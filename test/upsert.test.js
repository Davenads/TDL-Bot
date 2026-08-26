// Framework-free dry-run harness for the /signup sheet-write logic.
// Verifies the riskiest function (upsertSignups) without touching Google or Discord.
//
//   node test/upsert.test.js
//
// Exit code 0 = all pass, 1 = any failure.

process.env.TEST_MODE = 'true'; // -> REG_TAB = 'Registration Test'

const assert = require('assert');
const { formatSheetTimestamp } = require('../utils/tdlWeekUtils');
const { _internals } = require('../commands/signup');
const { upsertSignups, REG_TAB } = _internals;

const HEADER = ['Timestamp', 'Discord UUID', 'Discord Username', 'Notes', 'Category'];
const NOW = formatSheetTimestamp();      // current-week timestamp (ET, sheet format)
const STALE = '1/1/2020 12:00:00';        // well before any current week
const AUTH = { fake: true };

function rng(row) {
    return `${REG_TAB}!A${row}:E${row}`;
}

// Fake googleapis `sheets` object. `get` returns the seeded rows once;
// `update` records every write so we can assert range + payload.
function makeSheets(rows) {
    const updates = [];
    const api = {
        spreadsheets: {
            values: {
                get: async () => ({ data: { values: rows } }),
                update: async ({ range, requestBody }) => {
                    updates.push({ range, values: requestBody.values[0] });
                    return { data: {} };
                }
            }
        }
    };
    return { api, updates };
}

// Minimal runner ------------------------------------------------------------
let pass = 0;
let fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Cases ---------------------------------------------------------------------

test('Both -> two created rows at the next two rows', async () => {
    const { api, updates } = makeSheets([HEADER.slice()]);
    const results = await upsertSignups({
        sheets: api, auth: AUTH, uuid: 'U1', username: 'alice', notes: '', divisions: ['HLD', 'LLD']
    });
    assert.strictEqual(updates.length, 2, 'two writes');
    assert.strictEqual(updates[0].range, rng(2), 'first at row 2');
    assert.strictEqual(updates[1].range, rng(3), 'second at row 3');
    assert.deepStrictEqual(results, [
        { category: 'HLD', action: 'created' },
        { category: 'LLD', action: 'created' }
    ]);
});

test('Re-run same (UUID+Category) this week -> updated in place, no new row', async () => {
    const existing = [NOW, 'U1', 'alice', 'old note', 'HLD'];
    const { api, updates } = makeSheets([HEADER.slice(), existing]);
    const results = await upsertSignups({
        sheets: api, auth: AUTH, uuid: 'U1', username: 'alice', notes: 'new note', divisions: ['HLD']
    });
    assert.strictEqual(updates.length, 1, 'one write');
    assert.strictEqual(updates[0].range, rng(2), 'targets the existing row');
    assert.strictEqual(updates[0].values[3], 'new note', 'notes refreshed');
    assert.deepStrictEqual(results, [{ category: 'HLD', action: 'updated' }]);
});

test('Stale (last-week) row is ignored -> creates a new row', async () => {
    const stale = [STALE, 'U1', 'alice', '', 'HLD'];
    const { api, updates } = makeSheets([HEADER.slice(), stale]);
    const results = await upsertSignups({
        sheets: api, auth: AUTH, uuid: 'U1', username: 'alice', notes: '', divisions: ['HLD']
    });
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].range, rng(3), 'appends rather than overwriting the stale row');
    assert.deepStrictEqual(results, [{ category: 'HLD', action: 'created' }]);
});

test('Different UUID, same category -> separate row', async () => {
    const other = [NOW, 'U1', 'alice', '', 'HLD'];
    const { api, updates } = makeSheets([HEADER.slice(), other]);
    const results = await upsertSignups({
        sheets: api, auth: AUTH, uuid: 'U2', username: 'bob', notes: '', divisions: ['HLD']
    });
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].range, rng(3));
    assert.strictEqual(updates[0].values[1], 'U2');
    assert.deepStrictEqual(results, [{ category: 'HLD', action: 'created' }]);
});

test('Both with one pre-existing division -> mixed created/updated', async () => {
    const existingLLD = [NOW, 'U1', 'alice', 'prev', 'LLD'];
    const { api, updates } = makeSheets([HEADER.slice(), existingLLD]);
    const results = await upsertSignups({
        sheets: api, auth: AUTH, uuid: 'U1', username: 'alice', notes: 'x', divisions: ['HLD', 'LLD']
    });
    assert.strictEqual(updates.length, 2);
    assert.strictEqual(updates[0].range, rng(3), 'new HLD appended');
    assert.strictEqual(updates[1].range, rng(2), 'existing LLD updated in place');
    assert.deepStrictEqual(results, [
        { category: 'HLD', action: 'created' },
        { category: 'LLD', action: 'updated' }
    ]);
});

test('Written row shape = [timestamp, uuid, username, notes, category]', async () => {
    const { api, updates } = makeSheets([HEADER.slice()]);
    await upsertSignups({
        sheets: api, auth: AUTH, uuid: 'U9', username: 'carol', notes: 'gg', divisions: ['HLD']
    });
    const row = updates[0].values;
    assert.strictEqual(row.length, 5);
    assert.match(row[0], /^\d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2}$/, 'sheet timestamp format');
    assert.strictEqual(row[1], 'U9');
    assert.strictEqual(row[2], 'carol');
    assert.strictEqual(row[3], 'gg');
    assert.strictEqual(row[4], 'HLD');
});

test('Both writes share one identical timestamp', async () => {
    const { api, updates } = makeSheets([HEADER.slice()]);
    await upsertSignups({
        sheets: api, auth: AUTH, uuid: 'U1', username: 'alice', notes: '', divisions: ['HLD', 'LLD']
    });
    assert.strictEqual(updates[0].values[0], updates[1].values[0], 'same timestamp on both rows');
});

test('Empty sheet (no header) -> first write lands at row 1', async () => {
    const { api, updates } = makeSheets([]);
    const results = await upsertSignups({
        sheets: api, auth: AUTH, uuid: 'U1', username: 'alice', notes: '', divisions: ['HLD']
    });
    assert.strictEqual(updates[0].range, rng(1));
    assert.deepStrictEqual(results, [{ category: 'HLD', action: 'created' }]);
});

// Run -----------------------------------------------------------------------
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
})();
