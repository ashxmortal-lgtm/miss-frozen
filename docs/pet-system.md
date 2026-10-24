# Pet System (`/pet`)

Pet system for MissFrozen (@missfrozen_bot, TGCloud app8888370613), ported from
the Aww `pet.py` / `map.py` reference and rebuilt around the **persistent
session** model: Play 30 min, Train 2 h, Rest 30 min. There are no in-memory
timers and no cron — every session is a row with `started_at` / `ends_at` and is
settled lazily by the next interaction or by the message sweep.

## Player-facing surface

| Entry | Behaviour |
|---|---|
| `/pet` | Opens the **equipped pet's card** directly: pet photo + status caption + the fixed menu. A single owned pet is opened even when none is equipped; otherwise the pet list appears |
| `/pet me [name]` | Same card; a name/custom name opens that owned pet |
| `/pet_store` | Store: catalogue + prices + balance + `🍖 Pet food` · `🕸️ Pet abilities` · `Back` |
| `/buy <pet name>` · `/buy <shinobi name>` | One command for pets and shinobi; the catalogue decides the type; multi-word names work (`/buy pet name`, `/buy Starter Shinobi`) |
| `/equip <pet name>` · `/equip <shinobi name>` | Equips the pet (single active companion) or the shinobi (max 3) |
| `/pet_rename [PetName] NewName` | Renames using one Pet Nametag |

The card is a photo message (storage-channel `file_id`, same mechanism as the map
artwork) whose caption is:

```text
{pet name or custom name}

Current status: ready / playing / training / resting / exhausted

✨ {ability name}
```

with these exact rows:

```text
[🍖 Feed] [🎾 Play] [🏋️ Train] [😴 Rest]
[📊 Pet stats] [🕸️ Pet abilities]
[🔄 Switch pet] [✏️ Rename pet] [❌ Close]
```

The rows never change with state: the server refuses what the pet cannot do
right now — Feed only while the pet is hungry (energy below 100 and the pet is
`READY`), Play/Train never while `EXHAUSTED` (the answer asks for rest), and Rest
is the wake toggle while `RESTING`. **Switch pet never opens the pet list**: one
tap equips the other owned pet, answers with `🔄 ꜱᴡɪᴛᴄʜᴇᴅ ᴛᴏ …` and renders that
pet's card in place; with a single owned pet it only explains that the user owns
one pet. Rename pet opens the nametag/rename screen, Close deletes the card.

When the pet is already busy, tapping any other activity answers with an alert
that names the **running** activity and its remaining time:

```text
⏳ {PetName} ɪꜱ ʙᴜꜱʏ
🏋️ ᴄᴜʀʀᴇɴᴛ ᴀᴄᴛɪᴠɪᴛʏ: ᴛʀᴀɪɴɪɴɢ · 1h 55m
❌ ᴘʟᴀʏ ᴄᴀɴ'ᴛ ꜱᴛᴀʀᴛ ᴜɴᴛɪʟ ᴛʜɪꜱ ᴇɴᴅꜱ.
```

Pet commands live behind the **PETS** button of `/help` (the main help message no
longer lists them). `/help` itself shows the profile block, the PvP block and
`/start` · `/help` · `/owner`, with `PETS · JUTSU · FUN` and
`MORE ❄️ GAMES · BACK` rows.
| `/pet food`, `/pet stats`, `/pet ability`, `/pet help` | Sub-screens |

Store instruction line (the bot's small-caps style renders the placeholders
exactly like this; `/buy` and `/equip` keep their real spelling):

```
ʙᴜʏ ᴡɪᴛʜ: "/buy ᴘᴇᴛ ɴᴀᴍᴇ" ᴇǫᴜɪᴘ ᴡɪᴛʜ: /equip ᴘᴇᴛ ɴᴀᴍᴇ
```

`/pet_store` never shows purchase buttons. Its only buttons are
`[Pet 🍖 food] [Pet abilities]` and `[⬅️ Back]`; food opens the existing Ichiraku
pet-food menu, abilities opens the store-wide guide
<https://t.me/frozenblooded/23> (per-pet cards and the stats screen use the pet's
own guide), Back returns to the caller's pet menu (or the store hub when opened
from the map).

### Stats screen

```text
📊 𝐏𝐄𝐓 𝐒𝐓𝐀𝐓𝐒          ← heading, outside the quote
> ⭐ ʟᴇᴠᴇʟ: 1/5　○○○○○
> ✨ xᴘ: 0 / 1,000
> ⚡ ᴇɴᴇʀɢʏ: 70/100
> 🏋️ ꜱᴛᴀᴛᴜꜱ: ᴛʀᴀɪɴɪɴɢ · 1h 55m
> 🏆 ᴛᴏᴛᴀʟ xᴘ ᴇᴀʀɴᴇᴅ: 1,350

──────────  (rich divider block)
🦋 𝐅𝐋𝐔𝐓𝐓𝐄𝐑 𝐅𝐎𝐑𝐓𝐔𝐍𝐄
🍀 ᴛʀɪɢɢᴇʀ ᴄʜᴀɴᴄᴇ: 8%
🎁 ʀᴇᴡᴀʀᴅ ʙᴏɴᴜꜱ: +10%
✨ ꜱʜɪɴᴏʙɪ xᴘ: +2%
```

The heading stays outside; every stat line is inside a rich `blockquote`
(`<blockquote>` in the HTML card, flattened quote lines on the classic path).
Only the equipped pet's own ability is shown (Capycorn shows duration/cooldown
reductions instead), and its button opens that pet's guide: Axofly
<https://t.me/frozenblooded/26>, Capycorn <https://t.me/frozenblooded/27>,
fallback <https://t.me/frozenblooded/23> for any other pet. `xᴘ` is progress
inside the current level; at max level it shows total XP / 15,000. The divider is
the rich block `{ type: 'divider' }` and renders as a line of `─` on the classic
path.

### Map entry points and locations

Every pet entry point (completion DM button, legacy `map_pet_menu` button,
Training Ground / BBQ / Hot Springs pet buttons) renders the **same `/pet` card**;
the retired map pet menu no longer exists. All map buttons carry an emoji
(Hokage Office, Gate, BBQ, Stores, Hot Springs, Back).

Store → 🐾 Pet Store · Training Ground → 🐾 Train Pet · Ichiraku → 🍱 Pet Food.
Map screens keep the existing artwork, Close button and Frozen Blooded theme.

**BBQ** (`🍖 𝐁𝐁𝐐` caption + rich divider):

```text
[Join BBQ] [Feed pet]
[Instant shinobi recovery]
[Play with pet] [Back]
```

Join BBQ opens the shinobi picker; the chosen shinobi recovers `+20` chakra
every 30 minutes and stays **busy** until the chakra pool is full, then is freed
automatically (the catch-up sweep deletes the session). Feed pet opens the pet
food caption below.

**Hot Springs** (`♨️ 𝐇𝐎𝐓 𝐒𝐏𝐑𝐈𝐍𝐆𝐒` caption):

```text
[Relax shinobis] [Rest pet]
[Recall shinobis] [Back]
```

Relax sends a shinobi into the springs with the same `+20 / 30 min` recovery and
the same auto-free rule; Recall lists everyone currently relaxing so they can be
pulled out early.

**Ramen shop pet food** (one caption, then the price buttons):

```text
➤ 🍱 𝐍𝐈𝐍𝐉𝐀 𝐏𝐄𝐓 𝐌𝐄𝐀𝐋

✨ +100 xᴘ · +10 ⚡

💰 500 🍥

➤ 🍬 𝐂ʜᴀᴋʀᴀ 𝐓ʀᴇᴀᴛ

✨ +250 xᴘ · +25 ⚡

💰 1,000 🍥

➤ 🍜 𝐈ᴄʜɪʀᴀᴋᴜ 𝐅ᴇᴀꜱᴛ

✨ +500 xᴘ · +50 ⚡

💰 2,000 🍥

[500 🍥] [1,000 🍥] [2,000 🍥]
[⬅️ Back]
```

Tapping a price buys that meal immediately (same `feedPet` path, charge + XP +
energy, duplicate taps stay silent).

### Daily quest (Hokage Office)

```text
🗺️ 𝐊𝐎𝐍𝐎𝐇𝐀 𝐌𝐀𝐏
🎯 𝐃𝐀𝐈𝐋𝐘 𝐐𝐔𝐄𝐒𝐓
📜 ǫᴜᴇꜱᴛ: {mission name}
🥷 ᴏʙᴊᴇᴄᴛɪᴠᴇ: {mission objective}
🍥 ʀᴇᴡᴀʀᴅ: {rewardCoins} Konoha coins
📊 ꜱᴛᴀᴛᴜꜱ: pending / completed
⌛ ᴇxᴘɪʀᴇꜱ: today
```

The objective comes from the assigned mission template, and the reward is that
mission's own `rewardCoins` — never a hardcoded value.

Callbacks are owner-first and re-validated server-side:

```text
pet_menu:{uid} · pet_me:{uid}:{petId} · pet_feed_menu:{uid}:{petId}
pet_food:{uid}:{petId}:{foodKey} · pet_play:{uid}:{petId}
pet_start:{uid}:{petId}:{type}:{shinobi} · pet_train|rest|wake|stats|equip|name|close:{uid}:{petId?} · pet_switch:{uid}:{petId}
map_pet_*:…  (owner id first for uid-first shapes, last for pet-first shapes)
map_hot_relax|map_hot_recall:{uid} · map_hot_go|map_hot_stop:{shinobi}:{uid}
map_bbq_select|map_bbq_recall|map_bbq_heal|map_bbq_hpay:{uid}
map_bbq_go|map_bbq_stop:{shinobi}:{uid}
map_btog|map_ptog:{shinobi}:{uid} · map_ball|map_pall|map_psend:{uid}
```

The Gate (`map_loc_gate`) adds `🍖 Visit BBQ and recover` → `map_bbq_heal` as soon as one
roster member is exhausted; that window is the BBQ recovery selection. After the
200 🍥-each recovery the same message turns into the patrol picker with the healed
units preselected (`map_btog` keeps re-rendering it), so a shinobi can be recovered
and sent on patrol without walking back to the Gate.

The owner id must equal `cb.from.id` (`🔒 ᴛʜɪꜱ ᴍᴇɴᴜ ɪꜱɴ'ᴛ ʏᴏᴜʀꜱ.`), and every
pet id is re-read from the caller's own `user_pets` rows — a tampered callback
can at most address nothing (`❌ ᴘᴇᴛ ɴᴏᴛ ꜰᴏᴜɴᴅ.`). Unknown or outdated callbacks
answer `⚠️ ᴛʜɪꜱ ᴍᴇɴᴜ ɪꜱ ᴏᴜᴛᴅᴀᴛᴇᴅ…`, caught errors answer the generic unexpected
error, and technical details stay in the server log.

## Values

| Pet | Price | Ability |
|---|---|---|
| 🦋 Axofly | 30,000 🍥 | Flutter Fortune — trigger 8/12/15/18/22 %, reward +10/10/15/20/25 %, Shinobi XP +2/3/4/5/7 % |
| 🦄 Capycorn | 40,000 🍥 | Royal Pace — Mission & Patrol duration −3/4/5/7/10 %, cooldown −2/3/4/5/7 % |

- XP thresholds (cumulative): 0 / 1,000 / 3,000 / 7,000 / 15,000; cap 15,000, level cap 5.
- Energy: max 100 · +10 per 2 h · +15 per 1 h while resting (lazy timestamps).
- **Feed** 🍖 — instant: Ninja Pet Meal 500 → +100 XP · Chakra Treat 1,000 → +250 XP
  · Ichiraku Feast 2,000 → +500 XP, each also restoring 10 / 25 / 50 energy.
  One debit per tap (idempotency key), Ichiraku cut paid to the property owners,
  daily `pet_feed` progress once per purchase.
- **Play** 🎾 — 30 min, 75 XP, 15 energy, locks the pet **and** one eligible
  starter shinobi; both stay busy until the session completes.
- **Train** 🏋️ — 120 min, 150 XP, 30 energy, locks the pet only.
- **Rest** 😴 — 30 min, only for an exhausted pet, 0 XP, restores the pet to
  READY with full energy; cannot be used to farm XP.
- Pet Nametag: 3,000 🍥, 24 visible characters, consumed per rename.
- Pet photos come from the private storage channel
  (`t.me/c/3889508991/540` Axofly, `/541` Capycorn). Those are Telegram message
  links, not HTTP photo URLs, so they are resolved through the storage-channel
  forward → cached `file_id` path (`map_media_cache`) and embedded in the rich
  message; they are never passed to `sendPhoto` as a URL.

## State machine

```
READY ──play(30m, +shinobi)──▶ PLAYING ──done──▶ EXHAUSTED
READY ──train(2h)───────────▶ TRAINING ──done──▶ EXHAUSTED
EXHAUSTED ──rest(30m)───────▶ RESTING ──done──▶ READY (energy = 100)
RESTING ──wake/cancel───────▶ EXHAUSTED (no energy, no XP, no reward)
```

Rules enforced in `startPetActivity` (re-read immediately before the claim):

- only the equipped pet acts; only `STARTABLE_ACTIVITIES` can start;
- one active session per pet — a second tap returns `busy` (no duplicate row);
- Play needs an owned, non-exhausted shinobi that is not on patrol, mission,
  training or another pet session; that shinobi cannot start patrol, mission or
  shinobi training until the session settles. Death is account-level and never
  blocks Play — a dead account's shinobi are available like any other;
- a stale lock (a finished patrol nobody settled, or a pet session row that no
  longer exists) is repaired before the availability check, so Play can never be
  blocked by a shinobi that is not actually busy;
- Train is rejected while the pet is exhausted (`rest_required`); Rest is
  rejected while the pet is ready (`not_exhausted`);
- energy is checked and deducted with a guarded `UPDATE … AND energy >= cost`.

Completion is claimed by a guarded `DELETE … WHERE status='active' AND
started_at=…`, so a double sweep, a duplicate callback or two devices can pay
only once. Play/Train award XP, add the session stats, mark the pet exhausted
and free the shinobi; Rest clears exhaustion, restores full energy and frees
nothing else. Cancelling a rest pays nothing.

## Serverless completion

`settlePetActivities(userId)` runs inside `listPets`, `getPet`,
`startPetActivity`, `cancelPetActivity`, `feedPet`, `/inventory`, `/gate` and the
global message sweep (`sweepActivities`). Each settled session produces one
completion message (XP + level-up combined) sent as a DM with no buttons; a
completion that nobody observed is delivered by the next sweep, so the bot never
claims a notice it did not send.

## `/inventory` and the Village Gate

`/inventory` lists owned pets with `🟢 ʀᴇᴀᴅʏ`, `🎾 ᴘʟᴀʏɪɴɢ · 29m`,
`🏋️ ᴛʀᴀɪɴɪɴɢ · 1h 59m`, `😴 ʀᴇꜱᴛɪɴɢ · 29m` or `⚠️ ᴇxʜᴀᴜꜱᴛᴇᴅ · ʀᴇꜱᴛ ʀᴇQᴜɪʀᴇᴅ`.

The **Village Gate does not show pet activity at all** — only the shinobi status
table. The shinobi row still says `🎾 Playing with {pet} — Returns …` while a
Play session locks that shinobi (that is shinobi availability, not a pet panel).

## Files

| File | Role |
|---|---|
| `tgcloud/lib/pet/defs.js` | Pure catalogue, constants, XP/energy/level math, ability tables |
| `tgcloud/lib/pet/text.js` | Every user-facing pet dialogue (catalogue, pure functions) |
| `tgcloud/lib/pet/store.js` | Persistence: lazy schema, buy/equip/rename, instant feed, sessions, settle, stats, abilities |
| `tgcloud/lib/pet/ui.js` | Screens, keyboards, `pet_*` router, `/pet*` commands, HTML variants |
| `tgcloud/lib/pet/media.js` | Storage-channel photo `file_id` resolver (540 / 541) |
| `tgcloud/lib/pet/migration.js` | One-time legacy (`economy.db`) pet restoration on first interaction |
| `tgcloud/lib/pet/migration_data.js` | Generated JS mirror of the migration JSON (runtime source of truth) |
| `tgcloud/lib/pet/data/missfrozen_pet_migration.json` | Canonical legacy pet snapshot exported from `economy.db` |
| `tgcloud/lib/buy.js` | `/buy` for pets **and** shinobi items (catalogue decides, multi-word names) |
| `tgcloud/lib/economy_handler.js` | `/equip` for pets **and** shinobi, `/pet*` dispatch |
| `tgcloud/lib/map/handler.js`, `map/ui.js` | Map pet entry points, `map_pet_*` / `map_hot_*` routing, BBQ and Hot Springs captions |
| `tgcloud/lib/map/bbq.js` | Shared BBQ / Hot Springs recovery sessions (`bbq_sessions.location`) |
| `tgcloud/lib/activities.js` | Patrol/mission settlement, `busy_pet` guard, pet sweep DMs |
| `tgcloud/lib/rpg/status.js`, `inventory.js` | Roster "Playing with {pet}" label, pet status lines |
| `tgcloud/lib/rpg/training.js` | Shinobi training `busy` guard while a pet session runs |
| `tgcloud/schema.js` | Declarative tables/columns (additive only) |

## Schema (additive only)

Tables: `user_pets`, `equipped_pet`, `pet_activity`, `pet_stats`,
`pet_migration_status`, `special_inventory`, `property_ownership`,
`property_partnership_requests`, `daily_missions`, `map_media_cache`.

Additive columns added by this task:

| Table | Column | Purpose |
|---|---|---|
| `user_pets` | `exhausted` (integer, default 0) | Play/Train completion state; cleared by Rest |
| `activities` | `partner_pet` (text) | Which pet a locked shinobi is playing with |

`ensurePetSchema()` (memoised per isolate) creates the same DDL with
`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN`, so a missed migration
cannot break gameplay. Existing pet/feed/train cooldown columns are kept for
legacy rows only.

Migration on the bot's own project (not run by this change):

```sh
npx tgcloud status      # review the schema diff
npx tgcloud migrate     # applies the additive tables/columns
npx tgcloud push        # deploys modules
npx tgcloud webhook     # confirm handler routing
```

No data reset is required. Pet owners carried over from the legacy `economy.db`
bot are restored lazily on their first interaction — see
[`docs/pet-migration.md`](./pet-migration.md). That path only needs the additive
`pet_migration_status` table; it never charges coins, never logs a purchase and
never touches an existing pet row.

## Tests

- `test/pet_system.test.js` — constants, XP/level/energy math, ability tables,
  schema, command/callback routing, map entry points, duplicate-safe SQL.
- `test/pet_engine.test.js` + `test/helpers/run_pet_engine.mjs` — real modules on
  in-memory SQLite through an SDK shim: purchase race, equip exclusivity, instant
  feed/idempotency/XP cap, Play lock (pet + shinobi), busy rejection across
  conflicting activities, Train → exhaustion → Rest → full recovery, duplicate
  settle, expired-session reconciliation, food fees, nametags and daily missions.
- `test/pet_ui.test.js` + `test/helpers/run_pet_ui.mjs` — store and `/pet me`
  buttons, food navigation, abilities URL, stats/level/dots/ability screens,
  dialogue catalogue, owner/unknown-pet/stale callback guards and the 64-byte
  callback limit.
- `test/pet_migration.test.js` + `test/helpers/run_pet_migration.mjs` — legacy
  restoration: single/multi-pet owners, users without pets, repeated updates,
  live-data preservation, failed runs, in-flight/stale claims, unknown pet ids,
  level flooring and the JSON ↔ generated-mirror drift guard.
- Commands: `npm test`, `npm run validate`, and
  `node --experimental-loader ./test/helpers/sdk-loader.mjs test/helpers/run_pet_engine.mjs`.

## Deliberate differences from the Python appendix

1. **Pet card artwork.** The reference copies photos from the storage channel and
   edits captions per action. This port resolves the same storage messages
   (540 / 541) into a cached `file_id` and embeds it in the rich panel, so pet
   screens carry the official artwork without separate photo messages.
2. **Feed is instant.** The appendix runs a 30-minute feed session; the spec
   requires food to apply immediately, so feeding is a purchase + XP/energy
   update (one debit per tap). `PET_ACTIVITIES.feed` only exists to settle rows
   started before this update.
3. **Daily progress timing.** Progress is notified on successful **completion**,
   never on start, and a background completion never assigns a mission by itself.
4. **Kill/rob bonuses.** The appendix wires `get_pet_reward_bonus` only into
   claim/patrol/mission; this port also applies it at the successful `/kill` and
   `/rob` reward boundary.
5. **Mission duration.** The appendix reduces patrol duration only; here missions
   and patrols both use whole-minute, minimum-one-minute arithmetic, and the
   reduction is stored when the mission starts.
6. **Pet stats counters.** Counters are per user (`pet_stats.telegram_id`), not
   per user+pet; values and display are otherwise the same.
7. **Property partnership UI.** Earnings splitting honours stored shares (solo
   100/0, partnership as configured); the group partnership invite/confirm
   screens were not part of the pet spec and are not ported.
