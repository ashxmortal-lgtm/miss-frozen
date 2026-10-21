# TGCloud / Telegram Serverless facts used by this project

Checked on **2026-10-21** against the official Telegram Serverless documentation
(https://core.telegram.org/bots/serverless), the bundled `@tgcloud/cli` **0.2.0**
(`README.md`, `CHANGELOG.md`, `schema/tgcloud.json`) and the scaffolded SDK
reference that ships with the CLI (`docs/tgcloud-sdk.md` in the parent project).

This file records what the platform actually supports — and what it does not —
so this project does not invent APIs.

## Runtime

| Topic | Documented reality | Consequence here |
|---|---|---|
| Language/runtime | JavaScript modules executed in a V8 isolate | Plain ESM, no TypeScript/build step |
| Module system | Import project files by relative path **with `.js`**; import the SDK by name (`sdk`, `sdk/db`) | Enforced by `scripts/validate.js` |
| Packages | No npm packages, no filesystem, no `node:` built-ins at runtime | Frontend and server have zero runtime dependencies |
| What is deployed | `tgcloud/schema.js`, `tgcloud/lib/**`, `tgcloud/handlers/*.js`, `tgcloud/endpoints/*.js`, plus the static folder named in `tgcloud.jsonc` | Only `tgcloud/` runs; `web/` is static |
| Handlers | One level under `tgcloud/handlers/`; module `export default (payload, ctx)` | `message.js`, `callback_query.js` |
| Endpoints | `tgcloud/endpoints/<name>.js` → `POST /api/<name>` on the Mini App host | `getAccessStatus`, `getGift` |

## Environment variables and secrets

**TGCloud 0.2.0 does not document runtime environment variables or a secrets
store.** The project config schema (`node_modules/@tgcloud/cli/schema/tgcloud.json`)
has only `$schema` and `static`; the SDK reference exposes only `db`, `api`,
`fetch`, `InputFile`, `BotApiError`, `EndpointError` and `console`. The only
environment variable in the CLI is `TGCLOUD_TOKEN`, used to authenticate the CLI
in CI.

Consequences, implemented honestly:

- **No `BOT_TOKEN` is needed.** `api.sendMessage(...)` is proxied by the platform,
  already authenticated as this bot. Putting a token in the repo would be a leak,
  and there is no supported place to store one at runtime.
- **No webhook secret is configurable by the project.** TGCloud derives the
  webhook from deployed `handlers/*` and refreshes it on `push`; `npx tgcloud
  webhook` shows/repairs drift. Webhook security is platform-managed.
- **The owner ID is trusted server code**, not an environment variable. See
  `tgcloud/lib/config.js`.
- **The Mini App URL is durable data**, set after deploy with the owner command
  `/setapp https://app<app_id>.tgcloud.ai/`. This avoids a redeploy.
- `.env` / `.env.example` exist only for local/CI tooling. The deployed code does
  not read them.

## Database / storage

- Every bot gets its own persistent **SQLite-backed** database.
- Tables are declared in `tgcloud/schema.js`; `npx tgcloud push` uploads the
  schema but **never changes the database**. `npx tgcloud migrate` applies the
  change.
- All DB calls are async. Raw SQL is available through `db.run/get/all`; named
  parameters use `:name`. A plain write returns `{ rowsAffected, ... }`.
- **No foreign keys** are supported (the DSL throws if declared). Integrity is
  enforced in application code.
- Migrations are separate from deploys, so the documented order is
  `push` → `migrate`.

The allowlist therefore lives in the bot's own database, not in memory or a
local file. The exact SQL used by production is in `tgcloud/lib/sql.js` and is
executed by tests against a real SQLite file with `node:sqlite`.

## Mini App hosting

- `tgcloud.jsonc` → `"static": { "source": "web" }` uploads `web/` as the Mini
  App. There is no separate static host to configure.
- The app is served at **`https://app<app_id>.tgcloud.ai/`**; `npx tgcloud push`
  prints the actual URL. Never guess the `<app_id>`.
- `"spa": true` serves `index.html` for extension-less paths that do not exist,
  which makes the direct route **`/gift`** work.
- The static site is **public**. TGCloud does not document per-file auth. The
  letter is therefore served only by the authenticated `getGift` endpoint and is
  absent from `web/`.

## Mini App authentication

- The official front-end bridge is `Telegram.WebApp.Serverless.call(name, input,
  cb)` from `telegram-web-app.js`. It attaches the Mini App init data.
- `ctx.initData` is **verified by the platform** before the endpoint is invoked;
  invalid/missing init data yields `401` and the endpoint never runs. It has the
  same shape as `Telegram.WebApp.initDataUnsafe` but is trustworthy.
- The isolate has no bot token, so this project cannot and does not recompute
  Telegram's HMAC. It independently validates shape, `auth_date` freshness and
  the durable allowlist. `Telegram.WebApp.initDataUnsafe` is never used as
  evidence anywhere in the frontend.
- Refusals use `throw new EndpointError(description, parameters)` → `400` with a
  safe description. Other exceptions become a generic `500`.

## Telegram Bot API features used

- `sendMessage` with `parse_mode: 'HTML'` and an explicitly escaped
  `tg://user?id=...` mention for the rejection message.
- Inline keyboards with `callback_data` (kept under Telegram's 64-byte limit).
- `answerCallbackQuery` for every callback.
- Inline `web_app` buttons (private chats only) pointing at the HTTPS Mini App
  route `/gift`. Telegram documents `web_app` on `InlineKeyboardButton`; no
  BotFather domain registration is required for this button type.
- The platform manages the webhook and Bot API auth.

## Commands used

```bash
npx tgcloud login       # link this folder to the bot (writes .tgcloud/, gitignored)
npx tgcloud status      # diff local project vs cloud
npx tgcloud push        # deploy modules + static (never migrates)
npx tgcloud migrate     # apply tgcloud/schema.js changes
npx tgcloud webhook     # inspect webhook status; `webhook sync` repairs drift
npx tgcloud run <mod>   # execute a module in the cloud (touches real DB)
npx tgcloud fetch       # sync cloud revision metadata (used in CI)
```

## Deliberate limitations

- No session cookies: each endpoint request carries platform-verified initData and
  is checked against the allowlist. This is stricter than a session and survives
  revocation immediately.
- No rate limiter beyond a small per-user menu-tap cooldown. A private two-person
  bot does not need a generic quota system; Telegram also rate-limits updates.
- No scheduler: not required by this gift.
- No account export/backup command is documented; keep the repo private and the
  TGCloud project under the owner's BotFather account.
