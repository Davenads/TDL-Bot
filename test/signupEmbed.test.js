// Framework-free harness for the shared signups embed builder.
// Fake googleapis `sheets` branches by range (Discord Registration vs Roster);
// Redis is forced OFF so every read is live (no cache interplay to reason about).
//
//   node test/signupEmbed.test.js
//
// Exit code 0 = all pass, 1 = any failure.

process.env.TEST_MODE = 'true'; // MUST precede requiring signupUtils (REG_TAB read at load)

const assert = require('assert');
const redisClient = require('../utils/redisClient');
const { formatSheetTimestamp } = require('../utils/tdlWeekUtils');
const { buildSignupsEmbed, fieldValue } = require('../utils/signupEmbed');

// Redis OFF → cacheGet returns null, every call reads Sheets live.
redisClient.isReady = () => false;

const AUTH = { fake: true };
const SHEET_ID = 'sheet-id';
const NOW = formatSheetTimestamp();
const STALE = '1/1/2020 12:00:00';

const SIGNUP_HEADER = ['Status', 'Timestamp', 'Discord UUID', 'Discord Username', 'Notes', 'Category'];
const ROSTER_HEADER = ['Data Name', 'Discord Name', 'UUID'];

// Fake `sheets` that returns signup rows or roster rows based on the A1 range.
function makeSheets({ signups, roster }) {
    return {
        spreadsheets: {
            values: {
                get: async ({ range }) => {
                    const rows = range.includes('Roster') ? roster : signups;
                    return { data: { values: rows.map(r => (r ? r.slice() : r)) } };
                }
            }
        }
    };
}

function embedOf(e) {
    const data = e.data;
    const fields = {};
    for (const f of data.fields || []) fields[f.name] = f.value;
    return { title: data.title, description: data.description, fields };
}

// ---- Runner ----
let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- Cases ----

test('fieldValue: empty -> _None yet_', () => {
    assert.strictEqual(fieldValue([]), '_None yet_');
});

test('fieldValue: joins names with comma', () => {
    assert.strictEqual(fieldValue(['alice', 'bob']), 'alice, bob');
});

test('fieldValue: truncates with +N more past the cap', () => {
    const names = Array.from({ length: 200 }, (_, i) => `player${i}`);
    const v = fieldValue(names);
    assert.ok(v.length <= 1024, 'stays under the Discord field cap');
    assert.ok(/\(\+\d+ more\)/.test(v), 'carries a +N more tail');
});

test('groups by division, maps Data Names from Roster, sorts', async () => {
    const sheets = makeSheets({
        signups: [
            SIGNUP_HEADER,
            ['', NOW, 'U1', 'aliceDiscord', '', 'HLD'],
            ['', NOW, 'U2', 'bobDiscord', 'gg', 'LLD'],
            ['', STALE, 'U3', 'oldcarol', '', 'HLD'] // last week -> excluded
        ],
        roster: [
            ROSTER_HEADER,
            ['Zara', 'aliceDiscord', 'U1'],
            ['Aaron', 'bobDiscord', 'U2']
        ]
    });
    const e = embedOf(await buildSignupsEmbed({ sheets, auth: AUTH, spreadsheetId: SHEET_ID }));
    assert.strictEqual(e.title, 'TDL Signups');
    assert.ok(e.description.includes('**2** duelers'), 'counts 2 unique duelers');
    assert.strictEqual(e.fields['HLD (1)'], 'Zara', 'HLD shows the roster Data Name');
    assert.strictEqual(e.fields['LLD (1)'], 'Aaron', 'LLD shows the roster Data Name');
});

test('falls back to Discord username when UUID not on roster', async () => {
    const sheets = makeSheets({
        signups: [SIGNUP_HEADER, ['', NOW, 'U9', 'mysteryDiscord', '', 'HLD']],
        roster: [ROSTER_HEADER]
    });
    const e = embedOf(await buildSignupsEmbed({ sheets, auth: AUTH, spreadsheetId: SHEET_ID }));
    assert.strictEqual(e.fields['HLD (1)'], 'mysteryDiscord', 'fallback to stored username');
});

test('dedupes a doubled-up UUID within one division', async () => {
    const sheets = makeSheets({
        signups: [
            SIGNUP_HEADER,
            ['', NOW, 'U1', 'alice', '', 'HLD'],
            ['', NOW, 'U1', 'alice', 'dup', 'HLD'] // manual double -> counted once
        ],
        roster: [ROSTER_HEADER, ['Alice', 'alice', 'U1']]
    });
    const e = embedOf(await buildSignupsEmbed({ sheets, auth: AUTH, spreadsheetId: SHEET_ID }));
    assert.ok(e.description.includes('**1** dueler'), 'one unique dueler');
    assert.strictEqual(e.fields['HLD (1)'], 'Alice');
});

test('empty week renders zero duelers and _None yet_ fields', async () => {
    const sheets = makeSheets({ signups: [SIGNUP_HEADER], roster: [ROSTER_HEADER] });
    const e = embedOf(await buildSignupsEmbed({ sheets, auth: AUTH, spreadsheetId: SHEET_ID }));
    assert.ok(e.description.includes('**0** duelers'), 'zero duelers');
    assert.strictEqual(e.fields['HLD (0)'], '_None yet_');
    assert.strictEqual(e.fields['LLD (0)'], '_None yet_');
});

test('roster read failure is non-fatal (falls back to usernames)', async () => {
    const sheets = {
        spreadsheets: {
            values: {
                get: async ({ range }) => {
                    if (range.includes('Roster')) throw new Error('roster boom');
                    return { data: { values: [SIGNUP_HEADER, ['', NOW, 'U1', 'aliceDiscord', '', 'HLD']] } };
                }
            }
        }
    };
    const e = embedOf(await buildSignupsEmbed({ sheets, auth: AUTH, spreadsheetId: SHEET_ID }));
    assert.strictEqual(e.fields['HLD (1)'], 'aliceDiscord', 'username fallback on roster error');
});

test('signups read failure propagates (caller shows unavailable)', async () => {
    const sheets = { spreadsheets: { values: { get: async () => { throw new Error('signups boom'); } } } };
    await assert.rejects(
        () => buildSignupsEmbed({ sheets, auth: AUTH, spreadsheetId: SHEET_ID }),
        /signups boom/
    );
});

// ---- Run ----
process.on('unhandledRejection', (err) => { console.error('Unhandled rejection:', err); process.exit(1); });

(async () => {
    for (const t of tests) {
        try { await t.fn(); console.log(`PASS  ${t.name}`); pass++; }
        catch (err) { console.error(`FAIL  ${t.name}\n      ${err.message}`); fail++; }
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((err) => { console.error('Runner crashed:', err); process.exit(1); });
