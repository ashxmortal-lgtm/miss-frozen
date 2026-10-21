import { AccessError } from '../lib/errors.js';
import { access } from '../lib/access_production.js';
import { accessStatusFor } from '../lib/api_service.js';
import { toEndpointError } from '../lib/endpoint_errors.js';

/**
 * POST /api/getAccessStatus
 * Called when the Mini App opens. The platform verifies initData before this
 * runs; we independently enforce freshness and the durable allowlist.
 */
export default async function (_input, ctx) {
  try {
    return await accessStatusFor(ctx, access);
  } catch (error) {
    if (error instanceof AccessError) console.error('[endpoint] access denied');
    throw toEndpointError(error);
  }
}
