// bot.js — Discord Disputes Bot (ESM, Node 18+)

import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events, ChannelType,
  ThreadAutoArchiveDuration, SlashCommandBuilder, Routes, REST,
  PermissionFlagsBits
} from 'discord.js';

// ====== ENV ======
const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token || !token.includes('.')) {
  console.error('❌ DISCORD_TOKEN missing/invalid.');
  process.exit(1);
}

const {
  GUILD_ID,
  DISPUTE_CHANNEL_ID,
  REF_HUB_CHANNEL_ID,
  REF_ROLE_ID,
  JR_REF_ROLE_ID,
  TRIGGER_ROLE_ID,
  DISPUTE_REVIEW_CHANNEL_ID // optional; used by /close DM text if provided
} = process.env;

for (const [k, v] of Object.entries({
  GUILD_ID, DISPUTE_CHANNEL_ID, REF_HUB_CHANNEL_ID,
  REF_ROLE_ID, JR_REF_ROLE_ID, TRIGGER_ROLE_ID
})) {
  if (!v) {
    console.error(`❌ Missing required env var: ${k}`);
    process.exit(1);
  }
}

// ====== STATE ======
const disputeToRefThread = new Map();     // disputeThreadId -> refThreadId
const playerToRefThread = new Map();      // userId -> refThreadId
const refThreadToPlayer = new Map();      // refThreadId -> player1Id (raiser)
const refThreadToOrigin = new Map();      // refThreadId -> {channelId, messageId}
const closedPlayers = new Set();          // userIds with closed dispute
const refMeta = new Map();                // refThreadId -> {p1Id,p2Id,issue, playerCountry, opponentCountry}

// ====== CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ====== UTILS ======
const slug = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function messageMentionsRole(message, roleId) {
  return message.mentions.roles.has(roleId) || message.content.includes(`<@&${roleId}>`);
}

function getMemberCountry(member) {
  // any role with [ ... ] in the name
  const role = member.roles.cache.find(r => /\[.*\]/.test(r.name));
  return role ? { id: role.id, name: role.name } : { id: null, name: null };
}

function getOpponentCountryFromMessage(message, excludeName) {
  const role = [...message.mentions.roles.values()]
    .find(r => /\[.*\]/.test(r.name) && (!excludeName || r.name !== excludeName));
  return role ? { id: role.id, name: role.name } : { id: null, name: null };
}

async function findDecisionChannel(guild, countryA, countryB) {
  if (!countryA || !countryB) return null;
  const a = slug(countryA), b = slug(countryB);
  const chans = guild.channels.cache.filter(
    c => c.type === ChannelType.GuildText && c.name.includes(a) && c.name.includes(b)
  );
  // prefer channels starting with "post" or "results" if any
  return chans.find(c => /^post|^result/.test(c.name)) || chans.first() || null;
}

async function createRefThread(guild, disputeMessage) {
  const refHub = await guild.channels.fetch(REF_HUB_CHANNEL_ID);
  if (!refHub || refHub.type !== ChannelType.GuildText)
    throw new Error('#disputes-referees must be a TEXT channel that allows private threads.');

  const playerName = disputeMessage.author.globalName || disputeMessage.author.username;
  const thread = await refHub.threads.create({
    name: `Dispute – ${playerName}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    type: ChannelType.PrivateThread,
    invitable: false,
  });
  return thread;
}

function buildIntro({ playerName, playerCountry, opponentCountry }) {
  const refRoleMention = `<@&${REF_ROLE_ID}>`;
  const jrRoleMention  = `<@&${JR_REF_ROLE_ID}>`;
  const countriesLine = (playerCountry?.name || opponentCountry?.name)
    ? `**Countries:** ${playerCountry?.name || 'Unknown'} vs ${opponentCountry?.name || 'Unknown'}`
    : `**Countries:** (not detected)`;
  const sourceLine = `**Source:** <#${DISPUTE_CHANNEL_ID}>`;

  return [
    `${refRoleMention} ${jrRoleMention}`,
    `**Dispute Thread for ${playerName}.**`,
    countriesLine,
    sourceLine,
    '',
    '— **Referee quick-start** —',
    '• Use `/set_issue` to set the issue (Lag, Communication, Device Issue, No Show, Wrong Pokemon or Moveset).',
    '• Use `/set_players` to set Player 1 & Player 2 — the thread title will update automatically.',
  ].join('\n');
}

async function renameThreadByMeta(thread) {
  const meta = refMeta.get(thread.id) || {};
  let title = thread.name;

  const names = [];
  if (meta.p1Id) {
    const u1 = await thread.guild.members.fetch(meta.p1Id).catch(() => null);
    names.push(u1?.user?.username || 'Player1');
  }
  if (meta.p2Id) {
    const u2 = await thread.guild.members.fetch(meta.p2Id).catch(() => null);
    names.push(u2?.user?.username || 'Player2');
  }

  if (meta.issue && names.length === 2) {
    title = `${meta.issue} – ${names[0]} vs ${names[1]}`;
  } else if (!/Dispute\s–/.test(title)) {
    // keep original format if not already set
    title = thread.name;
  }

  if (title !== thread.name) {
    await thread.setName(title).catch(() => {});
  }
}

async function dmDisputeRaiser(message, disputeThread) {
  const user = message.author;
  const name = user.globalName || user.username;
  const link = disputeThread
    ? `https://discord.com/channels/${message.guild.id}/${disputeThread.id}`
    : message.url;

  const text = [
    `Hi ${name}, this is the **Gymbreakers Referee Team**.`,
    `Please send all evidence and messages **in this DM**. We’ll mirror everything privately for the referees.`,
    '',
    '**Questions to answer:**',
    '• Please describe the issue.',
    '• Who was involved?',
    '• Please provide screenshots of your communication.',
    '• For Gameplay disputes, please provide full video evidence.',
    '',
    'Reference link to your dispute:',
    link
  ].join('\n');

  try {
    await user.send(text);
  } catch {
    // DM closed; tell them in the channel
    try {
      await message.reply({
        content: 'I tried to DM you but could not. Please keep evidence **in this thread** and enable DMs if possible.',
        allowedMentions: { parse: [] }
      });
    } catch {}
  }
}

// ====== MESSAGE HANDLERS ======

// Trigger: @Referee in #dispute-request -> create thread, intro post, DM user
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author?.bot) return;

    const inDispute =
      message.channel.id === DISPUTE_CHANNEL_ID ||
      message.channel?.parentId === DISPUTE_CHANNEL_ID;
    const mentioned = messageMentionsRole(message, TRIGGER_ROLE_ID);
    if (!inDispute || !mentioned) return;

    // Countries
    const member = await message.guild.members.fetch(message.author.id);
    const playerCountry = getMemberCountry(member);
    const opponentCountry = getOpponentCountryFromMessage(message, playerCountry.name);

    // Require opponent country to proceed
    if (!opponentCountry.name) {
      await message.reply({
        content: 'I couldn’t detect an **opponent country**. Please **re-raise the issue and tag the opponent country role** (a role whose name includes `[XX]`).',
        allowedMentions: { parse: [] }
      });
      return;
    }

    // Create thread
    const disputeThread =
      (message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread)
        ? message.channel
        : null;

    let refThread = disputeThread ? await message.guild.channels
      .fetch(disputeToRefThread.get(disputeThread.id) || '0').catch(() => null) : null;

    if (!refThread) {
      refThread = await createRefThread(message.guild, message);
      if (disputeThread) disputeToRefThread.set(disputeThread.id, refThread.id);
    }

    // Seed meta, mappings
    refMeta.set(refThread.id, {
      p1Id: message.author.id,
      p2Id: null,
      issue: null,
      playerCountry,
      opponentCountry
    });
    playerToRefThread.set(message.author.id, refThread.id);
    refThreadToPlayer.set(refThread.id, message.author.id);
    refThreadToOrigin.set(refThread.id, { channelId: message.channel.id, messageId: message.id });
    closedPlayers.delete(message.author.id);

    // Intro post (single)
    const playerName = message.author.globalName || message.author.username;
    await refThread.send(buildIntro({ playerName, playerCountry, opponentCountry }));

    // DM the player with questions
    await dmDisputeRaiser(message, disputeThread);

  } catch (err) {
    console.error('Dispute trigger handler error:', err);
  }
});

// Mirror player DMs -> thread (ignore when closed)
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.guild) return;
    if (message.author?.bot) return;
    if (message.channel?.type !== ChannelType.DM) return;

    const uid = message.author.id;
    const refThreadId = playerToRefThread.get(uid);
    if (!refThreadId) return;
    if (closedPlayers.has(uid)) {
      try { await message.reply('This dispute is **Closed**. Your DM was not forwarded.'); } catch {}
      return;
    }

    const refThread = await client.channels.fetch(refThreadId).catch(() => null);
    if (!refThread) return;

    const files = [...message.attachments.values()].map(a => a.url);
    const content = `📥 **${message.author.username} (DM):** ${message.content || (files.length ? '(attachment)' : '(empty)')}`;

    if (files.length) {
      await refThread.send({ content, files }).catch(async () => {
        await refThread.send(content + `\n(Attachments present but could not be forwarded)`);
      });
    } else {
      await refThread.send(content);
    }
  } catch (e) {
    console.error('DM mirror error:', e);
  }
});

// ====== SLASH COMMANDS ======
const ISSUE_CHOICES = [
  { name: 'Lag', value: 'Lag' },
  { name: 'Communication', value: 'Communication' },
  { name: 'Device Issue', value: 'Device Issue' },
  { name: 'No Show', value: 'No Show' },
  { name: 'Wrong Pokemon or Moveset', value: 'Wrong Pokemon or Moveset' },
];

const cmdSetPlayers = new SlashCommandBuilder()
  .setName('set_players')
  .setDescription('Set Player 1 and Player 2 for this dispute thread.')
  .addUserOption(o => o.setName('player1').setDescription('Player 1').setRequired(true))
  .addUserOption(o => o.setName('player2').setDescription('Player 2').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

const cmdSetIssue = new SlashCommandBuilder()
  .setName('set_issue')
  .setDescription('Set the issue and rename the thread.')
  .addStringOption(o => {
    o.setName('issue').setDescription('Issue type').setRequired(true);
    ISSUE_CHOICES.forEach(c => o.addChoices(c));
    return o;
  })
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

const cmdMessage = new SlashCommandBuilder()
  .setName('message')
  .setDescription('Send a DM to player1/player2/both; echo in thread.')
  .addStringOption(o =>
    o.setName('target')
      .setDescription('Who to DM')
      .setRequired(true)
      .addChoices(
        { name: 'player1', value: 'p1' },
        { name: 'player2', value: 'p2' },
        { name: 'both',    value: 'both' },
      ))
  .addStringOption(o =>
    o.setName('text').setDescription('Message text').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

const cmdCountryPost = new SlashCommandBuilder()
  .setName('country_post')
  .setDescription('Post a message to the appropriate country channel.')
  .addStringOption(o => o.setName('text').setDescription('Message to post').setRequired(true))
  .addChannelOption(o => o.setName('channel').setDescription('Override target channel').setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

const cmdClose = new SlashCommandBuilder()
  .setName('close')
  .setDescription('Close this dispute: archive+lock, stop mirroring, delete original trigger, DM player.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

const slashCommands = [cmdSetPlayers, cmdSetIssue, cmdMessage, cmdCountryPost, cmdClose];

// ---- interactions
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const ch = interaction.channel;
  const isThread = ch && (ch.type === ChannelType.PrivateThread || ch.type === ChannelType.PublicThread);
  if (!isThread) return interaction.reply({ ephemeral: true, content: 'Use this inside a **Dispute Thread**.' });

  const meta = refMeta.get(ch.id) || {};

  if (interaction.commandName === 'set_players') {
    const p1 = interaction.options.getUser('player1', true);
    const p2 = interaction.options.getUser('player2', true);

    meta.p1Id = p1.id;
    meta.p2Id = p2.id;
    refMeta.set(ch.id, meta);

    // Allow DM mirroring from both players
    playerToRefThread.set(p1.id, ch.id);
    playerToRefThread.set(p2.id, ch.id);

    await renameThreadByMeta(ch);
    return interaction.reply({
      content: `Players set: **Player 1:** <@${p1.id}>  •  **Player 2:** <@${p2.id}>`,
      ephemeral: false
    });
  }

  if (interaction.commandName === 'set_issue') {
    const issue = interaction.options.getString('issue', true);
    meta.issue = issue;
    refMeta.set(ch.id, meta);

    await renameThreadByMeta(ch);
    return interaction.reply({ content: `Issue set to **${issue}**.`, ephemeral: false });
  }

  if (interaction.commandName === 'message') {
    const target = interaction.options.getString('target', true); // p1|p2|both
    const text = interaction.options.getString('text', true);

    const ids = [];
    if (target === 'p1' && meta.p1Id) ids.push(meta.p1Id);
    if (target === 'p2' && meta.p2Id) ids.push(meta.p2Id);
    if (target === 'both') {
      if (meta.p1Id) ids.push(meta.p1Id);
      if (meta.p2Id) ids.push(meta.p2Id);
    }
    if (!ids.length) return interaction.reply({ ephemeral: true, content: 'Player(s) not set yet. Use `/set_players` first.' });

    const results = [];
    for (const uid of ids) {
      try {
        const u = await interaction.client.users.fetch(uid);
        await u.send(text);
        results.push(`✅ DM → <@${uid}> sent`);
      } catch {
        results.push(`❌ Couldn’t DM <@${uid}> (DMs closed?)`);
      }
    }

    // Echo in thread for visibility
    await ch.send(`📤 **Bot DM:** ${text}\n${results.join(' • ')}`);

    return interaction.reply({ content: 'Sent.', ephemeral: true });
  }

  if (interaction.commandName === 'country_post') {
    let target = interaction.options.getChannel('channel', false);
    const text = interaction.options.getString('text', true);

    if (!target) {
      const g = await interaction.guild.fetch();
      target = await findDecisionChannel(
        interaction.guild,
        meta.playerCountry?.name,
        meta.opponentCountry?.name
      );
    }
    if (!target || target.type !== ChannelType.GuildText) {
      return interaction.reply({ ephemeral: true, content: 'No suitable country channel found. Provide one with the `channel` option.' });
    }

    try {
      await target.send(text);
      await interaction.reply({ content: `Posted to <#${target.id}>.`, ephemeral: false });
    } catch (e) {
      console.error('country_post error', e);
      await interaction.reply({ ephemeral: true, content: 'Failed to post to the channel.' });
    }
  }

  if (interaction.commandName === 'close') {
    try {
      // Stop mirroring both players
      if (meta.p1Id) closedPlayers.add(meta.p1Id);
      if (meta.p2Id) closedPlayers.add(meta.p2Id);

      // Delete original trigger message if we have it
      const origin = refThreadToOrigin.get(ch.id);
      if (origin) {
        const srcChan = await interaction.guild.channels.fetch(origin.channelId).catch(() => null);
        if (srcChan?.type === ChannelType.GuildText || srcChan?.type === ChannelType.PublicThread) {
          const msg = await srcChan.messages.fetch(origin.messageId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        }
      }

      // DM the raiser about closure
      const raiserId = refThreadToPlayer.get(ch.id);
      if (raiserId) {
        try {
          const u = await interaction.client.users.fetch(raiserId);
          const review = DISPUTE_REVIEW_CHANNEL_ID ? ` <#${DISPUTE_REVIEW_CHANNEL_ID}>` : ' the Dispute Review channel.';
          await u.send(`Your dispute has been **Closed** by the referees. If you need to follow up, please message${review}`);
        } catch {}
      }

      // Archive & lock
      await ch.setArchived(true).catch(() => {});
      await ch.setLocked(true).catch(() => {});
      return interaction.reply({ content: '✅ Dispute closed (archived & locked).', ephemeral: false });
    } catch (e) {
      console.error('close error', e);
      return interaction.reply({ ephemeral: true, content: 'Failed to close this thread.' });
    }
  }
});

// ====== READY (register commands) ======
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    const guilds = await client.guilds.fetch();
    for (const [id, g] of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, id), { body: slashCommands });
        console.log(`✅ Commands registered in: ${g?.name || id}`);
      } catch (e) {
        console.error(`❌ Failed to register in guild ${id}:`, e?.code || e?.message || e);
      }
    }
  } catch (e) {
    console.error('Failed to fetch guilds:', e);
  }
});

// ====== BOOT ======
client.login(token);
