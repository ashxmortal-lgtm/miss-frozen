/* MissFrozen Gaming Mini App contract. No secrets. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FBContract = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Actions implemented by tgcloud/endpoints/miniapp.js (gaming only).
  const ACTIONS = ['bootstrap', 'claim', 'purchase'];

  // Whitelisted /start payloads handled in tgcloud/handlers/message.js.
  const BOT_STARTS = {
    mini_map: '/map',
    mini_owner: '/owner',
  };

  const BOT_USERNAME = 'missfrozen_bot';

  function unwrapPayload(result) {
    if (
      result &&
      typeof result === 'object' &&
      result.ok === true &&
      Object.prototype.hasOwnProperty.call(result, 'result')
    ) {
      return result.result;
    }
    return result;
  }

  function isDashboard(data) {
    return !!(
      data &&
      typeof data === 'object' &&
      data.profile &&
      typeof data.profile === 'object' &&
      data.balance &&
      typeof data.balance === 'object' &&
      Array.isArray(data.inventory) &&
      Array.isArray(data.store)
    );
  }

  return { ACTIONS, BOT_STARTS, BOT_USERNAME, unwrapPayload, isDashboard };
});
