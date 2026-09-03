# `/signup` Command — Design (Planning)

The first and focal feature. Lets a player register for the weekly Monday event.

## Goals

- One command: `/signup` (also `!signup` prefix alias, like DFC, optional).
- Capture **Discord UUID** + **live Discord username** automatically.
- Let the player choose **Category**: HLD, LLD, or Both.
- Let the player add an **optional Notes** string.
- Write directly into the `Registration` (prod) / `Registration Test` (test) tab.
- Only allow signup during the **registration window** (chrono-gated, like DFC).
- Handle **duplicate signups** for the same week gracefully (upsert).

## User flow (proposed — button + modal)

```
/signup
  │
  ├─ [not @Dueler?]  → ephemeral "You need the @Dueler role to sign up." STOP.
  │
  ├─ [window closed?] → ephemeral "Registration Closed" embed w/ next open time. STOP.
  │
  ├─ [not on Roster?] → ephemeral "You're not on the TDL roster yet — get added
  │                      first." (resolve UUID → Roster; see Roster gate below). STOP.
  │
  ├─ Step 1: ephemeral embed "Pick your division"
  │     [ HLD ]  [ LLD ]  [ Both ]        (buttons)
  │
  ├─ Step 2: button click → show Modal
  │     • Notes (Paragraph, optional, maxLength ~300)
  │       Category is encoded in the modal customId (no session store needed).
  │
  └─ Step 3: modal submit → deferReply(ephemeral)
        • Build row: [ timestamp, discordUUID, discordUsername, notes, category ]
        • Upsert into sheet (see Duplicate handling below)
        • Roster: Data Name already resolved at the gate; if the stored username is
          stale, fire-and-forget refresh of Roster col B (see Roster gate below)
        • Refresh signups cache (fire-and-forget)
        • Reply: green confirmation embed (Data Name, division, notes, week label)
```

### Why encode category in customId instead of Redis session

TDL's flow has only two data points (category + notes). We can carry `category`
in the modal's `customId` (e.g. `tdlsignup_modal_HLD`) and read `notes` from the
modal fields — so **no Redis session is required**. This is simpler and more robust
than DFC's `signupCache` (which it needs because it collects many classes + builds
across multiple modals). Redis stays optional, used only for the signups read-cache.

### Alternative (simpler, no buttons): slash options

```
/signup category:<HLD|LLD|Both> [notes:<text>]
```
- Pros: single interaction, no modal. Cons: no confirmation-before-submit step,
  notes limited to slash option length, less "wizard" feel.
- **Recommendation:** button + modal flow for parity with DFC UX, but this is a
  minor preference — confirm with David.

## Registration window (chrono gate)

Event is **Monday 6:00 PM ET**. Mirrors DFC's `isRegistrationOpen()` day/hour gate.

**DECIDED window** — closes **one day before the event** so Toeshank can build the
matchups from the signup list before Monday night:
- **Opens:** Tuesday 12:00 AM ET
- **Closes:** Sunday 11:59 PM ET (end of the day before the event)
- **Closed:** all day Monday (Toeshank organizes matchups + the event runs).

```js
// tdlWeekUtils.isRegistrationOpen() — pseudocode
// ET now → day (0=Sun..6=Sat)
// Monday = 1.
// Closed if: day === 1        (all of Monday — organize + event day)
// Open otherwise (Tue 00:00 → Sun 23:59)
```

> Non-blocking nuance: "one day before" is implemented as end-of-Sunday. If a fuller
> lead time is wanted, tighten the close to **Sun 6:00 PM ET** (exactly 24h pre-event)
> — a one-constant change.

Also adapt DFC's week-boundary helpers so "current week's signups" can be computed:
- `getCurrentEventDate()` → upcoming Monday 6pm ET
- `getWeekStartDate()` → the Tuesday 12am ET that opened the current window
- `filterCurrentWeekSignups(rows)` → rows with Timestamp >= week start

> These week helpers matter for **duplicate detection** and future `/recentsignups`.

## Sheet write

Direct append/update via Sheets API (pattern from DFC `register.js`, not a Form POST).

**Row shape (DECIDED):** `[ Timestamp, Discord UUID, Discord Username, Notes, Category ]`

- **Timestamp:** Sheets-native `M/D/YYYY H:mm:ss` (match the existing Form format so
  the Looker Studio report parses it).
- **Category value:** only ever `HLD` or `LLD`. A **"Both"** selection writes **two
  rows** — one `HLD` and one `LLD` (see below).

Write mechanics:
- Read the target tab range (e.g. `Registration Test!A:E`) to find `nextRow`.
- `values.update` at `A{nextRow}:E{nextRow}` (deterministic), OR `values.append`
  with `insertDataOption: 'INSERT_ROWS'`. Prefer `update` at computed row for upsert
  control; `append` is fine for pure inserts.

## Duplicate handling (upsert) — DECIDED

Dedupe key = **(Discord UUID + Category)**. One signup per player **per division**
per week.

- On submit, for each division being registered, scan current-week rows for a row
  matching **(this UUID + this Category)**.
  - **None found:** append a new row for that division.
  - **Found:** overwrite that row (refresh notes + timestamp).
- Confirmation states whether each division was **created** or **updated**.

## "Both" category storage — DECIDED (two rows)

A **"Both"** selection expands into **two independent rows**: one `HLD` and one
`LLD`. Consequences:

- Each division is upserted independently against (UUID + Category).
- A player who first signs up `HLD`, then later picks `Both`, ends up with their
  existing `HLD` row updated **plus** a new `LLD` row added.
- A player who picks `Both`, then re-runs as `HLD` only, keeps their `HLD` row
  updated; their `LLD` row is left as-is (we do **not** auto-remove divisions — a
  future `/cancelsignup` handles removal).

## Roster gate + enrichment (Discord ↔ Data Name) — DECIDED

Roster membership is a **hard guard**, checked **up front** (before the division
prompt) against the `Roster` tab (`Data Name | Discord Name | Discord UUID`) keyed on
the user's **UUID**:

- **Not matched → STOP.** Reply ephemerally that they're not on the TDL roster yet
  and must register first (via `/register`, or an admin adds them). No division
  prompt, no sheet write.
- **Matched → proceed**, carrying the resolved **Data Name** through to the public
  confirmation (which leads with it). If their stored `Discord Name` (Roster col B)
  no longer matches their live username, **fire-and-forget** overwrite col B with the
  current name after the Registration write — keeping the volatile usernames fresh.

The bot never **invents** a Data Name and never inserts roster rows here — creation is
`/register`'s job. The gate read failing (Sheets 4xx/5xx) should fail
**closed** with a "try again later" message; the post-write col-B refresh failing must
**never** fail the signup (row already written) — swallow and log. Mechanics live in
`02-sheets-integration.md`; decisions in `03-decisions.md` (rows 11–14).

## Permissions / roles — DECIDED

- `/signup` requires the **@Dueler** role.
- Store the role by **name or ID** in config; resolve per environment (test vs prod
  servers will have different role IDs — mirror DFC's emoji/env split).
- No role → ephemeral "You need the @Dueler role to sign up." and STOP.

## Error / edge cases

- **Window closed** → informative ephemeral embed with next open time.
- **Not on Roster** → ephemeral "you're not on the TDL roster yet — get added first"
  and STOP (no division prompt, no write).
- **Roster read fails (Google 4xx/5xx)** → fail **closed** ("try again later") — do
  not let a lookup error silently bypass the gate.
- **Sheet write fails (Google 4xx/5xx)** → ephemeral "try again later", log full error.
- **Interaction timeout** → `deferReply({ ephemeral: true })` before the sheet call.
- **Duplicate within window** → upsert + "updated your signup" message.
- **Missing username edge** → fall back to `user.tag` / `user.globalName`.
- **DM usage** → **guild-only.** Public confirmation and the @Dueler role check both
  require guild context, so `/signup` is disabled in DMs.

## Button routing (index.js)

Add prefixes to the routing map, all → `signup` command:
- `tdlsignup` (category buttons: `tdlsignup_HLD` / `_LLD` / `_Both`)
- `tdlsignupmodal` (modal submit: `tdlsignupmodal_HLD` etc.)

Handler must `startsWith('tdlsignup')` guard (per DFC button-routing convention).

## Confirmation — DECIDED: public

Post a **public** confirmation message (not ephemeral) so signups are visible for
hype/roster awareness. Keep it lightweight — no UUID in the public message.

```
✅ ToeshankFan signed up for TDL — Monday <date> 6PM ET
Division: Both (HLD + LLD)
Notes: "prefer bo5 for HLD"
```

Implementation notes:
- The wizard steps (division buttons + notes modal) stay **ephemeral**; only the
  final confirmation is public.
- Dedicated signups channel supported via optional `SIGNUP_CHANNEL_ID`; if unset,
  confirmations post in the invoking channel (default). **Implemented.**
- On an **update** (re-signup), phrase it as "updated their TDL signup" to avoid
  spam confusion.
- Because roster membership is required, the **Data Name always resolves** — the
  confirmation leads with it (e.g. "✅ **<DataName>** signed up …") for roster/ranking
  recognition. Still no UUID in the public message.
