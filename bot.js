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

const debugKeys = Object.keys(process.env)
  .filter(k => k.startsWith('DISCORD') || k.startsWith('RAILWAY') || k === 'NODE_VERSION')
  .sort();
console.log('ENV KEYS SEEN:', debugKeys);
console.log('DISCORD_TOKEN length:', token ? token.length : 0);

if (!token || !token.includes('.')) {
  console.error('❌ DISCORD_TOKEN missing/invalid. Set it in Railway → Service → Variables.');
  process.exit(1);
}
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
  'For Gameplay disputes, please provide full video evidence.'
];

// ====== STATE ======
const disputeToRefThread = new Map();    // disputeThreadId -> refThreadId
const disputeToDecisionChan = new Map(); // disputeThreadId -> decisionChannelId
const playerToRefThread = new Map();     // userId -> refThreadId
const refThreadToPlayer = new Map();     // refThreadId -> userId (dispute raiser)
const refThreadToOrigin = new Map();     // refThreadId -> {channelId, messageId}
const closedPlayers = new Set();         // userIds whose DM mirror is paused

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

// Find first role on a member that looks like a country tag, prefer `[XX]` style
function getMemberCountry(member) {
  // 1) role with [..]
  const bracket = member.roles.cache.find(r => hasBrackets(r.name));
  if (bracket) return { id: bracket.id, name: bracket.name };

  // 2) role name starting with configured prefix
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

async function createRefThread(guild, disputeMessage, playerCountry, opponentCountry) {
  const refHub = await guild.channels.fetch(REF_HUB_CHANNEL_ID);
  if (!refHub || refHub.type !== ChannelType.GuildText) {
    throw new Error('#disputes-referees must be a TEXT channel that allows private threads.');
  }

  const player = disputeMessage.author;
  const playerName = player.globalName || player.username;
  const threadName = `Dispute – ${playerName}`;

  const thread = await refHub.threads.create({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    type: ChannelType.PrivateThread,
    invitable: false,
  });

  const refRoleMention = `<@&${REF_ROLE_ID}>`;
  const jrRoleMention  = `<@&${JR_REF_ROLE_ID}>`;
  const countriesLine = [
    playerCountry?.name ? playerCountry.name : '(player country not found)',
    opponentCountry?.name ? opponentCountry.name : '(opponent country not found)'
  ].join(' vs ');

  await thread.send(
    [
      `${refRoleMention} ${jrRoleMention}`,
      `Dispute Thread for **${playerName}**.`,
      `Countries: ${countriesLine}`,
      `Source: <#${DISPUTE_CHANNEL_ID}>`,
    ].join('\n')
  );

  return thread;
}

// --- DM helper: send the player the questions and tell them to use DM ---
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

    // Require an opponent country role mention (with [..])
    if (!opponentCountry.name) {
      await message.reply({
        content: 'I couldn’t detect an **opponent country**. Please **re-raise and tag the opponent country role** (a role with `[ ]`).',
        allowedMentions: { parse: [] }
      });
      return;
    }

    // Link to a dispute thread if already in one, else null
    const isThread = message.channel.isThread?.() || (
      message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread
    );
    const disputeThread = isThread ? message.channel : null;

    // Create or reuse ref/dispute thread
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

    // Map player ↔ thread and remember original message (for potential cleanups later)
    playerToRefThread.set(message.author.id, refThread.id);
    refThreadToPlayer.set(refThread.id, message.author.id);
    refThreadToOrigin.set(refThread.id, { channelId: message.channel.id, messageId: message.id });
    closedPlayers.delete(message.author.id);

    // Seed context in the ref thread
    const summary = (message.content || '').trim().split('\n')[0]?.slice(0, 300);
    await refThread.send(
      [
        `🧵 New dispute raised by <@${message.author.id}>`,
        `Countries: ${playerCountry.name || '(unknown)'} vs ${opponentCountry.name || '(unknown)'}`,
        summary ? `Summary: ${summary}` : '',
        `Source: ${message.url}`,
      ].filter(Boolean).join('\n')
    );

    // DM the player (no public questions)
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

// Build /decision with two no-show variants (regular and last 24h)
const decisionCmd = new SlashCommandBuilder()
  .setName('decision')
  .setDescription('Dispute decisions')
  .addSubcommand(sc =>
    sc.setName('no_show')
      .setDescription('No show decision')
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
      .setDescription('No show decision (last 24h)')
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

// Collect and register
const slashCommands = [decisionCmd.toJSON()];

// ====== DECISION HELPERS ======
function formatReminderFooter() {
  return [
    '',
    'We would like to remind all parties involved that referees and staff members from countries involved in disputes cannot be involved in the resolution of the dispute.',
    '',
    'Good luck in your remaining battles.'
  ].join('\n');
}

async function resolveTargetChannel(interaction, disputeThreadId) {
  // If user provided override
  const override = interaction.options.getChannel('channel');
  if (override?.type === ChannelType.GuildText) return override;

  // Try known per-dispute default channel
  if (disputeThreadId) {
    const autoId = disputeToDecisionChan.get(disputeThreadId);
    if (autoId) {
      const c = await interaction.guild.channels.fetch(autoId).catch(() => null);
      if (c) return c;
    }
  }
  // Fallback to current channel (if text) or deny
  if (interaction.channel?.type === ChannelType.GuildText) return interaction.channel;
  return null;
}

function mention(u) { return u ? `<@${u.id}>` : '@Player'; }

// ====== INTERACTIONS ======
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // ===== /decision =====
  if (interaction.commandName === 'decision') {
    const sub = interaction.options.getSubcommand();
    try {
      // Must be used from within a ref/dispute thread to auto-link data
      const ch = interaction.channel;
      const isThread = ch && (ch.type === ChannelType.PrivateThread || ch.type === ChannelType.PublicThread);
      if (!isThread) {
        return interaction.reply({ ephemeral: true, content: 'Use this inside a Dispute Thread.' });
      }

      // Find linked dispute thread
      const disputeThreadId = [...disputeToRefThread.entries()].find(([, refId]) => refId === ch.id)?.[0] || null;

      // Resolve players: from options if provided, else infer from dispute thread
      let p1 = interaction.options.getUser('player1') || null;
      let p2 = interaction.options.getUser('player2') || null;
      if ((!p1 || !p2) && disputeThreadId) {
        const inferred = await inferPlayersFromDisputeThread(interaction.guild, disputeThreadId);
        p1 = p1 || inferred.p1;
        p2 = p2 || inferred.p2;
      }

      // Reporter (dispute raiser) if known
      const reporterId = refThreadToPlayer.get(ch.id) || interaction.user.id;

      const culprit = interaction.options.getString('culprit', true); // 'p1' | 'p2'
      const culpritUser = culprit === 'p1' ? p1 : p2;

      const targetChannel = await resolveTargetChannel(interaction, disputeThreadId);
      if (!targetChannel) {
        return interaction.reply({ ephemeral: true, content: 'No target channel found. Provide one with the channel option.' });
      }

      // Compose bodies
      let body = '';
      if (sub === 'no_show') {
        body = [
          `${mention(p1)} ${mention(p2)}`,
          `After reviewing the dispute set by <@${reporterId}> regarding a **no show**, the Referees team has decided that ${mention(culpritUser)} failed to show in time and, per **6.2.5**, the penalty is **three (3) penalty points**.`,
          '',
          'The remaining games are to be played.',
          formatReminderFooter(),
        ].join('\n');
      } else if (sub === 'no_show_24h') {
        body = [
          `${mention(p1)} ${mention(p2)}`,
          `After reviewing the dispute set by <@${reporterId}> regarding a **no show (within the last 24 hours)**, the Referees team has decided that ${mention(culpritUser)} failed to show in time and, per **6.2.4/6.2.5**, the penalty is **one (1) penalty point**.`,
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
      try {
        await interaction.reply({ ephemeral: true, content: 'Failed to post decision. Check my permissions and try again.' });
      } catch {}
    }
  }
});

// ====== READY (config check + register commands GUILD-ONLY; clear GLOBAL) ======
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(token);

  // Config check
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

  // Register in every guild the bot is in (GUILD-ONLY)
  try {
    const guilds = await client.guilds.fetch();
    console.log(
      'Guilds I am in:',
      [...guilds.values()].map((g) => `${g.name} (${g.id})`).join(', ') || '(none)',
    );

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

  // 🔥 Clear GLOBAL commands so you don’t get duplicates
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
    console.log('🧹 Cleared GLOBAL commands (guild-only now).');
  } catch (e) {
    console.error('Global clear failed:', e?.code || e?.message || e);
  }
});

// ====== BOOT ======
client.login(token);
