# For My Sheesh 🎀🌸

A private Telegram bot + Mini App holding one anniversary gift: a pastel
sakura gift cover, a blue envelope with a red heart, and a 7-month letter that is
only released to Telegram users the owner has explicitly authorized.

Built as a **standalone Telegram Serverless (TGCloud 0.2.0) project**: plain ESM
modules, the platform's built-in SQLite database, and a dependency-free
HTML/CSS/JS Mini App.

| | |
|---|---|
| Owner (trusted server config) | `8716863150` |
| Bot | **not created yet** — needs @BotFather |
| TGCloud app id | **not created yet** |
| Mini App URL | **pending deploy** — `push` prints it |
| Runtime | TGCloud V8 isolate (JavaScript ESM) |
| Storage | TGCloud built-in SQLite (`npx tgcloud migrate`) |
| Frontend | `web/` — no build step, no CDN assets |
| Tests | 85 passing locally |

> **Privacy:** the letter lives in server source (`tgcloud/lib/content.js`) and
> in the authenticated `getGift` endpoint only. Keep this project in a **private**
> repository. The enclosing `miss-frozen` repository is currently public, so do
> not commit this folder there without making it private first.

## What works

- Strict allowlist: owner only at start; unknown users are denied on every
  command, callback and endpoint.
- Exact unauthorized rejection, exact girlfriend welcome, exactly one
  `mini 🎁 surprises` button.
- Menu flow: `mini 🎁 surprises` → `choose` + `8 oct 2026` → anniversary intro +
  `hehe 🤌` → Mini App at `/gift`.
- Owner commands: `/grant`, `/revoke`, `/access`, `/help`, plus `/setapp` to set
  the deployed Mini App URL without a redeploy. The owner cannot be revoked.
- Mini App: pastel cover, inline SVG envelope/heart with a gentle float, coral
  open button, full scrollable letter, back-to-cover, loading/error states,
  reduced-motion support, sakura petals.
- Server-side guards: platform-verified `initData`, freshness check, durable
  allowlist check per request, generic error responses, no private content in
  static assets.
- Tests: authorization, persistence, concurrency/idempotency, fail-closed
  storage, bot copy/flow, callbacks, forged/replayed taps, initData validation,
  endpoint payloads, DOM rendering, routing, reduced motion, API bridge.

## Quick start

```bash
cd for-my-sheesh
npm ci
npm run validate        # validation + 85 tests
npx tgcloud login       # paste app<id>:<secret> from BotFather -> Serverless
npx tgcloud status
npx tgcloud push        # code + web/ ; prints https://app<id>.tgcloud.ai/
npx tgcloud migrate     # create the 5 tables (separate step; review it)
npx tgcloud webhook     # confirm the managed webhook
```

Then, from the owner's chat:

```
/setapp https://app<id>.tgcloud.ai/
/grant <her_numeric_telegram_user_id>
```

Full runbook: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Security model in one screen

- Owner identity is **trusted server code**, never a DB role, username, query
  string or browser value.
- Every private action re-checks the durable `access_list` on the server.
- A DB failure is a denial, not an allow.
- Grants are atomic `INSERT … ON CONFLICT DO NOTHING`; revokes are immediately
  effective for the next command/callback/endpoint.
- Mini App endpoints receive `ctx.initData` **already signature-verified by
  TGCloud**; this code additionally checks shape/freshness and the allowlist.
  `Telegram.WebApp.initDataUnsafe` is never trusted.
- The letter is absent from `web/`; the static site is public, the API is not.

Details: [docs/SECURITY.md](docs/SECURITY.md).

## TGCloud reality check

TGCloud 0.2.0 has **no documented runtime environment variables or secrets
store**. The bot token is not needed at runtime (the `api` proxy is authenticated
by the platform) and the webhook is platform-managed. The owner ID is a constant
in `tgcloud/lib/config.js`; the Mini App URL is durable data set by `/setapp`.
`.env`/`.env.example` are for CLI/CI only and are not read by deployed code.

Read [docs/TGCLOUD.md](docs/TGCLOUD.md) for the exact verified capabilities and
the limitations this implementation works within.

## Commands

| Command | Purpose |
|---|---|
| `/start` | owner control room or the girlfriend's exact welcome |
| `/help` | commands available to the caller |
| `/grant <id>` | owner-only; authorize a member |
| `/revoke <id>` | owner-only; remove a member (owner protected) |
| `/access` | owner-only allowlist |
| `/setapp <url>` | owner-only; set the TGCloud Mini App base URL |

Everything else is ignored or answered generically; unknown users get the exact
rejection copy and no buttons.

## Layout

```
for-my-sheesh/
├─ tgcloud.jsonc              # static: web/, spa: true for /gift
├─ tgcloud/
│  ├─ schema.js               # access_list, owner_audit, bot_settings, …
│  ├─ handlers/               # message.js, callback_query.js
│  ├─ endpoints/              # getAccessStatus.js, getGift.js
│  └─ lib/                    # config, access, store/sql, initData, content,
│                             # keyboards, bot routers, Mini App URL
├─ web/                       # index.html, CSS, ES modules, inline SVG
├─ test/                      # node:test + jsdom + node:sqlite
├─ scripts/validate.js        # pre-deploy security/config/static checks
└─ docs/                      # TGCLOUD.md, SECURITY.md, DEPLOYMENT.md
```

## Testing

```bash
npm test          # 85 tests, node:test + jsdom
npm run validate  # syntax/imports/layout/schema/config/privacy/secrets + tests
```

Coverage includes: owner bootstrap, unknown denial, grant/revoke by owner,
non-owner rejection, self-revoke protection, invalid IDs, idempotency, poisoned
rows, storage failure, persistence across a DB reopen, concurrent grants,
`/access` privacy, exact bot copy, the full menu sequence, forged/replayed
callbacks, duplicate updates, cooldown, initData freshness/tampering, endpoint
payload privacy, gift cover markup, envelope animation CSS, reduced motion,
deep-link routing, loading/error states, and the `Serverless.call` bridge.

## Status and what remains manual

Implemented and locally verified: code, schema, frontend, tests, validation.
**Not deployed.** Creating the bot in BotFather, enabling Serverless, obtaining
the CLI token, `push`/`migrate`, the real Mini App URL, real Telegram end-to-end
testing and a private GitHub repository all require the owner's accounts and are
documented step by step. No deployment URL or live test result is claimed here.

## Repository placement

This is a self-contained project inside the existing `miss-frozen` checkout at
`for-my-sheesh/`; the unrelated gaming bot at the repository root is untouched.
It can be moved to its own repository by copying this folder (its
`package.json`, `tgcloud.jsonc`, `tgcloud/`, `web/`, tests and docs are
self-sufficient). A dedicated private repository still needs to be created —
keep the letter out of public source history.
