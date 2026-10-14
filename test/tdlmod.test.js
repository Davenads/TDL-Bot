// Framework-free harness for the mod-tools command gate + button routing.
// Fakes Discord interactions/members and a googleapis `sheets`; Redis is forced
// OFF so refreshSignupPanel finds no binding (returns false deterministically).
//
//   node test/tdlmod.test.js
//
// Exit code 0 = all pass, 1 = any failure.

process.env.TEST_MODE = 'true'; // MUST precede requiring signupUtils (REG_TAB read at load)

const assert = require('assert');
const redisClient = require('../utils/redisClient');
redisClient.isReady = () => false; // cache off, no bound panel

const { formatSheetTimestamp } = require('../utils/tdlWeekUtils');
const tdlmod = require('../commands/tdlmod');

const AUTH = { fake: true };
const SHEET_ID = 'sheet-id';
const NOW = formatSheetTimestamp();

const SIGNUP_HEADER = ['Status', 'Timestamp', 'Discord UUID', 'Discord Username', 'Notes', 'Category'];
const ROSTER_HEADER = ['Data Name', 'Discord Name', 'UUID'];

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

// Fake member whose roles cache supports `.has(id)` (Map native) and `.some(fn)`.
function fakeMember({ mod = false } = {}) {
    const cache = new Map();
    if (mod) cache.set('Moderator', { id: 'r-mod', name: 'Moderator' });
    cache.some = (fn) => [...cache.values()].some(fn);
    return { roles: { cache } };
}

function fakeInteraction({ customId = '', member = fakeMember(), guild = { id: 'g1' } } = {}) {
    const rec = { replies: [], defers: 0, edits: [] };
    const i = {
        customId,
        guild,
        member,
        user: { id: 'U1', tag: 'tester#0001' },
        client: {},
        replied: false,
        deferred: false,
        async reply(o) { rec.replies.push(o); this.replied = true; },
        async deferReply(o) { rec.defers++; this.deferred = true; },
        async editReply(o) { rec.edits.push(o); },
        rec
    };
    return i;
}

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ---- data ----
test('exposes a /tdlmod slash command', () => {
    assert.strictEqual(tdlmod.data.name, 'tdlmod');
});

test('command is hidden by default (default_member_permissions = 0)', () => {
    // discord.js serializes the builder; 0 => admins-only until granted in Integrations.
    const json = tdlmod.data.toJSON();
    assert.strictEqual(json.default_member_permissions, '0');
});

// ---- startModTools (entry) ----
test('startModTools denies a non-mod', async () => {
    const i = fakeInteraction({ member: fakeMember({ mod: false }) });
    await tdlmod.startModTools(i);
    assert.strictEqual(i.rec.replies.length, 1);
    assert.ok(/Moderator/.test(i.rec.replies[0].content), 'deny mentions Moderator');
    assert.strictEqual(i.rec.replies[0].ephemeral, true);
});

test('startModTools shows the menu to a mod', async () => {
    const i = fakeInteraction({ member: fakeMember({ mod: true }) });
    await tdlmod.startModTools(i);
    assert.strictEqual(i.rec.replies.length, 1);
    const payload = i.rec.replies[0];
    assert.ok(payload.embeds && payload.embeds.length === 1, 'menu embed present');
    assert.ok(payload.components && payload.components.length === 1, 'button row present');
    assert.strictEqual(payload.ephemeral, true);
});

// ---- handleButton routing/gate ----
test('handleButton ignores non-tdlmod customIds', async () => {
    const i = fakeInteraction({ customId: 'tdlsignup_panel', member: fakeMember({ mod: true }) });
    const handled = await tdlmod.handleButton(i, makeSheets({ signups: [SIGNUP_HEADER], roster: [ROSTER_HEADER] }), AUTH);
    assert.strictEqual(handled, false);
});

test('handleButton denies a non-mod on tdlmod_view (no sheet read)', async () => {
    let reads = 0;
    const sheets = { spreadsheets: { values: { get: async () => { reads++; return { data: { values: [] } }; } } } };
    const i = fakeInteraction({ customId: 'tdlmod_view', member: fakeMember({ mod: false }) });
    const handled = await tdlmod.handleButton(i, sheets, AUTH);
    assert.strictEqual(handled, true);
    assert.strictEqual(reads, 0, 'gate blocks before any sheet read');
    assert.ok(/Moderator/.test(i.rec.replies[0].content));
});

test('handleButton tdlmod_view returns the mod embed for a mod', async () => {
    const sheets = makeSheets({
        signups: [SIGNUP_HEADER, ['', NOW, 'U1', 'aliceDiscord', '', 'HLD']],
        roster: [ROSTER_HEADER, ['Zara', 'aliceDiscord', 'U1']]
    });
    const i = fakeInteraction({ customId: 'tdlmod_view', member: fakeMember({ mod: true }) });
    const handled = await tdlmod.handleButton(i, sheets, AUTH);
    assert.strictEqual(handled, true);
    assert.strictEqual(i.rec.defers, 1, 'deferred ephemerally');
    assert.ok(i.rec.edits[0].embeds && i.rec.edits[0].embeds.length === 1, 'edited with an embed');
    const data = i.rec.edits[0].embeds[0].data;
    const fields = {};
    for (const f of data.fields || []) fields[f.name] = f.value;
    assert.strictEqual(fields['HLD (1)'], 'Zara (aliceDiscord)');
});

test('handleButton tdlmod_refresh reports no bound panel (Redis off)', async () => {
    const i = fakeInteraction({ customId: 'tdlmod_refresh', member: fakeMember({ mod: true }) });
    const handled = await tdlmod.handleButton(i, makeSheets({ signups: [SIGNUP_HEADER], roster: [ROSTER_HEADER] }), AUTH);
    assert.strictEqual(handled, true);
    assert.strictEqual(i.rec.defers, 1);
    assert.ok(/No bound panel/.test(i.rec.edits[0].content), 'reports nothing to refresh');
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
