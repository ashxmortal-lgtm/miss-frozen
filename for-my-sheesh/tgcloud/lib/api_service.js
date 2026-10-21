import { AccessError, ACCESS_ERROR_CODES } from './errors.js';
import { validateInitData } from './initdata.js';
import { LETTER } from './content.js';

const FORBIDDEN_MESSAGE = 'You are not allowed to open this app.';

/**
 * Shared server-side guard for every private Mini App endpoint.
 *
 * 1. The platform has already verified the initData signature; validateInitData
 *    re-checks shape and freshness and extracts the verified numeric user ID.
 * 2. The durable allowlist is checked independently for this request.
 * 3. Only then is private content returned.
 *
 * No part of `input` — body, route, query or user fields — can supply identity.
 */
async function authorizedUser(ctx, accessService, options) {
  const identity = validateInitData(ctx?.initData, options);
  const auth = await accessService.authorize(identity.userId);
  if (!auth.allowed) {
    throw new AccessError(ACCESS_ERROR_CODES.NOT_OWNER, FORBIDDEN_MESSAGE);
  }
  return { identity, auth };
}

/** Minimal status payload; returns no private content. */
export async function accessStatusFor(ctx, accessService, options = {}) {
  const { auth } = await authorizedUser(ctx, accessService, options);
  return { allowed: true, role: auth.role, isOwner: auth.isOwner };
}

/**
 * The private gift payload. This is the only place the letter exists at
 * runtime; it is never bundled into public static assets.
 */
export async function giftFor(ctx, accessService, options = {}) {
  await authorizedUser(ctx, accessService, options);
  return {
    gift: {
      id: LETTER.id,
      title: LETTER.title,
      occasion: '7 months of us',
      paragraphs: [...LETTER.paragraphs],
      signature: LETTER.signature,
    },
  };
}

export { FORBIDDEN_MESSAGE };
