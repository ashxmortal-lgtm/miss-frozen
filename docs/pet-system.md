# Pet System V1 (`/pet`)

Port of the Aww `pet.py` / `map.py` pet system into MissFrozen (@missfrozen_bot,
TGCloud app8888370613). Implemented against `MissFrozen_Pet_System_COMPLETE.pdf`
and the supplied Python appendix. Values are reproduced exactly; this document
records the integration points, the migration steps, and every known difference.

## Player-facing surface

| Entry | Behaviour |
|---|---|
| `/pet` | Equipped-pet profile: name, level, XP/next, energy, activity timer, per-activity cooldowns, ability, Shinobi, Feed/Play/Train/Rest, Stats, Ability, Switch, Nametag, Store |
| `/pet feed\|play\|train [Shinobi]` | Starts the activity (Shinobi picker when omitted) |
| `/pet rest` | Starts the open-ended rest (+15 energy/hour) |
| `/pet store\|buy`, `/pet_store` | Catalogue: price + ability + balance |
| `/buy_pet Axofly\|Capycorn` | Adopts (never auto-equips) |
| `/equip_pet [name]` | Switches the single active pet |
| `/pet stats`, `/pet food`, `/pet ability`, `/pet name`, `/pet help` | Sub-screens |
| `/pet_rename [PetName] NewName` | Renames using one Pet Nametag |

Map entry points: Store → 🐾 Pet Store / 🏠 Property, BBQ → 🍖 Feed Pet /
🎾 Play with Pet, Training Ground → 🐾 Train Pet, Hot Springs → ♨️ Rest Pet
(tap again to wake), Ichiraku → 🍱 Pet Food. Every map control is a rich button
and keeps the existing artwork, Close button and Frozen Blooded theme.

Pet callbacks are owner-checked (`pet_*:{uid}:…`); map callbacks use
`map_pet_*:{…}:{uid}` and are routed through the map handler. Completion notices
are sent as a DM by the (scheduler-free) sweep with a **🐾 Open Pets** button
(the source sends no group notice for pet completions).

## Exact values

| Pet | Price | Ability |
|---|---|---|
| 🦋 Axofly | 30,000 🍥 | Flutter Fortune — reward chance 8/12/15/18/22 %, bonus +10/10/15/20/25 %, Shinobi XP +2/3/4/5/7 % |
| 🦄 Capycorn | 40,000 🍥 | Royal Pace — duration −3/4/5/7/10 %, cooldown −2/3/4/5/7 % |

- XP thresholds (cumulative): 0 / 1,000 / 3,000 / 7,000 / 15,000; XP cap 15,000, level cap 5.
- Energy: max 100, +10 / 2 h normally, +15 / 1 h while resting; lazy timestamp regeneration.
- Feed 🍖: BBQ, 30 min, 6 h cooldown, 50 XP, 10 energy.
- Play 🎾: BBQ, 45 min, 4 h cooldown, 75 XP, 15 energy.
- Train 🏋️: Training Ground, 120 min, 8 h cooldown, 150 XP, 30 energy.
- Rest ♨️: Hot Springs, open-ended/cancelable, 0 XP, 0 energy, no cooldown.
- Food: Ninja Pet Meal 500 → +100 XP · Chakra Treat 1,000 → +250 XP · Ichiraku Feast 2,000 → +500 XP (equipped pet only).
- Pet Nametag: 3,000 🍥, 24-character limit, consumed per rename, HTML-sanitised;
  the purchase keeps one debit per tap and refunds if the item grant fails.
- BBQ feed fee: 150 🍥 charged only when feeding from a group map at an owned BBQ; refunded if the start fails; paid to the property owners' pot.
- Daily missions: Feed Your Companion 750, Playtime 750, Pet Training 1,500 (once per IST day).

Rules: only the equipped pet acts; one activity per pet; Feed/Play/Train need
an owned, alive, non-exhausted Shinobi who is not on another activity and stays
busy until completion; XP is awarded at completion; cooldowns are per activity
type, stored on the pet row and fixed at completion; energy is checked and
deducted at start. Rest is canceled by tapping Wake Pet.

## Files

| File | Role |
|---|---|
| `tgcloud/lib/pet/defs.js` | Pure catalogue, constants, XP/energy/level math, ability rolls (injectable RNG) |
| `tgcloud/lib/pet/store.js` | Persistence: lazy schema, buy/equip/rename, energy clocks, start/cancel/settle, food, ability helpers |
| `tgcloud/lib/pet/ui.js` | Rich UI, classic fallback, `/pet*` commands, `pet_*` callback router |
| `tgcloud/lib/property.js` | BBQ/Ichiraku ownership, feed fee + refund, earnings, partnership-safe splits |
| `tgcloud/lib/daily.js`, `daily_defs.js` | IST daily missions, idempotent progress/reward |
| `tgcloud/lib/activities.js` | Mission/patrol settlement; pet rows excluded; Capycorn start-only reductions; Axofly/XP hooks |
| `tgcloud/lib/economy.js` | `/claim` Axofly coin bonus + Shinobi XP multiplier |
| `tgcloud/lib/rpg/combat.js` | `/kill` and `/rob` Axofly bonuses (successful rewards only) |
| `tgcloud/lib/map/handler.js`, `map/ui.js` | Map entry points and `map_pet_*` / `map_prop_*` callbacks |
| `tgcloud/lib/economy_handler.js` | Command gate, completion notices, `/claim` line |
| `tgcloud/lib/command_registry.js`, `handlers/callback_query.js`, `rpg/status.js` | Help entries, callback routing, roster "Pet activity" label |
| `tgcloud/schema.js` | Declarative tables/columns (additive only) |

## Schema (additive only, no drops)

New tables: `user_pets`, `equipped_pet`, `pet_activity`, `pet_stats`,
`special_inventory`, `property_ownership`, `property_partnership_requests`,
`daily_missions`. New column: `activities.cooldown_sec`. `user_pets` carries
`feed_cooldown_until`, `play_cooldown_until`, `train_cooldown_until`.
`ensurePetSchema()` (memoised per isolate) creates the same DDL with
`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN` and swallows
"duplicate column" errors, so a missed migration cannot break gameplay.

Migration on the bot's own project (not run here):

```sh
npx tgcloud status      # review the schema diff
npx tgcloud migrate     # applies additive tables/columns
npx tgcloud push        # deploys modules
npx tgcloud webhook     # confirm handler routing
```

No data reset, backfill, or destructive change is required.

## Serverless completion

No timers, cron, or background workers. Due work is settled lazily inside any
request that needs it (`listPets`, `startPetActivity`, `cancelPetActivity`) and
on every incoming message through `sweepActivities()` →
`settlePetActivities()`. Settlement is claimed by a guarded
`DELETE … WHERE status='active' AND started_at=…`, so a duplicate sweep or
callback cannot pay twice. The Shinobi's `activities` row (`kind='pet'`) is
released in the same flow.

## Tests

- `test/pet_system.test.js` — constants, XP/level/energy math, ability tables,
  schema, command/callback routing, map entry points, duplicate-safe SQL.
- `test/pet_engine.test.js` + `test/helpers/run_pet_engine.mjs` — real modules on
  in-memory SQLite through an SDK shim: purchase race, equip exclusivity,
  equipped-only starts, Shinobi conflicts, energy/XP, per-type cooldowns,
  double-settle no-op, rest cancel, food idempotency, nametag purchase/consumption,
  BBQ fee charge/refund/split, daily mission completion-only progress,
  sweep-based completion.
- Commands: `npm test`, `npm run validate` (61/61 tests), and
  `node --experimental-loader ./test/helpers/sdk-loader.mjs test/helpers/run_pet_engine.mjs`.

## Deliberate differences from the Python appendix

1. **Pet card artwork.** The source sends a photo copied from the storage
   channel (`PET_IMAGE_CHAT_ID`, message ids 349/353) and edits its caption.
   This bot has no access to that channel, so the pet card is a rich message
   (with a classic HTML fallback). All data and buttons are identical.
2. **Daily progress timing.** The source calls `notify_daily_mission_progress`
   right after a successful start; §5 of the specification requires progress on
   successful **completion**, so the port notifies from the settle path. A
   background completion never assigns a mission by itself.
3. **Kill/rob bonuses.** The appendix wires `get_pet_reward_bonus` only into
   claim/patrol/mission. The specification (§2, §9) lists `/kill` and `/rob`, so
   both are wired here at the successful-reward boundary; failed kills/robs and
   zero rewards never roll.
4. **Mission duration.** The appendix only reduces patrol duration; the
   specification asks for missions and patrols, so both use the same
   whole-minute, minimum-one-minute arithmetic. Cooldown reduction is stored at
   mission creation and never rewrites a running timer.
5. **Pet stats granularity.** Counters are per user (`pet_stats.telegram_id`),
   not per user+pet; the values and display are otherwise the same.
6. **Property partnership UI.** Earnings splitting honours stored shares
   (solo 100/0, partnership as configured), but the group partnership
   invite/confirm screens were not part of the pet specification and were not
   ported; solo purchase and earnings claim are available from Store → Property.
