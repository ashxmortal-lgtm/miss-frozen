# Support inbox (`/awwsheesh`)

## User experience

- `/awwsheesh` is handled only in private chats. In groups and supergroups it is intentionally silent.
- The welcome message for regular users, admins, and the owner includes a **💬 Contact Owner** Rich Message button. It opens a support menu with Rich **📨 Start / Resume** and **⏸ Pause** controls. The same menu is available through `/awwsheesh`.
- Starting creates one forum topic per user the first time. Subsequent starts reuse that topic; the bot refreshes the topic title when the user’s first/last name or username changes. The conversation history is retained.
- On the first topic use, the bot posts a Rich Message containing `#newmsg`, a linked user mention, a username field (blank when unavailable), user ID, creation date, and an owner-only **🚫 Ban** button. Banning changes it to a green **✅ Unban** button.
- Active non-command private messages are copied to the user’s topic. The user keeps the original message and gets a rich confirmation with a **⏸ Pause conversation** button only after Telegram accepts the copy. Paused/stopped conversations do not forward new messages in either direction.
- Only IDs in `ADMIN_IDS` can send topic messages to users through this feature. Replies to messages copied from the user preserve the reply relationship where Telegram and the saved message mapping allow it.
- Banning a user stops forwarding and blocks owner replies to that user. The bot notifies the user and gives them a Rich **📝 Request unban** button. The button opens a one-message reply prompt; only that explanation is sent to the configured `users` topic, as `#unbanreq`, with a green **✅ Unban** control. A user can submit one request per 24 hours.
- Owner unban restores access, changes the per-user topic control back to **🚫 Ban**, marks the unban request resolved, and notifies the user. The user must start/resume support again to reopen the conversation.
- `#newuser` continues to go to the configured `users` topic. `#blockbot` goes to the affected user’s topic when one exists, otherwise to `users`.

## Map controls

`/map` retains the current map/location photos. All navigation and action controls are rendered as Telegram Rich Message buttons in a separate rich panel replied to the corresponding photo. This avoids putting a classic inline keyboard on map images and allows the panel to be updated while preserving the artwork. Store and ability screens also use the rich-button helpers on their map paths.

## Configuration

Edit `tgcloud/lib/topic_config.js` before deployment:

1. Set `SUPPORT_GROUP_ID` to the numeric ID of the dedicated supergroup (normally a negative ID such as `-100…`).
2. Set `SUPPORT_USERS_TOPIC_ID` to the numeric `message_thread_id` for the pre-created `users` topic.
3. Add the numeric Telegram user IDs of support admins to `ADMIN_IDS`. Only IDs in this list can use the ban/unban controls or reply to users.

Create a dedicated **supergroup with Topics enabled** and a topic named `users` in Telegram. Add the bot as an administrator and grant **Manage Topics** plus permission to send messages. The first Start / Resume call checks that `getChat` reports a forum supergroup, then creates the user’s topic; if configuration or permissions are missing, it reports a handled error instead of routing to a different chat.

Telegram's `copyMessage` supports most ordinary message types while excluding some service, paid-media, giveaway, and invoice messages. Such failures are handled without claiming delivery.

## Migration and deployment

The support feature initially added `support_conversations` and `support_message_links`. This update adds only columns to `support_conversations` for ban state, the topic intro message ID, and unban prompt/request timestamps; it does not drop or recreate existing tables. After reviewing the schema diff, run from the bot project linked to the intended Telegram bot:

```sh
npx tgcloud status
npx tgcloud migrate   # review the preview; applies the schema changes
npx tgcloud push      # deploys the modules
npx tgcloud webhook   # confirm the deployed webhook matches handlers
```

Migration and deployment are intentionally not run by the contributor. Apply them only from the bot owner's configured tgcloud project after reviewing the migration preview and confirming the target bot.

## Test plan

1. Confirm `/awwsheesh` in a group produces no bot message. In private, confirm it opens the rich Start / Resume and Pause menu.
2. Test Contact Owner from the normal-user, admin, and owner welcome messages; each should open the same user’s support menu.
3. Configure the forum and `users` topic. Start as a new user and verify there is one topic and its first message is the Rich `#newmsg` intro, with username blank when absent and a red Ban button.
4. Change a user’s display name or username, invoke `/awwsheesh` or Contact Owner again, and verify the same topic is renamed with no second intro message.
5. Press Start / Resume repeatedly and verify only one per-user topic exists. Send text, formatted text, a photo with caption, a document, a video, and a voice message while active; confirm each is copied and only one rich confirmation remains.
6. Press Pause and verify user messages stop forwarding. Resume and confirm the same topic/history is reused.
7. As the owner, press Ban in the user’s topic. Verify the user gets a ban notice with a rich Request unban button, owner replies are not delivered, and later user messages are not forwarded.
8. Press Request unban, submit an explanation, and verify only that response is sent as `#unbanreq` in `SUPPORT_USERS_TOPIC_ID`, with a green Unban button. Try a second request inside 24 hours and verify it is refused.
9. Press Unban from the user topic and from a request message. Verify access is restored, the topic card changes back to red Ban, and the user must Start / Resume to reopen the conversation.
10. Verify callbacks from non-owner IDs, another user’s topic, and non-private user controls cannot start, pause, ban, or unban conversations.
11. Open `/map`, navigate home → locations → map actions, and verify every map button is a Telegram Rich Message button while map photos remain visible. Exercise Shinobi Store and ability screens as well.
12. After migration, verify rows persist across handler invocations and unrelated commands, games, and welcome callbacks still work.
