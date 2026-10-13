// Framework-free harness pinning the TUESDAY registration schedule.
// Exercises the now-injection in tdlWeekUtils (isRegistrationOpen /
// getWeekStartDate / getCurrentEventDate) against a fixed, known week so the
// day-of-week math can never silently regress.
//
//   node test/tdlWeekUtils.test.js
//
// Exit code 0 = all pass, 1 = any failure.

const assert = require('assert');
const {
    isRegistrationOpen,
    getWeekStartDate,
    getCurrentEventDate
} = require('../utils/tdlWeekUtils');

// Anchor week (verified): local-time noon on each day of a real 2026 week.
//   Sun Oct 11 .. Sat Oct 17, 2026  (Tue Oct 13 is the event/closed day).
// Using local-time Dates keeps the setDate/setHours arithmetic in the same
// zone the functions operate in, so the assertions are deterministic.
const D = (y, m, d, h = 12) => new Date(y, m, d, h, 0, 0, 0);

const SUN = D(2026, 9, 11);
const MON = D(2026, 9, 12);
const TUE = D(2026, 9, 13);
const WED = D(2026, 9, 14);
const THU = D(2026, 9, 15);
const FRI = D(2026, 9, 16);
const SAT = D(2026, 9, 17);

// Sanity: the anchor dates really are the weekdays we think they are.
const DAY = { SUN: 0, MON: 1, TUE: 2, WED: 3, THU: 4, FRI: 5, SAT: 6 };

let pass = 0;
let fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function sameDay(actual, y, m, d) {
    return actual.getFullYear() === y && actual.getMonth() === m && actual.getDate() === d;
}

// ---- Anchor sanity ----
test('anchor dates map to the expected weekdays', () => {
    assert.strictEqual(SUN.getDay(), DAY.SUN);
    assert.strictEqual(MON.getDay(), DAY.MON);
    assert.strictEqual(TUE.getDay(), DAY.TUE);
    assert.strictEqual(WED.getDay(), DAY.WED);
    assert.strictEqual(THU.getDay(), DAY.THU);
    assert.strictEqual(FRI.getDay(), DAY.FRI);
    assert.strictEqual(SAT.getDay(), DAY.SAT);
});

// ---- isRegistrationOpen: closed only Tuesday ----
test('registration is OPEN Wed through Mon', () => {
    for (const d of [WED, THU, FRI, SAT, SUN, MON]) {
        assert.strictEqual(isRegistrationOpen(d), true, `expected open on getDay ${d.getDay()}`);
    }
});

test('registration is CLOSED on Tuesday (event/organize day)', () => {
    assert.strictEqual(isRegistrationOpen(TUE), false);
});

// ---- getWeekStartDate: most recent Wednesday 00:00 ----
test('weekStart is always a Wednesday at local midnight', () => {
    for (const d of [SUN, MON, TUE, WED, THU, FRI, SAT]) {
        const ws = getWeekStartDate(d);
        assert.strictEqual(ws.getDay(), DAY.WED, `weekStart not Wednesday for getDay ${d.getDay()}`);
        assert.strictEqual(ws.getHours(), 0);
        assert.strictEqual(ws.getMinutes(), 0);
        assert.strictEqual(ws.getSeconds(), 0);
    }
});

test('weekStart resolves to the correct Wednesday across the cycle', () => {
    // Sun/Mon/Tue belong to the cycle opened Wed Oct 7.
    for (const d of [SUN, MON, TUE]) {
        assert.ok(sameDay(getWeekStartDate(d), 2026, 9, 7), `expected Oct 7 for getDay ${d.getDay()}`);
    }
    // Wed..Sat belong to the cycle opened Wed Oct 14.
    for (const d of [WED, THU, FRI, SAT]) {
        assert.ok(sameDay(getWeekStartDate(d), 2026, 9, 14), `expected Oct 14 for getDay ${d.getDay()}`);
    }
});

// ---- getCurrentEventDate: upcoming Tuesday 18:00 ----
test('event date is always a Tuesday at 6:00 PM', () => {
    for (const d of [SUN, MON, TUE, WED, THU, FRI, SAT]) {
        const ev = getCurrentEventDate(d);
        assert.strictEqual(ev.getDay(), DAY.TUE, `event not Tuesday for getDay ${d.getDay()}`);
        assert.strictEqual(ev.getHours(), 18);
        assert.strictEqual(ev.getMinutes(), 0);
    }
});

test('event date resolves to the correct Tuesday across the cycle', () => {
    // Sun/Mon/Tue point at Tue Oct 13 (Tuesday returns today).
    for (const d of [SUN, MON, TUE]) {
        assert.ok(sameDay(getCurrentEventDate(d), 2026, 9, 13), `expected Oct 13 for getDay ${d.getDay()}`);
    }
    // Wed..Sat point at the next Tuesday, Oct 20.
    for (const d of [WED, THU, FRI, SAT]) {
        assert.ok(sameDay(getCurrentEventDate(d), 2026, 9, 20), `expected Oct 20 for getDay ${d.getDay()}`);
    }
});

test('weekStart (Wed) and event (Tue) bound the same cycle', () => {
    // The Wednesday that opened the cycle is 6 days before the Tuesday that ends it.
    for (const d of [SUN, MON, TUE, WED, THU, FRI, SAT]) {
        const ws = getWeekStartDate(d);
        const ev = getCurrentEventDate(d);
        // Normalize the event to local midnight so the 6:00 PM event time
        // doesn't skew the calendar-day delta.
        const evMidnight = new Date(ev.getFullYear(), ev.getMonth(), ev.getDate());
        const days = Math.round((evMidnight - ws) / 86400000);
        assert.strictEqual(days, 6, `cycle span not 6 days for getDay ${d.getDay()}`);
    }
});

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
