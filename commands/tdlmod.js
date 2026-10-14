const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');
const { buildModSignupsEmbed } = require('../utils/signupEmbed');
// Reuse the panel's OR gate (panel-admin role ID OR a role named "Moderator")
// and the live-panel refresher.
const { memberCanManagePanel, refreshSignupPanel } = require('./tdlpanel');

// ---- Config ----
const SPREADSHEET_ID = process.env.TDL_SPREADSHEET_ID || '1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww';

const BRAND_COLOR = 0x2b6cb0;

function denyReply(interaction) {
    return interaction.reply({
        content: 'You need the **Moderator** role to use TDL mod tools.',
        ephemeral: true
    });
}

function modMenuEmbed() {
    return new EmbedBuilder()
        .setColor(BRAND_COLOR)
        .setTitle('TDL Mod Tools')
        .setDescription(
            'Choose an action:\n\n' +
            '**View Signups** — see who\'s signed up this week (Data Name + Discord name). Mod-only; the public panel shows counts only.\n' +
            '**Refresh Panel** — force the public signup panel to refresh now (e.g. after a manual sheet edit).'
        )
        .setFooter({ text: 'Toeshank Dueling League' });
}

function modMenuRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tdlmod_view').setLabel('View Signups').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('tdlmod_refresh').setLabel('Refresh Panel').setStyle(ButtonStyle.Secondary)
    );
}

/**
 * Entry flow shared by `/tdlmod` (and any future panel entry). Gates on the mod
 * role and replies ephemerally with the mod-tools menu.
 */
async function startModTools(interaction) {
    if (!interaction.guild || !interaction.member) {
        await interaction.reply({ content: 'Run `/tdlmod` in the TDL server, not in DMs.', ephemeral: true });
        return;
    }
    if (!memberCanManagePanel(interaction.member)) {
        await denyReply(interaction);
        return;
    }
    await interaction.reply({ embeds: [modMenuEmbed()], components: [modMenuRow()], ephemeral: true });
}

module.exports = {
    // Exposed for unit testing.
    startModTools,

    data: new SlashCommandBuilder()
        .setName('tdlmod')
        .setDescription('Moderator tools for TDL signups')
        // Hidden by default (admins only); grant the mod role access via
        // Server Settings → Integrations → TDL-Bot → /tdlmod.
        .setDefaultMemberPermissions('0'),

    async execute(interaction, sheets, auth) {
        return startModTools(interaction);
    },

    async handleButton(interaction, sheets, auth) {
        if (!interaction.customId.startsWith('tdlmod_')) return false;

        // Gate every mod action server-side (defense in depth).
        if (!memberCanManagePanel(interaction.member)) {
            await denyReply(interaction);
            return true;
        }

        const timestamp = new Date().toISOString();

        if (interaction.customId === 'tdlmod_view') {
            await interaction.deferReply({ ephemeral: true });
            try {
                const embed = await buildModSignupsEmbed({ sheets, auth, spreadsheetId: SPREADSHEET_ID });
                await interaction.editReply({ embeds: [embed] });
                console.log(`[${timestamp}] tdlmod view by ${interaction.user.tag}`);
            } catch (error) {
                console.error(`[${timestamp}] tdlmod view failed:`, error.message);
                await interaction.editReply({ content: 'Could not load this week\'s signups right now. Please try again in a moment.' });
            }
            return true;
        }

        if (interaction.customId === 'tdlmod_refresh') {
            await interaction.deferReply({ ephemeral: true });
            try {
                const ok = await refreshSignupPanel(interaction.client, sheets, auth);
                await interaction.editReply({ content: ok ? 'Signup panel refreshed.' : 'No bound panel to refresh.' });
                console.log(`[${timestamp}] tdlmod refresh by ${interaction.user.tag} — refreshed=${ok}`);
            } catch (error) {
                console.error(`[${timestamp}] tdlmod refresh failed:`, error.message);
                await interaction.editReply({ content: 'Panel refresh failed. Please try again in a moment.' });
            }
            return true;
        }

        await interaction.reply({ content: 'Unknown mod action. Please run `/tdlmod` again.', ephemeral: true });
        return true;
    }
};
