const { submitBooking } = require('./bookingApi');

// Field-by-field editing for Basic Details, Hotel Details, Price Details, General Remarks, and
// Extra Note & Emergency Contact all lives in chat.js (openEditSection/openHotelFieldChoice/
// openFieldSection and their pendingXxx handlers) - each field asks for one value at a time, with
// the same real dropdown/calendar/Yes-No UI bookingFlow.js's own hotelCollect step uses when adding
// a brand-new hotel, rather than one combined form parsed after the fact. This file just holds the
// one thing every one of those field edits ends with in common: writing the change back.

// GetBookingById returns travelDate/returnDate as ISO ("2026-12-25"). Quotation-mode saves tolerate
// that fine, but resubmitting a real BOOKING with them left as ISO silently fails - the real site's
// own AddBooking endpoint returns "0" (a bare rejection, no error text) rather than a new id. Same
// fix, same reason, as convertBooking.js's performConversion needed for the "Convert to Booking"
// action - confirmed live (raw.isBooking true, raw.travelDate still "2026-08-18") that a real
// booking's own raw record comes back with these still unconverted.
function isoToDDMMYYYY(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
}

// Resubmits the record's own live representation (raw, from GetBookingById - same read every edit
// path in this codebase reuses) with `patch` spread over it, via the same /booking/AddBooking
// endpoint used everywhere else. No isDuplicateCheck - raw.id stays the record's own id, so this is
// an in-place UPDATE (same mechanism editBooking.js's applySimpleFieldEdit and convertBooking.js's
// performConversion already use), not a new row.
async function saveRawPatch(raw, patch, { allowSalesEntry = true } = {}) {
  const dateFix = raw.isBooking ? { travelDate: isoToDDMMYYYY(raw.travelDate), returnDate: isoToDDMMYYYY(raw.returnDate) } : {};
  const patched = { ...raw, ...dateFix, ...patch };
  return submitBooking(patched, !!raw.isBooking, { allowSalesEntry });
}

module.exports = { saveRawPatch };
