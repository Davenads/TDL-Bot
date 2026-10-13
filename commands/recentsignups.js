const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { buildSignupsEmbed } = require('../utils/signupEmbed');

// ---- Config ----
const SPREADSHEET_ID = process.env.TDL_SPREADSHEET_ID || '1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww';

const WARN_COLOR = 0xe53e3e;

function unavailableEmbed() {
    return new EmbedBuilder()
        .setColor(WARN_COLOR)
        .setTitle('Signups Unavailable')
        .setDescription("Could not load this week's signups right now. Please try again in a moment.")
        .setFooter({ text: 'Toeshank Dueling League' })
        .setTimestamp();
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('recentsignups')
        .setDescription("See who's signed up for this week's TDL event"),

    async execute(interaction, sheets, auth) {
        const timestamp = new Date().toISOString();

        if (!interaction.guild) {
            await interaction.reply({
                content: 'Please run `/recentsignups` in the TDL server, not in DMs.',
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        // Shared renderer: the signups read-through cache (may throw → unavailable),
        // roster mapping is non-fatal inside the builder.
        let embed;
        try {
            embed = await buildSignupsEmbed({ sheets, auth, spreadsheetId: SPREADSHEET_ID });
        } catch (error) {
            console.error(`[${timestamp}] recentsignups read failed:`, error.message);
            await interaction.editReply({ embeds: [unavailableEmbed()] });
            return;
        }

        await interaction.editReply({ embeds: [embed] });
        console.log(`[${timestamp}] recentsignups shown to ${interaction.user.tag}`);
    }
};
