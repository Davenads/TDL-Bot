# 05 — Heroku Hosting

How TDL-Bot is deployed and run on Heroku. Mirrors the DFC-Data model so both
bots operate the same way.

## Deployment model: GitHub auto-deploy

Deployment is driven by **GitHub**, not the Heroku CLI.

1. Push to `main` on GitHub (`git push origin main`).
2. The Heroku app is connected to the repo with **Automatic deploys** enabled.
3. Heroku builds and releases the new version automatically.

**Never run `git push heroku main` or `heroku git:remote`.** The Heroku git
remote is intentionally not used; GitHub is the single source of deploys. Manual
CLI pushes create drift between what's on GitHub and what's running.

## Dyno & process type

- `Procfile`: `web: npm start` (which runs `node index.js`).
- Uses a **web** dyno because `index.js` binds an HTTP server when `PORT` is set
  (see below). A web dyno is required for Heroku to consider the app "up"; a
  worker dyno would be killed for not binding the port.
- Free of any inbound traffic needs — the HTTP server exists only to satisfy
  Heroku's port-binding requirement and acts as a health check.

> Note: DFC-Data uses a `worker` dyno. TDL-Bot deliberately uses `web` + a
> minimal HTTP listener so a single Eco/Basic web dyno keeps the gateway
> connection alive. Keep exactly one dyno running to avoid duplicate bots
> double-posting signups.

## Port binding (already implemented)

`index.js` starts an HTTP server only in production / when `PORT` is present:

```js
if (process.env.PORT || process.env.NODE_ENV === 'production') {
    const PORT = process.env.PORT || 3000;
    http.createServer((req, res) => {
        res.statusCode = 200;
        res.end('TDL bot is running!\n');
    }).listen(PORT);
}
```

Heroku injects `PORT`; the bot binds it and responds 200 to any request. Locally
`PORT` is unset, so no server starts.

## Config vars (Heroku Settings → Config Vars)

Set every key from `.env.example` as a Heroku config var. Do **not** commit
`.env`; it stays gitignored and Heroku holds the real values.

| Config var | Notes |
|---|---|
| `BOT_TOKEN` | Discord bot token |
| `CLIENT_ID` | Discord application (client) ID |
| `GUILD_ID` | Test guild ID |
| `PROD_GUILD_ID` | Production (Toeshank's) guild ID |
| `TDL_SPREADSHEET_ID` | TDL Google Sheet ID |
| `GOOGLE_CLIENT_EMAIL` | Service-account email |
| `GOOGLE_PRIVATE_KEY` | **Paste real newlines**, not `\n`-escaped (see caveat) |
| `TEST_MODE` | `true` -> Registration Test tab; `false` -> Registration tab |
| `DUELER_ROLE_NAME` | Defaults to `Dueler` if unset |
| `SIGNUP_CHANNEL_ID` | Optional public-confirmation channel |
| `REDISCLOUD_URL` | Optional; set automatically if the Redis Cloud add-on is provisioned |
| `NODE_ENV` | Set to `production` (also forces the HTTP server on) |

### GOOGLE_PRIVATE_KEY caveat

`utils/googleAuth.js` normalizes with `privateKey.replace(/\\n/g, '\n')`, so both
forms technically work, but the convention is:

- **Local `.env`:** single line with literal `\n` escapes.
- **Heroku config var:** paste the actual multi-line PEM (real newlines). In the
  dashboard field, paste it exactly as it appears in the JSON key, including the
  `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines.

If auth fails on Heroku with a 400/parse error, the private key formatting is the
first thing to check.

## Redis (optional, phase 2)

- Provision the **Redis Cloud** add-on to get `REDISCLOUD_URL` set automatically.
- The bot runs fine without it — `redisClient.connect()` failures are caught in
  `ready` and logged; commands fall back to live Sheets reads.
- Not required for `/signup` (write path). Only relevant once read/caching
  commands are added.

## First-time setup checklist

1. Create the Heroku app.
2. Settings → **Deploy** → connect to the `Davenads/TDL-Bot` GitHub repo.
3. Enable **Automatic deploys** from `main`.
4. Settings → **Config Vars** → add every key from the table above.
5. (Optional) Add the Redis Cloud add-on.
6. Ensure exactly **one** web dyno is scaled on (`heroku ps:scale web=1` or via
   the Resources tab). Never scale above 1 — duplicate bots double-post.
7. Register slash commands once (locally or via a one-off dyno):
   `node deploy-commands.js`.
8. Trigger a deploy (push to `main` or "Deploy Branch" once) and watch the logs.

## Operations

- **Logs:** `heroku logs --tail -a <app>` (or the dashboard). The bot logs
  command loads, signup blocks/writes, button/modal routing, and Redis status.
- **Restart:** `heroku restart -a <app>` (rarely needed).
- **Rollback:** Heroku **Activity** tab → "Roll back" to a previous release if a
  deploy breaks the bot.
- **Scaling rule:** keep `web=1`. More than one dyno = duplicate Discord clients
  = duplicate signup rows and confirmations.

## Guardrails

- Deploy only via GitHub `main`. No `git push heroku main`.
- `TEST_MODE` on the production app must be `false` so writes hit the
  `Registration` tab, not `Registration Test`.
- Rotate `BOT_TOKEN` and the Google key via config vars only; never commit them.
