// bot.js — Discord Disputes Bot (ESM, Node 18+)

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  ChannelType,
  ThreadAutoArchiveDuration,
  SlashCommandBuilder,
  Routes,
  REST,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags
} from 'discord.js';


// ====== TOKEN ONLY FROM ENV ======
const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token || !token.includes('.')) {
  console.error('❌ DISCORD_TOKEN missing/invalid.');
  process.exit(1);
}

/**
 * HARD-CODED SERVER/CHANNEL/ROLE/USER IDS
 *
 * Gymbreakers Server ID:              416850757245992961
 * Gymbreakers Referee Role ID:        731919384179638285
 * Gymbreakers Junior Referee Role ID: 975306021058777149
 * Gymbreakers Dispute Request ID:     743575738665533541
 * Gymbreakers Referee Decision ID:    731919732441350215  (used as the REF HUB for threads)
 *
 * Pogo Raiders Server ID:             736744916012630046
 * Pogo Raiders Referee Role ID:       797983986152243200
 * Pogo Raiders Dispute Request ID:    1420609143894442054
 *
 * Bot user ID (for @mention trigger): 1417212106461286410
 */

// ----- Destination (Gymbreakers) for ALL dispute threads -----
const DEST_GUILD_ID           = '416850757245992961';
const DEST_REF_HUB_CHANNEL_ID = '731919732441350215'; // Gymbreakers Referee Decision = thread hub

// ----- Destination referee roles (Gymbreakers only) -----
const REF_ROLE_ID    = '731919384179638285'; // Gymbreakers Referee
const JR_REF_ROLE_ID = '975306021058777149'; // Gymbreakers Junior Referee

// Only re-add this role on /retag_refs
const RETAG_ROLE_ID  = '963394397687414804';

// ----- Origins (where we LISTEN for disputes) -----
const GYM_GUILD_ID               = '416850757245992961';
const GYM_DISPUTE_CHANNEL_ID     = '743575738665533541';
const GYM_TRIGGER_ROLE_ID        = '731919384179638285'; // Referee role as trigger

const RAID_GUILD_ID              = '736744916012630046';
const RAID_DISPUTE_CHANNEL_ID    = '1420609143894442054';
const RAID_TRIGGER_ROLE_ID       = '797983986152243200'; // Referee role as trigger

// ----- Bot mention trigger -----
const BOT_USER_ID = '1417212106461286410';

// Optional: destination review channel & rules reference (leave empty if not used)
const DISPUTE_REVIEW_CHANNEL_ID  = ''; // lives in destination (Gymbreakers), optional
const RULES_CHANNEL_ID           = ''; // optional global fallback for rules mention

// Per-origin config map
const ORIGINS = {
  [GYM_GUILD_ID]: {
    key: 'GYM',
    disputeChannelId: GYM_DISPUTE_CHANNEL_ID,
    triggerRoleId: GYM_TRIGGER_ROLE_ID,
    rulesChannelId: null
  },
  [RAID_GUILD_ID]: {
    key: 'RAID',
    disputeChannelId: RAID_DISPUTE_CHANNEL_ID,
    triggerRoleId: RAID_TRIGGER_ROLE_ID,
    rulesChannelId: null
  }
};

// ====== STATE ======
// When a request is itself a thread: map origin thread -> ref thread (in Gymbreakers)
const disputeToRefThread = new Map(); // originThreadId -> destRefThreadId

// Multi-dispute support:
// Track all open ref threads per player (Disputer or Opponent)
const openThreadsByPlayer = new Map(); // userId -> Set<refThreadId>

// For DM mirroring: the currently selected ref thread per player
const dmRouteChoice = new Map(); // userId -> refThreadId

// Who raised the dispute originally (for headers/DMs)
const refThreadToPlayer = new Map(); // refThreadId -> raiser userId

// For closing cleanup (delete the original trigger message)
const refThreadToOrigin = new Map();  // refThreadId -> { originGuildId, channelId, messageId }

// Meta for titles & decisions (persisted in memory until /close)
const refMeta = new Map(); // refThreadId -> {p1Id,p2Id,issue, playerCountry, opponentCountry, originGuildId, ...opts }

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
const mention = id => id ? `<@${id}>` : '@User';
const bracketCode = (name) => (name?.match(/\[([^\]]+)\]/)?.[1] || '').toLowerCase();

function messageMentionsRole(message, roleId) {
  return message.mentions.roles.has(roleId) || message.content.includes(`<@&${roleId}>`);
}
function messageMentionsBot(message) {
  return message.mentions.users.has(BOT_USER_ID) || message.content.includes(`<@${BOT_USER_ID}>`);
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
    name: `Dispute - ${playerName}`,
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
    '— **Referee quick start** —',
    '• Use `/set issue` to set the issue (Lag, Communication, Device Issue, No Show, Wrong Pokemon or Moveset).',
    '• Use `/set players` to set Disputer & Opponent — the thread title will update automatically.',
    '• Use `/remove_conflicts` any time to purge conflicted referees.',
    '• Use `/retag_refs` to ping the specified role again.'
  ].join('\n');
}

async function renameThreadByMeta(thread) {
  const meta = refMeta.get(thread.id) || {};
  const names = [];

  async function nameFor(id, fallback) {
    if (!id) return fallback;
    const m = await thread.guild.members.fetch(id).catch(() => null);
    if (m?.user?.username) return m.user.username;
    const u = await thread.client.users.fetch(id).catch(() => null);
    return u?.username || fallback;
  }

  if (meta.p1Id) names.push(await nameFor(meta.p1Id, 'Disputer'));
  if (meta.p2Id) names.push(await nameFor(meta.p2Id, 'Opponent'));

  if (meta.issue && names.length === 2) {
    const title = `${meta.issue} - ${names[0]} vs ${names[1]}`;
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
    `Please send all evidence and messages **in this DM**. We will mirror everything privately for the referees.`,
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

// ====== Referee membership flow (destination guild) ======
async function addAllRefsToThread(thread, destGuild) {
  const meta = refMeta.get(thread.id) || {};
  const excluded = new Set([meta.p1Id, meta.p2Id].filter(Boolean));

  const all = await destGuild.members.fetch();
  const refs = all.filter(m =>
    (m.roles.cache.has(REF_ROLE_ID) || (JR_REF_ROLE_ID && m.roles.cache.has(JR_REF_ROLE_ID))) &&
    !excluded.has(m.id)
  );

  let added = 0;
  for (const member of refs.values()) {
    await thread.members.add(member.id).catch(() => {});
    added++;
  }
  await thread.send(`👥 Added ${added} referees to this dispute thread.`);
}

// Add ONLY members who have a specific role to the thread (exclude disputer/opponent)
async function addRoleMembersToThread(thread, destGuild, roleId) {
  const meta = refMeta.get(thread.id) || {};
  const excluded = new Set([meta.p1Id, meta.p2Id].filter(Boolean));

  const all = await destGuild.members.fetch();
  const targets = all.filter(m => m.roles.cache.has(roleId) && !excluded.has(m.id));

  let added = 0;
  await thread.members.fetch().catch(() => {});
  for (const member of targets.values()) {
    if (!thread.members.cache.has(member.id)) {
      await thread.members.add(member.id).catch(() => {});
      added++;
    }
  }
  if (added > 0) {
    await thread.send(`👥 Added ${added} member(s) with role <@&${roleId}> to this dispute thread.`);
  } else {
    await thread.send(`ℹ️ No additional members with role <@&${roleId}> were added.`);
  }
}

// Remove conflicted refs already in the thread (match by exact role name or bracket code like [GB])
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
    await thread.send(`🚫 Auto removed conflicted referees: ${kicked.join(', ')}.`);
  } else {
    await thread.send(`✅ No conflicted referees found.`);
  }
}

// Ensure Disputer/Opponent are not in the private ref thread
async function purgePlayersFromThread(thread, destGuild) {
  const meta = refMeta.get(thread.id) || {};
  const ids = [meta.p1Id, meta.p2Id].filter(Boolean);
  if (!ids.length) return;

  await thread.members.fetch().catch(() => {});
  for (const id of ids) {
    if (thread.members.cache.has(id)) {
      await thread.members.remove(id).catch(() => {});
    }
  }
}

// ====== Open-thread bookkeeping for multi-dispute DM routing ======
function addOpenThreadFor(userId, refThreadId) {
  if (!userId || !refThreadId) return;
  const set = openThreadsByPlayer.get(userId) ?? new Set();
  set.add(refThreadId);
  openThreadsByPlayer.set(userId, set);
  if (!dmRouteChoice.has(userId) && set.size === 1) {
    dmRouteChoice.set(userId, refThreadId);
  }
}
function removeOpenThreadFor(userId, refThreadId) {
  const set = openThreadsByPlayer.get(userId);
  if (!set) return;
  set.delete(refThreadId);
  if (set.size === 0) {
    openThreadsByPlayer.delete(userId);
  }
  if (dmRouteChoice.get(userId) === refThreadId) {
    dmRouteChoice.delete(userId);
  }
}

function buildDmRouteSelect(userId) {
  const set = openThreadsByPlayer.get(userId);
  if (!set || set.size === 0) return null;

  const options = [];
  for (const refThreadId of set) {
    const meta = refMeta.get(refThreadId) || {};
    const issue = meta.issue || 'Dispute';
    const labelP1 = meta.p1Id ? `Disputer` : 'Disputer?';
    const labelP2 = meta.p2Id ? `Opponent` : 'Opponent?';
    const value = refThreadId;

    options.push({
      label: `${issue} - ${labelP1} vs ${labelP2}`,
      value
    });
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId('dm-route-select')
    .setPlaceholder('Select which dispute this DM relates to')
    .addOptions(options.slice(0, 25)); // Discord max 25

  return new ActionRowBuilder().addComponents(menu);
}

async function promptDmRouteSelect(user) {
  try {
    const row = buildDmRouteSelect(user.id);
    if (!row) {
      await user.send('I do not see any active disputes for you. To raise one, tag @Referee in the appropriate Dispute Request channel.');
      return false;
    }
    await user.send({
      content: 'You have multiple active disputes. Which one is this message about?',
      components: [row]
    });
    return true;
  } catch {
    return false;
  }
}

function getRoutableThreadIdForUser(userId) {
  const set = openThreadsByPlayer.get(userId);
  if (!set || set.size === 0) return null;
  const chosen = dmRouteChoice.get(userId);
  if (chosen && set.has(chosen)) return chosen;
  if (set.size === 1) return [...set][0];
  return null;
}

function metaPreview(meta) {
  return [
    `• Disputer: ${meta.p1Id ? `<@${meta.p1Id}>` : '—'} (${meta.playerCountry?.name ?? '—'})`,
    `• Opponent: ${meta.p2Id ? `<@${meta.p2Id}>` : '—'} (${meta.opponentCountry?.name ?? '—'})`,
    `• Issue: ${meta.issue ?? '—'}`,
    `• Favour: ${meta.favour ?? '—'} | PenaltyAgainst: ${meta.penalty_against ?? '—'}`,
    `• DevicePlayer: ${meta.device_player ?? '—'} | TeamRule: ${meta.team_rule ?? '—'}`,
    `• Window: ${meta.schedule_window ?? '—'}`,
    `• Pokémon: ${meta.pokemon ?? '—'} | Move: ${meta.old_move ?? '—'} → ${meta.new_move ?? '—'}`,
  ].join('\n');
}

// ====== MESSAGE HANDLERS ======

// Trigger: @Referee OR @Bot in either origin server's dispute channel -> create thread in Gymbreakers
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author?.bot) return;

    const originCfg = ORIGINS[message.guild.id];
    if (!originCfg) return; // ignore other servers
    
    const inOriginDisputeChan =
      message.channel.id === originCfg.disputeChannelId ||
      message.channel?.parentId === originCfg.disputeChannelId;

    const mentioned = messageMentionsRole(message, originCfg.triggerRoleId) || messageMentionsBot(message);
    if (!inOriginDisputeChan || !mentioned) return;

   if (message.reactions.cache.has('✅')) return;
await message.react('✅').catch(() => {});

    // Countries — detect from ORIGIN guild roles/mentions
    const member = await message.guild.members.fetch(message.author.id);
    const playerCountry = getMemberCountry(member);
    const opponentCountry = getOpponentCountryFromMessage(message, playerCountry.name);

    // Require opponent country
    if (!opponentCountry.name) {
      await message.reply({
        content: 'I could not detect an **opponent country**. Please re-raise the issue and tag the opponent country role (name includes [XX]).',
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

  // 🧵 Thread successfully created
  await message.react('🧵').catch(() => {});
}

    // Seed meta, mappings (store ORIGIN guild id for later ops)
    refMeta.set(refThread.id, {
      p1Id: message.author.id,  // Disputer
      p2Id: null,               // Opponent
      issue: null,
      playerCountry,
      opponentCountry,
      originGuildId: message.guild.id
    });

    // track open threads for Disputer (author)
    addOpenThreadFor(message.author.id, refThread.id);

    refThreadToPlayer.set(refThread.id, message.author.id);
    refThreadToOrigin.set(refThread.id, {
      originGuildId: message.guild.id,
      channelId: message.channel.id,
      messageId: message.id
    });

    // Intro post in DEST thread
    const playerName = message.author.globalName || message.author.username;
    await refThread.send(buildIntro({
      playerName,
      playerCountry,
      opponentCountry,
      originGuildName: message.guild?.name
    }));

    // Add refs / remove conflicts / purge players in DEST guild
    await addAllRefsToThread(refThread, destGuild);
    await removeConflictedFromThread(
      refThread,
      destGuild,
      [playerCountry?.name, opponentCountry?.name].filter(Boolean)
    );
    await purgePlayersFromThread(refThread, destGuild);

    // DM the player with questions (origin still OK)
    await dmDisputeRaiser(message, disputeThread);

  } catch (err) {
    console.error('Dispute trigger handler error:', err);
  }
});

// Mirror player DMs -> selected ref thread (or ask to select if multiple)
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.guild) return;
    if (message.author?.bot) return;
    if (message.channel?.type !== ChannelType.DM) return;

    const uid = message.author.id;

    // Determine routing
    let refThreadId = getRoutableThreadIdForUser(uid);
    if (!refThreadId) {
      const ok = await promptDmRouteSelect(message.author);
      if (!ok) {
        try { await message.reply('I could not determine a dispute to forward this to.'); } catch {}
      }
      return;
    }

    const refThread = await client.channels.fetch(refThreadId).catch(() => null);
    if (!refThread) {
      // Clean up dead mapping and re-prompt if other threads exist
      removeOpenThreadFor(uid, refThreadId);
      const nextId = getRoutableThreadIdForUser(uid);
      if (!nextId) {
        const ok = await promptDmRouteSelect(message.author);
        if (!ok) try { await message.reply('I could not find an active dispute to forward this to.'); } catch {}
        return;
      }
    }

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

// Handle DM route selection
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== 'dm-route-select') return;

    const uid = interaction.user.id;
    const choice = interaction.values?.[0];
    if (!choice) return interaction.reply({ content: 'No selection received.', flags: MessageFlags.Ephemeral });

    // Validate selection belongs to the user
    const set = openThreadsByPlayer.get(uid);
    if (!set || !set.has(choice)) {
      return interaction.reply({ content: 'That dispute is no longer available.', flags: MessageFlags.Ephemeral });
    }

    dmRouteChoice.set(uid, choice);
    return interaction.reply({ content: 'Got it. I will forward your DMs to that dispute thread.', flags: MessageFlags.Ephemeral });
  } catch (e) {
    console.error('dm-route-select error', e);
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
  .setDescription('Set Disputer and Opponent for this dispute thread.')
  .addUserOption(o => o.setName('player1').setDescription('Disputer').setRequired(true))
  .addUserOption(o => o.setName('player2').setDescription('Opponent').setRequired(true))
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

// Unified /set with subcommands
const cmdSet = new SlashCommandBuilder()
  .setName('set')
  .setDescription('Set dispute data for this thread')
  .addSubcommand(sc =>
    sc.setName('players')
      .setDescription('Set Disputer and Opponent')
      .addUserOption(o => o.setName('disputer').setDescription('Disputer').setRequired(true))
      .addUserOption(o => o.setName('opponent').setDescription('Opponent').setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName('issue')
      .setDescription('Set issue')
      .addStringOption(o => o.setName('value').setDescription('Issue').setRequired(true).addChoices(...ISSUE_CHOICES))
  )
  .addSubcommand(sc =>
    sc.setName('countries')
      .setDescription('Set country names for Disputer and Opponent')
      .addStringOption(o => o.setName('disputer').setDescription('Disputer country').setRequired(true))
      .addStringOption(o => o.setName('opponent').setDescription('Opponent country').setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName('favour')
      .setDescription('Set who gains points on comms rulings')
      .addStringOption(o => o.setName('value').setDescription('Country to favour').setRequired(true).addChoices(
        { name: 'Disputer country', value: 'p1_country' },
        { name: 'Opponent country', value: 'p2_country' },
      ))
  )
  .addSubcommand(sc =>
    sc.setName('penalty_against')
      .setDescription('Set which country gets the penalty (Wrong Pokemon/Moveset)')
      .addStringOption(o => o.setName('value').setDescription('Penalised country').setRequired(true).addChoices(
        { name: 'Disputer country', value: 'p1_country' },
        { name: 'Opponent country', value: 'p2_country' },
      ))
  )
  .addSubcommand(sc =>
    sc.setName('device_player')
      .setDescription('Set which player had the device issue')
      .addStringOption(o => o.setName('value').setDescription('Who').setRequired(true).addChoices(
        { name: 'Disputer', value: 'p1' },
        { name: 'Opponent', value: 'p2' },
      ))
  )
  .addSubcommand(sc =>
    sc.setName('team_rule')
      .setDescription('Set team rule for rematch templates')
      .addStringOption(o => o.setName('value').setDescription('Rule').setRequired(true).addChoices(
        { name: 'Same teams and same lead', value: 'same_teams_same_lead' },
        { name: 'Same lead, backline may change', value: 'same_lead_flex_back' },
        { name: 'New teams allowed', value: 'new_teams' },
      ))
  )
  .addSubcommand(sc =>
    sc.setName('schedule_window')
      .setDescription('Set schedule window text (for comms rulings)')
      .addStringOption(o => o.setName('value').setDescription('e.g., 24 hours').setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName('pokemon')
      .setDescription('Set Pokémon name for Wrong Pokémon/Moveset')
      .addStringOption(o => o.setName('name').setDescription('Pokémon').setRequired(true))
  )
  .addSubcommand(sc =>
    sc.setName('moveset')
      .setDescription('Set moveset change details')
      .addStringOption(o => o.setName('pokemon').setDescription('Pokémon').setRequired(true))
      .addStringOption(o => o.setName('old').setDescription('Old move').setRequired(true))
      .addStringOption(o => o.setName('new').setDescription('New move used').setRequired(true))
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

const cmdMessage = new SlashCommandBuilder()
  .setName('message')
  .setDescription('DM disputer/opponent/both; echo in thread.')
  .addStringOption(o =>
    o.setName('target')
      .setDescription('Target')
      .setRequired(true)
      .addChoices(
        { name: 'disputer', value: 'p1' },
        { name: 'opponent', value: 'p2' },
        { name: 'both',    value: 'both' },
      ))
  .addStringOption(o =>
    o.setName('text').setDescription('Message text').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

// ✅ country_post now requires a channel (no auto-find)
const cmdCountryPost = new SlashCommandBuilder()
  .setName('country_post')
  .setDescription('Post a message to a specified channel.')
  .addChannelOption(o =>
    o.setName('channel')
      .setDescription('Where to post it')
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildText)
  )
  .addStringOption(o => o.setName('text').setDescription('Message').setRequired(true))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

const cmdClose = new SlashCommandBuilder()
  .setName('close')
  .setDescription('Close: archive and lock, stop DMs, delete trigger, DM disputer.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

// Re-run conflict removal on demand
const cmdRemoveConflicts = new SlashCommandBuilder()
  .setName('remove_conflicts')
  .setDescription('Remove all conflicted referees from this thread.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

// Retag (only add members with RETAG_ROLE_ID)
const cmdRetagRefs = new SlashCommandBuilder()
  .setName('retag_refs')
  .setDescription('Re-add and ping the specified role in this thread.')
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
       { name: 'Lag - Rematch', value: 'lag_rematch' },
       { name: 'Lag - No Rematch', value: 'lag_no_rematch' },
       { name: 'Lag - Win → Disputer', value: 'lag_win_p1' },
       { name: 'Lag - Win → Opponent', value: 'lag_win_p2' },
       // Communication
       { name: 'Communication - Missed to one opponent (6.1 - 1pt)', value: 'comm_bad_1' },
       { name: 'Communication - Missed to both opponents (6.1 - 3pt)', value: 'comm_bad_3' },
       { name: 'Communication - Dispute invalid', value: 'comm_invalid' },
       // Device
       { name: 'Device - Rematch', value: 'dev_rematch' },
       { name: 'Device - No Rematch', value: 'dev_no_rematch' },
       { name: 'Device - Win → Disputer', value: 'dev_win_p1' },
       { name: 'Device - Win → Opponent', value: 'dev_win_p2' },
       // No Show
       { name: 'No Show - Disputer failed (6.2.4 - 1pt)', value: 'ns_p1_1' },
       { name: 'No Show - Opponent failed (6.2.4 - 1pt)', value: 'ns_p2_1' },
       { name: 'No Show - Disputer failed (6.2.5 - 3pt)', value: 'ns_p1_3' },
       { name: 'No Show - Opponent failed (6.2.5 - 3pt)', value: 'ns_p2_3' },
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
       { name: 'Same teams and same lead', value: 'same_teams_same_lead' },
       { name: 'Same lead, backline may change', value: 'same_lead_flex_back' },
       { name: 'New teams allowed', value: 'new_teams' },
     ))
  .addStringOption(o =>
    o.setName('favour')
     .setDescription('Communication: award country')
     .setRequired(false)
     .addChoices(
       { name: 'Disputer country', value: 'p1_country' },
       { name: 'Opponent country', value: 'p2_country' },
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
       { name: 'Disputer', value: 'p1' },
       { name: 'Opponent', value: 'p2' },
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
       { name: 'Disputer country', value: 'p1_country' },
       { name: 'Opponent country', value: 'p2_country' },
     ))
  .addChannelOption(o =>
    o.setName('channel')
     .setDescription('Post target (optional)')
     .setRequired(false))
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .toJSON();

// ---- /vote ----
const cmdVote = new SlashCommandBuilder()
  .setName('vote')
  .setDescription('Create a vote and add reaction options.')
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
  .addStringOption(o => o.setName('title').setDescription('Heading (default: Vote time)').setRequired(false))
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

const slashCommands = [
  cmdSetPlayers, cmdSetIssue, cmdSet, cmdMessage,
  cmdCountryPost, cmdClose, cmdRemoveConflicts, cmdRetagRefs,
  cmdDecision, cmdVote
];

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
  const disputer = mention(meta.p1Id), opponent = mention(meta.p2Id);
  const raiser = mention(raiserId);
  const issue = issueForText || meta.issue || '(issue)';
  return [
    `${disputer} ${opponent}`,
    `After reviewing the match dispute set by ${raiser} regarding ${issue}. The Referees team has decided:`
  ];
}

function getRulesChannelMention() {
  return RULES_CHANNEL_ID ? `<#${RULES_CHANNEL_ID}>` : '📓rules-for-worlds';
}

function buildDecisionText(meta, opts, raiserId) {
  const disputer = mention(meta.p1Id), opponent = mention(meta.p2Id);
  const p1c = meta.playerCountry?.name || 'Disputer country';
  const p2c = meta.opponentCountry?.name || 'Opponent country';

  const header = decisionHeader(meta, raiserId, null);
  const lines = [];

  const favourCountry = (opts.favour === 'p1_country') ? p1c
                        : (opts.favour === 'p2_country') ? p2c
                        : '(country)';
  const deviceUser = (opts.device_player === 'p1') ? disputer
                    : (opts.device_player === 'p2') ? opponent
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
      lines.push(`The **win is awarded to ${disputer}**. The remaining games are still to be played (if applicable).`);
      lines.push(`The score is 1-0 in favour of the Disputer. Please update the score when available.`);
      break;
    case 'lag_win_p2':
      lines.push(`The **win is awarded to ${opponent}**. The remaining games are still to be played (if applicable).`);
      lines.push(`The score is 1-0 in favour of the Opponent. Please update the score when available.`);
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
      lines.push(`The **win is awarded to ${disputer}** (device issue on opponent).`);
      lines.push(`A warning is issued to ${deviceUser}.`);
      break;
    case 'dev_win_p2':
      lines.push(`The **win is awarded to ${opponent}** (device issue on opponent).`);
      lines.push(`A warning is issued to ${deviceUser}.`);
      break;

    // --- No Show ---
    case 'ns_p1_1':
      lines.push(`${disputer} **failed to show in time**. Subsequent to 6.2.4 the penalty is **1 penalty point**.`);
      lines.push('The remaining games are to be played.');
      break;
    case 'ns_p2_1':
      lines.push(`${opponent} **failed to show in time**. Subsequent to 6.2.4 the penalty is **1 penalty point**.`);
      lines.push('The remaining games are to be played.');
      break;
    case 'ns_p1_3':
      lines.push(`${disputer} **failed to show in time**. Subsequent to 6.2.5 (last 24 hours) the penalty is **3 penalty points**.`);
      lines.push('The remaining games are to be played.');
      break;
    case 'ns_p2_3':
      lines.push(`${opponent} **failed to show in time**. Subsequent to 6.2.5 (last 24 hours) the penalty is **3 penalty points**.`);
      lines.push('The remaining games are to be played.');
      break;

    // --- Wrong Pokémon or Moveset ---
    case 'wp_pokemon':
      lines.push(`An **unregistered Pokémon** was used (${opts.pokemon || '(Pokémon)'}).`);
      lines.push(`Subsequent to 2.5.1 the outcome is **1 Penalty Point** on the Global Score against **${penaltyAgainst}**.`);
      lines.push(`The matches where ${opts.pokemon || '(the Pokémon)'} was used must be replayed.`);
      lines.push(`${disputer} and ${opponent} must only use the **registered Pokémon** in those games and with the rest of their opponents.`);
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

// ====== INTERACTIONS (slash commands) ======
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const ch = interaction.channel;
  const isThread = ch && (ch.type === ChannelType.PrivateThread || ch.type === ChannelType.PublicThread);
  if (!isThread) return interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Use this inside a **Dispute Thread**.' });

  const meta = refMeta.get(ch.id) || {};

  if (interaction.commandName === 'set_players') {
    const p1 = interaction.options.getUser('player1', true);
    const p2 = interaction.options.getUser('player2', true);

    meta.p1Id = p1.id; // Disputer
    meta.p2Id = p2.id; // Opponent
    refMeta.set(ch.id, meta);

    // Track open threads for DM routing (both users)
    addOpenThreadFor(p1.id, ch.id);
    addOpenThreadFor(p2.id, ch.id);

    await renameThreadByMeta(ch);
    await purgePlayersFromThread(ch, ch.guild);

    return interaction.reply({
  content: `Set: **Disputer:** <@${p1.id}>  •  **Opponent:** <@${p2.id}>`,
    });
  }

  if (interaction.commandName === 'set_issue') {
    const issue = interaction.options.getString('issue', true);
    meta.issue = issue;
    refMeta.set(ch.id, meta);

    await renameThreadByMeta(ch);
    return interaction.reply({ content: `Issue set to **${issue}**.` });
  }

  if (interaction.commandName === 'set') {
    const sub = interaction.options.getSubcommand();
    try {
      switch (sub) {
        case 'players': {
          const p1 = interaction.options.getUser('disputer', true).id;
          const p2 = interaction.options.getUser('opponent', true).id;
          meta.p1Id = p1; meta.p2Id = p2;
          refMeta.set(ch.id, meta);
          addOpenThreadFor(p1, ch.id);
          addOpenThreadFor(p2, ch.id);
          await renameThreadByMeta(ch);
          await purgePlayersFromThread(ch, ch.guild);
          break;
        }
        case 'issue': {
          const issue = interaction.options.getString('value', true);
          meta.issue = issue;
          refMeta.set(ch.id, meta);
          await renameThreadByMeta(ch);
          break;
        }
        case 'countries': {
          meta.playerCountry   = { name: interaction.options.getString('disputer', true) };
          meta.opponentCountry = { name: interaction.options.getString('opponent', true) };
          refMeta.set(ch.id, meta);
          break;
        }
        case 'favour':
          meta.favour = interaction.options.getString('value', true); refMeta.set(ch.id, meta); break;
        case 'penalty_against':
          meta.penalty_against = interaction.options.getString('value', true); refMeta.set(ch.id, meta); break;
        case 'device_player':
          meta.device_player = interaction.options.getString('value', true); refMeta.set(ch.id, meta); break;
        case 'team_rule':
          meta.team_rule = interaction.options.getString('value', true); refMeta.set(ch.id, meta); break;
        case 'schedule_window':
          meta.schedule_window = interaction.options.getString('value', true); refMeta.set(ch.id, meta); break;
        case 'pokemon':
          meta.pokemon = interaction.options.getString('name', true); refMeta.set(ch.id, meta); break;
        case 'moveset':
          meta.pokemon  = interaction.options.getString('pokemon', true);
          meta.old_move = interaction.options.getString('old', true);
          meta.new_move = interaction.options.getString('new', true);
          refMeta.set(ch.id, meta);
          break;
        default:
          return interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Unknown /set subcommand.' });
      }
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: `✅ Saved.\n\n**Current meta**\n${metaPreview(meta)}` });
    } catch (e) {
      console.error('/set error', e);
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Failed to set value(s).' });
    }
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
    if (!ids.length) return interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Disputer or Opponent not set yet. Use `/set players` first.' });

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
    return interaction.reply({ content: 'Sent.', flags: MessageFlags.Ephemeral });
  }

  // ✅ country_post: mandatory channel, no auto find, defer to avoid 10062
  if (interaction.commandName === 'country_post') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const target = interaction.options.getChannel('channel', true);
    const text = interaction.options.getString('text', true);

    if (!target || target.type !== ChannelType.GuildText) {
      return interaction.editReply('❌ Please choose a valid text channel.');
    }

    try {
      await target.send(text);
      return interaction.editReply(`✅ Posted to <#${target.id}>.`);
    } catch (e) {
      console.error('country_post error', e);
      return interaction.editReply('❌ Failed to post to the channel. Check my permissions.');
    }
  }

  if (interaction.commandName === 'remove_conflicts') {
    try {
      const destGuild = interaction.guild;
      await removeConflictedFromThread(
        ch,
        destGuild,
        [meta.playerCountry?.name, meta.opponentCountry?.name].filter(Boolean)
      );
      return interaction.reply({ content: 'Conflict removal completed.', flags: MessageFlags.Ephemeral });
    } catch (e) {
      console.error('remove_conflicts error', e);
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Failed to remove conflicts.' });
    }
  }

  if (interaction.commandName === 'retag_refs') {
    try {
      const destGuild = interaction.guild;

      // Re-run conflict removal first (safe & idempotent)
      await removeConflictedFromThread(
        ch,
        destGuild,
        [meta.playerCountry?.name, meta.opponentCountry?.name].filter(Boolean)
      );

      // Add ONLY the specified role holders
      await addRoleMembersToThread(ch, destGuild, RETAG_ROLE_ID);

      // Ping that role (not global ref roles)
      await ch.send(`<@&${RETAG_ROLE_ID}>\nPlease review this dispute. If you were removed as conflicted, do not rejoin.`);

      return interaction.reply({ content: 'Retagged the specified role.', flags: MessageFlags.Ephemeral });
    } catch (e) {
      console.error('retag_refs error', e);
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Failed to retag that role.' });
    }
  }

  // ✅ close: defer first, reply before archive/lock, and fixed brace structure
  if (interaction.commandName === 'close') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      // Remove this thread from open lists of both participants
      if (meta.p1Id) removeOpenThreadFor(meta.p1Id, ch.id);
      if (meta.p2Id) removeOpenThreadFor(meta.p2Id, ch.id);

      // Delete the original trigger message if possible
      const origin = refThreadToOrigin.get(ch.id);
      if (origin) {
        const srcGuild = await interaction.client.guilds.fetch(origin.originGuildId).catch(() => null);
        const srcChan = srcGuild ? await srcGuild.channels.fetch(origin.channelId).catch(() => null) : null;

        if (srcChan && 'messages' in srcChan) {
          const msg = await srcChan.messages.fetch(origin.messageId).catch(() => null);
          if (msg) await msg.delete().catch(() => {});
        }
      }

      // DM disputer
      const raiserId = refThreadToPlayer.get(ch.id);
      if (raiserId) {
        try {
          const u = await interaction.client.users.fetch(raiserId);
          const review = DISPUTE_REVIEW_CHANNEL_ID ? ` <#${DISPUTE_REVIEW_CHANNEL_ID}>` : ' the Dispute Review channel.';
          await u.send(`Your dispute has been **Closed** by the referees. If you need to follow up, please message${review}`);
        } catch {}
      }

      // Reply while thread is still active (prevents 50083)
      await interaction.editReply('✅ Dispute closed (archived & locked).');

      // Then lock + archive
      await ch.setLocked(true).catch(() => {});
      await ch.setArchived(true).catch(() => {});

      // Clean in-memory state AFTER closing
      refMeta.delete(ch.id);
      refThreadToPlayer.delete(ch.id);
      refThreadToOrigin.delete(ch.id);

      return;
    } catch (e) {
      console.error('close error', e);
      return interaction.editReply('❌ Failed to close this thread.');
    }
  }

  if (interaction.commandName === 'decision') {
    // Preflight: require Disputer, Opponent, and Issue
    if (!meta.p1Id || !meta.p2Id || !meta.issue) {
      return interaction.reply({
        flags: MessageFlags.Ephemeral,
        content: 'Cannot post decision: missing Disputer, Opponent, or Issue. Use `/set players` and `/set issue` first.'
      });
    }

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

    // Persist these opts into thread meta so later posts don't need re-entry
    meta.favour = favour ?? meta.favour;
    meta.schedule_window = schedule_window ?? meta.schedule_window;
    meta.device_player = device_player ?? meta.device_player;
    meta.team_rule = team_rule ?? meta.team_rule;
    meta.pokemon = pokemon ?? meta.pokemon;
    meta.old_move = old_move ?? meta.old_move;
    meta.new_move = new_move ?? meta.new_move;
    meta.penalty_against = penalty_against ?? meta.penalty_against;
    refMeta.set(ch.id, meta);

    const raiserId = refThreadToPlayer.get(ch.id);
    const text = buildDecisionText(meta, {
      outcome,
      team_rule: meta.team_rule,
      favour: meta.favour,
      schedule_window: meta.schedule_window,
      device_player: meta.device_player,
      pokemon: meta.pokemon,
      old_move: meta.old_move,
      new_move: meta.new_move,
      penalty_against: meta.penalty_against
    }, raiserId);

    // target: override -> origin guild country chan -> thread
    let targetChannel = overrideChan;
    if (!targetChannel) {
      const originId = meta.originGuildId;
      const originGuild = originId ? await interaction.client.guilds.fetch(originId).catch(() => null) : null;
      if (originGuild) {
        await originGuild.channels.fetch().catch(() => {}); // hydrate cache
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
      return interaction.reply({ content: 'Decision posted.', flags: MessageFlags.Ephemeral });
    } catch (e) {
      console.error('decision post error', e);
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Failed to post decision.' });
    }
  }

  if (interaction.commandName === 'vote') {
    const title = interaction.options.getString('title') || 'Vote time';
    const here  = interaction.options.getBoolean('here');
    const override = interaction.options.getChannel('channel', false);

    const keys = ['opt1','opt2','opt3','opt4','opt5','opt6']
      .map((k, idx) => interaction.options.getString(k, idx < 2))
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
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Pick at least two distinct options.' });
    }

    let target = override || interaction.channel;
    if (!target) return interaction.reply({ flags: MessageFlags.Ephemeral, content: 'No valid channel to post in.' });

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
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: `Vote created with ${items.length} option(s).` });
    } catch (e) {
      console.error('vote error', e);
      return interaction.reply({ flags: MessageFlags.Ephemeral, content: 'Failed to post vote (check Add Reactions & Mention Everyone permissions).' });
    }
  }
});

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

client.on(Events.GuildDelete, g => console.log(`➖ Removed: ${g.name} (${g.id})`));

// ====== BOOT ======
client.login(token);
