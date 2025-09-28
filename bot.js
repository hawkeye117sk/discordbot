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

  const player = disputeMessage.author;
  const playerName = player.globalName || player.username;
  const threadName = `Ref – ${playerName} – ${countries.map(slug).join(' vs ') || 'dispute'}`;

  const thread = await refHub.threads.create({
    name: threadName,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    type: ChannelType.PrivateThread,
    invitable: false,
  });

  const refRoleMention = `<@&${REF_ROLE_ID}>`;
  const jrRoleMention  = `<@&${JR_REF_ROLE_ID}>`;
  const countryLine = countries.length
    ? `**Countries:** ${countries.join(' vs ')}`
    : `**Countries:** (not detected)`;

  // Seed info for refs only
  await thread.send(
    [
      `${refRoleMention} ${jrRoleMention}`,
      `Ref thread for **${playerName}**.`,
      countryLine,
      `Dispute link: ${disputeMessage.url}`,
    ].join('\n')
  );

  // ❌ DO NOT add player to this private thread
  // ❌ No DM from here either

  return thread;
}

// ====== MESSAGE HANDLERS ======
async function dmDisputeRaiser(message, disputeThread) {
  const user = message.author;
  const name = user.globalName || user.username;

  // Link to the *dispute* place (not the ref thread)
  const link = disputeThread
    ? `https://discord.com/channels/${message.guild.id}/${disputeThread.id}`
    : message.url; // fallback to the original message link in a text channel

  const text = [
    `Hi ${name}, this is the **Gymbreakers Referee Team**.`,
    `Please send any evidence and messages **in your dispute thread** so referees can review:`,
    link
  ].join('\n');

  try {
    await user.send(text);
    console.log('📩 DM sent to', user.id);
  } catch (e) {
    console.log('⚠️ Could not DM user (DMs likely closed):', user.id, e?.message);
    // Optional: lightly notify them in the dispute thread
    try {
      await message.reply({
        content: `I tried to DM you but couldn’t (DMs disabled). Please continue here in this thread.`,
        allowedMentions: { parse: [], users: [user.id] }
      });
    } catch {}
  }
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author?.bot) return;
if (disputeThread && !disputeToRefThread.has(disputeThread.id)) {
  // Ask preset questions (once per dispute thread)
  await message.channel.send(
    `Thanks for tagging <@&${REF_ROLE_ID}>.\nPlease answer the following:\n- ${PRESET_QUERIES.join('\n- ')}`
  );

  // Greet & instruct the player in the *dispute* thread (not the ref thread)
  await message.reply({
    content:
      `👋 Hi <@${message.author.id}>, this is the **Gymbreakers Referee Team**.\n` +
      `Please send any evidence and messages **here in this thread**. ` +
      `We’ll mirror everything privately for the referees.`,
    allowedMentions: { users: [message.author.id] } // only ping the author
  });

  // ➕ ADD THIS LINE to DM them the thread link too
  await dmDisputeRaiser(message, disputeThread);
}

    // DEBUG: why we might be skipping
    const inDispute =
      message.channel.id === DISPUTE_CHANNEL_ID ||
      message.channel?.parentId === DISPUTE_CHANNEL_ID;
    const mentioned = messageMentionsRole(message, TRIGGER_ROLE_ID);

    if (inDispute && mentioned) {
      console.log('✅ Trigger detected in dispute area',
        'msgCh=', message.channel.id,
        'parent=', message.channel?.parentId,
        'roleMentions=', [...message.mentions.roles.keys()]
      );
    } else {
      console.log('⏭️ Skipping message',
        'inDispute=', inDispute,
        'mentioned=', mentioned,
        'msgCh=', message.channel.id,
        'parent=', message.channel?.parentId,
        'roleMentions=', [...message.mentions.roles.keys()]
      );
    }

    if (!inDispute) return;
    if (!mentioned) return;

    const isThread =
      message.channel.type === ChannelType.PublicThread || message.channel.type === ChannelType.PrivateThread;
    const disputeThread = isThread ? message.channel : null;

    if (disputeThread && !disputeToRefThread.has(disputeThread.id)) {
  // Ask preset questions (once per dispute thread)
  await message.channel.send(
    `Thanks for tagging <@&${REF_ROLE_ID}>.\nPlease answer the following:\n- ${PRESET_QUERIES.join('\n- ')}`
  );

  // Greet & instruct the player in the *dispute* thread (not the ref thread)
  await message.reply({
    content:
      `👋 Hi <@${message.author.id}>, this is the **Gymbreakers Referee Team**.\n` +
      `Please send any evidence and messages **here in this thread**. ` +
      `We’ll mirror everything privately for the referees.`,
    allowedMentions: { users: [message.author.id] } // only ping the author
  });
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

// ====== READY (config check + register commands) ======
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(token);

  // CONFIG CHECK: resolve your configured guild/channel/role
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

  // Log & register in all guilds the bot is in
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
