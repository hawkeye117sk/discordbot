// bot.js — Discord Disputes Bot (ESM, Node 18+)

import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events, ChannelType,
  ThreadAutoArchiveDuration, SlashCommandBuilder, Routes, REST,
  PermissionFlagsBits
} from 'discord.js';

// ====== ENV & DEBUG ======
const token = (process.env.DISCORD_TOKEN ?? '').trim();
const {
  GUILD_ID,
  DISPUTE_CHANNEL_ID,
  REF_HUB_CHANNEL_ID,
  REF_ROLE_ID,
  JR_REF_ROLE_ID,
  TRIGGER_ROLE_ID,
  COUNTRY_ROLE_PREFIX = 'Country: '
} = process.env;

const dbg = Object.keys(process.env)
  .filter(k => k.startsWith('DISCORD') || k.startsWith('RAILWAY') || k === 'NODE_VERSION')
  .sort();
console.log('ENV KEYS SEEN:', dbg);
console.log('DISCORD_TOKEN length:', token ? token.length : 0);

if (!token || !token.includes('.')) {
  console.error('❌ DISCORD_TOKEN missing/invalid. Set it in Railway → Service → Variables.');
  process.exit(1);
}
for (const [k, v] of Object.entries({
  GUILD_ID, DISPUTE_CHANNEL_ID, REF_HUB_CHANNEL_ID,
  REF_ROLE_ID, JR_REF_ROLE_ID, TRIGGER_ROLE_ID
})) {
  if (!v) {
    console.error(`❌ Missing required env var: ${k}`);
    process.exit(1);
  }
}

// ====== CONSTANTS ======
const PRESET_QUERIES = [
  'Please describe the issue.',
  'Who was involved?',
  'Please provide screenshots of your communication.',
  'For Gameplay disputes, please provide full video evidence.'
];

// ====== STATE ======
const disputeToRefThread   = new Map(); // disputeThreadId -> refThreadId
const disputeToDecisionChan= new Map(); // disputeThreadId -> decisionChannelId
const playerToRefThread    = new Map(); // userId -> refThreadId (raiser)
const refThreadToPlayer    = new Map(); // refThreadId -> userId (raiser)
const refThreadToOrigin    = new Map(); // refThreadId -> {channelId,messageId}
const closedPlayers        = new Set(); // userIds with paused DM mirror
const refThreadPlayers     = new Map(); // refThreadId -> {p1Id,p2Id}
const refThreadIssue       = new Map(); // refThreadId -> 'lag'|'communication'|'device_issue'|'no_show'

// ====== CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ====== UTILS ======
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const hasBrackets = (name) => name.includes('[') && name.includes(']');

function messageMentionsRole(message, roleId) {
  return message.mentions.roles.has(roleId) || message.content.includes(`<@&${roleId}>`);
}

function displayName(user) {
  return user?.globalName || user?.username || 'Player';
}
const ISSUE_TITLES = {
  lag: 'Lag',
  communication: 'Communication',
  device_issue: 'Device Issue',
  no_show: 'No Show',
  wrong_pokemon_moveset: 'Wrong Pokémon / Moveset',
};

function issueToTitle(issue) {
  return ISSUE_TITLES[issue] || 'Dispute';
}

// Find first role on a member that looks like a country tag, prefer `[XX]` style
function getMemberCountry(member) {
  const bracket = member.roles.cache.find(r => hasBrackets(r.name));
  if (bracket) return { id: bracket.id, name: bracket.name };
  const pref = member.roles.cache.find(r => r.name.startsWith(COUNTRY_ROLE_PREFIX));
  if (pref) return { id: pref.id, name: pref.name.slice(COUNTRY_ROLE_PREFIX.length) };
  return { id: null, name: null };
}

// From a message, get an opponent country role (with [..]) that isn’t the player’s
function getOpponentCountryFromMessage(message, playerCountryName) {
  for (const role of message.mentions.roles.values()) {
    if (hasBrackets(role.name) && role.name !== playerCountryName) {
      return { id: role.id, name: role.name };
    }
  }
  return { id: null, name: null };
}

async function findDecisionChannel(guild, countryA, countryB) {
  if (!countryA || !countryB) return null;
  const a = slug(countryA.replace(/\[|\]/g, ''));
  const b = slug(countryB.replace(/\[|\]/g, ''));
  const chans = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildText && c.name.includes(a) && c.name.includes(b),
  );
  return chans.find((c) => /^post|^result/.test(c.name)) || chans.first() || null;
}

async function renameThreadForContext(thread) {
  if (!thread) return;
  const players = refThreadPlayers.get(thread.id) || {};
  const issue   = refThreadIssue.get(thread.id) || null;

  const p1Name = players.p1Name || 'Player1';
  const p2Name = players.p2Name || 'Player2';

  const base = issue ? `${issueToTitle(issue)} – ${p1Name} vs ${p2Name}`
                     : `Dispute – ${p1Name} vs ${p2Name}`;
  if (thread.name !== base) {
    await thread.setName(base).catch(() => {});
  }
}

async function createRefThread(guild, disputeMessage, playerCountry, opponentCountry) {
  const refHub = await guild.channels.fetch(REF_HUB_CHANNEL_ID);
  if (!refHub || refHub.type !== ChannelType.GuildText) {
    throw new Error('#disputes-referees must be a TEXT channel that allows private threads.');
  }

  const player = disputeMessage.author;
  const playerName = displayName(player);
  const thread = await refHub.threads.create({
    name: `Dispute – ${playerName}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    type: ChannelType.PrivateThread,
    invitable: false,
  });

  const refRoleMention = `<@&${REF_ROLE_ID}>`;
  const jrRoleMention  = `<@&${JR_REF_ROLE_ID}>`;
  const countriesLine = [
    playerCountry?.name || '(player country not found)',
    opponentCountry?.name || '(opponent country not found)'
  ].join(' vs ');

  await thread.send([
    `${refRoleMention} ${jrRoleMention}`,
    `**Dispute Thread for ${playerName}.**`,
    `**Countries:** ${countriesLine}`,
    `**Source:** <#${DISPUTE_CHANNEL_ID}>`,
    '',
    '— **Referee quick-start** —',
    '• Use `/set_issue` to set the issue (Lag, Communication, Device Issue, No Show).',
    '• Use `/set_players` to set Player 1 and Player 2. The thread title will update automatically.'
  ].join('\n'));

  return thread;
}

// --- DM helper: send the player the questions and tell them to use DM ---
async function dmDisputeRaiser(message, disputeThread) {
  const user = message.author;
  const name = displayName(user);
  const link = disputeThread
    ? `https://discord.com/channels/${message.guild.id}/${disputeThread.id}`
    : message.url;

  const text = [
    `Hi ${name}, this is the **Gymbreakers Referee Team**.`,
    `Please send all evidence and messages **in this DM**. We’ll mirror everything privately for the referees.`,
    '',
    '**Questions to answer:**',
    ...PRESET_QUERIES.map(q => `• ${q}`),
    '',
    `Reference link to your dispute:`,
    link
  ].join('\n');

  try {
    await user.send(text);
    console.log('📩 DM sent to', user.id);
  } catch (e) {
    console.log('⚠️ Could not DM user (DMs likely closed):', user.id, e?.message);
    try {
      await message.reply({
        content:
          `I couldn’t DM you (DMs disabled). Please answer here and enable DMs if possible.\n` +
          '**Questions:**\n' + PRESET_QUERIES.map(q => `• ${q}`).join('\n'),
        allowedMentions: { parse: [], users: [user.id] }
      });
    } catch {}
  }
}

// Try to collect two players from the related dispute thread’s early messages
async function inferPlayersFromDisputeThread(guild, disputeThreadId) {
  try {
    const disputeThread = await guild.channels.fetch(disputeThreadId);
    if (!disputeThread?.isThread()) return { p1: null, p2: null, mentions: [] };
    const firstMsgs = await disputeThread.messages.fetch({ limit: 15 });
    const mentions = new Map();
    firstMsgs.forEach(m => m.mentions?.users?.forEach(u => mentions.set(u.id, u)));
    const arr = [...mentions.values()];
    return { p1: arr[0] || null, p2: arr[1] || null, mentions: arr };
  } catch {
    return { p1: null, p2: null, mentions: [] };
  }
}

function mention(u) { return u ? `<@${u.id}>` : '@Player'; }
function formatReminderFooter() {
  return [
    '',
    'We would like to remind all parties involved that referees and staff members from countries involved in disputes cannot be involved in the resolution of the dispute.',
    '',
    'Good luck in your remaining battles.'
  ].join('\n');
}

async function resolveTargetChannel(interaction, disputeThreadId) {
  const override = interaction.options.getChannel('channel');
  if (override?.type === ChannelType.GuildText) return override;

  if (disputeThreadId) {
    const autoId = disputeToDecisionChan.get(disputeThreadId);
    if (autoId) {
      const c = await interaction.guild.channels.fetch(autoId).catch(() => null);
      if (c) return c;
    }
  }
  if (interaction.channel?.type === ChannelType.GuildText) return interaction.channel;
  return null;
}

// ====== MESSAGE HANDLERS ======

// 1) Trigger from dispute area → create Dispute Thread + DM player (NO public questions).
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author?.bot) return;

    const inDispute =
      message.channel.id === DISPUTE_CHANNEL_ID ||
      message.channel?.parentId === DISPUTE_CHANNEL_ID;
    const mentioned = messageMentionsRole(message, TRIGGER_ROLE_ID);
    if (!inDispute || !mentioned) return;

    const member = await message.guild.members.fetch(message.author.id);
    const playerCountry   = getMemberCountry(member);
    const opponentCountry = getOpponentCountryFromMessage(message, playerCountry.name);

    if (!opponentCountry.name) {
      await message.reply({
        content: 'I couldn’t detect an **opponent country**. Please **re-raise and tag the opponent country role** (a role with `[ ]`).',
        allowedMentions: { parse: [] }
      });
      return;
    }

    const isThread = message.channel.isThread?.() || (
      message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread
    );
    const disputeThread = isThread ? message.channel : null;

    let refThread = disputeThread ? await message.guild.channels.fetch(disputeToRefThread.get(disputeThread.id)).catch(() => null) : null;
    if (!refThread) {
      refThread = await createRefThread(message.guild, message, playerCountry, opponentCountry);
      if (disputeThread) disputeToRefThread.set(disputeThread.id, refThread.id);

      const dc = await findDecisionChannel(message.guild, playerCountry.name, opponentCountry.name);
      if (dc && disputeThread) {
        disputeToDecisionChan.set(disputeThread.id, dc.id);
        await refThread.send(`📣 Default decision channel detected: <#${dc.id}>`);
      }
    }

    // map & context
    playerToRefThread.set(message.author.id, refThread.id);
    refThreadToPlayer.set(refThread.id, message.author.id);
    refThreadToOrigin.set(refThread.id, { channelId: message.channel.id, messageId: message.id });
    closedPlayers.delete(message.author.id);

    const summary = (message.content || '').trim().split('\n')[0]?.slice(0, 300);
    await refThread.send(
      [
        `🧵 New dispute raised by <@${message.author.id}>`,
        `Countries: ${playerCountry.name || '(unknown)'} vs ${opponentCountry.name || '(unknown)'}`,
        summary ? `Summary: ${summary}` : '',
        `Source: ${message.url}`,
      ].filter(Boolean).join('\n')
    );

    await dmDisputeRaiser(message, disputeThread);
  } catch (err) {
    console.error('Dispute trigger handler error:', err);
  }
});

// 2) Mirror messages that still land in dispute area (safety path)
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author?.bot) return;
    const refThreadId = playerToRefThread.get(message.author.id);
    if (!refThreadId) return;

    const isInDisputeArea =
      message.channel.id === DISPUTE_CHANNEL_ID ||
      message.channel?.parentId === DISPUTE_CHANNEL_ID ||
      (message.channel.type === ChannelType.PublicThread && message.channel.parentId === DISPUTE_CHANNEL_ID);
    if (!isInDisputeArea) return;

    const refThread = await message.guild.channels.fetch(refThreadId).catch(() => null);
    if (!refThread) return;

    await refThread.send(
      `👤 **${message.author.username} (channel):** ${message.content || '(attachment/message)'}${
        message.attachments.size ? '\n(Attachments present)' : ''
      }`,
    );
  } catch {}
});

// 3) Mirror player **DMs** into the Dispute Thread (drop if closed)
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;
    if (message.guild) return;
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

// /set_players
const setPlayersCmd = new SlashCommandBuilder()
  .setName('set_players')
  .setDescription('Set Player 1 and Player 2 for this dispute thread')
  .addUserOption(o => o.setName('player1').setDescription('Player 1').setRequired(true))
  .addUserOption(o => o.setName('player2').setDescription('Player 2').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

// /set_issue
const setIssueCmd = new SlashCommandBuilder()
  .setName('set_issue')
  .setDescription('Set the issue for this dispute thread (updates title)')
  .addStringOption(o => o.setName('issue').setDescription('Select issue').setRequired(true).addChoices(
    { name: 'Lag', value: 'lag' },
    { name: 'Communication', value: 'communication' },
    { name: 'Device Issue', value: 'device_issue' },
    { name: 'No Show', value: 'no_show' },
    { name: 'Wrong Pokémon / Moveset', value: 'wrong_pokemon_moveset' }
  ))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

// /decision with two no-show variants
const decisionCmd = new SlashCommandBuilder()
  .setName('decision')
  .setDescription('Dispute decisions')
  .addSubcommand(sc =>
    sc.setName('no_show')
      .setDescription('No show decision (6.2.4 → 1 pt)')
      .addStringOption(o => o.setName('culprit')
        .setDescription('Who failed to show')
        .setRequired(true)
        .addChoices(
          { name: 'Player 1', value: 'p1' },
          { name: 'Player 2', value: 'p2' }
        ))
      .addUserOption(o => o.setName('player1').setDescription('Player 1 (optional)'))
      .addUserOption(o => o.setName('player2').setDescription('Player 2 (optional)'))
      .addChannelOption(o => o.setName('channel').setDescription('Override target channel')))
  .addSubcommand(sc =>
    sc.setName('no_show_24h')
      .setDescription('No show decision (6.2.5 → 3 pts)')
      .addStringOption(o => o.setName('culprit')
        .setDescription('Who failed to show')
        .setRequired(true)
        .addChoices(
          { name: 'Player 1', value: 'p1' },
          { name: 'Player 2', value: 'p2' }
        ))
      .addUserOption(o => o.setName('player1').setDescription('Player 1 (optional)'))
      .addUserOption(o => o.setName('player2').setDescription('Player 2 (optional)'))
      .addChannelOption(o => o.setName('channel').setDescription('Override target channel')))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages);

const slashCommands = [setPlayersCmd.toJSON(), setIssueCmd.toJSON(), decisionCmd.toJSON()];

// ====== INTERACTIONS ======
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // --- /set_players ---
  if (interaction.commandName === 'set_players') {
    const ch = interaction.channel;
    const isThread = ch && (ch.type === ChannelType.PrivateThread || ch.type === ChannelType.PublicThread);
    if (!isThread) return interaction.reply({ ephemeral: true, content: 'Use this inside a Dispute Thread.' });

    const p1 = interaction.options.getUser('player1', true);
    const p2 = interaction.options.getUser('player2', true);

    refThreadPlayers.set(ch.id, { p1Id: p1.id, p2Id: p2.id, p1Name: displayName(p1), p2Name: displayName(p2) });
    await renameThreadForContext(ch);

    await ch.send(`👥 Players set: **${displayName(p1)}** vs **${displayName(p2)}**`);
    return interaction.reply({ ephemeral: true, content: '✅ Players saved.' });
  }

  // --- /set_issue ---
  if (interaction.commandName === 'set_issue') {
    const ch = interaction.channel;
    const isThread = ch && (ch.type === ChannelType.PrivateThread || ch.type === ChannelType.PublicThread);
    if (!isThread) return interaction.reply({ ephemeral: true, content: 'Use this inside a Dispute Thread.' });

    const issue = interaction.options.getString('issue', true); // lag|communication|device_issue|no_show
    refThreadIssue.set(ch.id, issue);
    await renameThreadForContext(ch);

    await ch.send(`🏷️ Issue set to **${issueToTitle(issue)}**.`);
    return interaction.reply({ ephemeral: true, content: '✅ Issue saved.' });
  }

  // --- /decision ---
  if (interaction.commandName === 'decision') {
    const sub = interaction.options.getSubcommand();
    try {
      const ch = interaction.channel;
      const isThread = ch && (ch.type === ChannelType.PrivateThread || ch.type === ChannelType.PublicThread);
      if (!isThread) {
        return interaction.reply({ ephemeral: true, content: 'Use this inside a Dispute Thread.' });
      }

      // Find linked dispute thread (for auto-target channel + inferring players)
      const disputeThreadId = [...disputeToRefThread.entries()].find(([, refId]) => refId === ch.id)?.[0] || null;

      // Resolve players: prefer explicit set_players, else options, else infer
      let p1User = null, p2User = null;
      const stored = refThreadPlayers.get(ch.id);
      if (stored?.p1Id && stored?.p2Id) {
        p1User = await interaction.client.users.fetch(stored.p1Id).catch(() => null);
        p2User = await interaction.client.users.fetch(stored.p2Id).catch(() => null);
      }
      p1User = p1User || interaction.options.getUser('player1') || null;
      p2User = p2User || interaction.options.getUser('player2') || null;

      if ((!p1User || !p2User) && disputeThreadId) {
        const inferred = await inferPlayersFromDisputeThread(interaction.guild, disputeThreadId);
        p1User = p1User || inferred.p1;
        p2User = p2User || inferred.p2;
      }

      const reporterId = refThreadToPlayer.get(ch.id) || interaction.user.id;
      const culprit = interaction.options.getString('culprit', true); // 'p1' | 'p2'
      const culpritUser = culprit === 'p1' ? p1User : p2User;

      const targetChannel = await resolveTargetChannel(interaction, disputeThreadId);
      if (!targetChannel) {
        return interaction.reply({ ephemeral: true, content: 'No target channel found. Provide one with the channel option.' });
      }

      let body = '';
      if (sub === 'no_show') {
        // 6.2.4 — 1 point
        body = [
          `${mention(p1User)} ${mention(p2User)}`,
          `After reviewing the dispute set by <@${reporterId}> regarding a **no show**, the Referees team has decided that ${mention(culpritUser)} failed to show in time and, per **6.2.4**, the penalty is **one (1) penalty point**.`,
          '',
          'The remaining games are to be played.',
          formatReminderFooter(),
        ].join('\n');
      } else if (sub === 'no_show_24h') {
        // 6.2.5 — 3 points (last 24h window)
        body = [
          `${mention(p1User)} ${mention(p2User)}`,
          `After reviewing the dispute set by <@${reporterId}> regarding a **no show (within the last 24 hours)**, the Referees team has decided that ${mention(culpritUser)} failed to show in time and, per **6.2.5**, the penalty is **three (3) penalty points**.`,
          '',
          'The remaining games are to be played.',
          formatReminderFooter(),
        ].join('\n');
      } else {
        return interaction.reply({ ephemeral: true, content: 'Unknown subcommand.' });
      }

      await targetChannel.send(body);
      return interaction.reply({ ephemeral: true, content: `✅ Posted to <#${targetChannel.id}>.` });
    } catch (e) {
      console.error(e);
      try { await interaction.reply({ ephemeral: true, content: 'Failed to post decision. Check my permissions and try again.' }); } catch {}
    }
  }
});

// ====== READY (config check + register commands GUILD-ONLY; clear GLOBAL) ======
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    const g = await client.guilds.fetch(GUILD_ID);
    const guild = await g.fetch();
    const chan = await client.channels.fetch(DISPUTE_CHANNEL_ID).catch(() => null);
    const trigRole = await guild.roles.fetch(TRIGGER_ROLE_ID).catch(() => null);
    console.log('🔎 Config check:',
      'guild=', guild?.name, `(${guild?.id})`,
      '| disputeChannel=', chan?.name, `(${chan?.id})`, 'type=', chan?.type,
      '| triggerRole=', trigRole?.name, `(${trigRole?.id})`
    );
  } catch (e) {
    console.error('Config check failed:', e?.code || e?.message || e);
  }

  // Register in all guilds (guild-only)
  try {
    const guilds = await client.guilds.fetch();
    console.log('Guilds I am in:', [...guilds.values()].map((g) => `${g.name} (${g.id})`).join(', ') || '(none)');

    for (const [id, g2] of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, id), { body: slashCommands });
        console.log(`✅ Commands registered in guild: ${g2?.name || id} (${id})`);
      } catch (e) {
        console.error(`❌ Failed to register in guild ${g2?.name || id} (${id}):`, e?.code || e?.message || e);
      }
    }
  } catch (e) {
    console.error('Failed to fetch guilds:', e);
  }

  // Clear GLOBAL commands to avoid duplicates
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    console.log('🧹 Cleared GLOBAL commands (guild-only now).');
  } catch (e) {
    console.error('Global clear failed:', e?.code || e?.message || e);
  }
});

// ====== BOOT ======
client.login(token);
