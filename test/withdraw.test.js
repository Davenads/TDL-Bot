// Framework-free harness for the /withdraw delete-row helpers in signupUtils.
// Verifies row detection + physical deletion (deleteDimension) without touching
// Google, Discord, or Redis.
//
//   node test/withdraw.test.js
//
// Exit code 0 = all pass, 1 = any failure.

process.env.TEST_MODE = 'true'; // set before requiring signupUtils (REG_TAB read at load)

const assert = require('assert');
const { formatSheetTimestamp } = require('../utils/tdlWeekUtils');
const {
    REG_TAB,
    COL,
    quoteSheet,
    getUserSignupRows,
    getUserSignupDivisions,
    resolveSheetId,
    deleteSignupRowsForUser
} = require('../utils/signupUtils');

assert.strictEqual(REG_TAB, 'Discord Registration Test', 'TEST_MODE must resolve REG_TAB to the test tab');

const HEADER = ['Status', 'Timestamp', 'Discord UUID', 'Discord Username', 'Notes', 'Category'];
const NOW = formatSheetTimestamp();     // current-week
const STALE = '1/1/2020 12:00:00';       // well before any current week
const AUTH = { fake: true };
const SHEET_ID = 'ssid';
const GID = 1675827465;

// Fake googleapis `sheets`. values.get returns a deep copy (fresh each call);
// spreadsheets.get returns tab metadata; batchUpdate records the requests.
function makeSheets(rows, { tabTitle = REG_TAB } = {}) {
    const batches = [];
    const stats = { get: 0, batchUpdate: 0, meta: 0 };
    const api = {
        spreadsheets: {
            get: async () => {
                stats.meta++;
                return { data: { sheets: [{ properties: { sheetId: GID, title: tabTitle } }] } };
            },
            values: {
                get: async () => { stats.get++; return { data: { values: rows.map(r => (r ? r.slice() : r)) } }; }
            },
            batchUpdate: async ({ requestBody }) => {
                stats.batchUpdate++;
                batches.push(requestBody.requests);
                return { data: {} };
            }
        }
    };
    return { api, batches, stats };
}

let pass = 0;
let fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- getUserSignupRows -----------------------------------------------------

test('getUserSignupRows returns current-week rows for the user with 1-based rowIndex', async () => {
    const { api } = makeSheets([
        HEADER,
        ['', NOW, 'U1', 'alice', '', 'HLD'],   // row 2
        ['', NOW, 'U2', 'bob', '', 'HLD'],      // row 3
        ['', NOW, 'U1', 'alice', '', 'LLD']     // row 4
    ]);
    const rows = await getUserSignupRows({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1' });
    assert.deepStrictEqual(rows, [
        { category: 'HLD', rowIndex: 2 },
        { category: 'LLD', rowIndex: 4 }
    ]);
});

test('getUserSignupRows ignores stale (last-week) rows', async () => {
    const { api } = makeSheets([
        HEADER,
        ['', STALE, 'U1', 'alice', '', 'HLD'],
        ['', NOW, 'U1', 'alice', '', 'LLD']   // row 3
    ]);
    const rows = await getUserSignupRows({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1' });
    assert.deepStrictEqual(rows, [{ category: 'LLD', rowIndex: 3 }]);
});

test('getUserSignupRows returns empty when the user has no rows', async () => {
    const { api } = makeSheets([HEADER, ['', NOW, 'U2', 'bob', '', 'HLD']]);
    const rows = await getUserSignupRows({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1' });
    assert.deepStrictEqual(rows, []);
});

// ---- getUserSignupDivisions ------------------------------------------------

test('getUserSignupDivisions returns distinct categories', async () => {
    const { api } = makeSheets([
        HEADER,
        ['', NOW, 'U1', 'alice', '', 'HLD'],
        ['', NOW, 'U1', 'alice', '', 'LLD']
    ]);
    const divs = await getUserSignupDivisions({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1' });
    assert.deepStrictEqual(divs.sort(), ['HLD', 'LLD']);
});

test('getUserSignupDivisions dedupes a doubled-up category', async () => {
    const { api } = makeSheets([
        HEADER,
        ['', NOW, 'U1', 'alice', '', 'HLD'],
        ['', NOW, 'U1', 'alice', '', 'HLD']
    ]);
    const divs = await getUserSignupDivisions({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1' });
    assert.deepStrictEqual(divs, ['HLD']);
});

// ---- resolveSheetId --------------------------------------------------------

test('resolveSheetId returns the numeric gid for the tab', async () => {
    const { api } = makeSheets([HEADER]);
    const gid = await resolveSheetId({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, title: REG_TAB });
    assert.strictEqual(gid, GID);
});

test('resolveSheetId throws when the tab is missing', async () => {
    const { api } = makeSheets([HEADER], { tabTitle: 'Some Other Tab' });
    await assert.rejects(
        () => resolveSheetId({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, title: REG_TAB }),
        /Sheet tab not found/
    );
});

// ---- deleteSignupRowsForUser -----------------------------------------------

test('deletes only the chosen category and returns a summary', async () => {
    const { api, batches } = makeSheets([
        HEADER,
        ['', NOW, 'U1', 'alice', '', 'HLD'],  // row 2
        ['', NOW, 'U1', 'alice', '', 'LLD']   // row 3
    ]);
    const out = await deleteSignupRowsForUser({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1', categories: ['HLD'] });
    assert.deepStrictEqual(out, { deleted: ['HLD'], count: 1 });
    assert.strictEqual(batches.length, 1, 'one batchUpdate');
    const reqs = batches[0];
    assert.strictEqual(reqs.length, 1);
    assert.deepStrictEqual(reqs[0].deleteDimension.range, {
        sheetId: GID, dimension: 'ROWS', startIndex: 1, endIndex: 2  // row 2 → 0-based [1,2)
    });
});

test('deletes both rows bottom-up (descending rowIndex) in one batch', async () => {
    // A gap row (other user) puts the two target rows at 2 and 4.
    const { api, batches } = makeSheets([
        HEADER,
        ['', NOW, 'U1', 'alice', '', 'HLD'],   // row 2
        ['', NOW, 'U2', 'bob', '', 'HLD'],      // row 3 (other user)
        ['', NOW, 'U1', 'alice', '', 'LLD']     // row 4
    ]);
    const out = await deleteSignupRowsForUser({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1', categories: ['HLD', 'LLD'] });
    assert.strictEqual(out.count, 2);
    assert.deepStrictEqual(out.deleted.sort(), ['HLD', 'LLD']);
    const reqs = batches[0];
    assert.strictEqual(reqs.length, 2);
    // Bottom-up: row 4 (startIndex 3) must be deleted before row 2 (startIndex 1).
    assert.strictEqual(reqs[0].deleteDimension.range.startIndex, 3);
    assert.strictEqual(reqs[1].deleteDimension.range.startIndex, 1);
});

test('no matching category → no batchUpdate, zero count', async () => {
    const { api, batches, stats } = makeSheets([
        HEADER,
        ['', NOW, 'U1', 'alice', '', 'HLD']
    ]);
    const out = await deleteSignupRowsForUser({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1', categories: ['LLD'] });
    assert.deepStrictEqual(out, { deleted: [], count: 0 });
    assert.strictEqual(batches.length, 0, 'no delete issued');
    assert.strictEqual(stats.meta, 0, 'no sheetId lookup when nothing to delete');
});

test('user with no current-week rows → zero count, no delete', async () => {
    const { api, batches } = makeSheets([HEADER, ['', STALE, 'U1', 'alice', '', 'HLD']]);
    const out = await deleteSignupRowsForUser({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1', categories: ['HLD'] });
    assert.deepStrictEqual(out, { deleted: [], count: 0 });
    assert.strictEqual(batches.length, 0);
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
