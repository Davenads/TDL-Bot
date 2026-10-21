# 11 — Event Day Migration: Monday → Tuesday

**Status:** Review / plan (no code changed yet)
**Trigger:** TDL events move from **Monday** to **Tuesday** nights, **same time of day (7:00 PM ET)**.

## 1. What actually changes

The whole schedule shifts **+1 day**. The time of day (19:00 ET) and the *shape*
of the cycle (registration opens the day after the event, closes the day before
the next event, event day fully closed for matchup building) are unchanged.

| | Old (Monday event) | New (Tuesday event) |
|---|---|---|
| Event | **Monday** 7:00 PM ET | **Tuesday** 7:00 PM ET |
| Window opens | Tuesday 12:00 AM ET | **Wednesday** 12:00 AM ET |
| Window closes | Sunday 11:59 PM ET | **Monday** 11:59 PM ET |
| Closed all day (organize) | Monday | **Tuesday** |
| Registration "week" starts | most recent Tuesday | most recent **Wednesday** |

### Assumption to confirm
This plan assumes a rigid +1-day shift of the *entire* window (open Wed 00:00 →
close Mon 23:59, Tuesday closed). If Toeshank wants a different window (e.g.
keep it open later into event day, or a longer/shorter window), only the
constants in `tdlWeekUtils.js` change — say the word and I'll adjust.

## 2. The single source of truth: `utils/tdlWeekUtils.js`

Everything else derives its event date/window from these three functions, so the
real change is here. Day indices: `0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat`.

### 2a. `isRegistrationOpen()` — closed day shifts Mon→Tue
```js
// OLD: closed only Monday
return day !== 1;
// NEW: closed only Tuesday (event/organize day). Open Wed..Mon.
return day !== 2;
```

### 2b. `getWeekStartDate()` — cycle start shifts Tue→Wed
```js
// OLD: most recent Tuesday
const daysSinceTuesday = day >= 2 ? day - 2 : day + 5;
// NEW: most recent Wednesday
const daysSinceWednesday = day >= 3 ? day - 3 : day + 4;
start.setDate(now.getDate() - daysSinceWednesday);
```

### 2c. `getCurrentEventDate()` — target event shifts Mon→Tue
```js
// OLD: upcoming Monday
const daysUntilMonday = (1 - day + 7) % 7;
// NEW: upcoming Tuesday (0 if today is Tuesday)
const daysUntilTuesday = (2 - day + 7) % 7;
event.setDate(now.getDate() + daysUntilTuesday);
event.setHours(19, 0, 0, 0); // 7:00 PM ET
```

### 2d. Comments / header block
Lines 4–6, 24, 29, 34, 41, 50–51, 65 all name "Monday"/"Tuesday"/"Sunday" — update
the doc comments to the new schedule and the "e.g. Monday, August 31" example.

### Day-of-week verification (new logic)

| Today | `isRegistrationOpen` | weekStart (most recent Wed) | event (upcoming Tue) |
|---|---|---|---|
| Sun | open | 4 days back | 2 days out |
| Mon | open | 5 days back | tomorrow |
| Tue | **closed** | 6 days back | **today** |
| Wed | open | today | 6 days out |
| Thu | open | 1 day back | 5 days out |
| Fri | open | 2 days back | 4 days out |
| Sat | open | 3 days back | 3 days out |

Invariant preserved: throughout a cycle, `weekStart` = the Wednesday that opened
it and `getCurrentEventDate` = the Tuesday that ends it, so current-week signups
stay correctly scoped to the upcoming event and roll over cleanly at Wed 00:00.
Structurally identical to the old Monday system.

## 3. User-facing copy that hardcodes a day

Only ONE place hardcodes day names in the bot UI:

**`commands/signup.js` → `windowClosedEmbed()`**
```
Opens: **Tuesday 12:00 AM ET**   →  Opens: **Wednesday 12:00 AM ET**
Closes: **Sunday 11:59 PM ET**   →  Closes: **Monday 11:59 PM ET**
The event runs **Mondays at 7:00 PM ET**.  →  ...**Tuesdays at 7:00 PM ET**.
```

Everywhere else the event date is rendered via `getEventDateString()` and the
time is the literal `7:00 PM ET` (unchanged), so **no change needed** in:
- `utils/signupEmbed.js` (line 87)
- `commands/signup.js` (lines 240, 371, 391 — date from `getEventDateString()`)
- `commands/withdraw.js` (line 99)
- `commands/tdlpanel.js` (line 43, `panelInfoEmbed`)

## 4. Comments elsewhere (accuracy only, no behavior)

- `utils/signupUtils.js` line 15: "Tuesday week-rollover" → "Wednesday week-rollover".
- `README.md` line 4: "runs Mondays at 7:00 PM ET" → "Tuesdays...".
- `README.md` lines 54–55: window description (open Wed / close Mon / Tuesday closed).

## 5. Tests

**No correctness changes required.** The suites use a current timestamp
(`formatSheetTimestamp()` = always ≥ `weekStart`) and a 2020 "stale" timestamp
(always < `weekStart`), so they're schedule-agnostic and stay green after the shift.

**Recommended (optional) hardening:** there is currently *no* unit test pinning the
window/event math. These functions read `new Date()` directly, so they aren't
testable as-is. Light refactor: give `isRegistrationOpen`, `getWeekStartDate`,
`getCurrentEventDate` an optional `now = nowET()` parameter, then add
`test/tdlWeekUtils.test.js` asserting the day-of-week table in §2 (feeding fixed
dates). This locks the Tuesday schedule against regressions and would be added to
the `npm test` chain. Can be its own small slice.

## 6. Plan-doc hygiene (optional)

These historical docs name the Monday schedule; update the living-reference ones
for accuracy or leave as dated records:
`plan/00-project-overview.md`, `plan/01-signup-command.md`, `plan/03-decisions.md`
(and in passing `plan/07`, `plan/10`).

## 7. Deployment timing (important — one-time transition)

The cache self-heals (the signups cache is `weekStart`-stamped, so a changed
`weekStart` forces a fresh read), **but the physical sheet rows do not**. If the
new code goes live mid-cycle, signups written under the old Tuesday-start window
could fall *before* the new Wednesday `weekStart` and be treated as stale
(dropped from `/recentsignups`, the panel, and dedupe).

**Recommendation:** deploy at the transition boundary — after the final Monday
event and before the first Tuesday event's signups begin — so no in-flight
current-week rows get re-scoped. Pair the league's announcement with the deploy.

External: Toeshank's Looker Studio report / sheet may have a "Monday" label or
date filter to update — out of bot scope, worth a heads-up.

## 8. Change checklist

Minimal (correctness):
- [ ] `utils/tdlWeekUtils.js` — 3 functions (§2a–2c) + comments (§2d)
- [ ] `commands/signup.js` — `windowClosedEmbed()` copy (§3)
- [ ] `utils/signupUtils.js` — comment (§4)
- [ ] `README.md` — lines 4, 54–55 (§4)

Optional:
- [ ] `test/tdlWeekUtils.test.js` + `now`-injection refactor + package.json (§5)
- [ ] plan-doc updates (§6)

Then: `npm test` → review → push → redeploy (Builds API) at the transition
boundary (§7). No command re-registration needed (no `data` definitions change).
