# Security model — For My Sheesh

**Default deny. Verify on every request. Fail closed.** The only people who can
read the letter are the configured owner (`8716863150`) and members the owner
explicitly grants.

## Trust boundaries

| Input | Trusted? | Used for |
|---|---|---|
| `message.from.id` / `callback_query.from.id` | Yes — Telegram-verified update | Authorization |
| `ctx.initData` on an endpoint | Yes — signature verified by TGCloud before invocation | Authorization |
| `Telegram.WebApp.initDataUnsafe` | **Never** | Nothing |
| Message text, callback data, `input`, query string, route | No | UI routing only, never identity |
| DB `access_list.role` | Partially | Can grant `member`; can never make a non-owner `owner` |
| `OWNER_TELEGRAM_ID` in `tgcloud/lib/config.js` | Yes — trusted server code | Sole source of owner identity |

## Owner identity

`tgcloud/lib/config.js` contains the sole owner ID as a numeric constant. It is
deployed only as server code, never sent to the Mini App and never in `web/`.
A database row whose `role` is `owner` for another ID is treated as poisoned and
denied. The owner row is bootstrapped idempotently with
`INSERT … ON CONFLICT DO NOTHING`.

Why not an environment variable? TGCloud 0.2.0 documents **no runtime environment
variables or secrets store** (see `docs/TGCLOUD.md`). Trusted server code is the
safest supported location. Why not a DB-only setting? A writable data row must
never be the thing that establishes ownership, so the constant is authoritative
and the DB merely mirrors it.

## Authorization flows

### Bot

1. Ignore everything that is not a private chat (`chat.type !== 'private'`), and
   ignore bots.
2. Read `message.from.id` (verified).
3. `access.authorize(id)`:
   - validate it is a positive numeric Telegram user ID;
   - bootstrap the owner row;
   - read `access_list` from the durable DB;
   - missing row → deny; `member` → allow; config owner → allow; anything else →
     deny; any storage error → throw, caller denies.
4. Only then route the command.
5. Every callback repeats steps 1–4 using `callback_query.from.id`; callback data
   is only a route hint.

### Mini App endpoint

1. TGCloud verifies the initData signature and rejects invalid data with `401`
   before the endpoint runs.
2. `validateInitData(ctx.initData)` re-checks: object shape, `auth_date` present,
   positive integer, not more than 60 s in the future, not older than
   `MAX_INIT_DATA_AGE_SECONDS` (12 h), a human `user`, and a valid numeric ID.
3. `access.authorize(user.id)` checks the durable allowlist **for this request**.
4. Only then does `getGift` return the letter. `getAccessStatus` returns no
   private content at all.
5. Any error is converted to `EndpointError` with a safe message; unexpected
   exceptions become a generic `500`.

There is no session object to become stale. Revocation changes the DB row, and
the next endpoint call is denied immediately. The frontend hiding the UI is never
a security control.

## Fail-closed matrix

| Condition | Result |
|---|---|
| DB unavailable / throws | Deny; safe "notebook unavailable" message |
| Table missing (migrate not run) | Deny |
| Unknown user | Deny with exact rejection copy |
| Revoked user | Deny on next command/callback/endpoint |
| Invalid / missing initData | Deny (platform 401 or our validation) |
| Expired `auth_date` | Deny |
| Tampered `user.id` in body | Irrelevant — body identity is never read |
| Poisoned `owner` row | Deny |
| Audit write failure | Access change stands (audit is not a permission boundary) |
| Dedupe/cooldown failure | Fails open for UX only; authorization already succeeded |

## `/grant` and `/revoke`

- Only `actor.id === OWNER_TELEGRAM_ID` passes. A member calling either command
  receives "Only the owner can do that."
- Target must be a positive integer, digits only; usernames, negative chat IDs,
  floats, `+`, leading zeros and extra arguments are rejected.
- `grant` uses an atomic `INSERT … ON CONFLICT(telegram_id) DO NOTHING`; repeated
  calls do not alter the original grant timestamp/actor.
- `revoke` refuses the configured owner in application code, and the normal SQL
  path also refuses to delete a row with `role = 'owner'`. A poisoned owner row
  for a **different** ID can be cleaned up only after the owner check passes.
- Success is reported only after the write resolves. `/access` is owner-only and
  shows only ID, role, grant time and granting owner.

## Private content

- The letter lives in `tgcloud/lib/content.js` and is returned only by
  `getGift` after steps above.
- `web/` contains no letter, signature or owner ID; validation checks this.
- The static host is public, so no secret is placed there.
- The Mini App URL carries only `/gift`; no ID, token or content.
- The bot token is never used or stored. TGCloud manages the webhook.

## What this project does **not** claim

- **Live deployment was not performed here.** The repository had no TGCloud
  credentials, BotFather access or created app. See `docs/DEPLOYMENT.md`.
- **The current parent repository is public.** The personal letter is in source.
  Keep this project in a **private** repository before committing/pushing it.
- TGCloud's platform may log endpoint errors and handler output. Do not log
  private content; this project logs only error objects for operators.
- Telegram bots are not end-to-end encrypted. Anyone with BotFather access to the
  bot can manage it.

## Manual verification checklist

1. Unauthorized account: `/start`, `/help`, `/grant 1`, `/access` → exact
   rejection; no buttons; nothing in the Mini App.
2. Owner: `/access` shows only the owner; `/grant <her id>` → success.
3. Her account: `/start` → exact welcome, exactly one `mini 🎁 surprises` button.
4. `mini 🎁 surprises` → `choose` + `8 oct 2026`; tap → anniversary intro +
   `hehe 🤌`; tap → Mini App at `/gift`.
5. Open the gift → full letter, scrolls to the signature.
6. Owner `/revoke <her id>`; her next `/start` and next callback are denied; her
   next Mini App open shows `You are not allowed to open this app.`
7. Owner `/access` after a redeploy: the allowlist survives `push`.
8. Open `https://app<id>.tgcloud.ai/gift` in a normal browser → error, no letter.
9. Try a forged callback (`fms:m`) from an unauthorized account → no message.
