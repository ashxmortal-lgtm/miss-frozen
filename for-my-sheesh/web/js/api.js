// The Mini App talks to the bot only through TGCloud endpoints, using the
// official telegram-web-app.js bridge. The bridge attaches the raw initData;
// the platform verifies its signature before the endpoint runs. We never read
// the unsafe client-side snapshot, and we never send identity fields ourselves.

export class ClientError extends Error {
  constructor(message, code = 'CLIENT_ERROR') {
    super(message);
    this.name = 'ClientError';
    this.code = code;
  }
}

const NOT_IN_TELEGRAM =
  'Open this little gift from Telegram so I can check whose hands it is in. 🎀';
const BRIDGE_MISSING =
  'This Telegram version cannot open the gift. Please update Telegram and try again. 🎀';

/**
 * @param {'getAccessStatus'|'getGift'} endpoint
 * @param {object} input
 * @param {{webApp?: object}} [options] injectable for tests
 */
export function callEndpoint(endpoint, input = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const telegram = options.webApp ?? globalThis.Telegram?.WebApp;

    if (!telegram) {
      reject(new ClientError(NOT_IN_TELEGRAM, 'NOT_IN_TELEGRAM'));
      return;
    }

    const bridge = telegram.Serverless;
    if (!bridge || typeof bridge.call !== 'function') {
      reject(new ClientError(BRIDGE_MISSING, 'BRIDGE_MISSING'));
      return;
    }

    try {
      bridge.call(endpoint, input, (error, result) => {
        if (error) {
          reject(
            new ClientError(
              typeof error.message === 'string' && error.message
                ? error.message
                : 'The gift could not be opened. Please try again. 🎀',
              typeof error.type === 'string' ? error.type : 'ENDPOINT_ERROR',
            ),
          );
          return;
        }
        resolve(result);
      });
    } catch {
      reject(new ClientError('The gift could not be opened. Please try again. 🎀'));
    }
  });
}

export function fetchAccessStatus(options = {}) {
  return callEndpoint('getAccessStatus', {}, options);
}

export function fetchGift(options = {}) {
  return callEndpoint('getGift', {}, options);
}
