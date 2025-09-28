// bot.js — Discord Disputes Bot (ESM, Node 18+)

import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events, ChannelType,
  ThreadAutoArchiveDuration, SlashCommandBuilder, Routes, REST,
  PermissionFlagsBits
} from 'discord.js';

// ====== ENV & DEBUG ======
const token = (process.env.DISCORD_TOKEN ?? '').trim();
const debugKeys = Object.keys(process.env)
  .filter(k => k.startsWith('DISCORD') || k.startsWith('RAILWAY') || k === 'NODE_VERSION')
  .sort();
console.log('ENV KEYS SEEN:', debugKeys);
console.log('DISCORD_TOKEN length:', token ? token.length : 0);

if (!token || !token.includes('.')) {
  console.error('❌ DISCORD_TOKEN missing/invalid. Set it in Railway → Service → Variables.');
  process.exit(1);
}

const {
  GUILD_ID,
  DISPUTE_CHANNEL_ID,
  REF_HUB_CHANNEL_ID,
  REF_ROLE_ID,
  JR_REF_ROLE_ID,
  TRIGGER_ROLE_ID,
  // COUNTRY_ROLE_PREFIX is no longer used; bracket roles are used instead
} = process.env;

const requiredEnv = {
  GUILD_ID, DISPUTE_CHANNEL_ID, REF_HUB_CHANNEL_ID,
  REF_ROLE_ID, JR_REF_ROLE_ID, TRIGGER_ROLE_ID
};
for (const [k, v] of Object.entries(requiredEnv)) {
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
  'For Gameplay disputes, please provide full video evidence.',
];

// ====== STATE ======
const disputeToRefThread = new Map();      // disputeThreadId -> refThreadId (if forum)
const disputeToDecisionChan = new Map();   // disputeThreadId -> decisionChannelId
const playerToRefThread = new Map();       // userId -> refThreadId
const refThreadToPlayer = new Map();       // refThreadId -> userId
const closedPlayers = new Set();           // userId => closed
const refThreadToOrigin = new Map();       // refThreadId -> { channelId, messageId }

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
const BRACKET_ROLE = /\[.+\]/; // any role whose name contains [ ... ]

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function messageMentionsRole(message, roleId) {
  return message.mentions.roles.has(roleId) || message.content.includes(`<@&${roleId}>`);
}

// Country from a member's roles → first role whose name contains [ ]
function getMemberCountry(member) {
  const role = member.roles.cache.find(r => BRACKET_ROLE.test(r.name));
  return role ? { name: role.name, roleId: role.id } : { name: null, roleId: null };
}

// Opponent country from the message → prefer role mentions with [ ], else text match, else forum tag with [ ]
function getOpponentCountryFromMessage(message, excludeName) {
  for (const role of message.mentions.roles.values()) {
    if (BRACKET_ROLE.test(role.name)) {
      const nm = role.name;
      if (!excludeName || nm.toLowerCase() !== (excludeName || '').toLowerCase()) {
        return { name: nm, roleId: role.id };
      }
    }
  }
  const content = (message.content || '').toLowerCase();
  const candidates = message.guild.roles.cache.filter(r => BRACKET_ROLE.test(r.name));
  for (const role of candidates.values()) {
    const nm = role.name;
    if (content.includes(nm.toLowerCase()) &&
        (!excludeName || nm.toLowerCase() !== (excludeName || '').toLowerCase())) {
      return { name: nm, roleId: role.id };
    }
  }
  if (message.channel?.type === ChannelType.PublicThread && message.channel.parent?.type === ChannelType.GuildForum) {
    const applied = message.channel.appliedTags || [];
    for (const tagId of applied) {
      const tag = message.channel.parent.availableTags.find(t => t.id === tagId);
      if (tag && BRACKET_ROLE.test(tag.name) &&
          (!excludeName || tag.name.toLowerCase() !== (excludeName || '').toLowerCase())) {
        return { name: tag.name, roleId: null };
      }
    }
  }
  return { name: null, roleId: null };
}

// Render as a role mention if we have the roleId; else plain name
const fmtCountry = (c) => c?.roleId ? `<@&${c.roleId}>` : (c?.name || 'Unknown');

// Find result channel that contains both country slugs (best effort)
async function findDecisionChannel(guild, countryA, countryB) {
  if (!countryA || !countryB) return null;
  const a = slug(countryA), b = slug(countryB);
  const chans = guild.channels.cache.filter(
    c => c.type === ChannelType.GuildText && c.name.includes(a) && c.name.includes(b)
  );
  return chans.find(c => /^post|^result/.test(c.name)) || chans.first() || null;
}

// Create the Dispute Thread (private for refs) and seed with ONE message
async function createRefThread(guild, disputeMessage, playerCountry, oppCountry) {
  const refHub = await guild.channels.fetch(REF_HUB_CHANNEL_ID);
  if (!refHub || refHub.type !== ChannelType.GuildText) {
    throw new Error('#dispute-referees must be a TEXT channel that allows private threads.');
  }

  const player = disputeMessage.author;
  const playerName = player.globalName || player.username;
  const thread = await refHub.threads.create({
    name: `Dispute - ${playerName}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    type: ChannelType.PrivateThread,
    invitable: false,
  });

  const refRoleMention = `<@&${REF_ROLE_ID}>`;
  const jrRoleMention  = `<@&${JR_REF_ROLE_ID}>`;
  const countriesLine = `Countries: ${fmtCountry(playerCountry)} and ${fmtCountry(oppCountry)}`;

  await thread.send(
    [
      `${refRoleMention} ${jrRoleMention}`,
      `Dispute Thread for **${playerName}**.`,
      countriesLine,
      `Source: <#${DISPUTE_CHANNEL_ID}>`
    ].join('\n')
  );

  return thread;
}

// Remove conflicted refs: any ref who has a bracketed role that matches either country name
async function removeConflictedRefs(thread, guild, countryNames) {
  const names = countryNames.filter(Boolean).map(n => n.toLowerCase());
  if (!names.length) return;

  await thread.members.fetch().catch(() => {});
  const allMembers = await guild.members.fetch();
  const refs = allMembers.filter(m => m.roles.cache.has(REF_ROLE_ID) || m.roles.cache.has(JR_REF_ROLE_ID));

  for (const member of refs.values()) {
    const hasConflict = member.roles.cache.some(r => BRACKET_ROLE.test(r.name) && names.includes(r.name.toLowerCase()));
    if (hasConflict) await thread.members.remove(member.id).catch(() => {});
  }
}

// --- DM helper: send questions (no “Dispute Review” line) ---
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
    ...PRESET_QUERIES.map(q => `• ${q}`),
    '',
    `Reference link to your dispute:`,
    link,
  ].join('\n');

  try {
    await user.send(text);
  } catch {
    try {
      await message.reply({
        content: `I couldn’t DM you (DMs disabled). Please answer here and enable DMs if possible.\n` +
                 '**Questions:**\n' + PRESET_QUERIES.map(q => `• ${q}`).join('\n'),
        allowedMentions: { parse: [], users: [user.id] }
      });
    } catch {}
  }
}

// ====== MESSAGE HANDLERS ======

// 1) Trigger from dispute area → create Dispute Thread + DM player (NO public questions).
//    If opponent country not detected → ask to re-raise with opponent country and exit.
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author?.bot) return;

    const inDispute =
      message.channel.id === DISPUTE_CHANNEL_ID ||
      message.channel?.parentId === DISPUTE_CHANNEL_ID;
    const mentioned = messageMentionsRole(message, TRIGGER_ROLE_ID);
    if (!inDispute || !mentioned) return;

    // Player/opponent countries
    const member = await message.guild.members.fetch(message.author.id);
    const playerCountry = getMemberCountry(member);
    const opponentCountry = getOpponentCountryFromMessage(message, playerCountry.name);

    // 🔒 Require an opponent country
    if (!opponentCountry.name) {
      await message.reply({
        content: 'I couldn’t detect an **opponent country**. Please **re-raise the issue and tag the opponent country role** (e.g., a role whose name includes `[XX]`).',
        allowedMentions: { parse: [] }
      });
      return;
    }

    // Create/use thread
    const isForumThread =
      message.channel.type === ChannelType.PublicThread ||
      message.channel.type === ChannelType.PrivateThread;
    const disputeThread = isForumThread ? message.channel : null;

    let refThread = disputeThread ? await message.guild.channels.fetch(disputeToRefThread.get(disputeThread.id)).catch(() => null) : null;
    if (!refThread) {
      refThread = await createRefThread(message.guild, message, playerCountry, opponentCountry);
      if (disputeThread) disputeToRefThread.set(disputeThread.id, refThread.id);

      const dc = await findDecisionChannel(message.guild, playerCountry.name, opponentCountry.name);
      if (dc && disputeThread) disputeToDecisionChan.set(disputeThread.id, dc.id);

      await removeConflictedRefs(refThread, message.guild, [playerCountry.name, opponentCountry.name].filter(Boolean));
    }

    // Map player ↔ thread and remember original message (for deletion on /close)
    playerToRefThread.set(message.author.id, refThread.id);
    refThreadToPlayer.set(refThread.id, message.author.id);
    closedPlayers.delete(message.author.id);
    refThreadToOrigin.set(refThread.id, { channelId: message.channel.id, messageId: message.id });

    // DM the player (no public message)
    await dmDisputeRaiser(message, disputeThread);

  } catch (err) {
    console.error('Dispute trigger handler error:', err);
  }
});

// 2) Mirror messages in dispute area (optional safety path)
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

// 3) Mirror player **DMs** into the Dispute Thread (silently drop when Closed)
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
function teamRuleText(rule) {
  switch (rule) {
    case 'same_teams_same_lead': return ['The same teams must be used, with the same lead Pokémon.'];
    case 'same_lead_flex_back':  return ['The same lead Pokémon must be used, the back line may be changed.'];
    case 'new_teams':            return ['New teams may be used.'];
    default: return [];
  }
}

const slashCommands = [
  new SlashCommandBuilder()
    .setName('decision')
    .setDescription('Post a dispute decision from the Dispute Thread.')
    .addStringOption(o =>
      o.setName('grant').setDescription('Rematch granted?').setRequired(true).addChoices(
        { name: 'will be granted', value: 'will' },
        { name: 'will NOT be granted', value: 'will not' },
      ))
    .addStringOption(o =>
      o.setName('team_rule').setDescription('Team/lead rule to apply').setRequired(true).addChoices(
        { name: 'Same teams & same lead', value: 'same_teams_same_lead' },
        { name: 'Same lead, backline may change', value: 'same_lead_flex_back' },
        { name: 'New teams allowed', value: 'new_teams' },
      ))
    .addStringOption(o => o.setName('issue').setDescription('Short issue text to insert').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Override target channel (optional)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Close dispute: archive+lock, stop mirroring, DM player, delete original message.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('reopen')
    .setDescription('Reopen dispute: unarchive+unlock and resume DM mirroring.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),
];

// Slash command logic
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'close' || interaction.commandName === 'reopen') {
    const ch = interaction.channel;
    const isThread = ch && (ch.type === ChannelType.PrivateThread || ch.type === ChannelType.PublicThread);
    const userId =
      isThread
        ? (refThreadToPlayer.get(ch.id)
           || [...playerToRefThread.entries()].find(([, refId]) => refId === ch.id)?.[0]
           || null)
        : null;

    if (!isThread || !userId) {
      return interaction.reply({ ephemeral: true, content: 'Use this inside a Dispute Thread (couldn’t resolve the player).' });
    }

    if (interaction.commandName === 'close') {
      closedPlayers.add(userId);
      try { await ch.setArchived(true, 'Closed by /close'); } catch {}
      try { await ch.setLocked(true, 'Closed by /close'); } catch {}

      try {
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) await user.send('Your dispute has been **Closed**. Your DMs to this bot will not be forwarded.');
      } catch {}

      try {
        const origin = refThreadToOrigin.get(ch.id);
        if (origin?.channelId && origin?.messageId) {
          const oChan = await client.channels.fetch(origin.channelId).catch(() => null);
          if (oChan && oChan.isTextBased?.()) {
            const msg = await oChan.messages.fetch(origin.messageId).catch(() => null);
            if (msg && msg.deletable) await msg.delete().catch(() => {});
          }
        }
      } catch {}

      return interaction.reply({ ephemeral: true, content: 'Dispute **Closed**: thread archived & locked, player notified, original message deleted (if permitted).' });
    }

    // reopen
    closedPlayers.delete(userId);
    try { await ch.setArchived(false, 'Reopened by /reopen'); } catch {}
    try { await ch.setLocked(false, 'Reopened by /reopen'); } catch {}
    return interaction.reply({ ephemeral: true, content: 'Dispute **Reopened**: DM mirroring resumed.' });
  }

  if (interaction.commandName === 'decision') {
    try {
      const current = interaction.channel;
      if (current?.type !== ChannelType.PrivateThread && current?.type !== ChannelType.PublicThread) {
        return interaction.reply({ ephemeral: true, content: 'Use this command from within the Dispute Thread (or specify a channel).' });
      }

      const disputeThreadId = [...disputeToRefThread.entries()].find(([, refId]) => refId === current.id)?.[0] || null;

      const grant = interaction.options.getString('grant', true);
      const rule  = interaction.options.getString('team_rule', true);
      const issue = interaction.options.getString('issue', true);
      const overrideChan = interaction.options.getChannel('channel', false);

      let targetChannel = overrideChan;
      if (!targetChannel) {
        const auto = disputeThreadId ? disputeToDecisionChan.get(disputeThreadId) : null;
        targetChannel = auto ? await interaction.guild.channels.fetch(auto).catch(() => null) : null;
      }
      if (!targetChannel) {
        return interaction.reply({ ephemeral: true, content: 'No target channel found. Provide one with /decision channel:...' });
      }

      const teamRuleLines = teamRuleText(rule);
      const body = [
        'Post: (countries not detected)', // simple header; can be improved to parse thread name
        '',
        '@Playername1 @Playername2',
        `After reviewing the match dispute set by <@${interaction.user.id}> regarding ${issue}. The Referees team has decided that a rematch **${grant}** be granted.`,
        '',
        ...teamRuleLines,
        '',
        'We would like to remind all parties involved that referees and staff members from countries involved in disputes cannot be involved in the resolution of the dispute.'
      ].join('\n');

      await targetChannel.send(body);
      await interaction.reply({ ephemeral: true, content: `Posted decision to <#${targetChannel.id}>.` });
    } catch (e) {
      console.error(e);
      try { await interaction.reply({ ephemeral: true, content: 'Failed to post decision. Check my permissions and try again.' }); } catch {}
    }
  }
});

// ====== READY (config check + register commands) ======
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

  try {
    const guilds = await client.guilds.fetch();
    console.log('Guilds I am in:', [...guilds.values()].map(g => `${g.name} (${g.id})`).join(', ') || '(none)');
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

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('ℹ️ Global commands pushed (may take time to appear).');
  } catch (e) {
    console.error('❌ Global registration failed:', e?.code || e?.message || e);
  }
});

// ====== BOOT ======
client.login(token);
