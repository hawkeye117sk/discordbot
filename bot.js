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
  'Please describe the issue in one sentence.',
  'Who was involved? (tag players)',
  'Exact time the issue occurred (with timezone).',
  'Provide video/screenshots (drive links acceptable).',
  'Confirm both teams and **lead Pokémon** used.',
  'Describe any lag/disconnects (who and when).',
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
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember],
});

// ====== UTILS ======
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function messageMentionsRole(message, roleId) {
  return message.mentions.roles.has(roleId) || message.content.includes(`<@&${roleId}>`);
}

async function extractCountries(message) {
  const guild = message.guild;
  const countries = new Set();

  // 1) Forum tags on the thread
  if (message.channel?.type === ChannelType.PublicThread && message.channel.parent?.type === ChannelType.GuildForum) {
    const applied = message.channel.appliedTags || [];
    for (const tagId of applied) {
      const tag = message.channel.parent.availableTags.find((t) => t.id === tagId);
      if (tag) countries.add(tag.name);
    }
  }

  // 2) Role mentions in the message
  for (const role of message.mentions.roles.values()) {
    countries.add(role.name);
  }

  // 3) Fallback — scan for roles named "Country: X" and match bare name in text
  const content = (message.content || '').toLowerCase();
  const allCountryRoles = guild.roles.cache.filter((r) => r.name.startsWith(COUNTRY_ROLE_PREFIX));
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
  const chans = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildText && c.name.includes(a) && c.name.includes(b),
  );
  return chans.find((c) => /^post|^result/.test(c.name)) || chans.first() || null;
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
    invitable: false,
  });

  const refRoleMention = `<@&${REF_ROLE_ID}>`;
  const jrRoleMention = `<@&${JR_REF_ROLE_ID}>`;
  const countryLine = countries.length
    ? `**Countries:** ${countries.join(' vs ')}`
    : `**Countries:** (not detected)`;

  await thread.send(
    [`${refRoleMention} ${jrRoleMention}`, `Ref thread for **${playerName}**.`, countryLine, `Dispute link: ${disputeMessage.url}`].join(
      '\n',
    ),
  );

  await thread.members.add(disputeMessage.author.id).catch(() => {});
  return thread;
}

async function removeConflictedRefs(thread, guild, countries) {
  if (!countries.length) return;

  const countryRoleNames = countries.map((c) => COUNTRY_ROLE_PREFIX + c);
  const conflictedRoleIds = guild.roles.cache
    .filter((r) => countryRoleNames.includes(r.name))
    .map((r) => r.id);

  if (!conflictedRoleIds.length) return;

  await thread.members.fetch().catch(() => {});
  const allMembers = await guild.members.fetch();

  const refs = allMembers.filter((m) => m.roles.cache.has(REF_ROLE_ID) || m.roles.cache.has(JR_REF_ROLE_ID));

  for (const member of refs.values()) {
    const hasConflict = member.roles.cache.some((r) => conflictedRoleIds.includes(r.id));
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
      message.channel.id === DISPUTE_CHANNEL_ID || message.channel?.parentId === DISPUTE_CHANNEL_ID;
    if (!inDisputeChannel) return;

    if (!messageMentionsRole(message, TRIGGER_ROLE_ID)) return;

    const isThread =
      message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread;
    const disputeThread = isThread ? message.channel : null;

    if (disputeThread && !disputeToRefThread.has(disputeThread.id)) {
      await message.channel.send(
        `Thanks for tagging <@&${REF_ROLE_ID}>.\nPlease answer the following:\n- ${PRESET_QUERIES.join('\n- ')}`,
      );
    }

    const countries = await extractCountries(message);
    const opponent = extractOpponentTag(message);
    const summary = extractIssueSummary(message);

    const existingRefThreadId = disputeThread ? disputeToRefThread.get(disputeThread.id) : null;
    let refThread = existingRefThreadId
      ? await message.guild.channels.fetch(existingRefThreadId).catch(() => null)
      : null;

    if (!refThread) {
      refThread = await createRefThread(message.guild, message, countries);
      if (disputeThread) disputeToRefThread.set(disputeThread.id, refThread.id);

      if (countries.length >= 2) {
        const decisionChan = await findDecisionChannel(message.guild, countries[0], countries[1]);
        if (decisionChan) {
          if (disputeThread) disputeToDecisionChan.set(disputeThread.id, decisionChan.id);
          await refThread.send(`📣 Default decision channel detected: <#${decisionChan.id}>`);
        }
      }

      await removeConflictedRefs(refThread, message.guild, countries);
    }

    const oppDisplay = opponent?.username
      ? `@${opponent.username}`
      : typeof opponent === 'string'
      ? `@${opponent}`
      : '(opponent not detected)';

    await refThread.send(
      [
        `🧵 New dispute raised by <@${message.author.id}> ${oppDisplay ? `vs ${oppDisplay}` : ''}`,
        countries.length ? `**Countries:** ${countries.join(' vs ')}` : '',
        summary ? `**Summary:** ${summary}` : '',
        `Source: ${message.url}`,
      ]
        .filter(Boolean)
        .join('\n'),
    );

    playerToRefThread.set(message.author.id, refThread.id);
  } catch (err) {
    console.error('MessageCreate handler error:', err);
  }
});

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
      `👤 **${message.author.username}:** ${message.content || '(attachment/message)'}${
        message.attachments.size ? '\n(Attachments present)' : ''
      }`,
    );
  } catch {
    // swallow
  }
});

// ====== SLASH COMMANDS ======
function teamRuleText(rule) {
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

const slashCommands = [
  new SlashCommandBuilder()
    .setName('decision')
    .setDescription('Post a dispute decision from the ref thread.')
    .addStringOption((o) =>
      o
        .setName('grant')
        .setDescription('Rematch granted?')
        .setRequired(true)
        .addChoices(
          { name: 'will be granted', value: 'will' },
          { name: 'will NOT be granted', value: 'will not' },
        ),
    )
    .addStringOption((o) =>
      o
        .setName('team_rule')
        .setDescription('Team/lead rule to apply')
        .setRequired(true)
        .addChoices(
          { name: 'Same teams & same lead', value: 'same_teams_same_lead' },
          { name: 'Same lead, backline may change', value: 'same_lead_flex_back' },
          { name: 'New teams allowed', value: 'new_teams' },
        ),
    )
    .addStringOption((o) => o.setName('issue').setDescription('Short issue text to insert').setRequired(true))
    .addChannelOption((o) => o.setName('channel').setDescription('Override target channel (optional)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),
];

// ====== INTERACTIONS ======
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'decision') return;

  try {
    const current = interaction.channel;
    if (current?.type !== ChannelType.PrivateThread && current?.type !== ChannelType.PublicThread) {
      return interaction.reply({
        ephemeral: true,
        content: 'Use this command from within the ref thread (or specify a channel).',
      });
    }

    const disputeThreadId =
      [...disputeToRefThread.entries()].find(([, refId]) => refId === current.id)?.[0] || null;

    const grant = interaction.options.getString('grant', true); // 'will' | 'will not'
    const rule = interaction.options.getString('team_rule', true);
    const issue = interaction.options.getString('issue', true);
    const overrideChan = interaction.options.getChannel('channel', false);

    let targetChannel = overrideChan;
    if (!targetChannel) {
      const auto = disputeThreadId ? disputeToDecisionChan.get(disputeThreadId) : null;
      targetChannel = auto ? await interaction.guild.channels.fetch(auto).catch(() => null) : null;
    }
    if (!targetChannel) {
      return interaction.reply({
        ephemeral: true,
        content: 'No target channel found. Provide one with /decision channel:...',
      });
    }

    // Best-effort country header from ref thread name
    let countries = [];
    try {
      const refThread = current;
      if (refThread?.name?.includes('–')) {
        const parts = refThread.name.split('–').map((s) => s.trim());
        const vs = parts.pop();
        if (vs?.includes('vs')) countries = vs.split('vs').map((s) => s.replace(/-/g, ' ').trim());
      }
    } catch {}

    // Try to detect main players mentioned in the dispute thread
    let playersLine = '';
    if (disputeThreadId) {
      try {
        const disputeThread = await interaction.guild.channels.fetch(disputeThreadId);
        const firstMsgs = await disputeThread.messages.fetch({ limit: 10 });
        const mentions = new Set();
        firstMsgs.forEach((m) => m.mentions?.users?.forEach((u) => mentions.add(u)));
        if (mentions.size) {
          playersLine = [...mentions].slice(0, 2).map((u) => `<@${u.id}>`).join(' ');
        }
      } catch {}
    }

    const header =
      countries.length === 2
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
      'We would like to remind all parties involved that referees and staff members from countries involved in disputes cannot be involved in the resolution of the dispute.',
    ].join('\n');

    await targetChannel.send(body);
    await interaction.reply({ ephemeral: true, content: `Posted decision to <#${targetChannel.id}>.` });
  } catch (e) {
    console.error(e);
    try {
      await interaction.reply({ ephemeral: true, content: 'Failed to post decision. Check my permissions and try again.' });
    } catch {}
  }
});

// ====== READY (register commands) ======
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(token);

  try {
    const guilds = await client.guilds.fetch();
    console.log(
      'Guilds I am in:',
      [...guilds.values()].map((g) => `${g.name} (${g.id})`).join(', ') || '(none)',
    );

    for (const [id, g] of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(client.user.id, id), { body: slashCommands });
        console.log(`✅ Commands registered in guild: ${g?.name || id} (${id})`);
      } catch (e) {
        console.error(`❌ Failed to register in guild ${g?.name || id} (${id}):`, e?.code || e?.message || e);
      }
    }
  } catch (e) {
    console.error('Failed to fetch guilds:', e);
  }

  // Optional fallback: global registration (may take time to appear)
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('ℹ️ Global commands pushed (may take time to appear).');
  } catch (e) {
    console.error('❌ Global registration failed:', e?.code || e?.message || e);
  }
});

// ====== BOOT ======
client.login(token);
