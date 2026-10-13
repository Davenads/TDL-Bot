// Framework-free harness for the /tdlpanel OR permission gate
// (memberCanManagePanel). No network — just the pure role check.
//
//   node test/tdlpanel.test.js
//
// Exit code 0 = all pass, 1 = any failure.

const assert = require('assert');
const { memberCanManagePanel } = require('../commands/tdlpanel');

const ROLE_ID = '1538611745558626315';

// Build a fake member whose roles.cache mimics a discord.js Collection
// (Map.has(id) + a .some(fn) helper). `roles` = [{ id?, name? }].
function member(roles) {
    const map = new Map(roles.map((r, i) => [r.id || `auto${i}`, r]));
    map.some = (fn) => [...map.values()].some(fn);
    return { roles: { cache: map } };
}

let pass = 0;
let fail = 0;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('allows a member holding the panel-admin role ID', () => {
    assert.strictEqual(memberCanManagePanel(member([{ id: ROLE_ID, name: 'Panel Admin' }])), true);
});

test('allows a member with a role named "Moderator" (by name)', () => {
    assert.strictEqual(memberCanManagePanel(member([{ id: '999', name: 'Moderator' }])), true);
});

test('allows a member with BOTH the role ID and Moderator', () => {
    assert.strictEqual(memberCanManagePanel(member([
        { id: ROLE_ID, name: 'Panel Admin' },
        { id: '999', name: 'Moderator' }
    ])), true);
});

test('denies a member with neither', () => {
    assert.strictEqual(memberCanManagePanel(member([{ id: '123', name: 'Dueler' }])), false);
});

test('name match is exact (not "Moderators" or lowercase)', () => {
    assert.strictEqual(memberCanManagePanel(member([{ id: '1', name: 'Moderators' }])), false);
    assert.strictEqual(memberCanManagePanel(member([{ id: '2', name: 'moderator' }])), false);
});

test('denies when there are no roles', () => {
    assert.strictEqual(memberCanManagePanel(member([])), false);
});

test('safe on a member with no roles cache', () => {
    assert.strictEqual(memberCanManagePanel({ roles: {} }), false);
});

test('safe on a null/undefined member', () => {
    assert.strictEqual(memberCanManagePanel(null), false);
    assert.strictEqual(memberCanManagePanel(undefined), false);
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
