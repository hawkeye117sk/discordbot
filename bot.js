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
  'Please describe the issue.',
  'Who was involved?',
  'Please provide screenshots of your communication.',
  'For Gameplay disputes, please provide full video evidence.',
];

// ====== STATE ======
const disputeToRefThread = new Map();      // disputeThreadId -> refThreadId
const disputeToDecisionChan = new Map();   // disputeThreadId -> decisionChannelId
const playerToRefThread = new Map();       // userId -> refThreadId
const refThreadToPlayer = new Map();       // refThreadId -> userId (for commands)
const closedPlayers = new Set();           // userId set => DM mirroring disabled

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
    throw new Error('#disputes-referees must be a TEXT channel that allows private threads.');
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

  await thread.send(
    [
      `${refRoleMention} ${jrRoleMention}`,
      `**Dispute Thread** for **${playerName}**.`,
      countryLine,
      `Source: ${disputeMessage.url}`,
    ].join('\n')
  );

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
    // Fallback: post the questions publicly so the process can continue
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

// ====== MESSAGE HANDLERS ======

// 1) Trigger from dispute area → create Dispute Thread + DM the player (NO public questions)
client.on(Events.MessageCreate, async (message) => {
  try {
    if (!message.guild || message.author?.bot) return;

    const inDispute =
      message.channel.id === DISPUTE_CHANNEL_ID ||
      message.channel?.parentId === DISPUTE_CHANNEL_ID;
    const mentioned = messageMentionsRole(message, TRIGGER_ROLE_ID);

    if (!inDispute || !mentioned) return;
    console.log('✅ Trigger detected in dispute area',
      'msgCh=', message.channel.id,
      'parent=', message.channel?.parentId,
      'roleMentions=', [...message.mentions.roles.keys()]
    );

    const isThread =
      message.channel.type === ChannelType.PublicThread ||
      message.channel.type === ChannelType.PrivateThread;
    const disputeThread = isThread ? message.channel : null;

    // Extract inputs
    const countries = await extractCountries(message);
    const opponent  = extractOpponentTag(message);
    const summary   = extractIssueSummary(message);

    // Create or reuse the Dispute Thread (private thread for refs)
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

    // Seed context in Dispute Thread
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
      ].filter(Boolean).join('\n'),
    );

    // Map the player ↔ Dispute Thread
    playerToRefThread.set(message.author.id, refThread.id);
    refThreadToPlayer.set(refThread.id, message.author.id);
    closedPlayers.delete(message.author.id); // ensure open

    // DM them the questions & instructions (no public message)
    await dmDisputeRaiser(message, disputeThread);

  } catch (err) {
    console.error('Dispute trigger handler error:', err);
  }
});

// 2) Mirror player messages posted in the dispute area (optional safety)
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

// 3) Mirror player **DMs** into the Dispute Thread (blocked if Closed)
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return;
    if (message.guild) return; // only handle DMs here
    if (message.channel?.type !== ChannelType.DM) return;

    const userId = message.author.id;
    const refThreadId = playerToRefThread.get(userId);
    if (!refThreadId) return; // no active dispute mapping

    if (closedPlayers.has(userId)) {
      // Politely tell them it's closed; do not forward
      try {
        await message.reply(
          'This dispute is **Closed**. Your messages are not being forwarded. ' +
          'Please contact a referee if you believe it should be reopened.'
        );
      } catch {}
      // Optional: notify refs once per session? Keep it lightweight:
      const t = await client.channels.fetch(refThreadId).catch(() => null);
      await t?.send(`⚠️ Blocked DM from <@${userId}> because this dispute is **Closed**.`);
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
    .setDescription('Post a dispute decision from the Dispute Thread.')
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

  new SlashCommandBuilder()
    .setName('close')
    .setDescription('Mark this dispute as Closed (player DM mirroring is disabled). Use inside the Dispute Thread.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('reopen')
    .setDescription('Reopen this dispute (resume player DM mirroring). Use inside the Dispute Thread.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),
];

// Slash command logic
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  // Helper: get the player mapped to this thread
  async function getPlayerFromCurrentThread() {
    const ch = interaction.channel;
    if (!ch || (ch.type !== ChannelType.PrivateThread && ch.type !== ChannelType.PublicThread)) return null;
    const uid = refThreadToPlayer.get(ch.id)
      || [...playerToRefThread.entries()].find(([, refId]) => refId === ch.id)?.[0]
      || null;
    return uid;
  }

  if (interaction.commandName === 'close') {
    const userId = await getPlayerFromCurrentThread();
    if (!userId) return interaction.reply({ ephemeral: true, content: 'Could not resolve the dispute’s player from this thread.' });

    closedPlayers.add(userId);
    await interaction.reply({ ephemeral: true, content: 'Marked dispute as **Closed**. Player DM mirroring is now disabled.' });
    try {
      await interaction.channel.send('🔒 This dispute is now **Closed**. Further player DMs will not be mirrored.');
    } catch {}
    return;
  }

  if (interaction.commandName === 'reopen') {
    const userId = await getPlayerFromCurrentThread();
    if (!userId) return interaction.reply({ ephemeral: true, content: 'Could not resolve the dispute’s player from this thread.' });

    closedPlayers.delete(userId);
    await interaction.reply({ ephemeral: true, content: 'Marked dispute as **Open**. Player DM mirroring resumed.' });
    try {
      await interaction.channel.send('🔓 This dispute has been **Reopened**. Player DMs will be mirrored again.');
    } catch {}
    return;
  }

  if (interaction.commandName === 'decision') {
    try {
      const current = interaction.channel;
      if (current?.type !== ChannelType.PrivateThread && current?.type !== ChannelType.PublicThread) {
        return interaction.reply({ ephemeral: true, content: 'Use this command from within the Dispute Thread (or specify a channel).' });
      }

      // Find linked dispute thread for this Dispute Thread
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

      // Try to pull two countries for header (best effort from thread name)
      let countries = [];
      try {
        const refThread = current;
        if (refThread?.name?.includes('–')) {
          const parts = refThread.name.split('–').map(s => s.trim());
          const vs = parts.pop();
          if (vs?.includes('vs')) countries = vs.split('vs').map(s => s.replace(/-/g, ' ').trim());
        }
      } catch {}

      // Try to detect main players mentioned in the dispute thread
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

      const teamRuleTextLines = (() => {
        switch (rule) {
          case 'same_teams_same_lead': return ['The same teams must be used, with the same lead Pokémon.'];
          case 'same_lead_flex_back':  return ['The same lead Pokémon must be used, the back line may be changed.'];
          case 'new_teams':            return ['New teams may be used.'];
          default: return [];
        }
      })();

      const body = [
        header,
        '',
        playersLine || '@Playername1 @Playername2',
        `After reviewing the match dispute set by <@${interaction.user.id}> regarding ${issue}. The Referees team has decided that a rematch **${grant}** be granted.`,
        '',
        ...teamRuleTextLines,
        '',
        'We would like to remind all parties involved that referees and staff members from countries involved in disputes cannot be involved in the resolution of the dispute.'
      ].join('\n');

      await targetChannel.send(body);
      await interaction.reply({ ephemeral: true, content: `Posted decision to <#${targetChannel.id}>.` });
    } catch (e) {
      console.error(e);
      try {
        await interaction.reply({ ephemeral: true, content: 'Failed to post decision. Check my permissions and try again.' });
      } catch {}
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

  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('ℹ️ Global commands pushed (may take time to appear).');
  } catch (e) {
    console.error('❌ Global registration failed:', e?.code || e?.message || e);
  }
});

// ====== BOOT ======
client.login(token);
