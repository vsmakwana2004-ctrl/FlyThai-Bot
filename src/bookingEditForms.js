const { submitBooking } = require('./bookingApi');

// Field-by-field editing for Basic Details, Hotel Details, Price Details, General Remarks, and
// Extra Note & Emergency Contact all lives in chat.js (openEditSection/openHotelFieldChoice/
// openFieldSection and their pendingXxx handlers) - each field asks for one value at a time, with
// the same real dropdown/calendar/Yes-No UI bookingFlow.js's own hotelCollect step uses when adding
// a brand-new hotel, rather than one combined form parsed after the fact. This file just holds the
// one thing every one of those field edits ends with in common: writing the change back.

// Resubmits the record's own live representation (raw, from GetBookingById - same read every edit
// path in this codebase reuses) with `patch` spread over it, via the same /booking/AddBooking
// endpoint used everywhere else. No isDuplicateCheck - raw.id stays the record's own id, so this is
// an in-place UPDATE (same mechanism editBooking.js's applySimpleFieldEdit and convertBooking.js's
// performConversion already use), not a new row.
async function saveRawPatch(raw, patch, { allowSalesEntry = true } = {}) {
  const patched = { ...raw, ...patch };
  return submitBooking(patched, !!raw.isBooking, { allowSalesEntry });
}

module.exports = { saveRawPatch };
