client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(token);

  // Log every guild the bot is in
  const guilds = await client.guilds.fetch();
  console.log(
    'Guilds I am in:',
    [...guilds.values()].map(g => `${g.name} (${g.id})`).join(', ')
  );

  // Register commands in every guild I'm in (avoids a wrong GUILD_ID blocking you)
  for (const [id, g] of guilds) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, id), { body: slashCommands });
      console.log(`✅ Commands registered in guild: ${g.name} (${id})`);
    } catch (e) {
      console.error(`❌ Failed to register in guild ${g.name} (${id}):`, e?.code || e?.message || e);
    }
  }

  // Optional fallback: also push global (may take up to ~1 hour to appear)
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: slashCommands });
    console.log('ℹ️ Global commands pushed (may take time to appear).');
  } catch (e) {
    console.error('❌ Global command registration failed:', e?.code || e?.message || e);
  }
});
