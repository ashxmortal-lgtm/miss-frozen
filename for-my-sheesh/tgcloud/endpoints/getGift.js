import { AccessError } from '../lib/errors.js';
import { access } from '../lib/access_production.js';
import { giftFor } from '../lib/api_service.js';
import { toEndpointError } from '../lib/endpoint_errors.js';

/**
 * POST /api/getGift
 *
 * The direct Mini App route /gift and the "Open Your Gift" button both call
 * this endpoint, so a deep link can never bypass authorization. The letter is
 * returned only after the platform-verified user passes the durable allowlist.
 */
export default async function (_input, ctx) {
  try {
    return await giftFor(ctx, access);
  } catch (error) {
    if (error instanceof AccessError) console.error('[endpoint] gift denied');
    throw toEndpointError(error);
  }
}
