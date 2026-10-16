// Framework-free harness for the periodic signup reminder. Fakes a Discord
// client/channel and a googleapis `sheets`; Redis is forced OFF so reads hit the
// fake sheet. Clock is injected via the `now` option to drive the window gate.
//
//   node test/signupReminder.test.js
//
// Exit code 0 = all pass, 1 = any failure.

process.env.TEST_MODE = 'true'; // MUST precede requiring signupUtils (REG_TAB read at load)

const assert = require('assert');
const { PermissionFlagsBits } = require('discord.js');
const redisClient = require('../utils/redisClient');
redisClient.isReady = () => false; // cache off — reads hit the fake sheet

const { formatSheetTimestamp } = require('../utils/tdlWeekUtils');
const reminder = require('../utils/signupReminder');

const AUTH = { fake: true };
const NOW = formatSheetTimestamp();

const SIGNUP_HEADER = ['Status', 'Timestamp', 'Discord UUID', 'Discord Username', 'Notes', 'Category'];
const ROSTER_HEADER = ['Data Name', 'Discord Name', 'UUID'];

// Anchor week (per repo convention): Sun Oct 11 – Sat Oct 17 2026, event Tue 13.
const OPEN_THU = new Date(2026, 9, 15, 12, 0, 0);  // Thursday noon — window OPEN, no ping
const OPEN_THU_4PM = new Date(2026, 9, 15, 16, 0, 0); // Thursday 4 PM — window OPEN, ping hour
const OPEN_THU_8AM = new Date(2026, 9, 15, 8, 0, 0);  // Thursday 8 AM — window OPEN, no ping
const CLOSED_MON = new Date(2026, 9, 12, 20, 0, 0); // Monday 8 PM — CLOSED (post-7PM)
const CLOSED_TUE = new Date(2026, 9, 13, 12, 0, 0); // Tuesday noon — CLOSED (event day)

function makeSheets(signups) {
    return {
        spreadsheets: {
            values: {
                get: async ({ range }) => {
                    const rows = range.includes('Roster') ? [ROSTER_HEADER] : signups;
                    return { data: { values: rows.map(r => (r ? r.slice() : r)) } };
                }
            }
        }
    };
}

function fakeChannel({ canView = true, canSend = true } = {}) {
    const rec = { sent: [], deleted: [] };
    return {
        rec,
        guild: { members: { me: { id: 'bot' } } },
        permissionsFor: () => ({
            has: (flag) => {
                if (flag === PermissionFlagsBits.ViewChannel) return canView;
                if (flag === PermissionFlagsBits.SendMessages) return canSend;
                return true;
            }
        }),
        async send(payload) {
            const id = 'm' + (rec.sent.length + 1);
            rec.sent.push({ id, payload });
            return { id };
        },
        messages: {
            fetch: async (id) => ({ id, async delete() { rec.deleted.push(id); } })
        }
    };
}

function fakeClient(channel) {
    return { channels: { fetch: async () => channel } };
}

const SIGNUPS = [SIGNUP_HEADER, ['', NOW, 'U1', 'alice', '', 'HLD']];

let pass = 0, fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function buttonIds(payload) {
    return payload.components[0].toJSON().components.map(c => c.custom_id);
}

// ---- buildReminderPayload shape ----
test('buildReminderPayload: one counts embed + Sign Up/Withdraw row', async () => {
    const payload = await reminder.buildReminderPayload(makeSheets(SIGNUPS), AUTH);
    assert.strictEqual(payload.embeds.length, 1);
    assert.strictEqual(payload.embeds[0].data.title, 'TDL Signups');
    assert.strictEqual(payload.components.length, 1);
    assert.deepStrictEqual(buttonIds(payload), ['tdlsignup_panel', 'tdlwithdraw_panel']);
});

// ---- window gate ----
test('postReminderNow: no-op Monday after 7 PM (window closed)', async () => {
    reminder._resetForTest();
    const ch = fakeChannel();
    const posted = await reminder.postReminderNow(fakeClient(ch), makeSheets(SIGNUPS), AUTH, { now: CLOSED_MON });
    assert.strictEqual(posted, false);
    assert.strictEqual(ch.rec.sent.length, 0, 'nothing posted while closed');
});

test('postReminderNow: no-op Tuesday (event day, closed)', async () => {
    reminder._resetForTest();
    const ch = fakeChannel();
    const posted = await reminder.postReminderNow(fakeClient(ch), makeSheets(SIGNUPS), AUTH, { now: CLOSED_TUE });
    assert.strictEqual(posted, false);
    assert.strictEqual(ch.rec.sent.length, 0);
});

// ---- happy path ----
test('postReminderNow: posts the panel when the window is open', async () => {
    reminder._resetForTest();
    const ch = fakeChannel();
    const posted = await reminder.postReminderNow(fakeClient(ch), makeSheets(SIGNUPS), AUTH, { now: OPEN_THU });
    assert.strictEqual(posted, true);
    assert.strictEqual(ch.rec.sent.length, 1);
    const payload = ch.rec.sent[0].payload;
    assert.strictEqual(payload.embeds[0].data.title, 'TDL Signups');
    assert.deepStrictEqual(buttonIds(payload), ['tdlsignup_panel', 'tdlwithdraw_panel']);
});

// ---- Option B: replace previous ----
test('postReminderNow: deletes the prior reminder before posting the next', async () => {
    reminder._resetForTest();
    const ch = fakeChannel();
    const client = fakeClient(ch);
    const first = await reminder.postReminderNow(client, makeSheets(SIGNUPS), AUTH, { now: OPEN_THU });
    const second = await reminder.postReminderNow(client, makeSheets(SIGNUPS), AUTH, { now: OPEN_THU });
    assert.strictEqual(first, true);
    assert.strictEqual(second, true);
    assert.strictEqual(ch.rec.sent.length, 2, 'two posts total');
    assert.deepStrictEqual(ch.rec.deleted, ['m1'], 'the first reminder was deleted');
});

// ---- role ping: 4 PM only ----
test('postReminderNow: pings the role on the 4 PM post (content, not embed)', async () => {
    reminder._resetForTest();
    const ch = fakeChannel();
    const posted = await reminder.postReminderNow(fakeClient(ch), makeSheets(SIGNUPS), AUTH, { now: OPEN_THU_4PM });
    assert.strictEqual(posted, true);
    const payload = ch.rec.sent[0].payload;
    assert.strictEqual(payload.content, `<@&${reminder.PING_ROLE_ID}>`, 'role mention in content');
    assert.deepStrictEqual(payload.allowedMentions, { roles: [reminder.PING_ROLE_ID] });
    // Ping must NOT be baked into the embed.
    assert.ok(!(payload.embeds[0].data.description || '').includes(reminder.PING_ROLE_ID));
});

test('postReminderNow: no ping on the 8 AM post', async () => {
    reminder._resetForTest();
    const ch = fakeChannel();
    await reminder.postReminderNow(fakeClient(ch), makeSheets(SIGNUPS), AUTH, { now: OPEN_THU_8AM });
    const payload = ch.rec.sent[0].payload;
    assert.strictEqual(payload.content, undefined, 'no content ping outside 4 PM');
    assert.strictEqual(payload.allowedMentions, undefined);
});

test('buildReminderPayload: ping flag toggles the role mention content', async () => {
    const pinged = await reminder.buildReminderPayload(makeSheets(SIGNUPS), AUTH, { ping: true });
    assert.strictEqual(pinged.content, `<@&${reminder.PING_ROLE_ID}>`);
    const silent = await reminder.buildReminderPayload(makeSheets(SIGNUPS), AUTH, { ping: false });
    assert.strictEqual(silent.content, undefined);
});

// ---- perms preflight ----
test('postReminderNow: skips when the bot lacks Send Messages', async () => {
    reminder._resetForTest();
    const ch = fakeChannel({ canSend: false });
    const posted = await reminder.postReminderNow(fakeClient(ch), makeSheets(SIGNUPS), AUTH, { now: OPEN_THU });
    assert.strictEqual(posted, false);
    assert.strictEqual(ch.rec.sent.length, 0);
});

// ---- schedule idempotency ----
test('startReminderSchedule: idempotent (second call reuses the task)', () => {
    const client = fakeClient(fakeChannel());
    const t1 = reminder.startReminderSchedule(client, makeSheets(SIGNUPS), AUTH);
    const t2 = reminder.startReminderSchedule(client, makeSheets(SIGNUPS), AUTH);
    assert.strictEqual(t1, t2, 'same task returned, no second job scheduled');
    if (t1 && typeof t1.stop === 'function') t1.stop();
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
