// Typed, safe errors. Messages here are the only text allowed to reach a
// client; internal errors are logged and replaced with a generic sentence.

export const ACCESS_ERROR_CODES = Object.freeze({
  NOT_OWNER: 'NOT_OWNER',
  INVALID_ID: 'INVALID_ID',
  OWNER_PROTECTED: 'OWNER_PROTECTED',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  MALFORMED_ACCESS: 'MALFORMED_ACCESS',
});

export class AccessError extends Error {
  /**
   * @param {keyof typeof ACCESS_ERROR_CODES} code
   * @param {string} message safe, human-readable
   */
  constructor(code, message) {
    super(message);
    this.name = 'AccessError';
    this.code = code;
  }
}

export const INIT_DATA_ERROR_CODES = Object.freeze({
  MISSING: 'MISSING',
  MALFORMED: 'MALFORMED',
  EXPIRED: 'EXPIRED',
});

export class InitDataError extends Error {
  /**
   * @param {keyof typeof INIT_DATA_ERROR_CODES} code
   * @param {string} message safe, human-readable
   */
  constructor(code, message) {
    super(message);
    this.name = 'InitDataError';
    this.code = code;
  }
}

export class MiniAppUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MiniAppUrlError';
    this.code = 'INVALID_MINI_APP_URL';
  }
}
