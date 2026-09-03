// Framework-free dry-run harness for the Roster gate/enrichment helpers.
// Verifies lookup + refresh logic without touching Google or Discord.
//
//   node test/roster.test.js
//
// Exit code 0 = all pass, 1 = any failure.

const assert = require('assert');
const {
    findRosterEntry,
    lookupRosterEntry,
    refreshDiscordName,
    registerRosterEntry,
    ROSTER_TAB
} = require('../utils/rosterUtils');

const AUTH = { fake: true };
const SHEET_ID = 'sheet-id';

// Roster!A:C — A=Data Name, B=Discord Name, C=Discord UUID
const HEADER = ['Data Name', 'Discord Name', 'Discord UUID'];

// Fake googleapis `sheets`. `get` returns a deep copy of the seeded rows;
// `update` records every write so we can assert range + payload.
function makeSheets(rows) {
    const updates = [];
    const api = {
        spreadsheets: {
            values: {
                get: async () => ({ data: { values: rows.map(r => (r ? r.slice() : r)) } }),
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

test('findRosterEntry matches on UUID (col C), returns 1-based rowIndex', () => {
    const rows = [HEADER, ['Toe', 'toeshank', 'U1'], ['Ally', 'alice#0', 'U2']];
    const entry = findRosterEntry(rows, 'U2');
    assert.deepStrictEqual(entry, { dataName: 'Ally', discordName: 'alice#0', rowIndex: 3 });
});

test('findRosterEntry ignores the header row naturally (real UUID skips past it)', () => {
    // A real snowflake can never equal the literal "Discord UUID" label, so the
    // header at row 1 is passed over and the data row resolves at its true index.
    const rows = [HEADER, ['Toe', 'toeshank', 'U1']];
    const entry = findRosterEntry(rows, 'U1');
    assert.deepStrictEqual(entry, { dataName: 'Toe', discordName: 'toeshank', rowIndex: 2 });
});

test('findRosterEntry returns null when not present', () => {
    const rows = [HEADER, ['Toe', 'toeshank', 'U1']];
    assert.strictEqual(findRosterEntry(rows, 'NOPE'), null);
});

test('findRosterEntry handles empty/missing input', () => {
    assert.strictEqual(findRosterEntry([], 'U1'), null);
    assert.strictEqual(findRosterEntry(null, 'U1'), null);
    assert.strictEqual(findRosterEntry([['x', 'y', 'U1']], ''), null);
});

test('findRosterEntry trims Data Name / Discord Name', () => {
    const entry = findRosterEntry([['  Ally  ', '  alice ', 'U2']], 'U2');
    assert.strictEqual(entry.dataName, 'Ally');
    assert.strictEqual(entry.discordName, 'alice');
});

test('lookupRosterEntry reads Roster!A:C and resolves the entry', async () => {
    const { api } = makeSheets([HEADER, ['Toe', 'toeshank', 'U1']]);
    let seenRange = null;
    api.spreadsheets.values.get = async ({ range }) => {
        seenRange = range;
        return { data: { values: [HEADER, ['Toe', 'toeshank', 'U1']] } };
    };
    const entry = await lookupRosterEntry({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1' });
    assert.strictEqual(seenRange, `${ROSTER_TAB}!A:C`, 'reads the Roster tab A:C');
    assert.strictEqual(entry.dataName, 'Toe');
});

test('lookupRosterEntry propagates API errors (so caller fails closed)', async () => {
    const api = {
        spreadsheets: { values: { get: async () => { throw new Error('boom'); } } }
    };
    await assert.rejects(
        () => lookupRosterEntry({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1' }),
        /boom/
    );
});

test('refreshDiscordName writes col B at the row when the name drifted', async () => {
    const { api, updates } = makeSheets([]);
    const did = await refreshDiscordName({
        sheets: api, auth: AUTH, spreadsheetId: SHEET_ID,
        entry: { dataName: 'Toe', discordName: 'old_name', rowIndex: 4 }, username: 'new_name'
    });
    assert.strictEqual(did, true);
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].range, `${ROSTER_TAB}!B4`, 'targets col B of the roster row');
    assert.strictEqual(updates[0].values[0], 'new_name');
});

test('refreshDiscordName is a no-op when the name already matches', async () => {
    const { api, updates } = makeSheets([]);
    const did = await refreshDiscordName({
        sheets: api, auth: AUTH, spreadsheetId: SHEET_ID,
        entry: { dataName: 'Toe', discordName: 'same', rowIndex: 4 }, username: 'same'
    });
    assert.strictEqual(did, false);
    assert.strictEqual(updates.length, 0, 'no write issued');
});

test('refreshDiscordName is a no-op with a missing entry or username', async () => {
    const { api, updates } = makeSheets([]);
    assert.strictEqual(await refreshDiscordName({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, entry: null, username: 'x' }), false);
    assert.strictEqual(await refreshDiscordName({ sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, entry: { rowIndex: 2, discordName: 'a' }, username: '' }), false);
    assert.strictEqual(updates.length, 0);
});

test('registerRosterEntry appends a new player at the next row (A:C)', async () => {
    const { api, updates } = makeSheets([HEADER, ['Toe', 'toeshank', 'U1']]);
    const result = await registerRosterEntry({
        sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U2', dataName: 'Ally', discordName: 'alice'
    });
    assert.deepStrictEqual(result, { ok: true, action: 'created', rowIndex: 3 });
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].range, `${ROSTER_TAB}!A3:C3`);
    assert.deepStrictEqual(updates[0].values, ['Ally', 'alice', 'U2']);
});

test('registerRosterEntry trims the Data Name before writing', async () => {
    const { api, updates } = makeSheets([HEADER]);
    const result = await registerRosterEntry({
        sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U9', dataName: '  Carol  ', discordName: 'carol'
    });
    assert.strictEqual(result.action, 'created');
    assert.strictEqual(updates[0].values[0], 'Carol');
});

test('registerRosterEntry updates the existing row when the UUID is already present', async () => {
    const { api, updates } = makeSheets([HEADER, ['OldName', 'old_alice', 'U1']]);
    const result = await registerRosterEntry({
        sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1', dataName: 'NewName', discordName: 'alice2'
    });
    assert.deepStrictEqual(result, { ok: true, action: 'updated', rowIndex: 2 });
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].range, `${ROSTER_TAB}!A2:C2`);
    assert.deepStrictEqual(updates[0].values, ['NewName', 'alice2', 'U1']);
});

test('registerRosterEntry blocks a Data Name held by a different UUID (case-insensitive)', async () => {
    const { api, updates } = makeSheets([HEADER, ['Toe', 'toeshank', 'U1']]);
    const result = await registerRosterEntry({
        sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U2', dataName: 'TOE', discordName: 'imposter'
    });
    assert.deepStrictEqual(result, { ok: false, reason: 'NAME_TAKEN', takenBy: 'U1' });
    assert.strictEqual(updates.length, 0, 'no write on a name clash');
});

test('registerRosterEntry allows keeping your own name on re-register (same UUID)', async () => {
    const { api, updates } = makeSheets([HEADER, ['Toe', 'toeshank', 'U1']]);
    const result = await registerRosterEntry({
        sheets: api, auth: AUTH, spreadsheetId: SHEET_ID, uuid: 'U1', dataName: 'Toe', discordName: 'toeshank_new'
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'updated');
    assert.deepStrictEqual(updates[0].values, ['Toe', 'toeshank_new', 'U1']);
});

// Run -----------------------------------------------------------------------
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
