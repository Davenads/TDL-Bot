const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v9');
require('dotenv').config();

// -------------------------------------------------------------------------
// Removes registered slash commands. Use this to clean up stale/duplicate
// commands (e.g. if commands were ever registered globally and now show up
// twice alongside the guild-scoped ones).
//
// Usage:
//   node clear-commands.js            -> clears the TEST + PROD guilds
//   node clear-commands.js --global   -> ALSO clears GLOBAL commands
//   node clear-commands.js --global-only
//                                     -> clears GLOBAL only (leave guilds alone)
//
// Clearing works by PUTting an empty command array to the endpoint.
// -------------------------------------------------------------------------

const { BOT_TOKEN, CLIENT_ID, GUILD_ID, PROD_GUILD_ID } = process.env;

if (!BOT_TOKEN || !CLIENT_ID) {
    console.error('Missing BOT_TOKEN or CLIENT_ID in .env.');
    process.exit(1);
}

const args = process.argv.slice(2);
const clearGlobal = args.includes('--global') || args.includes('--global-only');
const clearGuilds = !args.includes('--global-only');

const rest = new REST({ version: '9' }).setToken(BOT_TOKEN);

(async () => {
    if (clearGuilds) {
        const targets = [];
        if (GUILD_ID) targets.push({ label: 'TEST', id: GUILD_ID });
        if (PROD_GUILD_ID) targets.push({ label: 'PRODUCTION', id: PROD_GUILD_ID });

        for (const target of targets) {
            try {
                console.log(`Clearing ${target.label} guild (${target.id})...`);
                await rest.put(Routes.applicationGuildCommands(CLIENT_ID, target.id), { body: [] });
                console.log(`  Cleared ${target.label} guild commands.`);
            } catch (error) {
                console.error(`  Failed to clear ${target.label} guild: ${error.message}`);
            }
        }
    }

    if (clearGlobal) {
        try {
            console.log('Clearing GLOBAL commands...');
            await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
            console.log('  Cleared global commands.');
        } catch (error) {
            console.error(`  Failed to clear global commands: ${error.message}`);
        }
    }
})();
