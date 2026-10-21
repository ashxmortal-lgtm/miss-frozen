# AGENTS.md — For My Sheesh

A **standalone** Telegram Serverless (TGCloud) project: a private bot + Mini App
holding one anniversary gift. Run every command from this folder, not the
repository root (the root is a different bot).

## Non-negotiable security invariants

1. The owner is `8716863150`, from **trusted server config**
   (`tgcloud/lib/config.js`). A DB row, URL, browser value or Telegram username
   can never establish ownership.
2. Default deny. Every private command, callback and endpoint checks the durable
   allowlist server-side, on every request. Never cache authorization in a
   frontend or a module-level variable.
3. Fail closed. If the DB is missing/unreadable/malformed, deny. Only the
   configured owner may grant/revoke; the owner can never be revoked.
4. Identity comes only from a verified Telegram update (`message.from.id`,
   `callback_query.from.id`) or platform-verified `ctx.initData.user.id` — never
   from message text, callback data, query strings or a request body.
5. The full letter lives only in server code / the authenticated `getGift`
   endpoint. It must never appear in `web/`, in a public asset, or in an
   unauthenticated response.
6. Never commit tokens. The runtime needs no Bot API token and TGCloud has no
   documented secrets store (see `docs/TGCLOUD.md`).

## Layout

| Path | Purpose |
|---|---|
| `tgcloud/schema.js` | SQLite tables (access list, settings, dedupe) — apply with `migrate` |
| `tgcloud/handlers/` | `message.js`, `callback_query.js` — thin platform entry points |
| `tgcloud/endpoints/` | `getAccessStatus.js`, `getGift.js` — POST `/api/<name>` |
| `tgcloud/lib/` | config, access service, SQL store, Mini App initData guard, content, bot routers |
| `web/` | plain HTML/CSS/ES modules served at the Mini App host (no build step) |
| `test/` | Node test runner + jsdom + real SQLite (`node:sqlite`) |
| `scripts/validate.js` | syntax/import/config/privacy/secret validation |
| `docs/` | TGCloud facts, security model, deployment runbook |

## Platform rules that bite

- Import project modules by **relative path with `.js`**; import only `sdk`
  (and `sdk/db`) from the platform. No npm packages, filesystem, `node:` imports
  or environment variables inside `tgcloud/`.
- Every DB call is async (`await`). Raw SQL is used through `db.run/get/all`;
  named params use `:name`.
- `push` deploys code/static only. `migrate` applies schema changes separately.
- The platform verifies Mini App `initData` before an endpoint runs; invalid
  data gets 401. Our endpoints still re-check freshness and the allowlist.
- Static hosting is public. Never put private content there.

## Commands

```bash
npm ci
npm run validate     # validation script + all tests
npx tgcloud login
npx tgcloud status
npx tgcloud push
npx tgcloud migrate
npx tgcloud webhook
```

## Repository privacy

The letter is personal content in source. Keep this project in a **private**
repository. Do not commit it to a public repo.
