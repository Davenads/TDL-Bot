// Framework-free harness for the Redis cache layer + roster read-through.
// Uses an in-memory fake Redis (monkeypatched onto the redisClient singleton),
// so nothing here touches a real Redis, Google, or Discord.
//
//   node test/cache.test.js
//
// Exit code 0 = all pass, 1 = any failure.

const assert = require('assert');

// The singleton that utils/cache.js binds to. Monkeypatch isReady/getClient so
// cache calls hit our in-memory fake instead of a real connection.
const redisClient = require('../utils/redisClient');
const { KEYS, TTL, cacheGet, cacheSet, cacheDel } = require('../utils/cache');
const { getRosterMap, invalidateRosterCache } = require('../utils/rosterUtils');

const AUTH = { fake: true };
const SHEET_ID = 'sheet-id';
const HEADER = ['Data Name', 'Discord Name', 'Discord UUID'];

// ---- In-memory fake Redis client -----------------------------------------
const store = new Map();
let throwOnGet = false;
const fakeClient = {
    get: async (k) => {
        if (throwOnGet) throw new Error('redis get boom');
        return store.has(k) ? store.get(k) : null;
    },
    set: async (k, v /*, opts */) => { store.set(k, v); return 'OK'; },
    del: async (k) => { const had = store.has(k); store.delete(k); return had ? 1 : 0; }
};

function setReady(ready) {
    redisClient.isReady = () => ready;
    redisClient.getClient = () => fakeClient;
}
function reset() {
    store.clear();
    throwOnGet = false;
    setReady(true);
}

// Fake googleapis `sheets` that counts get() calls (to prove cache hits skip Sheets).
function makeSheets(rows) {
    const stats = { get: 0 };
    const api = {
        spreadsheets: {
            values: {
                get: async () => { stats.get++; return { data: { values: rows.map(r => (r ? r.slice() : r)) } }; }
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

// ---- Cases: cache helpers --------------------------------------------------

test('cacheSet + cacheGet round-trips JSON when Redis is ready', async () => {
    reset();
    const wrote = await cacheSet('tdl:test', { a: 1, b: ['x'] }, 60);
    assert.strictEqual(wrote, true);
    assert.deepStrictEqual(await cacheGet('tdl:test'), { a: 1, b: ['x'] });
});

test('cacheGet returns null on a miss', async () => {
    reset();
    assert.strictEqual(await cacheGet('tdl:missing'), null);
});

test('cacheDel removes a key', async () => {
    reset();
    await cacheSet('tdl:test', { v: 1 }, 60);
    assert.strictEqual(await cacheDel('tdl:test'), true);
    assert.strictEqual(await cacheGet('tdl:test'), null);
});

test('all helpers degrade to no-ops when Redis is not ready', async () => {
    reset();
    setReady(false);
    assert.strictEqual(await cacheGet('tdl:test'), null);
    assert.strictEqual(await cacheSet('tdl:test', { v: 1 }, 60), false);
    assert.strictEqual(await cacheDel('tdl:test'), false);
});

test('cacheGet swallows a client error and returns null (graceful)', async () => {
    reset();
    throwOnGet = true;
    assert.strictEqual(await cacheGet('tdl:test'), null);
});

// ---- Cases: getRosterMap read-through -------------------------------------

test('getRosterMap reads Sheets on a miss and returns a uuid->entry map', async () => {
    reset();
    const { api, stats } = makeSheets([HEADER, ['Toe', 'toeshank', 'U1'], ['Ally', 'alice', 'U2']]);
    const map = await getRosterMap({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    assert.strictEqual(stats.get, 1, 'one Sheets read on a cold cache');
    assert.deepStrictEqual(map['U1'], { dataName: 'Toe', discordName: 'toeshank', rowIndex: 2 });
    assert.deepStrictEqual(map['U2'], { dataName: 'Ally', discordName: 'alice', rowIndex: 3 });
});

test('getRosterMap serves the second call from cache (no second Sheets read)', async () => {
    reset();
    const { api, stats } = makeSheets([HEADER, ['Toe', 'toeshank', 'U1']]);
    await getRosterMap({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    await tick(); // let the fire-and-forget cacheSet settle
    const map2 = await getRosterMap({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    assert.strictEqual(stats.get, 1, 'second call is a cache hit');
    assert.strictEqual(map2['U1'].dataName, 'Toe');
});

test('getRosterMap propagates a Sheets error on a miss (gate fails closed)', async () => {
    reset();
    const api = { spreadsheets: { values: { get: async () => { throw new Error('sheets boom'); } } } };
    await assert.rejects(
        () => getRosterMap({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID }),
        /sheets boom/
    );
});

test('invalidateRosterCache forces the next getRosterMap to re-read Sheets', async () => {
    reset();
    const { api, stats } = makeSheets([HEADER, ['Toe', 'toeshank', 'U1']]);
    await getRosterMap({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    await tick();
    await invalidateRosterCache(); // e.g. after /register
    const map = await getRosterMap({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    assert.strictEqual(stats.get, 2, 'eviction forced a fresh Sheets read');
    assert.strictEqual(map['U1'].dataName, 'Toe');
});

test('getRosterMap still works (uncached) when Redis is down', async () => {
    reset();
    setReady(false);
    const { api, stats } = makeSheets([HEADER, ['Toe', 'toeshank', 'U1']]);
    const a = await getRosterMap({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    const b = await getRosterMap({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID });
    assert.strictEqual(stats.get, 2, 'every call reads Sheets when the cache is unavailable');
    assert.strictEqual(a['U1'].dataName, 'Toe');
    assert.strictEqual(b['U1'].dataName, 'Toe');
});

test('cache key/TTL constants are the expected namespaced values', () => {
    assert.strictEqual(KEYS.ROSTER, 'tdl:roster');
    assert.strictEqual(TTL.ROSTER_SEC, 600);
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
