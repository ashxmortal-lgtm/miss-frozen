# Deployment runbook

Everything here runs from **`for-my-sheesh/`**. These steps need a Telegram
account that can talk to @BotFather; they cannot be performed from a code
sandbox.

## 0. Prerequisites

- Node.js 20+ and npm.
- A **private** GitHub repository for this folder (the letter is in source).
- A new Telegram bot owned by the owner account (`8716863150`).
- TGCloud enabled for that bot in BotFather, with a CLI access token
  (`app<id>:<secret>`).

## 1. Create the bot and the TGCloud app (manual)

1. Open @BotFather → `/newbot`.
2. Choose a display name (e.g. **For My Sheesh**) and an available username.
3. Open the new bot in BotFather → **Serverless** → enable it.
4. Open **Serverless → CLI Access** and copy the **Access token**
   (`app<id>:<secret>`). This is not the Bot API token.
5. Optional: BotFather → **Bot Settings → Menu Button** → set the URL to the
   Mini App URL once step 5 prints it.

There is no way to create this bot or app from source control; the owner must do
it.

## 2. Prepare the private GitHub repository

The folder is already a standalone git repository (`main` branch, one commit,
no remote). Create the private repo and push it:

```bash
cd for-my-sheesh
gh repo create ashxmortal-lgtm/for-my-sheesh --private --source=. --push
# or, after creating the empty private repo on github.com:
git remote add origin https://github.com/ashxmortal-lgtm/for-my-sheesh.git
git push -u origin main
```

Then verify:

```bash
npm ci
npm run validate
```

Expected: syntax/import/config/privacy/secret checks pass, then **85 tests
pass**. The validate script fails in CI if `tgcloud.jsonc` or the Mini App
files are not tracked by Git.

> Keep the repository private. `tgcloud/lib/content.js` contains the personal
> letter. It is server code (never served statically), but it is still source.
> Do **not** push this folder to the public `miss-frozen` repository.

## 3. Link the CLI

```bash
npx tgcloud login     # paste app<id>:<secret>
npx tgcloud status    # confirm the target project/app BEFORE any push
```

`.tgcloud/` is gitignored and must never be committed. In CI, set the CLI token
as the `TGCLOUD_TOKEN_FOR_MY_SHEESH` repository secret instead.

## 4. Deploy code + static Mini App

```bash
npx tgcloud push
```

This uploads `tgcloud/` and `web/` and prints the real Mini App URL:

```
https://app<app_id>.tgcloud.ai/
```

Record that exact URL. Do not guess the app id. `push` **does not create tables**.

## 5. Create the database tables

Immediately after the first push:

```bash
npx tgcloud migrate
```

Review the diff and confirm. This creates:

- `access_list` — durable allowlist (ID, role, grant time, granting owner)
- `owner_audit` — append-only owner actions
- `bot_settings` — Mini App URL
- `processed_updates` — callback idempotency
- `menu_taps` — small per-step cooldown

Until this finishes, every command correctly fails closed with "My little
notebook is unavailable…".

## 6. Confirm the webhook

```bash
npx tgcloud webhook
```

TGCloud derives the webhook from deployed handlers and refreshes it on push. If
it reports drift, run `npx tgcloud webhook sync`. Do **not** call `setWebhook`
with a raw bot token; that is what causes drift and there is no project-level
webhook secret to configure.

## 7. Point the gift button at the deployed app

In the owner's private chat with the bot:

```
/setapp https://app<app_id>.tgcloud.ai/
```

The command accepts only the documented TGCloud host pattern
`https://app<digits>.tgcloud.ai/`, normalizes the trailing slash and stores it in
`bot_settings`. This needs no redeploy. The `hehe 🤌` button then opens
`https://app<app_id>.tgcloud.ai/gift`.

If `/setapp` is not run, the menu still renders but the final button safely
answers "The gift door is still being painted." — no broken private link.

## 8. Verify the owner experience

From the owner account:

```
/start      # owner control room + one "mini 🎁 surprises" button
/access     # should show only 8716863150 as owner
/help       # owner commands
```

Tap `mini 🎁 surprises` → `choose` + `8 oct 2026` → anniversary intro +
`hehe 🤌` → Mini App gift cover → **Open Your Gift 🎁** → full letter.

In a normal desktop browser, opening `https://app<app_id>.tgcloud.ai/gift`
must show an authorization error and **no letter** — the Mini App only works
inside Telegram with verified init data.

## 9. Grant the girlfriend later (no code, no redeploy)

```
/grant <her_numeric_telegram_user_id>
```

Then she opens the bot and sends `/start`. She should receive the exact welcome
and the single `mini 🎁 surprises` button.

`/access` lists IDs/roles. `/revoke <id>` removes her; her next command,
callback and Mini App request are denied immediately. The owner can never be
revoked.

If you do not know her numeric ID, obtain it from her own Telegram account using
a reputable "my ID" bot, or from the verified `from.id` in your own bot logs.
Never guess and never use a username.

## 10. Confirm persistence across redeploy

```bash
npx tgcloud push
```

Then send `/access` again. The owner and any granted member must still be there:
the allowlist is in the bot's own TGCloud SQLite database, not in memory, a file
or a deploy artifact.

## Verification matrix

| Item | Verified locally | Verified on TGCloud |
|---|---|---|
| Syntax, imports, layout, config | ✅ `npm run validate` | — |
| Authorization logic, idempotency, fail-closed | ✅ 16 access tests + bot/endpoint tests | ⏳ after deploy |
| SQL against real SQLite | ✅ tests (`node:sqlite`) | ⏳ `migrate` |
| Static assets / no private content | ✅ validation | ⏳ after push |
| Telegram updates, callbacks, exact copy | ✅ mocked Bot API tests | ⏳ real bot |
| Mini App initData → 401 | ✅ platform contract tests only | ⏳ real Telegram |
| Webhook | — | ⏳ `tgcloud webhook` |
| Durable allowlist across cold starts | ✅ file DB reopen test | ⏳ real redeploy |

## If something goes wrong

- **Every command says the notebook is unavailable** → `npx tgcloud migrate` was
  not run, or the schema push failed. Check `npx tgcloud status`.
- **Mini App shows "Open this little gift from Telegram…"** → it was opened
  outside Telegram. Open it from the `hehe 🤌` button.
- **Mini App shows the authorization error for the right person** → run
  `/access`; grant her numeric ID; make sure she reopened from the bot.
- **`hehe 🤌` says the gift door is being painted** → run `/setapp` with the URL
  printed by `push`.
- **Webhook drift** → `npx tgcloud webhook sync`.
- **Lost CLI token** → BotFather → Serverless → CLI Access; issue a new token.
- **Revoke immediately** → `/revoke <id>`. If the bot itself is compromised,
  revoke the CLI token in BotFather and disable Serverless.
