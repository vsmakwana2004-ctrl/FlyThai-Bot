const { AsyncLocalStorage } = require('async_hooks');

// Carries the current chat session's own FlyThai login cookie through the whole call chain
// (chat.js -> bookingFlow.js/editBooking.js/statusUpdate.js/etc -> bookingApi.js/convertBooking.js/
// jobSheetCopy.js) without threading a `cookie` parameter through every function signature in
// between - those three modules' buildHeaders() read from here first via getFlythaiCookie().
const storage = new AsyncLocalStorage();

function runWithFlythaiCookie(cookie, fn) {
  return storage.run({ flythaiCookie: cookie }, fn);
}

function getFlythaiCookie() {
  const store = storage.getStore();
  return (store && store.flythaiCookie) || null;
}

module.exports = { runWithFlythaiCookie, getFlythaiCookie };
