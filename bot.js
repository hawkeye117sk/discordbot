// bot.js — Discord Disputes Bot (ESM, Node 18+)

import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events, ChannelType,
  ThreadAutoArchiveDuration, SlashCommandBuilder, Routes, REST,
  PermissionFlagsBits
} from 'discord.js';

// ====== ENV & DEBUG ======
const token = (process.env.DISCORD_TOKEN ?? '').trim();

// Debug (no secrets)
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
  COUNTRY_ROLE_PREFIX = 'Country: '
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
  "Please describe the issue in one sentence.",
  "Who was involved? (tag players)",
  "Exact time the issue occurred (with timezone).",
  "Provide video/screenshots (drive links acceptable).",
  "Confirm both teams and **lead Pokémon** used.",
  "Describe any lag/disconnects (who and when)."
];

// ====== STATE ======
const disputeToRefThread = new Map();   // disputeThreadId -> refThreadId
const disputeToDecisionChan = new Map();// disputeThreadId -> decisionChannelId
const playerToRefThread = new Map();    // userId -> refThreadId (for mirroring)

// ====== CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

// ====== UTILS ======
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function messageMentionsRole(message, roleId) {
  return message.mentions.roles.has(roleId) ||
         message.content.includes(`<@&${roleId}>`);
}

async function extractCountries(message) {
  const guild = message.guild;
  const countries = new Set();

  if (message.channel?.type === ChannelType.PublicThread && message.channel.parent?.type === ChannelType.GuildForum) {
    const applied = message.channel.appliedTags || [];
    for (const tagId of applied) {
      const tag = message.channel.parent.availableTags.find(t => t.id === tagId);
      if (tag) countries.add(tag.name);
    }
  }

  for (const role of message.mentions.roles.values()) {
    countries.add(role.name);
  }

  const content = (message.content || '').toLowerCase();
  const allCountryRoles = guild.roles.cache.filter(r => r.name.startsWith(COUNTRY_ROLE_PREFIX));
  for (const role of allCountryRoles.values()) {
    const name = role.name.slice(COUNTRY_ROLE_PREFIX.length);
    if (name && content.includes(name.toLowerCase())) countries.add(name);
  }

  return Array.from(countries);
}

function extractOpponentTag(message) {
  for (const user of message.mentions.users.values()) {
    if (user.id !== message.author.id) return user; // first non-author mention
  }
  const m = (message.content || '').match(/@([A-Za-z0-9_\-\.]{2,32})/);
  return m ? m[1] : null;
}

function extractIssueSummary(message) {
  const firstLine = (message.content || '').trim().split('\n')[0];
  return firstLine.length > 200 ? firstLine.slice(0, 197) + '…' : firstLine;
}

async function findDecisionChannel(guild, countryA, countryB) {
  if (!countryA || !countryB) return null;
  const a = slug(countryA);
  const b = slug(countryB);
  const chans = guild.channels.cache.filter(c =>
    c.type === ChannelType.GuildText &&
    c.name.includes(a) && c.name.includes(b)
  );
  return chans.find(c => /^post|^result/.test(c.name)) || chans.first() || null;
}

async function createRefThread(guild, disputeMessage, countries) {
  const refHub = await guild.channels.fetch(REF_HUB_CHANNEL_ID);
  if (!refHub || refHub.type !== ChannelType.GuildText) {
    throw new Error('#dispute-referees must be a TEXT channel that allows private threads.');
  }

  const playerName = disputeMessage.author.globalName || disputeMessage.author.username;
  const threadName = `Ref – ${playerName} – ${countries.map(slug).join(' vs ') || 'dispute'}`;

  const thread = await refHub.threads.create({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    type: ChannelType.PrivateThread,
    invitable: false
  });

  const refRoleMention = `<@&${REF_ROLE_ID}>`;
  const jrRoleMention  = `<@&${JR_REF_ROLE_ID}>`;
  const countryLine = countries.length ? `**Countries:** ${countries.join(' vs ')}` : `**Countries:** (not detected)`;

  await thread.send([
    `${refRoleMention} ${jrRoleMention}`,
    `Ref thread for **${playerName}**.`,
    countryLine,
    `Dispute link: ${disputeMessage.url}`
  ].join('\n'));

  await thread.members.add(disputeMessage.author.id).catch(() => {});
  return thread;
}

async function removeConflictedRefs(thread, guild, countries) {
  if (!countries.length) return;

  const countryRoleNames = countries.map(c => COUNTRY_ROLE_PREFIX + c);
  const conflictedRoleIds = guild.roles.cache
    .filter(r => countryRoleNames.includes(r.name))
    .map(r => r.id);

  if (!conflictedRoleIds.length) return;

  await thread.members.fetch().catch(() => {});
  const allMembers = await guild.members.fetch();

  const refs = allMembers.filter(m => m.roles.cache.has(REF_ROLE_ID) || m.roles.cache.has(JR_REF_ROLE_ID));

  for (const member of refs.values()) {
    const hasConflict = member.roles.cache.some(r => conflictedRoleIds.includes(r.id));
    if (hasConflict) {
      await thread.members.remove(member.id).catch(() => {});
    }
  }

  await thread.send(`🚫 Removed conflicted referees based on country roles: ${countries.join(' / ')}`);
}

// ====== MESSAGE HANDLERS ======
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author?.bot) return;

    const inDisputeChannel =
      message.channel.id === DISPUTE_CHANNEL_ID ||
      message.channel?.parentId === DISPUTE_CHANNEL_ID;
    if (!inDisputeChannel) return;

    if (!messageMentionsRole(message, TRIGGER_ROLE_ID)) return;

    const isThread = (message.channel.type === ChannelType.PublicThread) || (message.channel.type === ChannelType.PrivateThread);
    const disputeThread = isThread ? message.channel : null;

    if (disputeThread && !disputeToRefThread.has(disputeThread.id)) {
      await message.channel.send(`Thanks for tagging <@&${REF_ROLE_ID}>.\nPlease answer the following:\n- ${PRESET_QUERIES.join('\n- ')}`);
    }

    const countries = await extractCountries(message);
    const opponent = extractOpponentTag(message);
    const summary  = extractIssueSummary(message);

    const existingRefThreadId = disputeThread ? disputeToRefThread.get(disputeThread.id) : null;
    let refThread = existingRefThreadId ? await message.guild.channels.fetch(existingRefThreadId).catch(() => null) : null;

    if (!refThread) {
      refThread = await createRefThread(message.guild, message, countries);
      if (disputeThread) disputeToRefThread.set(disputeThread.id, refThread.id);

      if (count
