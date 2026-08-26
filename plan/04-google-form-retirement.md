# Google Form — Retired (Decision Record)

> **DECIDED:** The Google Form signup path is **retired**. The bot is the **sole**
> signup entry point, writing rows directly to the `Registration` tab via the Sheets
> API. This doc records *why*, so the decision isn't re-litigated later.

## Why not keep/rebuild the Form

The reshaped tab requires a trustworthy **Discord UUID** per signup. A Google Form
cannot provide one:

- **No Discord identity.** Forms have no concept of Discord auth. A user filling out
  a form on their own exposes nothing about their Discord account.
- **Pre-filled links are the only injection path, and they're unusable here.** The
  bot could generate a per-user URL (`?entry.<id>=<uuid>`), but:
  - the field is **visible and user-editable** before submit → UUID is untrustworthy;
  - it **still requires the bot in the loop** to generate the link — at which point
    the bot may as well write the row directly and skip the form.
- **No hidden/server-side fields.** Forms offer no mechanism to attach data the
  respondent can't see or change.

Net: every path that lands a reliable UUID in the sheet goes through the bot. A Form
adds a second, weaker surface with no upside.

## Consequences

- **One code path** for signups (the bot) → simpler dedupe, validation, and the
  "Both → two rows" expansion all live in one place.
- **UUID + live username always populated** on every row.
- **Retire, don't delete blindly:** before removing the old Form, confirm nothing
  external still depends on its `formResponse` endpoint. If Toeshank wants a
  break-glass manual entry method, he can type rows into the sheet directly.

## If a fallback is ever needed later

Not planned now, but if the bot is down and someone must be added:
- **Manual sheet entry** by Toeshank (leave UUID blank; reconcile later), or
- a `/signup`-on-behalf mod command that takes a target user (bot still supplies the
  UUID). Preferred over resurrecting a Form.

## Migration note

- Point users at the bot (`/signup`) in the server's pinned instructions.
- Decommission the old Form after the first successful bot-run week.
