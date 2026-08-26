# 05 — Google Cloud Setup

How to provision the Google credentials the bot needs to read/write the TDL
spreadsheet via the Sheets API. Two paths are documented:

- **Path A — Reuse DFC's service account** (DECIDED, primary — see decision #7).
- **Path B — Create a new service account from scratch** (fallback / reference).

Either way the end state is the same three things in `.env`:

| Variable | Source |
|---|---|
| `GOOGLE_CLIENT_EMAIL` | The service account's email (`...@<project>.iam.gserviceaccount.com`) |
| `GOOGLE_PRIVATE_KEY` | The `private_key` field from the account's JSON key |
| `TDL_SPREADSHEET_ID` | Already known: `1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww` |

---

## Concepts (why a service account?)

- The bot runs headless (Heroku dyno) with no human to click an OAuth consent
  screen. A **service account** is a non-human Google identity that authenticates
  with a private key (JWT) — no interactive login.
- The service account has its own email address. To let it touch the TDL sheet,
  you **share the spreadsheet with that email as Editor**, exactly like sharing
  with a person.
- The bot signs a JWT with the private key, scoped to
  `https://www.googleapis.com/auth/spreadsheets`, and exchanges it for an access
  token (handled in `utils/googleAuth.js`).

---

## Path A — Reuse DFC's service account (primary)

DFC-Data already has a working service account with the Sheets API enabled. TDL
reuses it; there is no new Google Cloud project or key to create.

1. **Find DFC's service account email.**
   - In DFC-Data's `.env`, copy `GOOGLE_CLIENT_EMAIL`
     (`...@<project>.iam.gserviceaccount.com`).
   - Or read it from the JSON key: the `client_email` field.

2. **Share the TDL spreadsheet with that email.**
   - Open the sheet:
     `https://docs.google.com/spreadsheets/d/1gz1sIYGUf-vxMCmsl7b7icFfI9HlAYSbs1rOFRCz1Ww`
   - Click **Share**, paste the service account email, set role to **Editor**,
     uncheck "Notify people," and **Send/Share**.
   - Toeshank (the sheet owner) must do this, or grant you edit-share rights.

3. **Copy the two credential values into TDL's `.env`.**
   - `GOOGLE_CLIENT_EMAIL` — same value as DFC.
   - `GOOGLE_PRIVATE_KEY` — same value as DFC (see "Private key formatting" below).

4. **Sheets API is already enabled** on DFC's project, so nothing to enable.

5. **Done.** Skip to "Verify access."

> Note: reusing the account means TDL and DFC share the same Google Cloud
> quota/rate limits. Sheets API default quota (per-minute read/write per project)
> is generous for these low-volume bots, so this is fine. If usage ever grows,
> switch TDL to its own account via Path B.

---

## Path B — New service account from scratch (fallback)

Use this only if you want TDL isolated from DFC (separate quota, separate key
rotation, separate blast radius).

### B1. Create or pick a Google Cloud project

1. Go to <https://console.cloud.google.com/>.
2. Top bar → project dropdown → **New Project**.
3. Name it e.g. `tdl-bot`, create, then select it as the active project.

### B2. Enable the Google Sheets API

1. **APIs & Services → Library**.
2. Search **Google Sheets API** → open it → **Enable**.
   (No need to enable the Drive API for value read/write by spreadsheet ID.)

### B3. Create the service account

1. **APIs & Services → Credentials → Create Credentials → Service account**.
2. Name e.g. `tdl-bot-sheets`; Google generates the email
   `tdl-bot-sheets@<project>.iam.gserviceaccount.com`.
3. Skip the optional project-role and user-access steps (not needed — access is
   granted per-spreadsheet by sharing, not via IAM roles). **Done**.

### B4. Generate a JSON key

1. Open the new service account → **Keys** tab → **Add key → Create new key**.
2. Choose **JSON** → **Create**. A `*.json` file downloads. **This is the only
   copy** — Google does not store it. Keep it secret; never commit it.
3. The JSON contains `client_email` and `private_key` — these become
   `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY`.

### B5. Share the spreadsheet

Same as Path A step 2: share the sheet with the new `client_email` as **Editor**.

---

## Private key formatting (both paths)

The `private_key` in the JSON looks like:

```
-----BEGIN PRIVATE KEY-----\nMIIEv...\n...\n-----END PRIVATE KEY-----\n
```

`utils/googleAuth.js` calls `.replace(/\\n/g, '\n')`, so it accepts the escaped
form. Two environments, two formats:

- **Local `.env`:** keep the literal `\n` escape sequences, wrapped in double
  quotes on a single line:
  ```
  GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----\n"
  ```
- **Heroku config var:** paste the key with **real newlines** (multi-line value).
  Heroku preserves them; the `.replace` is then a no-op and the key still parses.

> `googleAuth.js` also sets `--openssl-legacy-provider` handling so the PKCS#8
> key parses under Node 20's OpenSSL 3. No action needed — just be aware.

---

## Verify access

After `.env` is filled and the sheet is shared:

1. `npm install`
2. Quick sanity check (reads the header row of the Registration Test tab):
   ```
   node -e "require('dotenv').config();const{google}=require('googleapis');const{createGoogleAuth}=require('./utils/googleAuth');(async()=>{const auth=createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets']);const sheets=google.sheets('v4');const r=await sheets.spreadsheets.values.get({auth,spreadsheetId:process.env.TDL_SPREADSHEET_ID,range:'Registration Test!A1:E1'});console.log(r.data.values);})().catch(e=>console.error('FAIL:',e.message));"
   ```
   - Prints the header array → auth + sharing are correct.
   - `FAIL: The caller does not have permission` → the sheet is not shared with
     the service account email (redo the Share step).
   - `FAIL: Unable to parse range` → tab name typo (check `Registration Test`).
   - `error:1E08010C:DECODER routines::unsupported` → private-key formatting
     (check the `\n` escaping / quoting).

---

## Security notes

- **Never commit** the JSON key or `.env`. `.gitignore` already excludes `.env`
  and `config/credentials.json`.
- Treat `GOOGLE_PRIVATE_KEY` like a password. If it leaks, delete that key in the
  Cloud Console (Service account → Keys) and generate a new one — the email stays
  the same, only re-fill `GOOGLE_PRIVATE_KEY`.
- Editor (not Owner) is the least privilege that still allows row writes.
