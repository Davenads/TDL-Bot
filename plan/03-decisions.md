# Decisions — RESOLVED

All blocking questions from the initial planning pass have been answered. This is
the source of truth; `01` and `02` reflect these.

| # | Question | Decision |
|---|---|---|
| 1 | Registration tab schema | **Reshape** to `Timestamp \| Discord UUID \| Discord Username \| Notes \| Category`. **Bot-only** — the Google Form is **retired** (a Form can't reliably capture a Discord UUID). See row 9. |
| 2 | "Both" storage | **Two rows** — one `HLD`, one `LLD`. Stored `Category` is only ever `HLD` or `LLD`. |
| 3 | Registration window | **Closes one day before the event** so Toeshank can build matchups. Event = Mon 6PM ET → registration **closes end of Sunday (Sun 11:59 PM ET)**; **opens Tue 12:00 AM ET**. Monday is closed (organize + event day). |
| 4 | Role gating | Require the **@Dueler** role to use `/signup`. |
| 5 | Duplicate policy | **Yes, upsert.** One signup per player per division per week. Re-running replaces that player's existing row for that division. Dedupe key = (Discord UUID + Category). |
| 6 | Timestamp format | **Match the existing Form's** Sheets-native format (`M/D/YYYY H:mm:ss`) so the Looker report parses it. |
| 7 | Service account | **Reuse DFC's** existing Google service account (must be granted Editor on the TDL sheet). |
| 8 | Confirmation visibility | **Public for now** — post a visible "X signed up for Monday TDL" message (division shown). |
| 9 | Google Form | **Retired.** Bot is the sole signup path. Forms can't reliably capture a Discord UUID; every path that gets a trustworthy UUID into the sheet runs through the bot anyway. |

## Still-open / minor (non-blocking, safe defaults chosen)

- **Command surface:** button + modal wizard (DFC-style). Can revisit vs. plain
  slash options.
- **`!signup` prefix alias:** include for parity (cheap). Confirm if unwanted.
- **DM usage:** allow, since we only need the user object. Confirm if it should be
  guild-only.
- **Exact close time nuance:** "one day before" implemented as end-of-Sunday
  (Sun 23:59 ET). If Toeshank wants a fuller lead time, tighten to Sun 6:00 PM ET
  (a clean 24h before event). Easy to change in one constant.

## Assumptions still in force

- Event: **Monday 6:00 PM ET**, ~4 hours.
- Bot writes to `Registration Test` in `TEST_MODE`, `Registration` in prod.
- Direct Sheets write (not a Form POST) to capture Discord UUID.
- No in-game-name mapping needed for signup (Discord UUID + username suffice).
- Low concurrency → simple read-then-write upsert is fine.
