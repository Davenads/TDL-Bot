const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');
const { isRegistrationOpen, getEventDateString } = require('../utils/tdlWeekUtils');
const {
    getUserSignupDivisions,
    deleteSignupRowsForUser,
    invalidateSignupsCache
} = require('../utils/signupUtils');

// ---- Config ----
const SPREADSHEET_ID = process.env.TDL_SPREADSHEET_ID || '1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww';

const BRAND_COLOR = 0x2b6cb0;
const OK_COLOR = 0x38a169;
const WARN_COLOR = 0xe53e3e;

const DIVISION_LABEL = {
    HLD: 'HLD (High Level Dueling)',
    LLD: 'LLD (Low Level Dueling)'
};

function withdrawErrorEmbed() {
    return new EmbedBuilder()
        .setColor(WARN_COLOR)
        .setTitle('Withdrawal Unavailable')
        .setDescription('Could not read this week\'s signups right now. Please try `/withdraw` again in a moment.')
        .setFooter({ text: 'Toeshank Dueling League' })
        .setTimestamp();
}

function notSignedUpEmbed() {
    return new EmbedBuilder()
        .setColor(WARN_COLOR)
        .setTitle('Nothing to Withdraw')
        .setDescription(
            `You're not signed up for **${getEventDateString()}** this week, so there's nothing to withdraw.`
        )
        .setFooter({ text: 'Toeshank Dueling League' })
        .setTimestamp();
}

/**
 * Entry flow shared by the `/withdraw` slash command and the panel's "Withdraw"
 * button. Detects which divisions the user is currently in and offers a picker
 * (one button per division, plus "Withdraw All" when they're in both). Replies
 * ephemerally for both interaction types.
 */
async function startWithdraw(interaction, sheets, auth) {
    const timestamp = new Date().toISOString();
    const user = interaction.user;

    if (!interaction.guild || !interaction.member) {
        await interaction.reply({
            content: 'Please run `/withdraw` in the TDL server, not in DMs.',
            ephemeral: true
        });
        return;
    }

    let divisions;
    try {
        divisions = await getUserSignupDivisions({ sheets, auth, spreadsheetId: SPREADSHEET_ID, uuid: user.id });
    } catch (error) {
        console.error(`[${timestamp}] Withdraw division lookup failed for ${user.tag} (${user.id}):`, error.message);
        await interaction.reply({ embeds: [withdrawErrorEmbed()], ephemeral: true });
        return;
    }

    if (!divisions.length) {
        await interaction.reply({ embeds: [notSignedUpEmbed()], ephemeral: true });
        return;
    }

    const row = new ActionRowBuilder();
    if (divisions.includes('HLD')) {
        row.addComponents(new ButtonBuilder().setCustomId('tdlwithdraw_HLD').setLabel('Withdraw HLD').setStyle(ButtonStyle.Danger));
    }
    if (divisions.includes('LLD')) {
        row.addComponents(new ButtonBuilder().setCustomId('tdlwithdraw_LLD').setLabel('Withdraw LLD').setStyle(ButtonStyle.Danger));
    }
    if (divisions.length > 1) {
        row.addComponents(new ButtonBuilder().setCustomId('tdlwithdraw_All').setLabel('Withdraw All').setStyle(ButtonStyle.Danger));
    }

    // Withdrawal is allowed anytime; just flag it softly when the window is closed.
    const softNote = isRegistrationOpen()
        ? ''
        : '\n\n_The registration window is closed, but you can still withdraw._';

    const embed = new EmbedBuilder()
        .setColor(BRAND_COLOR)
        .setTitle('Toeshank Dueling League — Withdraw')
        .setDescription(
            `Event: **${getEventDateString()} — 6:00 PM ET**\n\n` +
            `You're currently signed up for: **${divisions.join(', ')}**.\n\n` +
            'Choose which format(s) to withdraw from.' +
            softNote
        )
        .setFooter({ text: 'Toeshank Dueling League' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    console.log(`[${timestamp}] Withdraw picker shown to ${user.tag} (${user.id}) — divisions=${divisions.join(',')}`);
}

/**
 * Perform the deletion for a chosen set of categories and reply ephemerally.
 * Shared by the HLD / LLD / All picker buttons.
 */
async function performWithdraw(interaction, sheets, auth, categories) {
    const timestamp = new Date().toISOString();
    const user = interaction.user;

    await interaction.deferReply({ ephemeral: true });

    try {
        const { deleted, count } = await deleteSignupRowsForUser({
            sheets, auth, spreadsheetId: SPREADSHEET_ID, uuid: user.id, categories
        });

        if (count === 0) {
            await interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(WARN_COLOR)
                    .setTitle('Nothing to Withdraw')
                    .setDescription('You were no longer signed up for the selected format(s).')
                    .setFooter({ text: 'Toeshank Dueling League' })
                    .setTimestamp()]
            });
            return;
        }

        // The current-week signups changed — evict the read cache and refresh the
        // live panel. Both fire-and-forget so neither blocks the ephemeral reply.
        invalidateSignupsCache().catch(evErr =>
            console.error(`[${timestamp}] Signups cache evict failed (non-fatal):`, evErr.message)
        );
        require('./tdlpanel')
            .refreshSignupPanel(interaction.client, sheets, auth)
            .catch(pErr => console.error(`[${timestamp}] Panel refresh failed (non-fatal):`, pErr.message));

        console.log(`[${timestamp}] Withdraw complete for ${user.tag} (${user.id}) — deleted=${deleted.join(',')} count=${count}`);

        const uniqueDeleted = [...new Set(deleted)];
        await interaction.editReply({
            embeds: [new EmbedBuilder()
                .setColor(OK_COLOR)
                .setTitle('Withdrawal Confirmed')
                .setDescription(`You've been withdrawn from **${uniqueDeleted.join(', ')}** for **${getEventDateString()}**.`)
                .setFooter({ text: 'Toeshank Dueling League' })
                .setTimestamp()]
        });
    } catch (error) {
        console.error(`[${timestamp}] Error withdrawing ${user.tag} (${user.id}):`, error);
        await interaction.editReply({
            content: '⚠️ Withdrawal failed — could not update the sheet. Please try again in a moment.'
        });
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('withdraw')
        .setDescription('Withdraw from this week\'s Toeshank Dueling League event'),

    async execute(interaction, sheets, auth) {
        return startWithdraw(interaction, sheets, auth);
    },

    async handleButton(interaction, sheets, auth) {
        if (!interaction.customId.startsWith('tdlwithdraw_')) return false;

        // Panel "Withdraw" button → run the same detection/picker flow as /withdraw.
        if (interaction.customId === 'tdlwithdraw_panel') {
            await startWithdraw(interaction, sheets, auth);
            return true;
        }

        const choice = interaction.customId.replace('tdlwithdraw_', ''); // HLD | LLD | All

        let categories;
        if (choice === 'HLD' || choice === 'LLD') {
            categories = [choice];
        } else if (choice === 'All') {
            // Resolve the live set so "All" always matches what the user is in now.
            try {
                categories = await getUserSignupDivisions({ sheets, auth, spreadsheetId: SPREADSHEET_ID, uuid: interaction.user.id });
            } catch {
                categories = ['HLD', 'LLD'];
            }
        } else {
            await interaction.reply({ content: 'Unknown selection. Please run `/withdraw` again.', ephemeral: true });
            return true;
        }

        await performWithdraw(interaction, sheets, auth, categories);
        return true;
    }
};
