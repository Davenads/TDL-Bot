/**
 * Shared renderer for the "who's signed up this week" embed.
 *
 * Single source of truth for the current-week roster view, used by BOTH:
 *   - `/recentsignups` (ephemeral, on demand) — full NAME list per division, and
 *   - the persistent signup panel (Embed B, refreshed live) — COUNTS only
 *     (`countsOnly: true`), i.e. how many duelers are in each format.
 *
 * Names-only mode: grouped by division (`HLD (n)` / `LLD (n)`), sorted, deduped
 * by UUID. Data Names come from the cached Roster map; a missing roster entry (or
 * a roster read hiccup) falls back to the stored Discord username, then 'Unknown'.
 * Counts-only mode skips the roster lookup entirely (no names rendered).
 *
 * Read freshness is the CALLER's concern: this builds off `getCurrentWeekSignups`
 * (read-through cache). The panel refresher evicts first for a forced-fresh view;
 * `/recentsignups` rides the cache. The signups read may THROW (Sheets down) —
 * callers decide how to present that (e.g. an "unavailable" embed). The roster
 * read is non-fatal here (degrades to usernames).
 */

const { EmbedBuilder } = require('discord.js');
const { getEventDateString } = require('./tdlWeekUtils');
const { COL, getCurrentWeekSignups } = require('./signupUtils');
const { getRosterMap } = require('./rosterUtils');

const DIVISIONS = ['HLD', 'LLD'];
const BRAND_COLOR = 0x2b6cb0;

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

/**
 * Build the current-week signups embed.
 *
 * @param {object} args
 * @param {object} args.sheets - googleapis sheets client
 * @param {object} args.auth   - google auth
 * @param {string} args.spreadsheetId
 * @param {boolean} [args.countsOnly=false] - Render per-division COUNTS only
 *   (no names, no roster lookup). Used by the public panel.
 * @returns {Promise<EmbedBuilder>}
 * @throws if the signups Sheets read fails (caller presents "unavailable").
 */
async function buildSignupsEmbed({ sheets, auth, spreadsheetId, countsOnly = false }) {
    const rows = await getCurrentWeekSignups({ sheets, auth, spreadsheetId });

    // Resolve Data Names via the cached roster map — only when we render names.
    // Non-fatal: fall back to the stored Discord username if the roster hiccups.
    let rosterMap = {};
    if (!countsOnly) {
        try {
            rosterMap = await getRosterMap({ sheets, auth, spreadsheetId });
        } catch (rosterErr) {
            console.error(`[${new Date().toISOString()}] buildSignupsEmbed roster lookup failed (non-fatal):`, rosterErr.message);
        }
    }
    const nameFor = (uuid, fallback) =>
        (rosterMap[uuid] && rosterMap[uuid].dataName) || fallback || 'Unknown';

    // Group by division, deduped by UUID (upsert guarantees one row per
    // UUID+division, but manual sheet edits could double up).
    const byDivision = {};
    for (const div of DIVISIONS) byDivision[div] = new Map(); // uuid -> display name
    const allUuids = new Set();
    for (const row of rows) {
        const div = row[COL.CATEGORY];
        if (!byDivision[div]) continue; // ignore any unexpected category
        const uuid = row[COL.UUID];
        if (!uuid) continue;
        byDivision[div].set(uuid, countsOnly ? true : nameFor(uuid, row[COL.USERNAME]));
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

    if (countsOnly) {
        // Public panel: just the headcount per format, no names.
        for (const div of DIVISIONS) {
            const n = byDivision[div].size;
            embed.addFields({ name: div, value: `**${n}** signed up`, inline: true });
        }
    } else {
        for (const div of DIVISIONS) {
            const names = [...byDivision[div].values()].sort((a, b) => a.localeCompare(b));
            embed.addFields({ name: `${div} (${names.length})`, value: fieldValue(names), inline: false });
        }
    }

    return embed;
}

module.exports = { buildSignupsEmbed, fieldValue, DIVISIONS };
