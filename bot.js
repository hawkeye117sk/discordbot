// bot.js — Discord Disputes Bot (ESM, Node 18+)

import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events, ChannelType,
  ThreadAutoArchiveDuration, SlashCommandBuilder, Routes, REST,
  PermissionFlagsBits
} from 'discord.js';

// ====== ENV & DEBUG ======
const token = (process.env.DISCORD_TOKEN ?? '').trim();
const dbgKeys = Object.keys(process.env).filter(k =>
  k.startsWith('DISCORD') || k.startsWith('RAILWAY') || k === 'NODE_VERSION'
).sort();
console.log('ENV KEYS SEEN:', dbgKeys);
console.log('DISCORD_TOKEN length:', token ? token.length : 0);

if (!token || !token.includes('.')) {
  console.error('❌ DISCORD_TOKEN missing/invalid. Set it in Railway → Service → Variables.');
  process.exit(1);
}

const {
  GUILD_ID,
  DISPUTE_CHANNEL_ID,  // #dispute-request
  REF_HUB_CHANNEL_ID,  // #dispute-referees (allows private threads)
  REF_ROLE_ID,         // @Referee
  JR_REF_ROLE_ID,      // @Junior Referee
  TRIGGER_ROLE_ID      // role that triggers the bot (e.g. @Referee)
} = process.env;

const requiredEnv = { GUILD_ID, DISPUTE_CHANNEL_ID, REF_HUB_CHANNEL_ID, REF_ROLE_ID, JR_REF_ROLE_ID, TRIGGER_ROLE_ID };
for (const [k,v] of Object.entries(requiredEnv)) {
  if (!v) { console.error(`❌ Missing required env var: ${k}`); process.exit(1); }
}

// ====== CONSTANTS ======
const PRESET_QUERIES = [
  'Please describe the issue.',
  'Who was involved?',
  'Please provide screenshots of your communication.',
  'For Gameplay disputes, please provide full video evidence.',
];

const ISSUES = ['Lag', 'Communication', 'Device Issue', 'No Show'];
const BRACKET_ROLE = /\[.+\]/; // detect roles like "... [ND]"

// ====== STATE ======
const disputeToRefThread = new Map();     // disputeThreadId -> refThreadId
const disputeToDecisionChan = new Map();  // disputeThreadId -> decisionChannelId
const playerToRefThread = new Map();      // userId -> refThreadId (mirror)
const refThreadMeta = new Map();          // refThreadId -> { player1Id?, player2Id?, issue? }
const refThreadToOrigin = new Map();      // refThreadId -> { channelId, messageId, authorId }
const closedPlayers = new Set();          // userId => closed

// ====== CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

// ====== UTILS ======
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'');

function messageMentionsRole(message, roleId) {
  return message.mentions.roles.has(roleId) || (message.content || '').includes(`<@&${roleId}>`);
}

function getMemberCountry(member) {
  const role = member.roles.cache.find(r => BRACKET_ROLE.test(r.name));
  return role ? { name: role.name, roleId: role.id } : { name: null, roleId: null };
}

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

const fmtCountry = c => c?.roleId ? `<@&${c.roleId}>` : (c?.name || 'Unknown');

async function findDecisionChannel(guild, countryA, countryB) {
  if (!countryA || !countryB) return null;
  const a = slug(countryA), b = slug(countryB);
  const chans = guild.channels.cache.filter(c => c.type === ChannelType.GuildText && c.name.includes(a) && c.name.includes(b));
  return chans.find(c => /^post|^result/.test(c.name)) || chans.first() || null;
}

async function getUserNameMention(guild, userId) {
  try { const m = await guild.members.fetch(userId); return `@${m.user.username}`; }
  catch { try { const u = await client.users.fetch(userId); return `@${u.username}`; } catch { return '@Unknown'; } }
}

async function renameThreadWithMeta(thread, meta) {
  const p1 = meta.player1Id ? await getUserNameMention(thread.guild, meta.player1Id) : null;
  const p2 = meta.player2Id ? await getUserNameMention(thread.guild, meta.player2Id) : null;
  let name;
  if (meta.issue && p1 && p2) name = `${meta.issue} - ${p1.replace('@','')} vs ${p2.replace('@','')}`;
  else if (p1 && p2)          name = `Dispute - ${p1.replace('@','')} vs ${p2.replace('@','')}`;
  else if (meta.issue)        name = `${meta.issue}`;
  else if (p1)                name = `Dispute - ${p1.replace('@','')}`;
  else                        name = thread.name;
  if (name && name !== thread.name) { try { await thread.setName(name, 'Set by bot'); } catch {} }
}

async function createRefThread(guild, disputeMessage, playerCountry, oppCountry) {
  const refHub = await guild.channels.fetch(REF_HUB_CHANNEL_ID);
  if (!refHub || refHub.type !== ChannelType.GuildText) throw new Error('#dispute-referees must allow private threads.');
  const player = disputeMessage.author;
  const playerName = player.globalName || player.username;
  const thread = await refHub.threads.create({
    name: `Dispute - ${playerName}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    type: ChannelType.PrivateThread, invitable: false
  });
  const refRoleMention = `<@&${REF_ROLE_ID}>`;
  const jrRoleMention  = `<@&${JR_REF_ROLE_ID}>`;
  await thread.send([
    `${refRoleMention} ${jrRoleMention}`,
    `Dispute Thread for **${playerName}**.`,
    `Countries: ${fmtCountry(playerCountry)} and ${fmtCountry(oppCountry)}`,
    `Source: <#${DISPUTE_CHANNEL_ID}>`
  ].join('\n'));
  return thread;
}

async function removeConflictedRefs(thread, guild, countryNames) {
  const names = countryNames.filter(Boolean).map(n => n.toLowerCase());
  if (!names.length) return;
  await thread.members.fetch().catch(()=>{});
  const all = await guild.members.fetch();
  const refs = all.filter(m => m.roles.cache.has(REF_ROLE_ID) || m.roles.cache.has(JR_REF_ROLE_ID));
  for (const m of refs.values()) {
    const conflict = m.roles.cache.some(r => BRACKET_ROLE.test(r.name) && names.includes(r.name.toLowerCase()));
    if (conflict) await thread.members.remove(m.id).catch(()=>{});
  }
}

async function dmDisputeRaiser(message, disputeThread) {
  const user = message.author;
  const name = user.globalName || user.username;
  const link = disputeThread ? `https://discord.com/channels/${message.guild.id}/${disputeThread.id}` : message.url;
  const text = [
    `Hi ${name}, this is the **Gymbreakers Referee Team**.`,
    `Please send all evidence and messages **in this DM**. We’ll mirror everything privately for the referees.`,
    '', '**Questions to answer:**', ...PRESET_QUERIES.map(q=>`• ${q}`), '',
    'Reference link to your dispute:', link
  ].join('\n');
  try { await user.send(text); }
  catch {
    try {
      await message.reply({
        content: `I couldn’t DM you (DMs disabled). Please answer here and enable DMs if possible.\n` +
                 '**Questions:**\n' + PRESET_QUERIES.map(q=>`• ${q}`).join('\n'),
        allowedMentions: { parse: [], users: [user.id] }
      });
    } catch {}
  }
}

function teamRuleLine(key) {
  switch (key) {
    case 'same_teams_same_lead': return 'The same teams must be used, with the same lead Pokémon.';
    case 'same_lead_flex_back':  return 'The same lead Pokémon must be used, the back line may be changed.';
    case 'new_teams':            return 'New teams may be used.';
    default: return '';
  }
}

// ====== MESSAGE HANDLERS ======

// 1) Trigger from dispute area → create Dispute Thread + DM player
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author?.bot) return;

    const inDispute = message.channel.id === DISPUTE_CHANNEL_ID || message.channel?.parentId === DISPUTE_CHANNEL_ID;
    const mentioned = messageMentionsRole(message, TRIGGER_ROLE_ID);
    if (!inDispute || !mentioned) return;

    const member = await message.guild.members.fetch(message.author.id);
    const playerCountry = getMemberCountry(member);
    const opponentCountry = getOpponentCountryFromMessage(message, playerCountry.name);

    if (!opponentCountry.name) {
      await message.reply({
        content: 'I couldn’t detect an **opponent country**. Please **re-raise the issue and tag the opponent country role** (a role whose name includes `[XX]`).',
        allowedMentions: { parse: [] }
      });
      return;
    }

    const isForumThread = message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread;
    const disputeThread = isForumThread ? message.channel : null;

    let refThread = disputeThread ? await message.guild.channels.fetch(disputeToRefThread.get(disputeThread.id)).catch(()=>null) : null;
    if (!refThread) {
      refThread = await createRefThread(message.guild, message, playerCountry, opponentCountry);
      if (disputeThread) disputeToRefThread.set(disputeThread.id, refThread.id);
      const dc = await findDecisionChannel(message.guild, playerCountry.name, opponentCountry.name);
      if (dc && disputeThread) disputeToDecisionChan.set(disputeThread.id, dc.id);
      await removeConflictedRefs(refThread, message.guild, [playerCountry.name, opponentCountry.name].filter(Boolean));
    }

    // Meta
    const meta = refThreadMeta.get(refThread.id) || {};
    if (!meta.player1Id) meta.player1Id = message.author.id; // seed as P1 by default
    refThreadMeta.set(refThread.id, meta);

    // Maps
    playerToRefThread.set(message.author.id, refThread.id);
    closedPlayers.delete(message.author.id);
    refThreadToOrigin.set(refThread.id, { channelId: message.channel.id, messageId: message.id, authorId: message.author.id });

    await dmDisputeRaiser(message, disputeThread);
  } catch (err) {
    console.error('Dispute trigger handler error:', err);
  }
});

// 2) Mirror messages in dispute area (safety path)
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

    const refThread = await message.guild.channels.fetch(refThreadId).catch(()=>null);
    if (!refThread) return;

    await refThread.send(`👤 **${message.author.username} (channel):** ${message.content || '(attachment/message)'}${message.attachments.size ? '\n(Attachments present)' : ''}`);
  } catch {}
});

// 3) Mirror player DMs into the Dispute Thread (drop when Closed)
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;
    if (message.guild) return;
    if (message.channel?.type !== ChannelType.DM) return;

    const uid = message.author.id;
    const refThreadId = playerToRefThread.get(uid);
    if (!refThreadId) return;

    if (closedPlayers.has(uid)) { try { await message.reply('This dispute is **Closed**. Your DM was not forwarded.'); } catch {} return; }

    const refThread = await client.channels.fetch(refThreadId).catch(()=>null);
    if (!refThread) return;

    const files = [...message.attachments.values()].map(a => a.url);
    const content = `📥 **${message.author.username} (DM):** ${message.content || (files.length ? '(attachment)' : '(empty)')}`;
    if (files.length) {
      await refThread.send({ content, files }).catch(async () => { await refThread.send(content + `\n(Attachments present but could not be forwarded)`); });
    } else {
      await refThread.send(content);
    }
  } catch (e) { console.error('DM mirror error:', e); }
});

// ====== SLASH COMMANDS ======

// Helpers
async function getPlayersFromMeta(guild, meta) {
  const p1m = meta.player1Id ? `<@${meta.player1Id}>` : '@Player1';
  const p2m = meta.player2Id ? `<@${meta.player2Id}>` : '@Player2';
  return { p1m, p2m };
}
function originAuthorMention(refThreadId) {
  const o = refThreadToOrigin.get(refThreadId);
  return o?.authorId ? `<@${o.authorId}>` : '@PlayerThatPostedDispute';
}

const slashCommands = [
  new SlashCommandBuilder()
    .setName('set_players').setDescription('Set Player 1 and Player 2 for this thread.')
    .addUserOption(o => o.setName('player1').setDescription('Player 1').setRequired(true))
    .addUserOption(o => o.setName('player2').setDescription('Player 2').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('set_issue').setDescription('Set the issue for this thread.')
    .addStringOption(o => o.setName('issue').setDescription('Issue').addChoices(
      { name: 'Lag', value: 'Lag' },
      { name: 'Communication', value: 'Communication' },
      { name: 'Device Issue', value: 'Device Issue' },
      { name: 'No Show', value: 'No Show' },
    ).setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('message').setDescription('DM a player from this thread (echoed in thread).')
    .addStringOption(o => o.setName('target').setDescription('Who to DM').addChoices(
      { name: 'Player 1', value: 'p1' }, { name: 'Player 2', value: 'p2' }, { name: 'Both', value: 'both' }
    ).setRequired(true))
    .addStringOption(o => o.setName('text').setDescription('Message text').setRequired(true))
    .addBooleanOption(o => o.setName('echo').setDescription('Echo in thread (default true)'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),

  // ---- DECISIONS (templated) ----
  new SlashCommandBuilder()
    .setName('decision').setDescription('Post a dispute decision.')
    // Lag
    .addSubcommand(s => s.setName('lag').setDescription('Lag decision')
      .addStringOption(o => o.setName('outcome').setDescription('Result').addChoices(
        { name: 'Rematch', value: 'rematch' },
        { name: 'No Rematch', value: 'no_rematch' },
        { name: 'Win awarded', value: 'award_win' },
      ).setRequired(true))
      .addStringOption(o => o.setName('team_rule').setDescription('Team rule line (optional)').addChoices(
        { name: 'Same teams & same lead', value: 'same_teams_same_lead' },
        { name: 'Same lead, backline may change', value: 'same_lead_flex_back' },
        { name: 'New teams allowed', value: 'new_teams' },
      ))
      .addStringOption(o => o.setName('winner').setDescription('If awarding win: who').addChoices(
        { name: 'Player 1', value: 'p1' }, { name: 'Player 2', value: 'p2' }
      ))
      .addStringOption(o => o.setName('issue_text').setDescription('Issue wording (optional)'))
      .addChannelOption(o => o.setName('channel').setDescription('Target channel'))
    )
    // Communication
    .addSubcommand(s => s.setName('communication').setDescription('Communication decision')
      .addStringOption(o => o.setName('outcome').setDescription('Result').addChoices(
        { name: 'Did not communicate sufficiently', value: 'insufficient' },
        { name: 'Dispute was Invalid', value: 'invalid' },
      ).setRequired(true))
      .addStringOption(o => o.setName('offender').setDescription('Who failed?').addChoices(
        { name: 'Player 1', value: 'p1' }, { name: 'Player 2', value: 'p2' }
      ))
      .addStringOption(o => o.setName('country').setDescription('Country to receive penalty point'))
      .addStringOption(o => o.setName('schedule_by').setDescription('Deadline to schedule (e.g., 24 hours)'))
      .addChannelOption(o => o.setName('channel').setDescription('Target channel'))
    )
    // Device Issue
    .addSubcommand(s => s.setName('device_issue').setDescription('Device issue decision')
      .addStringOption(o => o.setName('outcome').setDescription('Result').addChoices(
        { name: 'Rematch', value: 'rematch' },
        { name: 'No Rematch', value: 'no_rematch' },
        { name: 'Win awarded', value: 'award_win' },
      ).setRequired(true))
      .addStringOption(o => o.setName('team_rule').setDescription('Team rule line (optional)').addChoices(
        { name: 'Same teams & same lead', value: 'same_teams_same_lead' },
        { name: 'Same lead, backline may change', value: 'same_lead_flex_back' },
        { name: 'New teams allowed', value: 'new_teams' },
      ))
      .addStringOption(o => o.setName('winner').setDescription('If awarding win: who').addChoices(
        { name: 'Player 1', value: 'p1' }, { name: 'Player 2', value: 'p2' }
      ))
      .addStringOption(o => o.setName('issue_text').setDescription('Issue wording (optional)'))
      .addStringOption(o => o.setName('culprit').setDescription('Who had the device issue?').addChoices(
        { name: 'Player 1', value: 'p1' }, { name: 'Player 2', value: 'p2' }
      ))
      .addChannelOption(o => o.setName('channel').setDescription('Target channel'))
    )
    // No Show
    .addSubcommand(s => s.setName('no_show').setDescription('No show decision')
      .addStringOption(o => o.setName('outcome').setDescription('Result').addChoices(
        { name: 'Failed to show on time', value: 'failed' },
        { name: 'Dispute was Invalid',    value: 'invalid_no_show' },
      ).setRequired(true))
      .addStringOption(o => o.setName('offender').setDescription('Who failed?').addChoices(
        { name: 'Player 1', value: 'p1' }, { name: 'Player 2', value: 'p2' }
      ))
      .addStringOption(o => o.setName('within_24h').setDescription('Within last 24h? yes/no').addChoices(
        { name: 'yes', value: 'yes' }, { name: 'no', value: 'no' }
      ))
      .addChannelOption(o => o.setName('channel').setDescription('Target channel'))
    )
    // Invalid due to 24h evidence timeout
    .addSubcommand(s => s.setName('invalid_timeout').setDescription('Invalid: evidence not provided in 24h')
      .addStringOption(o => o.setName('issue_text').setDescription('Issue wording (optional)'))
      .addChannelOption(o => o.setName('channel').setDescription('Target channel'))
    )
    // Generic award win
    .addSubcommand(s => s.setName('award_win').setDescription('Award win to a player')
      .addStringOption(o => o.setName('winner').setDescription('Who gets the win').addChoices(
        { name: 'Player 1', value: 'p1' }, { name: 'Player 2', value: 'p2' }
      ).setRequired(true))
      .addStringOption(o => o.setName('issue_text').setDescription('Reason / issue'))
      .addChannelOption(o => o.setName('channel').setDescription('Target channel'))
    )
    // Sportsmanship warning
    .addSubcommand(s => s.setName('sportsmanship').setDescription('Unsportsmanlike behaviour warning')
      .addStringOption(o => o.setName('player').setDescription('Who is warned?').addChoices(
        { name: 'Player 1', value: 'p1' }, { name: 'Player 2', value: 'p2' }
      ).setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Target channel'))
    )
    // Unregistered Pokémon (2.5.1)
    .addSubcommand(s => s.setName('unregistered_pokemon').setDescription('Unregistered Pokémon (2.5.1)')
      .addStringOption(o => o.setName('offender').setDescription('Who used wrong Pokémon?').addChoices(
        { name: 'Player 1', value: 'p1' }, { name: 'Player 2', value: 'p2' }
      ).setRequired(true))
      .addStringOption(o => o.setName('pokemon').setDescription('Wrong Pokémon').setRequired(true))
      .addStringOption(o => o.setName('country').setDescription('Country to receive penalty point').setRequired(true))
      .addStringOption(o => o.setName('correct_pokemon').setDescription('Correct Pokémon Player1 may use').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Target channel'))
    )
    // Moveset change (2.5.1)
    .addSubcommand(s => s.setName('moveset_change').setDescription('Illegal moveset change (2.5.1)')
      .addStringOption(o => o.setName('offender').setDescription('Who changed moves?').addChoices(
        { name: 'Player 1', value: 'p1' }, { name: 'Player 2', value: 'p2' }
      ).setRequired(true))
      .addStringOption(o => o.setName('pokemon').setDescription('Pokémon').setRequired(true))
      .addStringOption(o => o.setName('old_move').setDescription('Old move').setRequired(true))
      .addStringOption(o => o.setName('new_move').setDescription('New move').setRequired(true))
      .addStringOption(o => o.setName('country').setDescription('Country to receive penalty point').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Target channel'))
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),

  // Close/Reopen
  new SlashCommandBuilder().setName('close').setDescription('Close: archive+lock, stop mirroring, DM players, delete origin.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages).toJSON(),
  new SlashCommandBuilder().setName('reopen').setDescription('Reopen: unarchive+unlock and resume mirroring.').setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages).toJSON(),
];

// Slash logic
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const ch = interaction.channel;
  const inThread = ch && (ch.type === ChannelType.PrivateThread || ch.type === ChannelType.PublicThread);

  // /set_players
  if (interaction.commandName === 'set_players') {
    if (!inThread) return interaction.reply({ ephemeral: true, content: 'Use this inside a Dispute Thread.' });
    const p1 = interaction.options.getUser('player1', true);
    const p2 = interaction.options.getUser('player2', true);
    const meta = refThreadMeta.get(ch.id) || {};
    meta.player1Id = p1.id; meta.player2Id = p2.id;
    refThreadMeta.set(ch.id, meta);
    playerToRefThread.set(p1.id, ch.id); playerToRefThread.set(p2.id, ch.id);
    closedPlayers.delete(p1.id); closedPlayers.delete(p2.id);
    await renameThreadWithMeta(ch, meta);
    return interaction.reply({ ephemeral: false, content: `Players set: <@${p1.id}> vs <@${p2.id}> (thread name updated).` });
  }

  // /set_issue
  if (interaction.commandName === 'set_issue') {
    if (!inThread) return interaction.reply({ ephemeral: true, content: 'Use this inside a Dispute Thread.' });
    const issue = interaction.options.getString('issue', true);
    const meta = refThreadMeta.get(ch.id) || {};
    meta.issue = issue; refThreadMeta.set(ch.id, meta);
    await renameThreadWithMeta(ch, meta);
    return interaction.reply({ ephemeral: false, content: `Issue set: **${issue}** (thread name updated).` });
  }

  // /message
  if (interaction.commandName === 'message') {
    if (!inThread) return interaction.reply({ ephemeral: true, content: 'Use this inside a Dispute Thread.' });
    const target = interaction.options.getString('target', true); // p1 | p2 | both
    const text   = interaction.options.getString('text', true);
    const echo   = interaction.options.getBoolean('echo') ?? true;

    const meta = refThreadMeta.get(ch.id) || {};
    const targets = [];
    if (target === 'p1' && meta.player1Id) targets.push(meta.player1Id);
    if (target === 'p2' && meta.player2Id) targets.push(meta.player2Id);
    if (target === 'both') { if (meta.player1Id) targets.push(meta.player1Id); if (meta.player2Id) targets.push(meta.player2Id); }
    if (!targets.length) return interaction.reply({ ephemeral: true, content: 'Player(s) not set. Use /set_players first.' });

    let sent = 0;
    for (const uid of targets) {
      try { const u = await interaction.client.users.fetch(uid); await u.send(text); sent++; } catch {}
    }
    if (echo) {
      const toText = targets.map(uid => `<@${uid}>`).join(', ');
      await ch.send(`📤 **Bot → ${toText} (DM):** ${text}`);
    }
    return interaction.reply({ ephemeral: false, content: sent ? '✅ DM sent.' : '❌ Could not DM (DMs closed).' });
  }

  // /close & /reopen
  if (interaction.commandName === 'close' || interaction.commandName === 'reopen') {
    if (!inThread) return interaction.reply({ ephemeral: true, content: 'Use this inside a Dispute Thread.' });
    const meta = refThreadMeta.get(ch.id) || {};
    const ids = [meta.player1Id, meta.player2Id].filter(Boolean);

    if (interaction.commandName === 'close') {
      ids.forEach(id => closedPlayers.add(id));
      try { await ch.setArchived(true, 'Closed by /close'); } catch {}
      try { await ch.setLocked(true, 'Closed by /close'); } catch {}
      for (const uid of ids) { try { const u = await client.users.fetch(uid); await u.send('Your dispute has been **Closed**. Your DMs to this bot will not be forwarded.'); } catch {} }
      // delete origin
      try {
        const origin = refThreadToOrigin.get(ch.id);
        if (origin?.channelId && origin?.messageId) {
          const oChan = await client.channels.fetch(origin.channelId).catch(()=>null);
          if (oChan?.isTextBased?.()) {
            const msg = await oChan.messages.fetch(origin.messageId).catch(()=>null);
            if (msg?.deletable) await msg.delete().catch(()=>{});
          }
        }
      } catch {}
      return interaction.reply({ ephemeral: false, content: '🔒 Dispute **Closed**.' });
    } else {
      ids.forEach(id => closedPlayers.delete(id));
      try { await ch.setArchived(false, 'Reopened by /reopen'); } catch {}
      try { await ch.setLocked(false, 'Reopened by /reopen'); } catch {}
      return interaction.reply({ ephemeral: false, content: '🔓 Dispute **Reopened**. DM mirroring resumed.' });
    }
  }

  // /decision
  if (interaction.commandName === 'decision') {
    if (!inThread) return interaction.reply({ ephemeral: true, content: 'Use this in the Dispute Thread.' });

    const meta = refThreadMeta.get(ch.id) || {};
    const { p1m, p2m } = await getPlayersFromMeta(interaction.guild, meta);
    const raiser = originAuthorMention(ch.id);

    // target channel
    const override = interaction.options.getChannel('channel', false);
    let target = override;
    if (!target) {
      const disputeThreadId = [...disputeToRefThread.entries()].find(([, refId]) => refId === ch.id)?.[0] || null;
      const auto = disputeThreadId ? disputeToDecisionChan.get(disputeThreadId) : null;
      target = auto ? await interaction.guild.channels.fetch(auto).catch(()=>null) : null;
    }
    if (!target || !target.isTextBased?.()) target = ch;

    const sub = interaction.options.getSubcommand(true);
    let body = '';
    const footer = [
      '',
      'We would like to remind all parties involved that referees and staff members from countries involved in disputes cannot be involved in the resolution of the dispute.',
      '',
      'Good luck in your remaining battles.'
    ].join('\n');

    if (sub === 'lag' || sub === 'device_issue') {
      const outcome = interaction.options.getString('outcome', true); // rematch|no_rematch|award_win
      const teamRule = interaction.options.getString('team_rule', false);
      const issueText = interaction.options.getString('issue_text', false) || (sub === 'lag' ? 'lag' : 'a device issue');
      const winner = interaction.options.getString('winner', false);
      const winnerM = winner === 'p2' ? p2m : p1m;

      const header = `${p1m} ${p2m}\nAfter reviewing the match dispute set by ${raiser} regarding ${issueText}. The Referees team has decided that ` +
        (outcome === 'rematch' ? 'a rematch will be granted.' :
         outcome === 'no_rematch' ? 'a rematch will not be granted.' :
         `the win shall be awarded in favour of ${winnerM}.`);

      const ruleLine = teamRule ? `\n${teamRuleLine(teamRule)}` : '';
      let extra = '';
      if (sub === 'device_issue') {
        const culprit = interaction.options.getString('culprit', false);
        if (culprit) {
          const culpritM = culprit === 'p2' ? p2m : p1m;
          extra = `\nA warning is issued to ${culpritM} regarding device reliability.`;
        }
      }

      body = [header, ruleLine, extra, footer].join('');
    }

    if (sub === 'award_win') {
      const issueText = interaction.options.getString('issue_text', false) || '(insert reason for dispute)';
      const winner = interaction.options.getString('winner', true);
      const winnerM = winner === 'p2' ? p2m : p1m;

      body = [
        `${p1m} ${p2m}`,
        `After reviewing the match dispute set by ${raiser} regarding ${issueText}. The Referees team has decided that in this case **the win shall be awarded in favour of ${winnerM}**, the remaining games are still to be played - if they have not already been so.`,
        '',
        `The score is **1-0** in favour of ${winnerM} please update the score when available.`,
        footer
      ].join('\n');
    }

    if (sub === 'communication') {
      const outcome = interaction.options.getString('outcome', true); // insufficient|invalid
      if (outcome === 'insufficient') {
        const offender = interaction.options.getString('offender', true); // p1|p2
        const offenderM = offender === 'p2' ? p2m : p1m;
        const country = interaction.options.getString('country', false) || '(Insert country here)';
        const scheduleBy = interaction.options.getString('schedule_by', false) || '(Insert time here)';

        body = [
          `${p1m} ${p2m}`,
          `After reviewing the dispute set by ${raiser} regarding a failure to communicate. The Referees team has decided that  ${offenderM} failed to communicate in time and sufficiently, subsequent to **6.1** a **penalty point** is issued in favour of **${country}**. The games must be scheduled within **${scheduleBy}**. All games are still to be played.`,
          footer
        ].join('\n');
      } else {
        body = [
          `${p1m} ${p2m}`,
          `After reviewing the dispute set by ${raiser} regarding a failure to communicate. The Referees team has decided that **the dispute is invalid**.`,
          footer
        ].join('\n');
      }
    }

    if (sub === 'no_show') {
      const outcome = interaction.options.getString('outcome', true); // failed | invalid_no_show
      if (outcome === 'failed') {
        const offender = interaction.options.getString('offender', true);
        const offenderM = offender === 'p2' ? p2m : p1m;
        const within24 = interaction.options.getString('within_24h', false) || 'yes';
        const pts = within24 === 'yes' ? 'one penalty point' : 'three penalty points';
        body = [
          `${p1m} ${p2m}`,
          `After reviewing the dispute set by ${raiser} regarding a no show. The Referees team has decided that ${offenderM} failed to show in time and subsequent to **6.2.4/6.2.5** (if the last 24 hours) the penalty is **${pts}**.`,
          '',
          `The remaining games are to be played.`,
          footer
        ].join('\n');
      } else {
        // use the long invalid no-show text
        body = [
          `${p1m} ${p2m}`,
          `After reviewing the dispute set by ${raiser} regarding a no show. The Referees team has decided that **the dispute is invalid** subsequent to **6.2.5**.`,
          '',
          `The person who raises the dispute had messaged their opponent at the scheduled time window (within 15 minutes before scheduled time or within 14 minutes after the scheduled time) and after the sent message there have been at least 16 minutes passed. If person writes before scheduled time, the timer of 15 minutes starts from the originally scheduled time and not from the moment of writing to opponent, if such message was sent not longer than 15 minutes before scheduled time. If it was sent longer than 15 minutes before the scheduled time, there must be an additional message sent within the scheduled time`,
          '',
          `Both players are to communicate and agree a new time to battle within the next 24 hours. If any scheduling or communication issues persist please contact team captains in the first instance.`,
          footer
        ].join('\n');
      }
    }

    if (sub === 'invalid_timeout') {
      const issueText = interaction.options.getString('issue_text', false) || '(insert issue here)';
      const dr = `<#${DISPUTE_CHANNEL_ID}>`;
      body = [
        `${p1m} ${p2m}`,
        `After reviewing the match dispute set by ${raiser} regarding ${issueText}. The Referees team has decided that **the dispute will be ruled as invalid**.`,
        '',
        `Per rules :`,
        '',
        `DISPUTES`,
        '',
        `:exclamation: All disputes that get opened through ${dr} will have a time of **24 hours** from the moment an official referee or staff responds to your request, to send all the necessary information about the issue. If 24 or more hours have passed and you have not given the Referee or Staff all the necessary information, the @Referee team will not review your dispute as it will become invalid.`,
        footer
      ].join('\n');
    }

    if (sub === 'sportsmanship') {
      const who = interaction.options.getString('player', true); // p1 | p2
      const warned = who === 'p2' ? p2m : p1m;
      body = [
        `${p1m} ${p2m}`,
        `After reviewing the sportsmanship dispute set by ${raiser} regarding unsportsmanship behaviour. The Referees team has decided that a **warning** will be issued to ${warned}`,
        `The referees have reviewed all the evidence and decreed that ${warned} showed unsportsmanlike behaviour.`,
        '',
        `Please be aware that future penalties of this nature will be significantly more strict.`,
        footer
      ].join('\n');
    }

    if (sub === 'unregistered_pokemon') {
      const offender = interaction.options.getString('offender', true); // p1 | p2
      const offenderM = offender === 'p2' ? p2m : p1m;
      const wrongPkmn = interaction.options.getString('pokemon', true);
      const country = interaction.options.getString('country', true);
      const correctPkmn = interaction.options.getString('correct_pokemon', true);

      body = [
        `${p1m} ${p2m}`,
        `After reviewing the dispute set by ${p1m} regarding a use of an unregistered Pokemon **${wrongPkmn}**. The Referees team has decided that ${offenderM} indeed used an incorrect Pokemon and subsequent to **2.5.1** the outcome is **1 Penalty Point** on the Global Score against **${country}**.`,
        '',
        `The matches where **${wrongPkmn}** was used must be replayed and ${p1m} is allowed to only use **${correctPkmn}** in those games and with the rest of his opponents.`,
        footer
      ].join('\n');
    }

    if (sub === 'moveset_change') {
      const offender = interaction.options.getString('offender', true); // p1 | p2
      const offenderM = offender === 'p2' ? p2m : p1m;
      const pokemon = interaction.options.getString('pokemon', true);
      const oldMove = interaction.options.getString('old_move', true);
      const newMove = interaction.options.getString('new_move', true);
      const country = interaction.options.getString('country', true);

      body = [
        `${p1m} ${p2m}`,
        `After reviewing the dispute set by ${p1m} regarding a moveset change between opponents (**${oldMove}** -> **${newMove}**; **${pokemon}**). The Referees team has decided that ${offenderM} indeed illegaly changed movesets and subsequent to **2.5.1** the outcome is **1 Penalty Point** on the Global Score against **${country}**.`,
        '',
        `The matches where **${newMove}** was used must be replayed and ${offenderM} is allowed to only use **${oldMove}** in those games and with the rest of his opponents.`,
        footer
      ].join('\n');
    }

    if (!body) return interaction.reply({ ephemeral: true, content: 'Nothing to post (check options).' });

    await target.send(body);
    return interaction.reply({ ephemeral: false, content: `✅ Posted to ${target.id === ch.id ? 'this thread' : `<#${target.id}>`}.` });
  }
});

// ====== READY (config check + register commands) ======
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    const g = await client.guilds.fetch(GUILD_ID);
    const guild = await g.fetch();
    const chan = await client.channels.fetch(DISPUTE_CHANNEL_ID).catch(()=>null);
    const trigRole = await guild.roles.fetch(TRIGGER_ROLE_ID).catch(()=>null);
    console.log('🔎 Config check:',
      'guild=', guild?.name, `(${guild?.id})`,
      '| disputeChannel=', chan?.name, `(${chan?.id})`, 'type=', chan?.type,
      '| triggerRole=', trigRole?.name, `(${trigRole?.id})`
    );
  } catch (e) { console.error('Config check failed:', e?.code || e?.message || e); }

  try {
    const guilds = await client.guilds.fetch();
    console.log('Guilds I am in:', [...guilds.values()].map(g => `${g.name} (${g.id})`).join(', ') || '(none)');
    for (const [id, g2] of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, id), { body: slashCommands });
        console.log(`✅ Commands registered in guild: ${g2?.name || id} (${id})`);
      } catch (e) { console.error(`❌ Failed to register in guild ${g2?.name || id} (${id}):`, e?.code || e?.message || e); }
    }
  } catch (e) { console.error('Failed to fetch guilds:', e); }

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('ℹ️ Global commands pushed (may take time to appear).');
  } catch (e) { console.error('❌ Global registration failed:', e?.code || e?.message || e); }
});

// ====== BOOT ======
client.login(token);
