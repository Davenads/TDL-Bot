# Plan 10 — Persistent Signup Panel + Live Roster (+ Withdrawal)

## Goal
Add a persistent, self-updating panel to the prod channel **`#tdl-sign-up-page`
(`1539385574153003008`)** that lets duelers sign up and withdraw by button, and
shows a live list of everyone signed up for the upcoming Monday event — Data
Names grouped by division — sourced by mapping each signup's Discord UUID to the
`Roster` tab.

Decisions locked by the user:
1. **List format:** Names only (Data Names grouped `HLD (n)` / `LLD (n)`).
2. **Caching:** Reuse Redis; invalidate on signup, on withdrawal, and tolerate
   manual mod edits of the sheet (see §5).
3. **Who can create/bind the panel:** members holding role ID
   **`1538611745558626315`**.
4. **Withdrawal:** keep add/update, AND add a Withdraw button + `/withdraw`
   command that asks which division(s) to withdraw from.

---

## 1. Panel shape (one persistent message)
A single bot-owned message in the bound channel, **edited in place** on refresh:

- **Embed A — Signup panel:** title, `Event: <date> — 7:00 PM ET`, short
  instructions.
- **Embed B — Live roster:** identical to what `/recentsignups` renders today —
  dueler count + `HLD (n)` / `LLD (n)` fields of sorted Data Names. (Discord
  allows up to 10 embeds per message; two is fine.)
- **Action row:** `Sign Up` button (`tdlsignup_panel`) + `Withdraw` button
  (`tdlwithdraw_panel`). Static customIds → keep working across restarts.

Clicking a button produces an **ephemeral** flow private to that clicker, so one
shared message serves everyone. The roster embed is re-rendered and the message
edited whenever signups change (§4).

---

## 2. Reuse, don't duplicate — extract the embed builder
`commands/recentsignups.js` already: reads `getCurrentWeekSignups`, maps UUID →
Data Name via `getRosterMap` (fallback to stored Discord username), dedups by
UUID, groups by `['HLD','LLD']`, sorts, and truncates fields < 1024 chars.

- Extract that into `buildSignupsEmbed({ sheets, auth, spreadsheetId })` in
  `utils/signupUtils.js` (moving `fieldValue`, `DIVISIONS`), returning an
  `EmbedBuilder`.
- `recentsignups.execute` becomes a thin caller of it.
- The panel's Embed B is the same builder output. **One source of truth** for
  "who's signed up."

---

## 3. New module `commands/tdlpanel.js` (admin + lifecycle)
- **`/tdlpanel`** slash command, gated to role ID `1538611745558626315`
  (see §7). Run it **in the channel** you want the panel in:
  - If a binding exists for this mode and the message is still present → edit it
    (rebind/refresh, no duplicate).
  - Else post a fresh panel message, then store the binding.
  - Binding = `{ channelId, messageId }` stored in Redis under
    `tdl:panel:signup` (prod) / `tdl:panel:signup:test` (TEST_MODE). **No TTL**
    (persistent). Survives restarts.
  - No channel env var needed — binding to "the channel I was run in" makes
    TEST-guild QA vs prod a matter of where you run it.
- **Exports:**
  - `refreshSignupPanel(client, sheets, auth)` — read binding, rebuild embeds
    (forced-fresh, §5), edit the message. No-op if unbound or message gone.
  - `startPanelRefreshTimer(client, sheets, auth)` — `setInterval` every
    `PANEL_REFRESH_MS` (default 120000).
  - `getPanelBinding()` / `setPanelBinding()` helpers (or a tiny
    `utils/panelStore.js`).

---

## 4. Refresh triggers (keeping the roster live)
- **On boot** (`ready`, after Redis connects): if a binding exists, one
  `refreshSignupPanel` + `startPanelRefreshTimer`.
- **Timer:** every ~2 min, forced-fresh refresh (catches manual sheet edits and
  the Tuesday week-rollover, which `getCurrentWeekSignups` already week-scopes).
- **After `/signup` success:** `signup.handleModal` fires
  `refreshSignupPanel(interaction.client, sheets, auth)` (fire-and-forget).
- **After `/withdraw` success:** same.

---

## 5. Caching + invalidation (explicit — user-requested)
Existing primitives stay; we extend invalidation.

| Key | Purpose | TTL | Invalidation |
|---|---|---|---|
| `tdl:signups:current[:test]` | current-week signup rows (serves `/recentsignups` + panel) | 2h, weekStart-stamped | evict on `/signup` (exists), on `/withdraw` (NEW), and repopulated by the panel timer (NEW) |
| `tdl:roster` | UUID → Data Name map | 10 min | evict on `/register` (exists); TTL self-heals manual Roster edits |
| `tdl:panel:signup[:test]` | panel `{channelId,messageId}` binding | none (persistent) | overwritten by `/tdlpanel` |

**Manual-edit tolerance (the mod-edits-the-sheet case):**
- The ~2-min panel refresh does a **forced-fresh** read: it calls
  `invalidateSignupsCache()` then `getCurrentWeekSignups()`, which re-reads the
  sheet and **repopulates** the cache. So a mod's manual add/remove on the
  signup tab surfaces on the panel within ≤ ~2 min, and `/recentsignups` rides
  the freshly-warmed cache.
- Manual **Roster** edits self-heal within the 10-min roster TTL.
- Redis stays a pure cache; every helper already degrades to a live read if
  Redis is down (`utils/cache.js`), so nothing here can take the bot down.

**Binding-durability caveat:** the panel binding lives only in Redis. If Redis
is flushed, the live-refresh stops until an admin re-runs `/tdlpanel` (the
buttons still work — static customIds). Optional hardening: mirror the binding
to a tiny config cell. Deferred unless you want it.

---

## 6. Withdrawal flow — `commands/withdraw.js`
Entry points: `/withdraw` slash command **or** the panel `Withdraw` button
(`tdlwithdraw_panel`). Stateless (mirrors signup): the acting user comes from
`interaction.user.id`; the chosen division is carried in the button customId —
no session store.

1. Guild-only.
2. **Fresh** read of `REG_TAB!A:F`, filter to current week, collect the
   categories where column C (UUID) == the user → their active divisions.
3. **None** → ephemeral "You're not signed up this week."
4. **One** (e.g. HLD only) → ephemeral `[Withdraw from HLD] [Cancel]`.
   **Both** → ephemeral `[HLD] [LLD] [Both] [Cancel]`.
   Buttons: `tdlwithdraw_HLD` / `tdlwithdraw_LLD` / `tdlwithdraw_Both`.
5. On choice → re-validate fresh, **delete the matching row(s)**, evict cache,
   refresh panel, ephemeral confirmation (the live panel shows the removal).

New helpers in `utils/signupUtils.js` (write path → always fresh reads):
- `getUserSignupDivisions({ sheets, auth, spreadsheetId, uuid })` → `['HLD',...]`.
- `deleteSignupRowsForUser({ sheets, auth, spreadsheetId, uuid, divisions })` —
  resolves current-week rowIndexes for UUID+division and deletes them.
- `resolveSheetId({ sheets, auth, spreadsheetId, title })` — numeric gid lookup
  (memoized), needed for row deletion.

### §6a OPEN DECISION — how to "remove" a signup
Row deletion vs. cell-clear. Recommendation: **delete the physical row** via
`spreadsheets.batchUpdate` → `deleteDimension` (ROWS), deleting bottom-up for a
"Both" withdrawal to avoid index shift.
- **Pro:** clean sheet for admins — no blank/ghost rows, no orphaned Status.
- **Implication (acceptable):** the deleted row's manual **Status** value goes
  away with it — correct, the signup no longer exists. Column A on *other* rows
  is never touched.
- **Needs gid** (handled by `resolveSheetId`; prod `Discord Registration`
  gid=`1675827465`, test tab resolved dynamically).
- **Alternative (fallback):** clear B:F only (no gid needed, non-destructive to
  positions) but leaves blank rows + orphan Status that accumulate weekly.
  Not recommended given admins live in this sheet.

### §6b OPEN DECISION — window + notice
- **Window gate:** recommend **allow withdrawal anytime the user has a
  current-week signup** (withdrawing is always reductive/safe), with a soft note
  if the registration window is already closed ("matchups may be built — ping an
  admin"). Alternative: hard-gate to the open window like `/signup`.
- **Public notice:** recommend **ephemeral only** + panel refresh (the panel
  already reflects the removal publicly). Alternative: post a public
  "X withdrew" line like the signup confirmation.

---

## 7. Admin gating by role ID
`index.js` currently gates by role **name** (`command.role`). Add a parallel
**`command.roleId`** check in the command branch:
```
if (command.roleId && !interaction.member?.roles?.cache?.has(command.roleId)) { ... deny ... }
```
`tdlpanel.js` sets `roleId = process.env.TDL_PANEL_ADMIN_ROLE_ID ||
'1538611745558626315'`. Small, reusable, consistent with the existing hook.

---

## 8. Wiring changes in `index.js`
- `BUTTON_ROUTING` += `tdlwithdraw: 'withdraw'`. (`tdlsignup_panel` already
  routes to `signup` by prefix.)
- Add the `command.roleId` gate (§7).
- In `ready` (after Redis connect): `require('./commands/tdlpanel')` →
  `refreshSignupPanel(client, sheets, auth)` + `startPanelRefreshTimer(...)`.
- No change needed for per-signup refresh — `signup.handleModal` /
  `withdraw.handleButton` already receive `(interaction, sheets, auth)` and can
  call the panel refresher with `interaction.client`.

## 8a. `commands/signup.js` edits
- Extract `startSignup(interaction, sheets, auth)` from `execute()` (all the
  gates + the division-picker render); `execute()` calls it.
- In `handleButton`, branch: `tdlsignup_panel` → `startSignup(...)` (ephemeral);
  existing `tdlsignup_HLD|LLD|Both` → modal path unchanged.
- After a successful upsert: fire-and-forget `refreshSignupPanel`.

---

## 9. Env vars
- `TDL_PANEL_ADMIN_ROLE_ID=1538611745558626315`
- `PANEL_REFRESH_MS=120000` (optional)
- (No panel-channel var — binding is set by running `/tdlpanel` in-channel.)
- Add to `.env` and Heroku `tdl-bot` config.

---

## 10. Slash-command registration
`/tdlpanel` and `/withdraw` are new guild-scoped commands → re-run the
deploy-commands script after merge so they appear in both the TEST and prod
guilds.

---

## 11. Testing / QA
**Unit (mirror `test/upsert.test.js`, `test/signups.test.js`):**
- `buildSignupsEmbed` — grouping, sort, UUID dedup, field truncation, Data Name
  fallback.
- `getUserSignupDivisions` — correct set incl. "Both".
- `deleteSignupRowsForUser` — correct rowIndexes, bottom-up `deleteDimension`,
  leaves other rows intact, no-op when already withdrawn.
- Panel binding get/set; withdraw cache eviction.

**Staged manual QA (TEST first):** with `TEST_MODE=true` (writes to
`Discord Registration Test`): run `/tdlpanel` in a TEST-guild channel → `/signup`
(HLD, LLD, Both), confirm the live roster updates and `/recentsignups` matches →
`/withdraw` each variation, confirm rows deleted + panel updates → restart the
bot to confirm boot-refresh + buttons still fire. Then run `/tdlpanel` in the
real prod channel `1539385574153003008` and repeat a smoke test.

---

## 12. File-by-file
| File | Change |
|---|---|
| `commands/tdlpanel.js` | NEW — `/tdlpanel` (roleId-gated), `refreshSignupPanel`, timer, binding store |
| `commands/withdraw.js` | NEW — `/withdraw` + `handleButton` (`tdlwithdraw_*`), division clarification, deletion |
| `commands/signup.js` | extract `startSignup`, `tdlsignup_panel` branch, trigger panel refresh |
| `commands/recentsignups.js` | call shared `buildSignupsEmbed` |
| `utils/signupUtils.js` | add `buildSignupsEmbed`, `getUserSignupDivisions`, `deleteSignupRowsForUser`, `resolveSheetId` |
| `utils/panelStore.js` (opt) | binding get/set (or inline in tdlpanel.js) |
| `index.js` | BUTTON_ROUTING, `roleId` gate, boot refresh + timer |
| `.env` / Heroku config | `TDL_PANEL_ADMIN_ROLE_ID`, `PANEL_REFRESH_MS` |
| `test/*` | new + updated unit tests |

## 13. Rollback
Additive and non-destructive. Rollback = Heroku release rollback; delete the
panel message manually if needed. New commands/buttons leave existing `/signup`,
`/register`, `/recentsignups` untouched. Row deletion only ever removes a
withdrawing user's own current-week rows.

---

## Open decisions needing your nod before implementation
1. **§6a** — Delete the physical row (recommended, clean) vs. clear B:F cells
   (non-destructive but leaves ghost rows)?
2. **§6b window** — Allow withdrawal anytime signed up (recommended, with a
   soft "window closed" note) vs. hard-gate to the open window?
3. **§6b notice** — Withdrawal ephemeral-only + panel refresh (recommended) vs.
   also post a public "X withdrew" line?
