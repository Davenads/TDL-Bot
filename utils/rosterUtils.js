/**
 * Roster tab helpers — the Discord ↔ Data Name identity map.
 *
 * The `Roster` tab bridges a player's Discord account and how they appear in the
 * dueling data / rankings:
 *   A = Data Name     (rankings/data display — the bot NEVER invents this)
 *   B = Discord Name  (last-parsed username — volatile, changes ~every 2 weeks)
 *   C = Discord UUID  (stable join key — match on this, never on the name)
 *
 * Used by /signup as a HARD GATE (must exist to sign up) and for enrichment
 * (resolve the Data Name for the confirmation, opportunistically refresh col B).
 *
 * One shared tab — NOT TEST_MODE-split (only the Registration write target flips).
 */

const ROSTER_TAB = 'Roster';

// Roster tab columns: A=Data Name, B=Discord Name, C=Discord UUID
const ROSTER_COL = { DATA_NAME: 0, DISCORD_NAME: 1, UUID: 2 };

/**
 * Find a roster entry by Discord UUID (exact match on column C).
 *
 * Scans every row and matches on the UUID cell, so a header row is naturally
 * ignored — its "Discord UUID" label can't equal a real snowflake — and no
 * header assumption can drop a real entry.
 *
 * @param {Array<Array<string>>} rows - Raw `Roster!A:C` rows
 * @param {string} uuid - Discord user id (snowflake)
 * @returns {{ dataName:string, discordName:string, rowIndex:number }|null}
 *          rowIndex is the 1-based sheet row (for a col-B `values.update`).
 */
function findRosterEntry(rows, uuid) {
    if (!rows || !uuid) return null;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row) continue;
        if (row[ROSTER_COL.UUID] === uuid) {
            return {
                dataName: (row[ROSTER_COL.DATA_NAME] || '').trim(),
                discordName: (row[ROSTER_COL.DISCORD_NAME] || '').trim(),
                rowIndex: i + 1
            };
        }
    }
    return null;
}

/**
 * Read the Roster tab and resolve one user's entry by UUID.
 *
 * Throws on Sheets API errors so the caller can fail CLOSED (block the signup)
 * rather than silently bypass the gate.
 *
 * @returns {Promise<{dataName:string,discordName:string,rowIndex:number}|null>}
 */
async function lookupRosterEntry({ sheets, auth, spreadsheetId, uuid }) {
    const res = await sheets.spreadsheets.values.get({
        auth,
        spreadsheetId,
        range: `${ROSTER_TAB}!A:C`
    });
    return findRosterEntry(res.data.values || [], uuid);
}

/**
 * Refresh a roster row's Discord Name (col B) when the stored username has
 * drifted from the live one. Meant to be called fire-and-forget AFTER the
 * Registration write — never block the signup on it.
 *
 * Only writes on a real change; never touches Data Name or adds rows.
 *
 * @returns {Promise<boolean>} true if a write was issued, false if skipped.
 */
async function refreshDiscordName({ sheets, auth, spreadsheetId, entry, username }) {
    if (!entry || !entry.rowIndex || !username) return false;
    if (entry.discordName === username) return false; // already current
    await sheets.spreadsheets.values.update({
        auth,
        spreadsheetId,
        range: `${ROSTER_TAB}!B${entry.rowIndex}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[username]] }
    });
    return true;
}

module.exports = {
    ROSTER_TAB,
    ROSTER_COL,
    findRosterEntry,
    lookupRosterEntry,
    refreshDiscordName
};
