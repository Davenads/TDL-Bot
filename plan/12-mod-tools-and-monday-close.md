# Plan 12 — Panel Mod-Tools Wizard + Monday 7 PM Close

Reference doc for two separate asks:

- **Part A — Mod-tools wizard**: a mod-only button on the signup panel that opens
  an ephemeral menu of moderator actions. MVP action = *view this week's signups
  (names)*. This doc also brainstorms additional mod flows to phase in later.
- **Part B — Monday 7 PM close** (independent, ready to implement): signups close
  **Monday 7:00 PM ET** (not Monday 11:59 PM) so Toeshank can build the fight card
  before the Tuesday event.

Nothing here is implemented yet. Part B is a small, low-risk slice that can land on
its own; Part A is phased.

---

## Part B — Signups close Monday 7:00 PM ET (do first, small slice)

### Current behavior
`utils/tdlWeekUtils.js :: isRegistrationOpen` is **day-only**:

```js
function isRegistrationOpen(now = nowET()) {
    const day = now.getDay();
    return day !== 2;            // closed ALL DAY Tuesday only
}
```

So today the window is: open Wed 12:00 AM ET → **Mon 11:59 PM ET**, closed all Tue.

### Target behavior
Open Wed 12:00 AM ET → **Mon 7:00 PM ET**. Then closed Mon 7 PM → through Tue
(event/organize day) → reopens Wed 12:00 AM. The close becomes **time-aware**:

```js
function isRegistrationOpen(now = nowET()) {
    const day = now.getDay();
    if (day === 2) return false;                     // Tuesday: event day, closed all day
    if (day === 1 && now.getHours() >= 19) return false; // Monday: closes 7:00 PM ET
    return true;                                     // Wed–Sun open; Mon open until 19:00
}
```

`nowET()` already yields ET wall-clock, so `getHours()` is ET hours — no extra TZ
work. Cutoff is `>= 19`, i.e. 6:59 PM open, 7:00 PM closed.

### What does NOT change
- `getWeekStartDate` (most-recent-Wednesday) and `getCurrentEventDate` (upcoming
  Tuesday 7 PM) are untouched. The weekStart cache stamp is unaffected, so there's
  **no row self-heal / deploy-timing caveat** — this can ship any time.
- `/withdraw` stays allowed anytime (soft note when closed) — unchanged.

### Copy + doc edits
- `commands/signup.js` → `windowClosedEmbed`: `Closes: **Monday 11:59 PM ET**` →
  `Closes: **Monday 7:00 PM ET**`. Keep/boost the reason line ("Signups close
  before the event so Toeshank can build the fight card").
- `README.md` window description: `closes Monday 11:59 PM ET` → `closes Monday
  7:00 PM ET`.
- `utils/tdlWeekUtils.js` header comment: window line → `closes Monday 7:00 PM ET`.

### Tests (`test/tdlWeekUtils.test.js`)
The `D(y,m,d,h=12)` helper already takes an hour. Add Monday-evening cases:
- `isRegistrationOpen(D(2026,9,12,18))` → **open** (6 PM Mon).
- `isRegistrationOpen(D(2026,9,12,19))` → **closed** (7 PM Mon, boundary).
- `isRegistrationOpen(D(2026,9,12,20))` → **closed** (8 PM Mon).
- Existing "open Wed–Mon" case uses MON at noon → still open (unaffected).

### Checklist (Part B)
1. `isRegistrationOpen` time-aware (above).
2. signup.js close-copy + README + header comment.
3. Monday-evening tests.
4. `npm test` → commit → push → re-deploy (Builds API). No command re-registration
   (no slash definition changes).

---

## Part A — Mod-tools wizard on the panel

### The ask
Add a **mod-only button** to the panel that opens a wizard of moderator options.
First option: **see the list of users signed up for the current week** (the public
panel is counts-only by design — plan 10 / recent change — so names live behind a
mod gate).

### Entry points (recommend BOTH)
Mirror the signup/withdraw pattern (shared entry fn used by a slash command AND a
panel button):

- **Panel button** `tdlmod_panel` (label "Mod Tools", Secondary style), added to
  `panelButtons()` in `tdlpanel.js`. Satisfies the request.
- **Slash `/tdlmod`** (ephemeral) — a clean, invisible-to-non-mods entry. Optional
  but cheap, and avoids the one downside of the button (below).

> **Button visibility tradeoff:** the panel message is public, so the "Mod Tools"
> button is *visible to everyone*; Discord can't hide a component per-user. Non-mods
> who click get an ephemeral "You need the Moderator role" reply (gated server-side,
> same `memberCanManagePanel`). This is cosmetic only. The `/tdlmod` slash command
> is the clean alternative for mods who'd rather not see a button they can't tell
> apart. → **Open question Q1.**

### Gate
Reuse `memberCanManagePanel(interaction.member)` (already exported from
`tdlpanel.js`): panel-admin role ID `1538611745558626315` **OR** a role named
`Moderator`. Enforced at the top of every `tdlmod_*` handler and `/tdlmod`.
Destructive actions may warrant a narrower gate (Toeshank only) — **Q2**.

### Wizard UI mechanism
`index.js` currently routes `isButton`, `isModalSubmit`, `isAutocomplete` — **no
select-menu branch**. Two options for the action menu:

- **Buttons (MVP, recommended):** render the action list as buttons
  (`tdlmod_view`, `tdlmod_refresh`, …). Routes through the existing `isButton`
  path via the `tdlmod` prefix — **no `index.js` change beyond adding `tdlmod` to
  `BUTTON_ROUTING`.** Up to 25 buttons (5×5); plenty for the action set.
- **Select menu (later):** nicer for long lists and for *user-select* (pick a
  signed-up player to remove). Requires adding a generic select-menu branch to
  `index.js` (`SELECT_ROUTING` mirroring `BUTTON_ROUTING`). Needed for Phase 2
  "remove player" via user-select. → **Q3.**

### Plumbing
- New file `commands/tdlmod.js`: `data` = `SlashCommandBuilder('tdlmod')`,
  `execute` → `startModTools(interaction, sheets, auth)`, `handleButton` routes
  `tdlmod_*`. (Loader requires `data` + `execute`.)
- `index.js`: add `tdlmod: 'tdlmod'` to `BUTTON_ROUTING` (+ select branch later).
- `tdlpanel.js`: add the `tdlmod_panel` button to `panelButtons()`. Because
  `buildPanelPayload()` rebuilds the buttons on every refresh, the new button
  **appears on the live panel within one refresh cycle (≤2 min) after deploy** —
  no need to re-post the panel.
- Re-register slash commands (adds `/tdlmod`).

### Reusable building blocks (already exist)
| Need | Reuse |
|---|---|
| Mod gate | `memberCanManagePanel` (tdlpanel) |
| Names view | `buildSignupsEmbed({ …, countsOnly:false })` (signupEmbed) |
| Raw current-week rows | `getCurrentWeekSignups` (signupUtils) |
| Data Names | `getRosterMap` (rosterUtils) |
| Remove a player | `getUserSignupDivisions` + `deleteSignupRowsForUser` + `resolveSheetId` (signupUtils) |
| Post-write freshness | `invalidateSignupsCache` + `refreshSignupPanel` |
| Manual add | the `/signup` upsert (would need extracting/exporting from signup.js) |

---

## Brainstormed mod flows (ranked, for phasing)

### Phase 1 — MVP (small, high value)
1. **View current-week signups (names)** *(requested)* — ephemeral; per-division
   name list (Data Name, fallback Discord name), deduped by UUID. Option to also
   show who's in **Both** and each row's **notes**. Reuses `buildSignupsEmbed`.
2. **Force-refresh the panel now** — evict cache + rebuild immediately instead of
   waiting for the 2-min timer; handy right after a manual sheet edit. One button,
   calls `invalidateSignupsCache` + `refreshSignupPanel`.

### Phase 2 — Fight-card workflow (what Toeshank actually needs)
3. **Export fight-card data** — a copy-paste-ready codeblock **or** a downloadable
   `.csv`/`.txt` attachment: Data Name, Discord name, division, notes, timestamp;
   grouped by division, Both players listed under each. This is the raw material for
   building matchups. (Attachment via the Discord upload path or an embed codeblock.)
4. **Remove a player (admin override)** — pick a signed-up player (user-select) +
   division; delete their row(s) via `deleteSignupRowsForUser`. For no-shows, bans,
   or corrections. Confirm step; then evict + refresh panel. Requires select-menu
   routing (Q3).

### Phase 3 — Stats + control
5. **Signup stats / breakdown** — unique duelers, per-division counts, count in
   **Both**, optional week-over-week delta. Richer than the public counts embed.
6. **Manual open/close override** — a Redis-backed "lock signups now" / "reopen"
   switch that overrides the time window: close early, or extend past Monday 7 PM if
   the card isn't ready. Interacts with Part B's auto-close (override wins). → **Q4.**
7. **Manual add (admin signup override)** — add a dueler on their behalf, optionally
   bypassing the role/roster gate for edge cases (late roster entry). Reuses the
   upsert; care around the roster gate. → **Q5.**

### Phase 4 — Comms + destructive
8. **Ping / announce signed-up duelers** — post a pre-event reminder that
   @-mentions everyone signed up, to a chosen channel.
9. **Post the fight card** — once matchups are built (externally), paste/post the
   final card to an announcement/results channel as a formatted embed.
10. **Clear all signups for the week (danger)** — bottom-up delete of all
    current-week rows, red confirm; full week reset.
11. **Lookup one player's status** — by mention/UUID: divisions, notes, timestamp.
12. **Audit / recent activity** — last N signup/withdraw actions. Bigger lift: we
    don't persist an activity log today; would need one (Redis list or a sheet tab).

---

## Privacy note (why this is gated)
The public panel was deliberately switched to **counts-only** (no names). The
mod-tools "view signups" keeps the full name list **behind the mod gate and
ephemeral**, so names are never exposed publicly while mods retain full visibility.
Consistent with the counts-only decision.

---

## Open questions
- **Q1 — Entry point:** OK with the public panel showing a "Mod Tools" button to
  everyone (clicks gated; non-mods get an ephemeral denial)? Or button **plus** an
  ephemeral `/tdlmod` slash command, or `/tdlmod` **only** (no public button)?
- **Q2 — Who is a "mod":** same gate as `/tdlpanel` (role ID `1538611745558626315`
  OR "Moderator")? Should destructive actions (remove player, clear week) be
  restricted further to Toeshank / a head-mod (which user ID or role)?
- **Q3 — Menu mechanism:** buttons for MVP (no `index.js` select plumbing), adding
  select-menu routing later for "remove player"? Or build select-menu support now?
- **Q4 — Manual open/close override:** in scope? If yes, should a manual lock/unlock
  override the Part B auto-close both directions (force-closed *and* force-open)?
- **Q5 — Manual add override:** should admins be able to add a player who fails the
  role/roster gate, or must the roster gate always hold (add only after `/register`)?
- **Q6 — "View signups" detail level:** Data Name + Discord name only, or also
  include **notes** and **signup timestamp**? Flag **Both**-division players?
- **Q7 — Fight-card export format:** copy-paste codeblock in Discord, or a
  downloadable `.csv` / `.txt` attachment (or both)?
- **Q8 — Phasing:** confirm Phase 1 (view + force-refresh) as the first slice, then
  rank which Phase 2+ flows you actually want (several brainstormed are optional).
