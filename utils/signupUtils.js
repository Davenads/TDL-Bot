/**
 * Registration-tab schema + a read-through cache for the current week's signups.
 *
 * Owns the Registration schema (`REG_TAB`, `COL`) as the SINGLE source of truth
 * shared by the write path (`/signup`'s upsert) and the read path
 * (`/recentsignups`). Only the cached READ lives here; the upsert stays in
 * `commands/signup.js` and always reads the sheet FRESH to resolve its write
 * target (dedupe row / append index) — a write target must never come from cache.
 *
 * Cache design (cache-aside + delete-on-write; see plan/07-redis-caching.md):
 *  - `getCurrentWeekSignups` serves `/recentsignups` from Redis, falling back to
 *    a live Sheets read on a miss (and always when Redis is down).
 *  - `/signup` evicts via `invalidateSignupsCache` after each successful upsert.
 *  - The cached payload is stamped with the `weekStart` it was built for, so a
 *    Tuesday week-rollover can never serve last week's list (guard beyond TTL).
 */

const { cacheGet, cacheSet, cacheDel } = require('./cache');
const { getWeekStartDate, filterCurrentWeekSignups } = require('./tdlWeekUtils');

// Discord Registration tab: A=Status, B=Timestamp, C=Discord UUID, D=Discord Username, E=Notes, F=Category.
// Column A (Status) is a MANUAL Approved/Rejected/AFK dropdown owned by the league
// admins — the bot never writes it (writes target B:F only). COL indexes the full
// A:F row read back from the sheet, so STATUS occupies index 0.
const REG_TAB = process.env.TEST_MODE === 'true' ? 'Discord Registration Test' : 'Discord Registration';
const COL = { STATUS: 0, TIMESTAMP: 1, UUID: 2, USERNAME: 3, NOTES: 4, CATEGORY: 5 };

// A1 notation requires the sheet name to be single-quoted whenever it contains a
// space or other special char (e.g. the TEST_MODE tab "Discord Registration Test").
// Quoting an already-safe name ("Registration") is harmless, so always quote.
// Any literal single-quote in the name is escaped by doubling it, per the API.
const quoteSheet = (name) => `'${String(name).replace(/'/g, "''")}'`;

// Mode-namespaced so a shared Redis instance can't mix test/prod signups.
const SIGNUPS_KEY = process.env.TEST_MODE === 'true'
    ? 'tdl:signups:current:test'
    : 'tdl:signups:current';
// Every /signup evicts, so this TTL only bounds staleness from out-of-band
// manual sheet edits (which the bot can't observe).
const SIGNUPS_TTL_SEC = 7200; // 2 hours

/**
 * Current week's signup rows (raw `A:E` arrays, header + stale weeks removed).
 *
 * Read-through cache: returns the cached list when it was built for the same
 * registration week, otherwise reads `REG_TAB!A:F`, filters to the current week,
 * caches it (fire-and-forget), and returns it. Throws on a Sheets API error
 * (the caller is a display command, so it just reports "unavailable").
 *
 * NOTE: rows carry NO rowIndex — this is read/display only; never write from it.
 *
 * @returns {Promise<Array<Array<string>>>}
 */
async function getCurrentWeekSignups({ sheets, auth, spreadsheetId }) {
    const weekStart = getWeekStartDate().toISOString();

    const cached = await cacheGet(SIGNUPS_KEY);
    if (cached && cached.weekStart === weekStart && Array.isArray(cached.rows)) {
        return cached.rows;
    }

    const res = await sheets.spreadsheets.values.get({
        auth,
        spreadsheetId,
        range: `${quoteSheet(REG_TAB)}!A:F`
    });
    // Timestamp lives in column B (COL.TIMESTAMP=1) now that Status occupies A.
    const rows = filterCurrentWeekSignups(res.data.values || [], true, COL.TIMESTAMP);
    // Fire-and-forget (cacheSet is internally guarded and won't throw).
    cacheSet(SIGNUPS_KEY, { weekStart, rows }, SIGNUPS_TTL_SEC);
    return rows;
}

/**
 * Evict the current-week signups cache. Call fire-and-forget AFTER a successful
 * `/signup` upsert so `/recentsignups` reflects the change immediately.
 *
 * @returns {Promise<boolean>} true if an eviction was issued.
 */
async function invalidateSignupsCache() {
    return cacheDel(SIGNUPS_KEY);
}

module.exports = {
    REG_TAB,
    COL,
    SIGNUPS_KEY,
    SIGNUPS_TTL_SEC,
    quoteSheet,
    getCurrentWeekSignups,
    invalidateSignupsCache
};
