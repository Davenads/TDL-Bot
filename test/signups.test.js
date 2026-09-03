// Framework-free harness for the current-week signups read-through cache.
// Uses an in-memory fake Redis (monkeypatched onto the redisClient singleton)
// and a fake googleapis `sheets`; touches no real Redis, Google, or Discord.
//
//   node test/signups.test.js
//
// Exit code 0 = all pass, 1 = any failure.

process.env.TEST_MODE = 'true'; // MUST be set before requiring signupUtils (REG_TAB/key read at load)

const assert = require('assert');
const redisClient = require('../utils/redisClient');
const { cacheSet } = require('../utils/cache');
const { formatSheetTimestamp } = require('../utils/tdlWeekUtils');
const {
    REG_TAB,
    COL,
    SIGNUPS_KEY,
    getCurrentWeekSignups,
    invalidateSignupsCache
} = require('../utils/signupUtils');

// Guard the env-before-require ordering and the mode-namespaced key.
assert.strictEqual(REG_TAB, 'Registration Test', 'TEST_MODE must resolve REG_TAB to the test tab');
assert.ok(SIGNUPS_KEY.endsWith(':test'), 'signups cache key is mode-namespaced under TEST_MODE');

const AUTH = { fake: true };
const SHEET_ID = 'sheet-id';
const HEADER = ['Timestamp', 'Discord UUID', 'Discord Username', 'Notes', 'Category'];
const NOW = formatSheetTimestamp();   // current-week timestamp (ET, sheet format)
const STALE = '1/1/2020 12:00:00';    // year gap => reliably before this week (TZ-safe)

// ---- In-memory fake Redis client ------------------------------------------
const store = new Map();
let throwOnGet = false;
const fakeClient = {
    get: async (k) => { if (throwOnGet) throw new Error('redis get boom'); return store.has(k) ? store.get(k) : null; },
    set: async (k, v) => { store.set(k, v); return 'OK'; },
    del: async (k) => { const had = store.has(k); store.delete(k); return had ? 1 : 0; }
};
function setReady(ready) {
    redisClient.isReady = () => ready;
    redisClient.getClient = () => fakeClient;
}
function reset() { store.clear(); throwOnGet = false; setReady(true); }

// Fake `sheets` that counts get() calls and records the requested range.
function makeSheets(rows) {
    const stats = { get: 0, lastRange: null };
    const api = {
        spreadsheets: {
            values: {
                get: async ({ range }) => {
                    stats.get++;
                    stats.lastRange = range;
                    return { data: { values: rows.map(r => (r ? r.slice() : r)) } };
                }
            }
        }
    };
    return { api, stats };
}

// ---- Runner ----------------------------------------------------------------
let pass = 0;
let fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const tick = () => new Promise(r => setImmediate(r));

// ---- Cases -----------------------------------------------------------------

test('getCurrentWeekSignups reads REG_TAB!A:E and returns only current-week rows', async () => {
    reset();
    const { api, stats } = makeSheets([
        HEADER,
        [NOW, 'U1', 'alice', '', 'HLD'],
        [STALE, 'U2', 'oldbob', '', 'LLD'],   // last week -> dropped
        [NOW, 'U2', 'bob', 'gg', 'LLD']
    ]);
    const rows = await getCurrentWeekSignups({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    assert.strictEqual(stats.get, 1, 'one Sheets read on a cold cache');
    assert.strictEqual(stats.lastRange, 'Registration Test!A:E');
    assert.strictEqual(rows.length, 2, 'stale row excluded, header excluded');
    assert.deepStrictEqual(rows.map(r => r[COL.UUID]).sort(), ['U1', 'U2']);
});

test('getCurrentWeekSignups serves the second call from cache (no second read)', async () => {
    reset();
    const { api, stats } = makeSheets([HEADER, [NOW, 'U1', 'alice', '', 'HLD']]);
    await getCurrentWeekSignups({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    await tick(); // let the fire-and-forget cacheSet settle
    const rows2 = await getCurrentWeekSignups({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    assert.strictEqual(stats.get, 1, 'second call is a cache hit');
    assert.strictEqual(rows2[0][COL.UUID], 'U1');
});

test('invalidateSignupsCache forces the next call to re-read (delete-on-write)', async () => {
    reset();
    const { api, stats } = makeSheets([HEADER, [NOW, 'U1', 'alice', '', 'HLD']]);
    await getCurrentWeekSignups({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    await tick();
    await invalidateSignupsCache(); // e.g. after a /signup upsert
    await getCurrentWeekSignups({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    assert.strictEqual(stats.get, 2, 'eviction forced a fresh Sheets read');
});

test('a cache entry from a different week is ignored (weekStart guard)', async () => {
    reset();
    const { api, stats } = makeSheets([HEADER, [NOW, 'U1', 'alice', '', 'HLD']]);
    // Seed a stale-week payload directly.
    await cacheSet(SIGNUPS_KEY, {
        weekStart: '1999-01-01T00:00:00.000Z',
        rows: [[NOW, 'GHOST', 'ghost', '', 'HLD']]
    }, 7200);
    const rows = await getCurrentWeekSignups({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    assert.strictEqual(stats.get, 1, 'wrong-week cache ignored -> fresh read');
    assert.strictEqual(rows[0][COL.UUID], 'U1', 'returns fresh rows, not the ghost');
});

test('works uncached (every call reads Sheets) when Redis is down', async () => {
    reset();
    setReady(false);
    const { api, stats } = makeSheets([HEADER, [NOW, 'U1', 'alice', '', 'HLD']]);
    await getCurrentWeekSignups({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    await getCurrentWeekSignups({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    assert.strictEqual(stats.get, 2, 'no cache -> live read every time');
});

test('getCurrentWeekSignups propagates a Sheets error', async () => {
    reset();
    const api = { spreadsheets: { values: { get: async () => { throw new Error('sheets boom'); } } } };
    await assert.rejects(
        () => getCurrentWeekSignups({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID }),
        /sheets boom/
    );
});

test('a cache-read hiccup falls back to a live read (does not throw)', async () => {
    reset();
    throwOnGet = true; // cacheGet swallows and returns null
    const { api, stats } = makeSheets([HEADER, [NOW, 'U1', 'alice', '', 'HLD']]);
    const rows = await getCurrentWeekSignups({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    assert.strictEqual(stats.get, 1, 'cache error -> live Sheets read');
    assert.strictEqual(rows[0][COL.UUID], 'U1');
});

// ---- Run -------------------------------------------------------------------
process.on('unhandledRejection', (err) => {
    console.error('Unhandled rejection:', err);
    process.exit(1);
});

(async () => {
    for (const t of tests) {
        try {
            await t.fn();
            console.log(`PASS  ${t.name}`);
            pass++;
        } catch (err) {
            console.error(`FAIL  ${t.name}\n      ${err.message}`);
            fail++;
        }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((err) => {
    console.error('Runner crashed:', err);
    process.exit(1);
});
