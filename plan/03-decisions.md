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
| 6 | Timestamp format | **Match the retired Form's** Sheets-native format (`M/D/YYYY H:mm:ss`) so the Looker report keeps parsing. Bot writes this via `formatSheetTimestamp`. |
| 7 | Service account | **Reuse DFC's** existing Google service account (must be granted Editor on the TDL sheet). |
| 8 | Confirmation visibility | **Public for now** — post a visible "X signed up for Monday TDL" message (division shown). |
| 9 | Google Form | **Retired.** Bot is the sole signup path. Forms can't reliably capture a Discord UUID; every path that gets a trustworthy UUID into the sheet runs through the bot anyway. |
| 10 | Roster tab role | **Identity map, read on signup.** `Roster` = `Data Name \| Discord Name \| Discord UUID`. Join on **UUID** (col C) — the stable key; `Discord Name` drifts. This is the Discord ↔ in-game-name mapping (was deferred). See `02-sheets-integration.md`. |
| 11 | Roster as a gate? | **Yes — required.** `/signup` checks the invoking user's UUID against `Roster` (col C). **Not on the roster → blocked** with a "get added first" message; this is a hard guard alongside the `@Dueler` role. The bot never invents a Data Name — membership is created out-of-band (see row 14). |
| 12 | Roster username refresh | **Yes.** On a UUID match with a stale `Discord Name`, fire-and-forget overwrite of `Roster!B` with the live username. The bot therefore has **write** access to `Roster`. |
| 13 | Data Name in public confirmation | **Yes.** Since roster membership is now required, the Data Name always resolves — lead the confirmation with it (no UUID). |
| 14 | `/register` command | **Built.** Appends/updates a player in `Roster` (`Data Name \| Discord Name \| Discord UUID`) — the write path that populates the gate above. Model below (rows 15–18). |
| 15 | `/register` who | **Hybrid.** Anyone self-registers (`/register data_name:<name>`); admins may also register/fix others via an optional `user:` target. "Admin" = holds `TDL_ADMIN_ROLE_NAME` (optional) **or** has the Manage Server permission. |
| 16 | `/register` gate | **Open to any guild member** (no `@Dueler` needed) — `/register` is the onboarding entry point: register → get `@Dueler` → `/signup`. |
| 17 | Re-register (same UUID) | **Update in place** — overwrite the caller's Data Name + refresh the stored username. Lets players fix their own typos. |
| 18 | Data Name clash | **Blocked** — a name already held by a *different* UUID (case-insensitive) is refused (`NAME_TAKEN`). Prevents claiming another player's ranking identity. Only protects names already present in `Roster`. |

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
- `/signup` requires roster membership (UUID in `Roster` col C) **and** the `@Dueler`
  role; the roster supplies the **Data Name** join for rankings/reports.
- The bot has **read + write** access to `Roster` (write is used by the col-B username
  refresh and by the `/register` command).
- One shared `Roster` tab (not `TEST_MODE`-split); only the Registration write target
  flips between test/prod.
- Low concurrency → simple read-then-write upsert is fine.
