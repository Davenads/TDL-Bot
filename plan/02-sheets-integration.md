# Google Sheets Integration — Design (Planning)

## Auth

Reuse DFC's service-account JWT approach verbatim (`utils/googleAuth.js`):

- Env vars: `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`.
- Private key: `\\n` escapes locally, real newlines on Heroku.
- Scope: `https://www.googleapis.com/auth/spreadsheets`.

### ACTION REQUIRED (out-of-band)

**DECIDED: reuse DFC's existing Google service account.** Its email must be granted
**Editor** access to the TDL spreadsheet
`1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww`.
- Copy `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY` from DFC's env into TDL's env.

## Environment variables (`.env`)

```env
# Discord
BOT_TOKEN=
CLIENT_ID=
GUILD_ID=            # test server
PROD_GUILD_ID=       # Toeshank's server

# Google
TDL_SPREADSHEET_ID=1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww
GOOGLE_CLIENT_EMAIL=
GOOGLE_PRIVATE_KEY=

# Mode
TEST_MODE=true       # true → Registration Test tab, false → Registration tab

# Redis (optional)
REDISCLOUD_URL=
```

Tab name resolves from `TEST_MODE`:

```js
const REG_TAB = process.env.TEST_MODE === 'true' ? 'Registration Test' : 'Registration';
```

## Read (for dedupe + future /recentsignups)

```js
sheets.spreadsheets.values.get({
  auth,
  spreadsheetId: process.env.TDL_SPREADSHEET_ID,
  range: `${REG_TAB}!A:E`,
});
```

- Parse rows, skip header.
- Filter to current registration week via `tdlWeekUtils.filterCurrentWeekSignups`.
- For dedupe, match on Discord UUID column.

## Write (upsert) — DECIDED schema

Reshaped tab columns: `Timestamp | Discord UUID | Discord Username | Notes | Category`
(range `A:E`). Following DFC `register.js` pattern:

- Compute `nextRow = rows.length + 1` for inserts.
- **Insert:** `values.update` at `${REG_TAB}!A${nextRow}:E${nextRow}` (RAW).
- **Update existing:** `values.update` at the matched row's `A{n}:E{n}`.

Row values: `[ timestamp, uuid, username, notes, category ]` where `category` is
`HLD` or `LLD` only.

### "Both" = two writes

A "Both" signup performs the upsert **twice** — once for `HLD`, once for `LLD` —
each keyed on **(UUID + Category)** within the current week. Sequence them (read →
resolve both rows → write) so the second write sees the row the first may have added.
At this volume, two sequential `values.update` calls are fine.

## Caching (optional, phase 2)

Port DFC's `signupsCache.js` for read-heavy commands later (`/recentsignups`).
- Redis key e.g. `tdl-data:recent-signups`, TTL ~3h.
- Cron refreshes around the event (e.g. Monday afternoon + post-event).
- Graceful fallback to live Sheets read if Redis is down (same as DFC).

The `/signup` write path does **not** require Redis — only a fire-and-forget cache
refresh after a successful write.

## Timestamp format

DFC writes ISO strings for its own tabs. The **Registration** tab was historically
fed by a Google Form (now **retired** — the bot is the sole writer), which wrote
Sheets-native datetimes like `M/D/YYYY H:mm:ss`. The Looker Studio report parses
that format.

**DECIDED:** the bot writes timestamps in the **same Sheets-native format the old
Form used** (`M/D/YYYY H:mm:ss`) so downstream parsing (report, standings, ELO date
logic) stays intact. Implemented in `tdlWeekUtils.formatSheetTimestamp`. Verify
against a few existing `Registration` rows if the report ever mis-parses.

## Risks

- **Concurrent writes:** two players submitting at once could compute the same
  `nextRow`. Low volume (a niche weekly event) makes this unlikely, but `values.append`
  with `INSERT_ROWS` avoids the race for pure inserts. Upserts still read-then-write;
  acceptable at this scale. Note and revisit if volume grows.
- **Schema drift:** reshaping the Registration tab is safe on the Form side — the
  Google Form is **retired**, so there is no `formResponse` binding left to break
  (see `04-google-form-retirement.md`). The only downstream binding to preserve is
  the **Looker Studio report**; keep the reshaped columns and the Sheets-native
  timestamp format (above) so it keeps parsing.
