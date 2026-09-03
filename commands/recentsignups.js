const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getEventDateString } = require('../utils/tdlWeekUtils');
const { COL, getCurrentWeekSignups } = require('../utils/signupUtils');
const { getRosterMap } = require('../utils/rosterUtils');

// ---- Config ----
const SPREADSHEET_ID = process.env.TDL_SPREADSHEET_ID || '1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww';
const DIVISIONS = ['HLD', 'LLD'];

const BRAND_COLOR = 0x2b6cb0;
const WARN_COLOR = 0xe53e3e;

function unavailableEmbed() {
    return new EmbedBuilder()
        .setColor(WARN_COLOR)
        .setTitle('Signups Unavailable')
        .setDescription("Could not load this week's signups right now. Please try again in a moment.")
        .setFooter({ text: 'Toeshank Dueling League' })
        .setTimestamp();
}

/**
 * Join a division's names into an embed field value, staying under the 1024-char
 * cap by truncating with a "+N more" tail.
 */
function fieldValue(names) {
    if (names.length === 0) return '_None yet_';
    const full = names.join(', ');
    if (full.length <= 1000) return full;
    const shown = [];
    let len = 0;
    for (const n of names) {
        if (len + n.length + 2 > 950) break;
        shown.push(n);
        len += n.length + 2;
    }
    return `${shown.join(', ')} …(+${names.length - shown.length} more)`;
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

        // Current-week signups (cached read-through; fails loud → "unavailable").
        let rows;
        try {
            rows = await getCurrentWeekSignups({ sheets, auth, spreadsheetId: SPREADSHEET_ID });
        } catch (error) {
            console.error(`[${timestamp}] recentsignups read failed:`, error.message);
            await interaction.editReply({ embeds: [unavailableEmbed()] });
            return;
        }

        // Resolve Data Names via the cached roster map. Non-fatal: fall back to
        // the stored Discord username if the roster read hiccups.
        let rosterMap = {};
        try {
            rosterMap = await getRosterMap({ sheets, auth, spreadsheetId: SPREADSHEET_ID });
        } catch (rosterErr) {
            console.error(`[${timestamp}] recentsignups roster lookup failed (non-fatal):`, rosterErr.message);
        }
        const nameFor = (uuid, fallback) =>
            (rosterMap[uuid] && rosterMap[uuid].dataName) || fallback || 'Unknown';

        // Group by division, deduped by UUID (upsert already guarantees one row
        // per UUID+division, but manual sheet edits could double up).
        const byDivision = {};
        for (const div of DIVISIONS) byDivision[div] = new Map(); // uuid -> display name
        const allUuids = new Set();
        for (const row of rows) {
            const div = row[COL.CATEGORY];
            if (!byDivision[div]) continue; // ignore any unexpected category
            const uuid = row[COL.UUID];
            if (!uuid) continue;
            byDivision[div].set(uuid, nameFor(uuid, row[COL.USERNAME]));
            allUuids.add(uuid);
        }

        const embed = new EmbedBuilder()
            .setColor(BRAND_COLOR)
            .setTitle('TDL Signups')
            .setDescription(
                `Event: **${getEventDateString()} — 6:00 PM ET**\n` +
                `**${allUuids.size}** ${allUuids.size === 1 ? 'dueler' : 'duelers'} signed up so far.`
            )
            .setFooter({ text: 'Toeshank Dueling League' })
            .setTimestamp();

        for (const div of DIVISIONS) {
            const names = [...byDivision[div].values()].sort((a, b) => a.localeCompare(b));
            embed.addFields({ name: `${div} (${names.length})`, value: fieldValue(names), inline: false });
        }

        await interaction.editReply({ embeds: [embed] });
        console.log(`[${timestamp}] recentsignups shown to ${interaction.user.tag} — ${allUuids.size} duelers`);
    }
};
