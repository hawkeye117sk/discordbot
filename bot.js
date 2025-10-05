// bot.js — Discord Disputes Bot (ESM, Node 18+)

import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events, ChannelType,
  ThreadAutoArchiveDuration, SlashCommandBuilder, Routes, REST,
  PermissionFlagsBits,
  ActionRowBuilder, StringSelectMenuBuilder
} from 'discord.js';

// ====== TOKEN ONLY FROM ENV ======
const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token || !token.includes('.')) {
  console.error('❌ DISCORD_TOKEN missing/invalid.');
  process.exit(1);
}

// ====== HARD-CODED IDS ======
// Destination (Gymbreakers) for ALL dispute threads
const DEST_GUILD_ID           = '416850757245992961';
const DEST_REF_HUB_CHANNEL_ID = '731919732441350215'; // Gymbreakers Referee Decision (used as thread hub)

// Destination referee roles (Gymbreakers only)
const REF_ROLE_ID    = '731919384179638285'; // Gymbreakers Referee
const JR_REF_ROLE_ID = '975306021058777149'; // Gymbreakers Junior Referee (Gymbreakers only)

// Origins (where we LISTEN for disputes)
const GYM_GUILD_ID            = '416850757245992961';
const GYM_DISPUTE_CHANNEL_ID  = '743575738665533541';
const GYM_TRIGGER_ROLE_ID     = '731919384179638285'; // Gymbreakers Referee role

const RAID_GUILD_ID           = '736744916012630046';
const RAID_DISPUTE_CHANNEL_ID = '1420609143894442054';
const RAID_TRIGGER_ROLE_ID    = '797983986152243200'; // Pogo Raiders Referee role

// Optional: destination review channel & rules reference (leave empty if not used)
const DISPUTE_REVIEW_CHANNEL_ID  = ''; // lives in destination (Gymbreakers), optional
const RULES_CHANNEL_ID           = ''; // optional global fallback for rules mention

// Bot self user ID (to allow @bot mention to trigger)
const BOT_USER_ID = '1417212106461286410';

// Per-origin config map
const ORIGINS = {
  [GYM_GUILD_ID]: {
    key: 'GYM',
    disputeChannelId: GYM_DISPUTE_CHANNEL_ID,
    triggerRoleId: GYM_TRIGGER_ROLE_ID,
  },
  [RAID_GUILD_ID]: {
    key: 'RAID',
    disputeChannelId: RAID_DISPUTE_CHANNEL_ID,
    triggerRoleId: RAID_TRIGGER_ROLE_ID,
  }
};

// ====== STATE ======
const disputeToRefThread = new Map();     // disputeThreadId -> refThreadId (if the request itself was a thread)
const refThreadToPlayer = new Map();      // refThreadId -> raiser userId
const refThreadToOrigin = new Map();      // refThreadId -> {originGuildId, channelId, messageId}
const refMeta = new Map();                // refThreadId -> {p1Id,p2Id,issue, playerCountry, opponentCountry, originGuildId}

// Multi-dispute routing (no short codes)
const userToThreads = new Map();          // userId -> Set<threadId> (all open disputes for that user)
const pendingDm = new Map();              // userId -> { content, files } waiting on user's choice

// (Kept for backward-compat; not used by DM router anymore)
const closedPlayers = new Set();          // legacy global close flag (not used)

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
const mention = id => id ? `<@${id}>` : '@Player';
const roleMention = (id, fallbackName) => id ? `<@&${id}>` : (fallbackName || '@Country');
const bracketCode = (name) => (name?.match(/\[([^\]]+)\]/)?.[1] || '').toLowerCase();

function messageMentionsRole(message, roleId) {
  return message.mentions.roles.has(roleId) || message.content.includes(`<@&${roleId}>`);
}
function messageMentionsBot(message) {
  // robustly detect either the known ID or the runtime client id (covers nick pings too)
  const raw = message.content || '';
  const byId = raw.includes(`<@${BOT_USER_ID}>`) || raw.includes(`<@!${BOT_USER_ID}>`);
  const byCache = client.user?.id ? (message.mentions.users.has(client.user.id) || raw.includes(`<@${client.user.id}>`) || raw.includes(`<@!${client.user.id}>`)) : false;
  return byId || byCache;
}

function getMemberCountry(member) {
  const role = member.roles.cache.find(r => /\[.*\]/.test(r.name));
  return role ? { id: role.id, name: role.name } : { id: null, name: null };
}

function getOpponentCountryFromMessage(message, excludeName) {
  const role = [...message.mentions.roles.values()]
    .find(r => /\[.*\]/.test(r.name) && (!excludeName || r.name !== excludeName));
  return role ? { id: role.id, name: role.name } : { id: null, name: null };
}

async function findDecisionChannel(guild, countryA, countryB) {
  if (!guild || !countryA || !countryB) return null;
  const a = slug(countryA), b = slug(countryB);
  const chans = guild.channels.cache.filter(
    c => c.type === ChannelType.GuildText && c.name.includes(a) && c.name.includes(b)
  );
  return chans.find(c => /^post|^result/.test(c.name)) || chans.first() || null;
}

async function createRefThreadInDestination(destGuild, sourceMessage) {
  const refHub = await destGuild.channels.fetch(DEST_REF_HUB_CHANNEL_ID);
  if (!refHub || refHub.type !== ChannelType.GuildText)
    throw new Error('Ref hub must be a TEXT channel that allows private threads (destination).');

  const playerName = sourceMessage.author.globalName || sourceMessage.author.username;
  const thread = await refHub.threads.create({
    name: `Dispute – ${playerName}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    type: ChannelType.PrivateThread,
    invitable: false,
  });

  // Post a source link jump for refs
  try {
    await thread.send([
      `🔗 **Source:** ${sourceMessage.url}`,
      `🗺️ **Origin Server:** ${sourceMessage.guild?.name || sourceMessage.guildId}`
    ].join('\n'));
  } catch {}
  return thread;
}

function buildIntro({ playerName, playerCountry, opponentCountry, originGuildName }) {
  const refRoleMention = `<@&${REF_ROLE_ID}>`;
  const jrRoleMention  = JR_REF_ROLE_ID ? ` <@&${JR_REF_ROLE_ID}>` : '';
  const countriesLine = (playerCountry?.name || opponentCountry?.name)
    ? `**Countries:** ${playerCountry?.name || 'Unknown'} vs ${opponentCountry?.name || 'Unknown'}`
    : `**Countries:** (not detected)`;
  const sourceLine = `**Origin:** ${originGuildName || 'Unknown'}`;

  return [
    `${refRoleMention}${jrRoleMention}`,
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
    const title = `${meta.issue} – ${names[0]} vs ${names[1]}`;
    if (title !== thread.name) {
      await thread.setName(title).catch(() => {});
    }
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
    try {
      await message.reply({
        content: 'I tried to DM you but could not. Please keep evidence **in this thread** and enable DMs if possible.',
        allowedMentions: { parse: [] }
      });
    } catch {}
  }
}

function addUserToThreadMap(userId, threadId) {
  if (!userId || !threadId) return;
  if (!userToThreads.has(userId)) userToThreads.set(userId, new Set());
  userToThreads.get(userId).add(threadId);
}
function removeUserThread(userId, threadId) {
  userToThreads.get(userId)?.delete(threadId);
  if (userToThreads.get(userId)?.size === 0) userToThreads.delete(userId);
}
function originJumpLink(threadId) {
  const o = refThreadToOrigin.get(threadId);
  if (!o) return null;
  return `https://discord.com/channels/${o.originGuildId}/${o.channelId}/${o.messageId}`;
}

// ====== MESSAGE HANDLERS ======

// Trigger: @Referee OR @Bot in either origin server's dispute channel -> create thread in Gymbreakers hub
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author?.bot) return;

    const originCfg = ORIGINS[message.guild.id];
    if (!originCfg) return; // ignore other servers

    const inOriginDisputeChan =
      message.channel.id === originCfg.disputeChannelId ||
      message.channel?.parentId === originCfg.disputeChannelId;

    // Trigger if role mentioned OR bot mentioned
    const mentioned = messageMentionsRole(message, originCfg.triggerRoleId) || messageMentionsBot(message);
    if (!inOriginDisputeChan || !mentioned) return;

    // Countries — detect from ORIGIN guild roles/mentions
    const member = await message.guild.members.fetch(message.author.id);
    const playerCountry = getMemberCountry(member);
    const opponentCountry = getOpponentCountryFromMessage(message, playerCountry.name);

    // Require opponent country
    if (!opponentCountry.name) {
      await message.reply({
        content: 'I couldn’t detect an **opponent country**. Please **re-raise the issue and tag the opponent country role** (a role whose name includes `[XX]`).',
        allowedMentions: { parse: [] }
      });
      return;
    }

    // Destination (Gymbreakers) for thread creation
    const destGuild = await client.guilds.fetch(DEST_GUILD_ID).catch(() => null);
    if (!destGuild) {
      console.error('❌ Cannot fetch destination guild for thread creation.');
      return;
    }

    // If request already a thread, reuse mapping; else create new thread in DEST guild
    const isThread = (message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread);
    const disputeThread = isThread ? message.channel : null;

    let refThread = disputeThread ? await destGuild.channels
      .fetch(disputeToRefThread.get(disputeThread.id) || '0').catch(() => null) : null;

    if (!refThread) {
      refThread = await createRefThreadInDestination(destGuild, message);
      if (disputeThread) disputeToRefThread.set(disputeThread.id, refThread.id);
    }

    // Seed meta, mappings (store ORIGIN guild id for later ops)
    refMeta.set(refThread.id, {
      p1Id: message.author.id,
      p2Id: null,
      issue: null,
      playerCountry,
      opponentCountry,
      originGuildId: message.guild.id
    });
    refThreadToPlayer.set(refThread.id, message.author.id);
    refThreadToOrigin.set(refThread.id, {
      originGuildId: message.guild.id,
      channelId: message.channel.id,
      messageId: message.id
    });

    // Map the raiser → this dispute thread (so their DMs can route)
    addUserToThreadMap(message.author.id, refThread.id);

    // Intro post in DEST thread
    const playerName = message.author.globalName || message.author.username;
    await refThread.send(buildIntro({
      playerName,
      playerCountry,
      opponentCountry,
      originGuildName: message.guild?.name
    }));

    // Add refs / remove conflicts in DEST guild
    await addAllRefsToThread(refThread, destGuild);
    await removeConflictedFromThread(
      refThread,
      destGuild,
      [playerCountry?.name, opponentCountry?.name].filter(Boolean)
    );

    // DM the player with questions (origin still OK)
    await dmDisputeRaiser(message, disputeThread);

  } catch (err) {
    console.error('Dispute trigger handler error:', err);
  }
});

// Mirror player DMs -> chosen dispute thread (no short codes; chooser if multiple)
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.guild) return;
    if (message.author?.bot) return;
    if (message.channel?.type !== ChannelType.DM) return;

    const uid = message.author.id;
    const text = (message.content ?? '').trim();
    const files = [...message.attachments.values()].map(a => a.url);

    const tids = userToThreads.get(uid);
    if (!tids || tids.size === 0) {
      await message.reply('I can’t find any open disputes for you. Please raise the dispute in the server channel first.');
      return;
    }

    // Single dispute → auto-route
    if (tids.size === 1) {
      const threadId = [...tids][0];
      const refThread = await client.channels.fetch(threadId).catch(() => null);
      if (!refThread) {
        await message.reply('I couldn’t reach your dispute thread. Please ping staff.');
        return;
      }
      const content = `📥 **${message.author.username} (DM):** ${text || (files.length ? '(attachment)' : '(empty)')}`;
      if (files.length) {
        await refThread.send({ content, files }).catch(async () => {
          await refThread.send(content + `\n(Attachments present but could not be forwarded)`);
        });
      } else {
        await refThread.send(content);
      }
      return;
    }

    // Multiple disputes → ask the user to pick which one
    const options = [];
    const lines = ['You have multiple active disputes. Which message is this relating to?\n'];
    for (const threadId of tids) {
      const thread = await client.channels.fetch(threadId).catch(() => null);
      const name = thread?.name || `Dispute ${threadId}`;
      const jump = originJumpLink(threadId);
      lines.push(`• **${name}**${jump ? `\n  ↳ ${jump}` : ''}`);
      options.push({
        label: name.slice(0, 100),
        description: jump ? 'Open original dispute message' : 'No link available',
        value: threadId,
      });
    }

    // Stash this DM so we can forward after the user chooses
    pendingDm.set(uid, { content: text, files });

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('choose_thread')
        .setPlaceholder('Pick the dispute to attach this DM to…')
        .addOptions(options)
    );

    await message.reply({ content: lines.join('\n'), components: [row] });
  } catch (e) {
    console.error('DM mirror (chooser) error:', e);
  }
});

// ====== VOTE MAPPING ======
const VOTE_CHOICES = {
  rematch:      { label: 'Rematch',      emoji: '🔁' },
  no_rematch:   { label: 'No Rematch',   emoji: '❌' },
  invalid:      { label: 'Invalid',      emoji: '🚫' },
  defwin:       { label: 'Defwin',       emoji: '🏆' },
  warning:      { label: 'Warning',      emoji: '⚠️' },
  penalty:      { label: 'Penalty',      emoji: '🟨' },
};

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
  .addStringOption(o =>
    o.setName('issue').setDescription('Issue type').setRequired(true).addChoices(...ISSUE_CHOICES)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

const cmdMessage = new SlashCommandBuilder()
  .setName('message')
  .setDescription('DM player1/player2/both; echo in thread.')
  .addStringOption(o =>
    o.setName('target')
      .setDescription('Target')
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
  .setDescription('Post a message to the origin country channel.')
  .addStringOption(o => o.setName('text').setDescription('Message').setRequired(true))
  .addChannelOption(o => o.setName('channel').setDescription('Override channel').setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

const cmdClose = new SlashCommandBuilder()
  .setName('close')
  .setDescription('Close: archive & lock, stop DMs, delete trigger, DM player.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

// ---- /decision (templated rulings) ----
const cmdDecision = new SlashCommandBuilder()
  .setName('decision')
  .setDescription('Post a templated referee decision.')
  .addStringOption(o =>
    o.setName('outcome')
     .setDescription('Pick a template')
     .setRequired(true)
     .addChoices(
       // Lag
       { name: 'Lag – Rematch', value: 'lag_rematch' },
       { name: 'Lag – No Rematch', value: 'lag_no_rematch' },
       { name: 'Lag – Win → P1', value: 'lag_win_p1' },
       { name: 'Lag – Win → P2', value: 'lag_win_p2' },
       // Communication
       { name: 'Communication – Missed to one opponent (6.1 – 1pt)', value: 'comm_bad_1' },
       { name: 'Communication – Missed to both opponents (6.1 – 3pt)', value: 'comm_bad_3' },
       { name: 'Communication – Dispute invalid', value: 'comm_invalid' },
       { name: 'Communication – Force Substitution (no penalties)', value: 'comm_force_sub' },
       // Device
       { name: 'Device – Rematch', value: 'dev_rematch' },
       { name: 'Device – No Rematch', value: 'dev_no_rematch' },
       { name: 'Device – Win → P1', value: 'dev_win_p1' },
       { name: 'Device – Win → P2', value: 'dev_win_p2' },
       // No Show
       { name: 'No Show – P1 failed (6.2.4 - 1pt)', value: 'ns_p1_1' },
       { name: 'No Show – P2 failed (6.2.4 - 1pt)', value: 'ns_p2_1' },
       { name: 'No Show – P1 failed (6.2.5 - 3pt)', value: 'ns_p1_3' },
       { name: 'No Show – P2 failed (6.2.5 - 3pt)', value: 'ns_p2_3' },
       // Wrong Pokémon/Moveset
       { name: 'Wrong Pokémon (unregistered)', value: 'wp_pokemon' },
       { name: 'Wrong Moveset (changed)', value: 'wp_moveset' },
     )
  )
  .addStringOption(o =>
    o.setName('team_rule')
     .setDescription('If rematch: team rule')
     .setRequired(false)
     .addChoices(
       { name: 'Same teams & same lead', value: 'same_teams_same_lead' },
       { name: 'Same lead, backline may change', value: 'same_lead_flex_back' },
       { name: 'New teams allowed', value: 'new_teams' },
     ))
  .addStringOption(o =>
    o.setName('favour')
     .setDescription('Communication: award country')
     .setRequired(false)
     .addChoices(
       { name: 'Player1 country', value: 'p1_country' },
       { name: 'Player2 country', value: 'p2_country' },
     ))
  .addStringOption(o =>
    o.setName('schedule_window')
     .setDescription('Communication: schedule window (e.g., 24 hours)')
     .setRequired(false))
  .addStringOption(o =>
    o.setName('device_player')
     .setDescription('Device Issue: who had the device issue')
     .setRequired(false)
     .addChoices(
       { name: 'Player1', value: 'p1' },
       { name: 'Player2', value: 'p2' },
     ))
  .addStringOption(o =>
    o.setName('pokemon')
     .setDescription('Wrong Pokémon: name')
     .setRequired(false))
  .addStringOption(o =>
    o.setName('old_move')
     .setDescription('Wrong Moveset: old move')
     .setRequired(false))
  .addStringOption(o =>
    o.setName('new_move')
     .setDescription('Wrong Moveset: new move')
     .setRequired(false))
  .addStringOption(o =>
    o.setName('penalty_against')
     .setDescription('Penalty goes to which country')
     .setRequired(false)
     .addChoices(
       { name: 'Player1 country', value: 'p1_country' },
       { name: 'Player2 country', value: 'p2_country' },
     ))
  .addChannelOption(o =>
    o.setName('channel')
     .setDescription('Post target (optional)')
     .setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

// ---- /vote ----  (required options FIRST)
const cmdVote = new SlashCommandBuilder()
  .setName('vote')
  .setDescription('Create a vote and add reaction options.')
  // REQUIRED FIRST
  .addStringOption(o => o.setName('opt1').setDescription('Option 1').setRequired(true)
    .addChoices(
      { name: 'Rematch', value: 'rematch' },
      { name: 'No Rematch', value: 'no_rematch' },
      { name: 'Invalid', value: 'invalid' },
      { name: 'Defwin', value: 'defwin' },
      { name: 'Warning', value: 'warning' },
      { name: 'Penalty', value: 'penalty' },
    ))
  .addStringOption(o => o.setName('opt2').setDescription('Option 2').setRequired(true)
    .addChoices(
      { name: 'Rematch', value: 'rematch' },
      { name: 'No Rematch', value: 'no_rematch' },
      { name: 'Invalid', value: 'invalid' },
      { name: 'Defwin', value: 'defwin' },
      { name: 'Warning', value: 'warning' },
      { name: 'Penalty', value: 'penalty' },
    ))
  // OPTIONAL AFTER
  .addStringOption(o => o.setName('title').setDescription('Heading (default: Vote time!)').setRequired(false))
  .addStringOption(o => o.setName('opt3').setDescription('Option 3').setRequired(false)
    .addChoices(
      { name: 'Rematch', value: 'rematch' },
      { name: 'No Rematch', value: 'no_rematch' },
      { name: 'Invalid', value: 'invalid' },
      { name: 'Defwin', value: 'defwin' },
      { name: 'Warning', value: 'warning' },
      { name: 'Penalty', value: 'penalty' },
    ))
  .addStringOption(o => o.setName('opt4').setDescription('Option 4').setRequired(false)
    .addChoices(
      { name: 'Rematch', value: 'rematch' },
      { name: 'No Rematch', value: 'no_rematch' },
      { name: 'Invalid', value: 'invalid' },
      { name: 'Defwin', value: 'defwin' },
      { name: 'Warning', value: 'warning' },
      { name: 'Penalty', value: 'penalty' },
    ))
  .addStringOption(o => o.setName('opt5').setDescription('Option 5').setRequired(false)
    .addChoices(
      { name: 'Rematch', value: 'rematch' },
      { name: 'No Rematch', value: 'no_rematch' },
      { name: 'Invalid', value: 'invalid' },
      { name: 'Defwin', value: 'defwin' },
      { name: 'Warning', value: 'warning' },
      { name: 'Penalty', value: 'penalty' },
    ))
  .addStringOption(o => o.setName('opt6').setDescription('Option 6').setRequired(false)
    .addChoices(
      { name: 'Rematch', value: 'rematch' },
      { name: 'No Rematch', value: 'no_rematch' },
      { name: 'Invalid', value: 'invalid' },
      { name: 'Defwin', value: 'defwin' },
      { name: 'Warning', value: 'warning' },
      { name: 'Penalty', value: 'penalty' },
    ))
  .addBooleanOption(o => o.setName('here').setDescription('Tag @here (default: true)').setRequired(false))
  .addChannelOption(o => o.setName('channel').setDescription('Post in another channel (optional)').setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

const slashCommands = [cmdSetPlayers, cmdSetIssue, cmdMessage, cmdCountryPost, cmdClose, cmdDecision, cmdVote];

// ====== DECISION TEXT BUILDER ======
function teamRuleLines(rule) {
  switch (rule) {
    case 'same_teams_same_lead':
      return ['The same teams must be used, with the same lead Pokémon.'];
    case 'same_lead_flex_back':
      return ['The same lead Pokémon must be used, the back line may be changed.'];
    case 'new_teams':
      return ['New teams may be used.'];
    default:
      return [];
  }
}
function decisionHeader(meta, raiserId, issueForText) {
  const p1 = mention(meta.p1Id), p2 = mention(meta.p2Id);
  const raiser = mention(raiserId);
  const issue = issueForText || meta.issue || '(issue)';
  return [
    `${p1} ${p2}`,
    `After reviewing the match dispute set by ${raiser} regarding ${issue}. The Referees team has decided:`
  ];
}
function getRulesChannelMention() {
  return RULES_CHANNEL_ID ? `<#${RULES_CHANNEL_ID}>` : '📓rules-for-worlds';
}
function buildDecisionText(meta, opts, raiserId) {
  const p1 = mention(meta.p1Id), p2 = mention(meta.p2Id);
  const p1c = meta.playerCountry?.name || 'Player1 country';
  const p2c = meta.opponentCountry?.name || 'Player2 country';

  const header = decisionHeader(meta, raiserId, null);
  const lines = [];

  const favourCountry = (opts.favour === 'p1_country') ? p1c
                        : (opts.favour === 'p2_country') ? p2c
                        : '(country)';
  const deviceUser = (opts.device_player === 'p1') ? p1
                    : (opts.device_player === 'p2') ? p2
                    : '@player';
  const penaltyAgainst = (opts.penalty_against === 'p1_country') ? p1c
                        : (opts.penalty_against === 'p2_country') ? p2c
                        : '(country)';

  switch (opts.outcome) {
    // --- Lag ---
    case 'lag_rematch':
      lines.push('A **rematch will be granted**.');
      lines.push(...teamRuleLines(opts.team_rule));
      break;
    case 'lag_no_rematch':
      lines.push('A **rematch will NOT be granted**.');
      break;
    case 'lag_win_p1':
      lines.push(`The **win is awarded to ${p1}**. The remaining games are still to be played (if applicable).`);
      lines.push(`The score is 1-0 in favour of ${p1}. Please update the score when available.`);
      break;
    case 'lag_win_p2':
      lines.push(`The **win is awarded to ${p2}**. The remaining games are still to be played (if applicable).`);
      lines.push(`The score is 1-0 in favour of ${p2}. Please update the score when available.`);
      break;

    // --- Communication ---
    case 'comm_bad_1':
    case 'comm_bad':
      lines.push('**Did not communicate sufficiently.**');
      lines.push(`Subsequent to 6.1, a penalty point is issued in favour of **${favourCountry}**.`);
      lines.push(`The games must be scheduled within **${opts.schedule_window || '24 hours'}**. All games are to be played.`);
      break;

    case 'comm_bad_3':
      lines.push('**Did not communicate sufficiently (both opponents in the pair).**');
      lines.push(`Subsequent to 6.1, **3 penalty points** are issued in favour of **${favourCountry}**.`);
      lines.push(`The games must be scheduled within **${opts.schedule_window || '24 hours'}**. All games are to be played.`);
      break;

    case 'comm_invalid':
      lines.push('The dispute is **ruled invalid** under 6.1.');
      lines.push('Both players are to communicate and agree a new time to battle within the next 24 hours.');
      lines.push('If scheduling or communication issues persist please contact team captains first.');
      break;

    // --- Communication: Force Substitution (no penalties) ---
    case 'comm_force_sub': {
      const p1m = mention(meta.p1Id);
      const p2m = mention(meta.p2Id);
      const c1m = roleMention(meta.playerCountry?.id, meta.playerCountry?.name);
      const c2m = roleMention(meta.opponentCountry?.id, meta.opponentCountry?.name);
      const c1n = meta.playerCountry?.name || 'Country 1';
      const c2n = meta.opponentCountry?.name || 'Country 2';
      const rules = getRulesChannelMention();

      const body = [
        `${c1m} ${c2m}`,
        '',
        'After reviewing an evidence of the communication of the following players:',
        `${p1m} & ${p2m}`,
        '',
        'Staff team has decided that a substitution will be necessary in this case to conclude this particular matchup:',
        `❗${p1m} 0 - 0 ${p2m}`,
        '',
        'Please, both teams mention in your team channels, who will be the players replacing',
        `❗${c1n}: ${p1m}`,
        `❗${c2n}: ${p2m}`,
        '',
        'And make sure to tag @staff when making your decision! If both teams will decide to keep the same players, then we will be forcing both sides to either come to an agreement to play after all or both teams will have to choose other players from the roster.',
        'Decisions must be made within the next 24 hours.',
        `In terms of substitution rules, please visit ${rules}`,
        'No penalties will be applied.',
      ].join('\n');

      return body; // exact text, no standard header/footer
    }

    // --- Device Issue ---
    case 'dev_rematch':
      lines.push('A **rematch will be granted** due to a device issue.');
      lines.push(...teamRuleLines(opts.team_rule));
      lines.push(`A warning is issued to ${deviceUser}.`);
      break;
    case 'dev_no_rematch':
      lines.push('A **rematch will NOT be granted** (device issue).');
      lines.push(`A warning is issued to ${deviceUser}.`);
      break;
    case 'dev_win_p1':
      lines.push(`The **win is awarded to ${p1}** (device issue on opponent).`);
      lines.push(`A warning is issued to ${deviceUser}.`);
      break;
    case 'dev_win_p2':
      lines.push(`The **win is awarded to ${p2}** (device issue on opponent).`);
      lines.push(`A warning is issued to ${deviceUser}.`);
      break;

    // --- No Show (6.2.4 = 1pt, 6.2.5 = 3pt) ---
    case 'ns_p1_1':
      lines.push(`${p1} **failed to show in time**. Subsequent to 6.2.4 the penalty is **1 penalty point**.`);
      lines.push('The remaining games are to be played.');
      break;
    case 'ns_p2_1':
      lines.push(`${p2} **failed to show in time**. Subsequent to 6.2.4 the penalty is **1 penalty point**.`);
      lines.push('The remaining games are to be played.');
      break;
    case 'ns_p1_3':
      lines.push(`${p1} **failed to show in time**. Subsequent to 6.2.5 (last 24 hours) the penalty is **3 penalty points**.`);
      lines.push('The remaining games are to be played.');
      break;
    case 'ns_p2_3':
      lines.push(`${p2} **failed to show in time**. Subsequent to 6.2.5 (last 24 hours) the penalty is **3 penalty points**.`);
      lines.push('The remaining games are to be played.');
      break;

    // --- Wrong Pokémon or Moveset ---
    case 'wp_pokemon':
      lines.push(`An **unregistered Pokémon** was used (${opts.pokemon || '(Pokémon)'}).`);
      lines.push(`Subsequent to 2.5.1 the outcome is **1 Penalty Point** on the Global Score against **${penaltyAgainst}**.`);
      lines.push(`The matches where ${opts.pokemon || '(the Pokémon)'} was used must be replayed.`);
      lines.push(`${p1} and ${p2} must only use the **registered Pokémon** in those games and with the rest of their opponents.`);
      break;
    case 'wp_moveset':
      lines.push(`An **illegal moveset change** was used (${opts.old_move || '(old move)'} → ${opts.new_move || '(new move)'}; ${opts.pokemon || '(Pokémon)'}).`);
      lines.push(`Subsequent to 2.5.1 the outcome is **1 Penalty Point** on the Global Score against **${penaltyAgainst}**.`);
      lines.push(`The matches where ${opts.new_move || '(the new move)'} was used must be replayed.`);
      lines.push(`Only **${opts.old_move || '(the old move)'}** is allowed in those games and with the rest of the opponents.`);
      break;

    default:
      lines.push('Decision recorded.');
  }

  lines.push('');
  lines.push('We would like to remind all parties involved that referees and staff members from countries involved in disputes cannot be involved in the resolution of the dispute.');
  lines.push('');
  lines.push('Good luck in your remaining battles.');

  return [...header, '', ...lines].join('\n');
}

// ====== INTERACTIONS ======
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Handle the DM chooser selection
    if (interaction.isStringSelectMenu() && interaction.customId === 'choose_thread') {
      if (interaction.guildId) {
        await interaction.reply({ content: 'Please choose in DM.', ephemeral: true }).catch(() => {});
        return;
      }
      const uid = interaction.user.id;
      const threadId = interaction.values?.[0];
      if (!threadId) return;

      if (!userToThreads.get(uid)?.has(threadId)) {
        await interaction.reply({ content: 'That dispute is no longer active for you.', ephemeral: false }).catch(() => {});
        return;
      }

      const payload = pendingDm.get(uid);
      pendingDm.delete(uid);

      const refThread = await interaction.client.channels.fetch(threadId).catch(() => null);
      if (!refThread) {
        await interaction.update({ content: 'Could not reach that dispute thread anymore.', components: [] }).catch(() => {});
        return;
      }

      const text = (payload?.content ?? '').trim();
      const files = payload?.files || [];
      const content = `📥 **${interaction.user.username} (DM via chooser):** ${text || (files.length ? '(attachment)' : '(empty)')}`;

      if (files.length) {
        await refThread.send({ content, files }).catch(async () => {
          await refThread.send(content + `\n(Attachments present but could not be forwarded)`);
        });
      } else {
        await refThread.send(content);
      }

      await interaction.update({ content: 'Forwarded to the selected dispute thread. Thanks!', components: [] }).catch(() => {});
      return;
    }

    // Slash commands (must be inside a dispute thread)
    if (!interaction.isChatInputCommand()) return;

    const ch = interaction.channel;
    const isThread = ch && (ch.type === ChannelType.PrivateThread || ch.type === ChannelType.PublicThread);
    if (!isThread) {
      return interaction.reply({ ephemeral: true, content: 'Use this inside a **Dispute Thread**.' });
    }

    const meta = refMeta.get(ch.id) || {};

    if (interaction.commandName === 'set_players') {
      const p1 = interaction.options.getUser('player1', true);
      const p2 = interaction.options.getUser('player2', true);

      meta.p1Id = p1.id;
      meta.p2Id = p2.id;
      refMeta.set(ch.id, meta);

      // map both players → this thread for DM routing
      addUserToThreadMap(p1.id, ch.id);
      addUserToThreadMap(p2.id, ch.id);

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
          results.push(`✅ DM → <@${uid}>`);
        } catch {
          results.push(`❌ DM blocked → <@${uid}>`);
        }
      }

      await ch.send(`📤 **Bot DM:** ${text}\n${results.join(' • ')}`);
      return interaction.reply({ content: 'Sent.', ephemeral: true });
    }

    if (interaction.commandName === 'country_post') {
      let target = interaction.options.getChannel('channel', false);
      const text = interaction.options.getString('text', true);

      if (!target) {
        // Default to origin guild’s country channel
        const originId = meta.originGuildId;
        const originGuild = originId ? await interaction.client.guilds.fetch(originId).catch(() => null) : null;
        if (originGuild) {
          await originGuild.channels.fetch(); // hydrate cache
          target = await findDecisionChannel(
            originGuild,
            meta.playerCountry?.name,
            meta.opponentCountry?.name
          );
        }
      }
      if (!target || target.type !== ChannelType.GuildText) {
        return interaction.reply({ ephemeral: true, content: 'No suitable country channel found (origin). Provide one with the `channel` option.' });
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
        const origin = refThreadToOrigin.get(ch.id);
        if (origin) {
          const srcGuild = await interaction.client.guilds.fetch(origin.originGuildId).catch(() => null);
          const srcChan = srcGuild ? await srcGuild.channels.fetch(origin.channelId).catch(() => null) : null;
          if (srcChan?.type === ChannelType.GuildText || srcChan?.type === ChannelType.PublicThread) {
            const msg = await srcChan.messages.fetch(origin.messageId).catch(() => null);
            if (msg) await msg.delete().catch(() => {});
          }
        }

        // remove routing for players on this thread
        if (meta.p1Id) removeUserThread(meta.p1Id, ch.id);
        if (meta.p2Id) removeUserThread(meta.p2Id, ch.id);

        const raiserId = refThreadToPlayer.get(ch.id);
        if (raiserId) {
          try {
            const u = await interaction.client.users.fetch(raiserId);
            const review = DISPUTE_REVIEW_CHANNEL_ID ? ` <#${DISPUTE_REVIEW_CHANNEL_ID}>` : ' the Dispute Review channel.';
            await u.send(`Your dispute has been **Closed** by the referees. If you need to follow up, please message${review}`);
          } catch {}
        }

        await ch.setArchived(true).catch(() => {});
        await ch.setLocked(true).catch(() => {});
        return interaction.reply({ content: '✅ Dispute closed (archived & locked).', ephemeral: false });
      } catch (e) {
        console.error('close error', e);
        return interaction.reply({ ephemeral: true, content: 'Failed to close this thread.' });
      }
    }

    if (interaction.commandName === 'decision') {
      const outcome = interaction.options.getString('outcome', true);
      const team_rule = interaction.options.getString('team_rule', false) || null;
      const favour = interaction.options.getString('favour', false) || null;
      const schedule_window = interaction.options.getString('schedule_window', false) || null;
      const device_player = interaction.options.getString('device_player', false) || null;
      const pokemon = interaction.options.getString('pokemon', false) || null;
      const old_move = interaction.options.getString('old_move', false) || null;
      const new_move = interaction.options.getString('new_move', false) || null;
      const penalty_against = interaction.options.getString('penalty_against', false) || null;
      const overrideChan = interaction.options.getChannel('channel', false);

      const raiserId = refThreadToPlayer.get(ch.id);
      const text = buildDecisionText(meta, {
        outcome, team_rule, favour, schedule_window,
        device_player, pokemon, old_move, new_move, penalty_against
      }, raiserId);

      // target: override -> origin guild country chan -> thread
      let targetChannel = overrideChan;
      if (!targetChannel) {
        const originId = meta.originGuildId;
        const originGuild = originId ? await interaction.client.guilds.fetch(originId).catch(() => null) : null;
        if (originGuild) {
          await originGuild.channels.fetch(); // hydrate cache
          targetChannel = await findDecisionChannel(
            originGuild,
            meta.playerCountry?.name,
            meta.opponentCountry?.name
          );
        }
      }

      try {
        if (targetChannel && targetChannel.type === ChannelType.GuildText) {
          await targetChannel.send(text);
          await ch.send(`📣 Decision posted to <#${targetChannel.id}>.`);
        } else {
          await ch.send(text);
        }
        return interaction.reply({ content: 'Decision posted.', ephemeral: true });
      } catch (e) {
        console.error('decision post error', e);
        return interaction.reply({ ephemeral: true, content: 'Failed to post decision.' });
      }
    }

    if (interaction.commandName === 'vote') {
      const title = interaction.options.getString('title') || 'Vote time!';
      const here  = interaction.options.getBoolean('here');
      const override = interaction.options.getChannel('channel', false);

      const keys = ['opt1','opt2','opt3','opt4','opt5','opt6']
        .map((k, idx) => interaction.options.getString(k, idx < 2)) // first two required
        .filter(Boolean);

      const seen = new Set();
      const items = [];
      for (const k of keys) {
        const key = String(k).toLowerCase();
        if (!VOTE_CHOICES[key] || seen.has(key)) continue;
        seen.add(key);
        items.push(VOTE_CHOICES[key]);
      }

      if (items.length < 2) {
        return interaction.reply({ ephemeral: true, content: 'Pick at least two distinct options.' });
      }

      let target = override || interaction.channel;
      if (!target) return interaction.reply({ ephemeral: true, content: 'No valid channel to post in.' });

      const lines = items.map(it => `${it.emoji} : ${it.label}`);
      const content =
        `${here !== false ? '@here\n\n' : ''}` +
        `**${title}**\n\n` +
        lines.join('\n');

      try {
        const msg = await target.send({ content, allowedMentions: { parse: ['everyone'] } });
        for (const it of items) {
          await msg.react(it.emoji).catch(() => {});
        }
        return interaction.reply({ ephemeral: true, content: `Vote created with ${items.length} option(s).` });
      } catch (e) {
        console.error('vote error', e);
        return interaction.reply({ ephemeral: true, content: 'Failed to post vote (check Add Reactions & Mention Everyone permissions).' });
      }
    }
  } catch (e) {
    console.error('Interaction handler error:', e);
  }
});

// ====== Referee membership flow (destination guild) ======
async function addAllRefsToThread(thread, destGuild) {
  const all = await destGuild.members.fetch();
  const refs = all.filter(m => m.roles.cache.has(REF_ROLE_ID) || (JR_REF_ROLE_ID && m.roles.cache.has(JR_REF_ROLE_ID)));

  let added = 0;
  for (const member of refs.values()) {
    await thread.members.add(member.id).catch(() => {});
    added++;
  }
  await thread.send(`👥 Added ${added} referees to this dispute thread.`);
}
async function removeConflictedFromThread(thread, destGuild, countries /* array of names */) {
  const countryNames = (countries || []).filter(Boolean);
  const countryCodes = countryNames.map(bracketCode).filter(Boolean);

  await thread.members.fetch().catch(() => {});

  const kicked = [];
  for (const tm of thread.members.cache.values()) {
    const gm = await destGuild.members.fetch(tm.id).catch(() => null);
    if (!gm) continue;

    const hasConflict = gm.roles.cache.some(r => {
      if (countryNames.includes(r.name)) return true;
      const code = bracketCode(r.name);
      return code && countryCodes.includes(code);
    });

    if (hasConflict) {
      await thread.members.remove(gm.id).catch(() => {});
      kicked.push(gm.user?.username || gm.id);
    }
  }

  if (kicked.length) {
    await thread.send(`🚫 Auto-removed conflicted referees: ${kicked.join(', ')}.`);
  } else {
    await thread.send(`✅ No conflicted referees found.`);
  }
}

// ====== READY (register commands & log guilds) ======
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(token);

  const guilds = await client.guilds.fetch();
  console.log(
    '🧭 In guilds:',
    guilds.size
      ? [...guilds.values()].map(g => `${g.name} (${g.id})`).join(', ')
      : 'none'
  );

  for (const [id, g] of guilds) {
    try {
      await rest.put(
        Routes.applicationGuildCommands(client.user.id, id),
        { body: slashCommands }
      );
      console.log(`✅ Commands registered in: ${g?.name || id}`);
    } catch (e) {
      const raw = e?.rawError || e;
      console.error(
        `❌ Failed to register in guild ${id} (${g?.name || 'unknown'}):`,
        e?.code || e?.status || e?.message || e
      );
      if (raw?.errors) console.error('   ↳ Details:', JSON.stringify(raw.errors, null, 2));
    }
  }
});

// Auto-register when invited to a new server
client.on(Events.GuildCreate, async (g) => {
  console.log(`➕ Joined guild: ${g.name} (${g.id}) — registering commands`);
  const rest = new REST({ version: '10' }).setToken(token);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, g.id),
      { body: slashCommands }
    );
    console.log(`✅ Commands registered in new guild: ${g.name} (${g.id})`);
  } catch (e) {
    const raw = e?.rawError || e;
    console.error(
      `❌ Failed to register in new guild ${g.id} (${g?.name}):`,
      e?.code || e?.status || e?.message || e
    );
    if (raw?.errors) console.error('   ↳ Details:', JSON.stringify(raw.errors, null, 2));
  }
});

client.on(Events.GuildDelete, g => console.log(`➖ Removed from: ${g.name} (${g.id})`));

// ====== BOOT ======
client.login(token);
