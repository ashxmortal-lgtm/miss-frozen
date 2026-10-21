import { EndpointError } from 'sdk';
import { AccessError, ACCESS_ERROR_CODES, InitDataError } from './errors.js';

/**
 * Convert internal typed errors to the platform's EndpointError, which is the
 * only supported way for an endpoint to refuse a call with a safe description.
 * Anything unexpected becomes a generic message: stack traces, SQL and IDs
 * never reach the Mini App.
 */
export function toEndpointError(error) {
  if (error instanceof EndpointError) return error;

  if (error instanceof InitDataError) {
    return new EndpointError(error.message, { code: error.code });
  }

  if (error instanceof AccessError) {
    if (error.code === ACCESS_ERROR_CODES.STORAGE_UNAVAILABLE) {
      return new EndpointError(
        'My little notebook is unavailable right now. Please try again in a moment. 🎀',
        { code: 'STORAGE_UNAVAILABLE' },
      );
    }
    return new EndpointError('You are not allowed to open this app.', { code: 'FORBIDDEN' });
  }

  console.error('[endpoint] unexpected failure', error);
  return new EndpointError('Something went wrong on my side. Please try again. 🎀', {
    code: 'INTERNAL',
  });
}
