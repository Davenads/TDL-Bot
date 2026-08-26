const {
    SlashCommandBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const {
    isRegistrationOpen,
    getWeekStartDate,
    getEventDateString,
    formatSheetTimestamp
} = require('../utils/tdlWeekUtils');

// ---- Config ----
const DUELER_ROLE = process.env.DUELER_ROLE_NAME || 'Dueler';
const SPREADSHEET_ID = process.env.TDL_SPREADSHEET_ID || '1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww';
const REG_TAB = process.env.TEST_MODE === 'true' ? 'Registration Test' : 'Registration';
// Optional dedicated channel for public signup confirmations; falls back to the invoking channel.
const SIGNUP_CHANNEL_ID = process.env.SIGNUP_CHANNEL_ID || null;

// Reshaped Registration tab: A=Timestamp, B=Discord UUID, C=Discord Username, D=Notes, E=Category
const COL = { TIMESTAMP: 0, UUID: 1, USERNAME: 2, NOTES: 3, CATEGORY: 4 };

// A "Both" selection expands into two independent division rows (see plan 01/02).
const CATEGORY_DIVISIONS = {
    HLD: ['HLD'],
    LLD: ['LLD'],
    Both: ['HLD', 'LLD']
};
const CATEGORY_LABEL = {
    HLD: 'HLD (High Level Dueling)',
    LLD: 'LLD (Low Level Dueling)',
    Both: 'Both (HLD + LLD)'
};

const BRAND_COLOR = 0x2b6cb0;
const OK_COLOR = 0x38a169;
const WARN_COLOR = 0xe53e3e;

/**
 * Does the invoking member have the required @Dueler role?
 */
function hasDuelerRole(interaction) {
    const roles = interaction.member && interaction.member.roles && interaction.member.roles.cache;
    if (!roles) return false;
    return roles.some(r => r.name === DUELER_ROLE);
}

function windowClosedEmbed() {
    return new EmbedBuilder()
        .setColor(WARN_COLOR)
        .setTitle('Registration Closed')
        .setDescription(
            'TDL registration is currently closed.\n\n' +
            '**Registration Window**\n' +
            'Opens: **Tuesday 12:00 AM ET**\n' +
            'Closes: **Sunday 11:59 PM ET**\n\n' +
            'Signups close the day before the event so matchups can be built. ' +
            'The event runs **Mondays at 6:00 PM ET**.'
        )
        .setFooter({ text: 'Toeshank Dueling League' })
        .setTimestamp();
}

function noRoleEmbed() {
    return new EmbedBuilder()
        .setColor(WARN_COLOR)
        .setTitle('Missing Role')
        .setDescription(`You need the **@${DUELER_ROLE}** role to sign up for TDL.`)
        .setFooter({ text: 'Toeshank Dueling League' })
        .setTimestamp();
}

/**
 * Upsert one row per division into the Registration tab.
 * Dedupe key = (Discord UUID + Category) within the current registration week.
 * Existing row -> overwrite (refresh timestamp + notes). None -> append at next row.
 *
 * @returns {Promise<Array<{category:string, action:'created'|'updated'}>>}
 */
async function upsertSignups({ sheets, auth, uuid, username, notes, divisions }) {
    const res = await sheets.spreadsheets.values.get({
        auth,
        spreadsheetId: SPREADSHEET_ID,
        range: `${REG_TAB}!A:E`
    });

    const rows = res.data.values || [];
    const weekStart = getWeekStartDate();
    const timestamp = formatSheetTimestamp();
    let nextRow = rows.length + 1; // 1-based sheet row for the next append
    const results = [];

    for (const category of divisions) {
        // Find an existing current-week row for this (UUID + Category).
        let matchRow = -1; // 1-based sheet row
        for (let i = 1; i < rows.length; i++) { // skip header (row 0)
            const row = rows[i];
            if (!row || !row[COL.TIMESTAMP]) continue;
            const rowDate = new Date(row[COL.TIMESTAMP]);
            if (isNaN(rowDate.getTime()) || rowDate < weekStart) continue;
            if (row[COL.UUID] === uuid && row[COL.CATEGORY] === category) {
                matchRow = i + 1;
                break;
            }
        }

        const values = [[timestamp, uuid, username, notes, category]];

        if (matchRow > 0) {
            await sheets.spreadsheets.values.update({
                auth,
                spreadsheetId: SPREADSHEET_ID,
                range: `${REG_TAB}!A${matchRow}:E${matchRow}`,
                valueInputOption: 'RAW',
                requestBody: { values }
            });
            results.push({ category, action: 'updated' });
        } else {
            await sheets.spreadsheets.values.update({
                auth,
                spreadsheetId: SPREADSHEET_ID,
                range: `${REG_TAB}!A${nextRow}:E${nextRow}`,
                valueInputOption: 'RAW',
                requestBody: { values }
            });
            // Reflect locally so a second division in the same call increments correctly.
            rows[nextRow - 1] = values[0];
            nextRow++;
            results.push({ category, action: 'created' });
        }
    }

    return results;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('signup')
        .setDescription('Sign up for the weekly Toeshank Dueling League event'),

    async execute(interaction) {
        const timestamp = new Date().toISOString();
        const user = interaction.user;

        // Guild-only (public confirmation + role check both require guild context).
        if (!interaction.guild || !interaction.member) {
            await interaction.reply({
                content: 'Please run `/signup` in the TDL server, not in DMs.',
                ephemeral: true
            });
            return;
        }

        // Chrono gate.
        if (!isRegistrationOpen()) {
            console.log(`[${timestamp}] Signup blocked (window closed) for ${user.tag} (${user.id})`);
            await interaction.reply({ embeds: [windowClosedEmbed()], ephemeral: true });
            return;
        }

        // Role gate.
        if (!hasDuelerRole(interaction)) {
            console.log(`[${timestamp}] Signup blocked (no ${DUELER_ROLE} role) for ${user.tag} (${user.id})`);
            await interaction.reply({ embeds: [noRoleEmbed()], ephemeral: true });
            return;
        }

        // Step 1: division selection.
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('tdlsignup_HLD').setLabel('HLD').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tdlsignup_LLD').setLabel('LLD').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('tdlsignup_Both').setLabel('Both').setStyle(ButtonStyle.Success)
        );

        const embed = new EmbedBuilder()
            .setColor(BRAND_COLOR)
            .setTitle('Toeshank Dueling League — Signup')
            .setDescription(
                `Event: **${getEventDateString()} — 6:00 PM ET**\n\n` +
                '**Step 1:** Choose your division.\n' +
                '- **HLD** — High Level Dueling\n' +
                '- **LLD** — Low Level Dueling\n' +
                '- **Both** — sign up for both'
            )
            .setFooter({ text: 'Toeshank Dueling League' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
        console.log(`[${timestamp}] Division selection shown to ${user.tag} (${user.id})`);
    },

    async handleButton(interaction) {
        if (!interaction.customId.startsWith('tdlsignup_')) return false;

        const category = interaction.customId.replace('tdlsignup_', ''); // HLD | LLD | Both
        if (!CATEGORY_DIVISIONS[category]) {
            await interaction.reply({ content: 'Unknown division. Please run `/signup` again.', ephemeral: true });
            return true;
        }

        // Show the optional-notes modal. Category is carried in the modal customId,
        // so no session store is required.
        const modal = new ModalBuilder()
            .setCustomId(`tdlsignup_modal_${category}`)
            .setTitle(`TDL Signup — ${category}`);

        modal.addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('notes')
                    .setLabel('Notes (optional)')
                    .setStyle(TextInputStyle.Paragraph)
                    .setMaxLength(300)
                    .setRequired(false)
                    .setPlaceholder('e.g. preferred build or availability. Do not share sensitive info.')
            )
        );

        await interaction.showModal(modal);
        return true;
    },

    async handleModal(interaction, sheets, auth) {
        if (!interaction.customId.startsWith('tdlsignup_modal_')) return false;

        const timestamp = new Date().toISOString();
        const user = interaction.user;
        const category = interaction.customId.replace('tdlsignup_modal_', '');
        const divisions = CATEGORY_DIVISIONS[category];

        if (!divisions) {
            await interaction.reply({ content: 'Unknown division. Please run `/signup` again.', ephemeral: true });
            return true;
        }

        await interaction.deferReply({ ephemeral: true });

        let notes = '';
        try {
            notes = (interaction.fields.getTextInputValue('notes') || '').trim();
        } catch {
            notes = '';
        }

        const uuid = user.id;
        const username = user.username || user.globalName || user.tag || 'Unknown';

        try {
            const results = await upsertSignups({ sheets, auth, uuid, username, notes, divisions });

            const createdCount = results.filter(r => r.action === 'created').length;
            const updatedCount = results.filter(r => r.action === 'updated').length;
            const verb = createdCount === 0 ? 'Updated' : 'Registered';

            console.log(`[${timestamp}] Signup ${verb} for ${user.tag} (${user.id}) — category=${category} results=${JSON.stringify(results)}`);

            // Ephemeral summary (private, includes per-division status).
            const summary = new EmbedBuilder()
                .setColor(OK_COLOR)
                .setTitle('Signup Confirmed')
                .setDescription(`You're set for **${getEventDateString()} — 6:00 PM ET**.`)
                .addFields(
                    { name: 'Division', value: CATEGORY_LABEL[category], inline: true },
                    {
                        name: 'Status',
                        value: results.map(r => `${r.category}: ${r.action}`).join('\n'),
                        inline: true
                    }
                )
                .setFooter({ text: 'Toeshank Dueling League' })
                .setTimestamp();
            if (notes) summary.addFields({ name: 'Notes', value: notes, inline: false });

            await interaction.editReply({ embeds: [summary] });

            // Public confirmation (no UUID). "updated" phrasing when nothing new was created.
            const action = createdCount === 0 ? 'updated their TDL signup' : 'signed up for TDL';
            const publicEmbed = new EmbedBuilder()
                .setColor(OK_COLOR)
                .setDescription(
                    `**${username}** ${action} — ${getEventDateString()}, 6:00 PM ET\n` +
                    `**Division:** ${CATEGORY_LABEL[category]}` +
                    (notes ? `\n**Notes:** ${notes}` : '')
                )
                .setFooter({ text: 'Toeshank Dueling League' })
                .setTimestamp();

            try {
                let target = interaction.channel;
                if (SIGNUP_CHANNEL_ID) {
                    try {
                        const configured = await interaction.client.channels.fetch(SIGNUP_CHANNEL_ID);
                        if (configured && typeof configured.send === 'function') target = configured;
                    } catch (chErr) {
                        console.error(`[${timestamp}] SIGNUP_CHANNEL_ID ${SIGNUP_CHANNEL_ID} unavailable, using invoking channel:`, chErr.message);
                    }
                }
                await target.send({ embeds: [publicEmbed] });
            } catch (postErr) {
                console.error(`[${timestamp}] Failed to post public confirmation:`, postErr.message);
            }
        } catch (error) {
            console.error(`[${timestamp}] Error writing signup for ${user.tag} (${user.id}):`, error);
            await interaction.editReply({
                content: '⚠️ Signup failed — could not write to the sheet. Please try again in a moment.'
            });
        }

        return true;
    }
};
