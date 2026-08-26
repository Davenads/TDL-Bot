require('dotenv').config();
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const http = require('http');
const { createGoogleAuth } = require('./utils/googleAuth');
const redisClient = require('./utils/redisClient');

const PREFIX = '!';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Google Sheets API (single shared auth + client, passed into commands).
const sheets = google.sheets('v4');
const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets']);

// ---- Load commands ----
client.commands = new Collection();
client.commandAliases = new Collection();

const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const command = require(path.join(commandsPath, file));
    if (!command.data || !command.execute) {
        console.warn(`Skipping invalid command file: ${file}`);
        continue;
    }
    client.commands.set(command.data.name, command);
    client.commandAliases.set(command.data.name.toLowerCase(), command.data.name);
    console.log(`Command loaded: ${command.data.name}`);
}

// ---- Button routing (O(1) by customId prefix before the first underscore) ----
const BUTTON_ROUTING = {
    tdlsignup: 'signup'
};

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);

    // Redis is optional (phase-2 caching). Never let its absence take the bot down.
    try {
        await redisClient.connect();
        console.log('Redis connection established');
    } catch (error) {
        console.warn('Redis unavailable — continuing without cache:', error.message);
    }
});

// ---- Interaction handling ----
client.on('interactionCreate', async (interaction) => {
    if (interaction.isCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        // Generic role gating hook (commands may set `role` to a required role name).
        if (command.role && !interaction.member?.roles?.cache?.some(r => r.name === command.role)) {
            return interaction.reply({
                content: `You do not have the required ${command.role} role to use this command.`,
                ephemeral: true
            });
        }

        try {
            await command.execute(interaction, sheets, auth);
        } catch (error) {
            console.error(`Error executing command ${interaction.commandName}:`, error);
            const msg = { content: 'There was an error while executing this command!', ephemeral: true };
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(msg).catch(() => {});
            } else {
                await interaction.reply(msg).catch(() => {});
            }
        }
    } else if (interaction.isButton()) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] Button: ${interaction.customId} from ${interaction.user.tag}`);

        const prefix = interaction.customId.split('_')[0];
        const commandName = BUTTON_ROUTING[prefix];
        const command = commandName ? client.commands.get(commandName) : null;

        if (command && typeof command.handleButton === 'function') {
            try {
                const result = await command.handleButton(interaction, sheets, auth);
                if (!result && !interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'This interaction is no longer available.', ephemeral: true });
                }
            } catch (error) {
                console.error(`[${timestamp}] Error handling button ${interaction.customId}:`, error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'There was an error handling this interaction!', ephemeral: true }).catch(() => {});
                }
            }
        } else {
            console.warn(`[${timestamp}] No handler for button prefix: ${prefix}`);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: 'This interaction is no longer available.', ephemeral: true }).catch(() => {});
            }
        }
    } else if (interaction.isModalSubmit()) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] Modal: ${interaction.customId} from ${interaction.user.tag}`);

        let handled = false;
        for (const command of client.commands.values()) {
            if (typeof command.handleModal !== 'function') continue;
            try {
                const result = await command.handleModal(interaction, sheets, auth);
                if (result) {
                    handled = true;
                    break;
                }
            } catch (error) {
                console.error(`[${timestamp}] Error handling modal ${interaction.customId}:`, error);
                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({ content: 'There was an error handling this submission!', ephemeral: true }).catch(() => {});
                }
                handled = true;
                break;
            }
        }

        if (!handled && !interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'This submission is no longer available.', ephemeral: true }).catch(() => {});
        }
    } else if (interaction.isAutocomplete()) {
        const command = client.commands.get(interaction.commandName);
        if (!command || typeof command.autocomplete !== 'function') return;
        try {
            await command.autocomplete(interaction);
        } catch (error) {
            console.error('Autocomplete error:', error);
        }
    }
});

// ---- Minimal prefix support ----
// The signup wizard relies on slash interactions (buttons/modals), so `!signup`
// simply points users to the slash command.
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith(PREFIX)) return;
    const name = message.content.slice(PREFIX.length).trim().split(/ +/)[0].toLowerCase();
    if (name === 'signup') {
        message.reply('Please use the `/signup` slash command to register for TDL.').catch(() => {});
    }
});

client.login(process.env.BOT_TOKEN);

// ---- Heroku port binding (web dyno) ----
if (process.env.PORT || process.env.NODE_ENV === 'production') {
    const PORT = process.env.PORT || 3000;
    http.createServer((req, res) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain');
        res.end('TDL bot is running!\n');
    }).listen(PORT, () => {
        console.log(`HTTP server running on port ${PORT}`);
    });
} else {
    console.log('Running in development mode without HTTP server');
}
