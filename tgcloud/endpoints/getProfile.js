import { EndpointError } from 'sdk';
import { profileData } from '../lib/profile.js';

export default async function (_input, ctx) {
  // Telegram Serverless verifies Mini App initData before invoking this endpoint.
  // Never accept a user ID from the browser request body.
  const user = ctx?.initData?.user;
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) {
    throw new EndpointError('Open this Mini App from Telegram to load your profile.');
  }

  // profileData applies the same calculations and database reads as /profile.
  // Uncaught DB failures are converted by the platform to a generic 500 response.
  return profileData(user);
}
