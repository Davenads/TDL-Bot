const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config();

// -------------------------------------------------------------------------
// Registers slash commands to specific GUILDS (servers), NOT globally.
//
// Guild-scoped registration is instant (global can take up to ~1 hour to
// propagate) and keeps commands confined to the test + production servers.
//
// Targets, in order:
//   GUILD_ID       -> test server   (always registered if set)
//   PROD_GUILD_ID  -> production    (registered only if set)
// -------------------------------------------------------------------------

// ---- Preflight: fail fast with a clear message if env is incomplete ----
const { BOT_TOKEN, CLIENT_ID, GUILD_ID, PROD_GUILD_ID } = process.env;

const missing = [];
if (!BOT_TOKEN) missing.push('BOT_TOKEN');
if (!CLIENT_ID) missing.push('CLIENT_ID');
if (missing.length) {
    console.error(`Missing required env var(s): ${missing.join(', ')}. Check your .env file.`);
    process.exit(1);
}

const targets = [];
if (GUILD_ID) targets.push({ label: 'TEST', id: GUILD_ID });
if (PROD_GUILD_ID) targets.push({ label: 'PRODUCTION', id: PROD_GUILD_ID });
if (targets.length === 0) {
    console.error('No guild targets defined. Set GUILD_ID and/or PROD_GUILD_ID in .env.');
    process.exit(1);
}

// ---- Load command definitions ----
const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    if (command.data) {
        commands.push(command.data.toJSON());
        console.log(`  + ${command.data.name}`);
    } else {
        console.warn(`  ! Skipping ${file} (no .data export)`);
    }
}
console.log(`Loaded ${commands.length} command(s).`);

const rest = new REST({ version: '9' }).setToken(BOT_TOKEN);

(async () => {
    for (const target of targets) {
        try {
            console.log(`\nRegistering to ${target.label} guild (${target.id})...`);
            await rest.put(
                Routes.applicationGuildCommands(CLIENT_ID, target.id),
                { body: commands }
            );
            console.log(`Success: ${commands.length} command(s) live in the ${target.label} guild.`);
        } catch (error) {
            console.error(`Failed to register to ${target.label} guild (${target.id}):`);
            if (error.status === 403) {
                console.error('  403 Missing Access — the bot must be a MEMBER of this guild first. Invite it, then re-run.');
            } else if (error.status === 401) {
                console.error('  401 Unauthorized — BOT_TOKEN is wrong or was reset.');
            } else {
                console.error(`  ${error.message}`);
            }
        }
    }
})();
