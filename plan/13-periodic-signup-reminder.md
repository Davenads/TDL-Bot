# 13 — Periodic Signup Reminder Post

## Goal
The bot automatically posts a **signup panel** (counts embed + Sign Up/Withdraw
buttons) into the **TDL-chat** channel (`1537111833260064788`) every **8 hours**,
nudging duelers to sign up. Suppressed during the closed window (Monday 7:00 PM
ET through the Tuesday event) so we don't nag after signups lock.

## Requirements (locked — per Toeshank, lead mod)
- Post **every 8 hours**.
- Target channel: **TDL-chat** (`1537111833260064788`), **hardcoded** — no new
  env var required (matches the Configuration-Values convention in CLAUDE.md).
- Embed = the **counts panel embed**: total "N duelers signed up so far" + per-
  format **HLD / LLD** counts + event date (`buildSignupsEmbed countsOnly`).
- Buttons: **Sign Up + Withdraw** (`panelButtons()` — `tdlsignup_panel` /
  `tdlwithdraw_panel`).
- **Skip** posting during the closed window (Monday 7 PM → Tuesday event).

## What we reuse (almost everything already exists)
- **node-cron** `^4.0.7` — already a dependency; no new packages.
- **`buildSignupsEmbed({ countsOnly: true })`** (`utils/signupEmbed.js`) — the
  exact embed in Toeshank's mockup (total + HLD/LLD counts).
- **`panelButtons()`** (`commands/tdlpanel.js`) — the Sign Up + Withdraw row.
  Their customIds (`tdlsignup_panel` / `tdlwithdraw_panel`) already route via
  index.js `BUTTON_ROUTING` to signup.js / withdraw.js regardless of which
  message they sit on, so the reminder's buttons work with zero new routing.
- **`isRegistrationOpen(now)`** (`utils/tdlWeekUtils.js`) — returns `false`
  Monday ≥ 19:00 and all Tuesday, which exactly matches the skip rule.

To avoid a require cycle, the reminder module will import a small
`buildReminderPayload(sheets, auth)` that calls `buildSignupsEmbed countsOnly`
and `panelButtons()`. (We may export `panelButtons`/`buildPanelPayload` from
tdlpanel.js, or rebuild the counts payload locally — decide at implementation.)

## Design

### New module: `utils/signupReminder.js`
Mirrors the panel's `startPanelRefreshTimer` pattern; keeps cron/posting out of
command files. Exports:
- `startReminderSchedule(client, sheets, auth)` — register the cron job;
  idempotent (second call is a no-op).
- `buildReminderPayload(sheets, auth)` — `{ embeds: [countsEmbed], components: [panelButtons] }`.
- `postReminderNow(client, sheets, auth)` — the gated post routine (exported for
  unit testing).

### Scheduling
Fixed ET clock times (predictable, restart-safe, no boot drift). 8-hour cadence:
```js
cron.schedule('0 0,8,16 * * *', fn, { timezone: 'America/New_York' });
// 12:00 AM, 8:00 AM, 4:00 PM ET
```
On each fire → `postReminderNow(client, sheets, auth)`.

### Gating (`postReminderNow`)
1. `if (!isRegistrationOpen()) return;` — skips Mon 7 PM → Tue.
2. Fetch channel `1537111833260064788`; bail non-fatally if unavailable.
3. Preflight bot View/Send perms (same pattern as `/tdlpanel`); warn + bail if
   missing.
4. Build fresh counts payload (forced-fresh read like the panel) and post.

### Channel constant
```js
const REMINDER_CHANNEL_ID = process.env.REMINDER_CHANNEL_ID || '1537111833260064788';
```
Works with no env set; override stays available per convention.

### Wiring (`index.js`, ready handler)
After the panel boot block, non-fatal:
```js
require('./utils/signupReminder').startReminderSchedule(client, sheets, auth);
```

## Clutter handling — one remaining choice
Toeshank said "spam... every 8 hours," so repeated posts are intended. Options:
- **A — Fire-and-forget:** post each time, never delete. Literally what "spam"
  implies; most chat clutter.
- **B — Replace previous (recommended):** track the last reminder message ID
  (in-memory) and delete it when posting the next, so exactly one reminder is
  live but it still bumps to the bottom of chat on each fire. A dyno restart just
  orphans one old post (harmless), then B resumes. Redis-persist later if wanted.

Recommendation: **B** — keeps the nudge without a growing pile.

Note: each scheduled post is a point-in-time counts snapshot. `refreshSignupPanel`
only updates the *bound* panel, not these reminders — so a reminder's counts
won't live-update after someone clicks its button; the next scheduled post (or
the replacement under Option B) shows fresh numbers. Acceptable.

## Resolved open questions
1. Cadence → **every 8h** at `0 0,8,16` ET (Toeshank). *(times adjustable)*
2. Clutter → **B** recommended; final pick pending.
3. Scope/channel → **hardcoded** `1537111833260064788`, no env var (constant has
   dormant env override).
4. Counts → **yes**, counts embed (Toeshank's mockup).
5. First-post timing → **wait** for next scheduled fire (no burst on each boot).
6. Mention → **silent** embed (no role ping); Toeshank didn't request a ping.

## Testing (framework-free harness)
- `postReminderNow` no-ops when `isRegistrationOpen()` is false (Mon 8 PM, Tue
  noon) — assert no channel send.
- `postReminderNow` sends when open (e.g. Thursday) — assert one send: counts
  embed + a row with `tdlsignup_panel` and `tdlwithdraw_panel`.
- `buildReminderPayload` shape: one embed, one action row, both button customIds.
- (If Option B) replacing deletes the prior message ID.
- `startReminderSchedule` idempotent — second call registers no second job.

## Rollout
1. Confirm clutter choice (A vs B) + the three post times.
2. Implement `utils/signupReminder.js` + wire into `index.js`.
3. Add `test/signupReminder.test.js`; append to `package.json` test script.
4. `npm test` green → review → commit/push → deploy (Builds API) → verify dyno
   log shows the schedule registered.
