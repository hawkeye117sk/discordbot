// bot.js
import 'dotenv/config';

// DEBUG: show what env keys we actually have (no secrets printed)
const keys = Object.keys(process.env).filter(k => k.startsWith('DISCORD') || k.startsWith('RAILWAY') || k === 'NODE_VERSION');
console.log('ENV KEYS SEEN BY PROCESS:', keys);

const token = (process.env.DISCORD_TOKEN || '').trim();
if (!token || !token.includes('.')) {
  console.error('❌ DISCORD_TOKEN missing/invalid (not set, or trimmed). Set it in Railway → Service → Variables.');
  process.exit(1);
}

import 'dotenv/config';

const raw = process.env.DISCORD_TOKEN ?? '';
const token = raw.trim();

if (!token || !token.includes('.')) { // Discord tokens have dots
  console.error('❌ DISCORD_TOKEN missing/invalid (not set, or trimmed). Set it in Railway → Service → Variables.');
  process.exit(1);
}
console.log(`✅ Token loaded (length ${token.length}).`);
client.login(token);

import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events, ChannelType,
  ThreadAutoArchiveDuration, SlashCommandBuilder, Routes, REST,
  PermissionFlagsBits
} from 'discord.js';

const {
  DISCORD_TOKEN, GUILD_ID,
  DISPUTE_CHANNEL_ID, REF_HUB_CHANNEL_ID,
  REF_ROLE_ID, JR_REF_ROLE_ID, TRIGGER_ROLE_ID,
  COUNTRY_ROLE_PREFIX = 'Country: '
} = process.env;

const PRESET_QUERIES = [
  "Please describe the issue in one sentence.",
  "Who was involved? (tag players)",
  "Exact time the issue occurred (with timezone).",
  "Provide video/screenshots (drive links acceptable).",
  "Confirm both teams and **lead Pokémon** used.",
  "Describe any lag/disconnects (who and when)."
];

// memory stores (swap to a DB if you want persistence)
const disputeToRefThread = new Map();   // disputeThreadId -> refThreadId
const disputeToDecisionChan = new Map();// disputeThreadId -> decisionChannelId
const playerToRefThread = new Map();    // userId -> refThreadId (for mirroring)

// --- client/internals ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

// Utility: slugify for channel name matching
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Try to pull countries from: 1) forum tags; 2) role mentions/names; 3) #words in message that match country roles
async function extractCountries(message) {
  const guild = message.guild;
  const countries = new Set();

  // 1) Forum tags (if in a forum thread)
  if (message.channel?.type === ChannelType.PublicThread && message.channel.parent?.type === ChannelType.GuildForum) {
    const applied = message.channel.appliedTags || [];
    for (const tagId of applied) {
      const tag = message.channel.parent.availableTags.find(t => t.id === tagId);
      if (tag) countries.add(tag.name);
    }
  }

  // 2) Role mentions in message (e.g., @United Kingdom)
  for (const role of message.mentions.roles.values()) {
    countries.add(role.name);
  }

  // 3) Fallback: scan roles in guild that begin with COUNTRY_ROLE_PREFIX and look for their bare names in message
  const content = message.content.toLowerCase();
  const allCountryRoles = guild.roles.cache.filter(r => r.name.startsWith(COUNTRY_ROLE_PREFIX));
  for (const role of allCountryRoles.values()) {
    const name = role.name.slice(COUNTRY_ROLE_PREFIX.length);
    if (content.includes(name.toLowerCase())) countries.add(name);
  }

  return Array.from(countries);
}

function extractOpponentTag(message) {
  // First user mention that isn't the author
  for (const user of message.mentions.users.values()) {
    if (user.id !== message.author.id) return user;
  }
  // fallback: a plain-text @something (weak heuristic)
  const m = message.content.match(/@([A-Za-z0-9_\-\.]{2,32})/);
  return m ? m[1] : null;
}

function extractIssueSummary(message) {
  // Take first line or up to ~200 chars as a “brief overview”
  const firstLine = message.content.trim().split('\n')[0];
  return firstLine.length > 200 ? firstLine.slice(0, 197) + '…' : firstLine;
}

async function findDecisionChannel(guild, countryA, countryB) {
  if (!countryA || !countryB) return null;
  const a = slug(countryA);
  const b = slug(countryB);
  // look for channels containing both slugs in any order
  const chans = guild.channels.cache.filter(c =>
    c.type === ChannelType.GuildText &&
    c.name.includes(a) && c.name.includes(b)
  );
  // prefer a channel that starts with "post" or "results" if present
  let best = chans.find(c => /^post|^result/.test(c.name)) || chans.first();
  return best || null;
}

async function createRefThread(guild, disputeMessage, countries) {
  const refHub = await guild.channels.fetch(REF_HUB_CHANNEL_ID);
  if (!refHub || refHub.type !== ChannelType.GuildText) throw new Error('#dispute-referees not a text channel');

  const playerName = disputeMessage.author.globalName || disputeMessage.author.username;
  const threadName = `Ref – ${playerName} – ${countries.map(slug).join(' vs ') || 'dispute'}`;

  const thread = await refHub.threads.create({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    type: ChannelType.PrivateThread,
    invitable: false
  });

  // Seed post tagging refs + countries
  const refRoleMention = `<@&${REF_ROLE_ID}>`;
  const jrRoleMention  = `<@&${JR_REF_ROLE_ID}>`;
  const countryLine = countries.length ? `**Countries:** ${countries.join(' vs ')}` : `**Countries:** (not detected)`;

  await thread.send([
    `${refRoleMention} ${jrRoleMention}`,
    `Ref thread for **${playerName}**.`,
    countryLine,
    `Dispute link: ${disputeMessage.url}`
  ].join('\n'));

  // Add author to the thread so they can be referenced if needed (optional)
  await thread.members.add(disputeMessage.author.id).catch(() => { /* ignore if not allowed */ });

  return thread;
}

async function removeConflictedRefs(thread, guild, countries) {
  if (!countries.length) return;
  const countryRoleNames = countries.map(c => COUNTRY_ROLE_PREFIX + c);

  // Build a set of role IDs that are considered “conflicted”
  const conflictedRoleIds = guild.roles.cache
    .filter(r => countryRoleNames.includes(r.name))
    .map(r => r.id);

  if (!conflictedRoleIds.length) return;

  // Fetch members who can see the thread (we’ll check refs with role)
  await thread.members.fetch().catch(() => {});
  const allMembers = await guild.members.fetch();

  // Who counts as a ref?
  const refs = allMembers.filter(m => m.roles.cache.has(REF_ROLE_ID) || m.roles.cache.has(JR_REF_ROLE_ID));

  // Kick from the thread any ref with a conflicting country role
  for (const member of refs.values()) {
    const hasConflict = member.roles.cache.some(r => conflictedRoleIds.includes(r.id));
    if (hasConflict) {
      await thread.members.remove(member.id).catch(() => {});
    }
  }

  await thread.send(`🚫 Removed conflicted referees based on country roles: ${countries.join(' / ')}`);
}

function messageMentionsRole(message, roleId) {
  return message.mentions.roles.has(roleId) ||
         message.content.includes(`<@&${roleId}>`);
}

// --- event: new messages ---
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author?.bot) return;

    // Only react inside #dispute-request threads/posts
    const inDisputeChannel =
      message.channel.id === DISPUTE_CHANNEL_ID ||
      message.channel?.parentId === DISPUTE_CHANNEL_ID;

    if (!inDisputeChannel) return;

    // Trigger only when @referee mentioned
    if (!messageMentionsRole(message, TRIGGER_ROLE_ID)) return;

    // Post preset questions once per dispute thread
    const disputeThread = message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread
      ? message.channel
      : null;

    if (disputeThread && !disputeToRefThread.has(disputeThread.id)) {
      // Ask preset questions in the dispute thread
      await message.channel.send(`Thanks for tagging <@&${REF_ROLE_ID}>.\nPlease answer the following:\n- ${PRESET_QUERIES.join('\n- ')}`);
    }

    // Extract structured bits
    const countries = await extractCountries(message);
    const opponent = extractOpponentTag(message); // user object or string
    const summary  = extractIssueSummary(message);

    // Create ref thread (or reuse)
    const existingRefThreadId = disputeThread ? disputeToRefThread.get(disputeThread.id) : null;
    let refThread = existingRefThreadId ? await message.guild.channels.fetch(existingRefThreadId).catch(() => null) : null;
    if (!refThread) {
      refThread = await createRefThread(message.guild, message, countries);
      if (disputeThread) disputeToRefThread.set(disputeThread.id, refThread.id);

      // Decision channel discovery
      if (countries.length >= 2) {
        const decisionChan = await findDecisionChannel(message.guild, countries[0], countries[1]);
        if (decisionChan) {
          if (disputeThread) disputeToDecisionChan.set(disputeThread.id, decisionChan.id);
          await refThread.send(`📣 Default decision channel detected: <#${decisionChan.id}>`);
        }
      }

      // Remove conflicted refs
      await removeConflictedRefs(refThread, message.guild, countries);
    }

    // Seed the ref thread with context
    const oppDisplay = opponent?.username ? `@${opponent.username}` : (typeof opponent === 'string' ? `@${opponent}` : '(opponent not detected)');
    await refThread.send([
      `🧵 New dispute raised by <@${message.author.id}> ${oppDisplay ? `vs ${oppDisplay}` : ''}`,
      countries.length ? `**Countries:** ${countries.join(' vs ')}` : '',
      summary ? `**Summary:** ${summary}` : '',
      `Source: ${message.url}`
    ].filter(Boolean).join('\n'));

    // Start mirroring future messages from the player into their ref thread
    playerToRefThread.set(message.author.id, refThread.id);

  } catch (err) {
    console.error('MessageCreate handler error:', err);
  }
});

// Mirror player messages from the dispute thread into their ref thread
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

    await refThread.send(`👤 **${message.author.username}:** ${message.content || '(attachment/message)'}${message.attachments.size ? '\n(Attachments present)' : ''}`);
  } catch (e) {
    // swallow
  }
});

// --- slash command: /decision ---
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
const commands = [
  new SlashCommandBuilder()
    .setName('decision')
    .setDescription('Post a dispute decision from the ref thread.')
    .addStringOption(o => o.setName('grant')
      .setDescription('Rematch granted? yes/no').setRequired(true).addChoices(
        { name: 'will be granted', value: 'will' },
        { name: 'will NOT be granted', value: 'will not' }
      ))
    .addStringOption(o => o.setName('team_rule')
      .setDescription('Team/lead rule to apply').setRequired(true).addChoices(
        { name: 'Same teams & same lead', value: 'same_teams_same_lead' },
        { name: 'Same lead, backline may change', value: 'same_lead_flex_back' },
        { name: 'New teams allowed', value: 'new_teams' }
      ))
    .addStringOption(o => o.setName('issue')
      .setDescription('Short issue text to insert').setRequired(true))
    .addChannelOption(o => o.setName('channel')
      .setDescription('Override target channel (optional)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON()
];

async function registerCommands() {
  await rest.put(Routes.applicationGuildCommands((await client.application?.id) || '0', GUILD_ID), { body: commands });
}

// Decision text helper
function teamRuleText(rule) {
  switch (rule) {
    case 'same_teams_same_lead':
      return [
        "The same teams must be used, with the same lead Pokémon."
      ];
    case 'same_lead_flex_back':
      return [
        "The same lead Pokémon must be used, the back line may be changed."
      ];
    case 'new_teams':
      return [
        "New teams may be used."
      ];
    default: return [];
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'decision') return;

  try {
    // Must be used from a ref thread to auto-find dispute/post channels
    const current = interaction.channel;
    if (current?.type !== ChannelType.PrivateThread && current?.type !== ChannelType.PublicThread) {
      return interaction.reply({ ephemeral: true, content: 'Use this command from within the ref thread (or specify a channel).' });
    }

    // Find related dispute thread (reverse lookup)
    const disputeThreadId = [...disputeToRefThread.entries()].find(([, refId]) => refId === current.id)?.[0] || null;

    const grant = interaction.options.getString('grant', true);    // 'will' | 'will not'
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

    // Try to pull the two countries (best effort for header)
    let countries = [];
    if (disputeThreadId) {
      const refId = disputeToRefThread.get(disputeThreadId);
      const refThread = await interaction.guild.channels.fetch(refId).catch(() => null);
      if (refThread?.name?.includes('–')) {
        const parts = refThread.name.split('–').map(s => s.trim());
        const vs = parts.pop();
        if (vs?.includes('vs')) countries = vs.split('vs').map(s => s.replace(/-/g, ' ').trim());
      }
    }

    // Try to detect main players tagged in the dispute thread’s initial post
    let playersLine = '';
    if (disputeThreadId) {
      try {
        const disputeThread = await interaction.guild.channels.fetch(disputeThreadId);
        const firstMsgs = await disputeThread.messages.fetch({ limit: 10 });
        const mentions = new Set();
        firstMsgs.forEach(m => m.mentions?.users?.forEach(u => mentions.add(u)));
        if (mentions.size) {
          playersLine = [...mentions].slice(0, 2).map(u => `<@${u.id}>`).join(' ');
        }
      } catch {}
    }

    const header = countries.length === 2
      ? `Post: #${slug(countries[0])}-${slug(countries[1])}`
      : `Post: (countries not detected)`;

    const body = [
      header,
      '',
      playersLine || '@Playername1 @Playername2',
      `After reviewing the match dispute set by <@${interaction.user.id}> regarding ${issue}. The Referees team has decided that a rematch **${grant}** be granted.`,
      '',
      ...teamRuleText(rule),
      '',
      'We would like to remind all parties involved that referees and staff members from countries involved in disputes cannot be involved in the resolution of the dispute.'
    ].join('\n');

    await targetChannel.send(body);
    await interaction.reply({ ephemeral: true, content: `Posted decision to <#${targetChannel.id}>.` });
  } catch (e) {
    console.error(e);
    await interaction.reply({ ephemeral: true, content: 'Failed to post decision. Check my permissions and try again.' });
  }
});

// --- boot ---
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
  console.log('Commands registered.');
});
client.login(DISCORD_TOKEN);
