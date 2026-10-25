import { OWNER_ID } from './config.js';

export const ADMIN_IDS = [OWNER_ID];
// Set these to the numeric support supergroup ID and its dedicated "users" topic ID.
// Leave at 0 until configured; notifications and inbox setup fail closed.
export const SUPPORT_GROUP_ID = -1003990910649;
export const SUPPORT_USERS_TOPIC_ID = 3;
// The storage channel lives in map/constants.js (MAP_IMAGE_CHAT_ID); the study
// bot's quiz/suggest/edit-session constants were removed in the round-18 audit
// after a repo-wide reference check found no readers.
