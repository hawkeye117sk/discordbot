// bot.js — Discord Disputes Bot (ESM, Node 18+)
// -------------------------------------------------

import 'dotenv/config';
import {
  Client, GatewayIntentBits, Partials, Events, ChannelType,
  ThreadAutoArchiveDuration, SlashCommandBuilder, Routes, REST,
  PermissionFlagsBits
} from 'discord.js';

// ====== ENV & SAFETY CHECKS ======
const token = (process.env.DISCORD_TOKEN ?? '').trim();
if (!token || !token.includes('.')) {
  console.error('❌ DISCORD_TOKEN missing/invalid. Set it in Railway → Service → Variables (service-level), then redeploy.');
  process.exit(1);
}

const {
  GUILD_ID,
  DISPUTE_CHANNEL_ID,            // #dispute-request (forum or normal channel)
  REF_HUB_CHANNEL_ID,            // #dispute-referees (text channel where private threads are created)
  REF_ROLE_ID,                   // @referee role ID
  JR_REF_ROLE_ID,                // @junior referee role ID
  TRIGGER_ROLE_ID,               // which role mention triggers the bot (usually same as REF_ROLE_ID)
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

// ====== STATE (swap to DB if you need persistence) ======
const disputeToRefThread = new Map();   // disputeThreadId -> refThreadId
const disputeToDecisionChan = new Map();// disputeThreadId -> decisionChannelId
const playerToRefThread = new Map();    // userId -> refThreadId (for mirroring)

// ====== CLIENT ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,     // required to read roles for conflict removal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent    // required to read message text
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

// ====== UTILS ======
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function messageMentionsRole(message, roleId) {
  return message.mentions.roles.has(roleId) ||
         message.content.includes(`<@
