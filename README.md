# MissFrozen — Gaming Bot 🍥

Independent Telegram **gaming** bot split out of Frozen Blooded.

| | |
|---|---|
| Bot | [@missfrozen_bot](https://t.me/missfrozen_bot) |
| TGCloud app | `app8888370613` |
| Mini App | https://app8888370613.tgcloud.ai/ |
| CI secret | `TGCLOUD_TOKEN_MISSFROZEN` (issued for **this app only**) |

Gaming features only: `/games` `/xoxo` `/rps` (+ cancels/stats), `/map`
`/mission` `/patrol`, `/shinobi_store` `/buy` `/inventory` `/equip` `/unequip`,
`/ability`, `/claim`+`/daily`, `/balance` `/profile` `/leaderboard` (`/lb`),
`/transfer`, gifts & socials, `/mt` `/kill` `/rob` `/protect` `/byakugan`
`/search_tsuna`, coupons (`/redeem` `/create_cc` `/list_cc` `/edit_cc`),
`/addcoins`, plus common commands. No study features, no `/imfrozen`.

**`/eco on|off`** is available to the bot owner and to **Telegram group admins**
(verified live with `getChatMember`) — no `/imfrozen` registration is needed
or read. Ordinary users cannot change it. While economy is off in a group, the
existing economy-command lock applies unchanged.

## Setup (fresh database — no data is migrated)

```bash
npm ci
npm run validate          # syntax + imports + snapshot + tests
npx tgcloud login         # link THIS folder to app8888370613 / @missfrozen_bot
npx tgcloud status        # confirm the target app before doing anything else
npx tgcloud migrate       # create this bot's own tables (fresh DB of app8888370613)
npx tgcloud push          # deploy code + Mini App (web/)
```

⚠️ `migrate` and `push` act on the **live app your token points at**. The
combined Frozen Blooded bot previously ran on this app — deploying this
gaming-only build replaces its **code** (deploy never deletes database rows;
`migrate` only applies this schema). Confirm you really want the cutover, and
never use the ExFrozen token here.

## Manual checks before first deploy

1. **BotFather** — bot username is `@missfrozen_bot`; Mini App / menu-button URL
   (if set) is `https://app8888370613.tgcloud.ai/`.
2. **GitHub secret** — `TGCLOUD_TOKEN_MISSFROZEN` contains a token issued for
   `app8888370613` only. The workflow refuses tokens embedding a different app id.
3. **Support inbox** — `tgcloud/lib/topic_config.js` still points at the shared
   support supergroup/topic used by Frozen Blooded. Change it if MissFrozen
   needs its own support group.
4. **Map media** — map photos are cached from the storage channel referenced in
   `tgcloud/lib/map/*`; keep @missfrozen_bot in that channel.

## Economy

Coins, inventory, purchases, games and RPG state live in this app's own
database only. Study rewards do not exist here and never touch this balance.

## Layout

`tgcloud/` = deployed code (schema, lib, handlers, endpoints) · `web/` = Mini
App · `test/`, `scripts/validate.js` = local validation. See `AGENTS.md`.
