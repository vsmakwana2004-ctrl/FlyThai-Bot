const { resolveBookingByCode, resolveBookingByGuestName } = require('./documents');
const { fetchRawRecord } = require('./convertBooking');
const { submitBooking, findBookingById } = require('./bookingApi');

const CODE_RE = /\bFTQ?\d+\b/i;
const DUPLICATE_RE = /\bduplicate\b/i;

// Detects "duplicate FT08261797", "duplicate this booking" (falls back to the session's
// last-mentioned code, same convention as convert/fieldEdit/itineraryEdit), or "duplicate the
// booking for <guest>".
function detectDuplicateIntent(text, lastBookingCode) {
  if (!DUPLICATE_RE.test(text)) return null;
  const codeMatch = text.match(CODE_RE);
  if (codeMatch) return { code: codeMatch[0].toUpperCase() };
  const guestMatch = text.match(/\bfor\s+(?:guest\s+)?([a-zA-Z][a-zA-Z\s'.-]{1,40})/i);
  if (guestMatch) return { guestName: guestMatch[1].trim() };
  if (lastBookingCode) return { code: lastBookingCode };
  return null;
}

// Returns { status: 'not_found' } | { status: 'ambiguous', matches } | { status: 'ok', booking }.
// Same ambiguity handling as convertBooking.js/editBooking.js - QuotationId isn't guaranteed unique.
async function resolveForDuplicate(intent) {
  const matches = intent.guestName ? await resolveBookingByGuestName(intent.guestName) : await resolveBookingByCode(intent.code);
  if (matches.length === 0) return { status: 'not_found' };
  if (matches.length > 1) return { status: 'ambiguous', matches };
  return { status: 'ok', booking: matches[0] };
}

// GetBookingById returns travelDate/returnDate as ISO ("2026-12-25") - an AddBooking-bound
// submission needs dd-MM-yyyy instead, same fix convertBooking.js's isoToDDMMYYYY already applies
// (and for the same reason: booking-mode saves do date-dependent processing that silently rejects
// the ISO form, proven live there).
function isoToDDMMYYYY(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
}

// GetBookingById returns itinearyDetails as a day-keyed dict (e.g. {"1": [...]}) but itinearies
// (the flat list) as null - bookingFlow.js's own buildModel() documents why AddBooking needs BOTH:
// submitting itinearyDetails alone silently saves NO itinerary rows at all on an insert (proven
// there for the create path). A duplicate is an insert too (a new BookingMaster row, not an update
// of the original), so it hits the exact same gap - reproduced live here: the first test duplicate
// (FT08261798) came back with a real new booking id but zero itinerary rows. Flattening
// itinearyDetails into itinearies (mirroring managebookings.js's own convertItineraryData()) is the
// same fix already applied there.
function flattenItinerary(itinearyDetails) {
  if (!itinearyDetails || typeof itinearyDetails !== 'object') return null;
  const itinearies = Object.entries(itinearyDetails).flatMap(([day, items]) => (items || []).map((item) => ({ ...item, day })));
  return itinearies.length > 0 ? itinearies : null;
}

// Mirrors the real site's own "Duplicate Booking" action (managebookings.js): fetch the record's
// live representation (GetBookingById - the same read convert/field-edit/itinerary-edit already
// reuse), then resubmit it via the same /booking/AddBooking endpoint everything else here uses,
// with isDuplicateCheck:true. Confirmed from managebookings.js that this flag is the ONLY
// difference between an edit-save and a duplicate-save request - the record's own id is resent
// unchanged either way - so the server, not a zeroed id, is what decides "insert a new row" here.
async function performDuplicate(internalId, { allowSalesEntry = true } = {}) {
  const raw = await fetchRawRecord(internalId);
  const patched = {
    ...raw,
    travelDate: isoToDDMMYYYY(raw.travelDate),
    returnDate: isoToDDMMYYYY(raw.returnDate),
    itinearies: flattenItinerary(raw.itinearyDetails),
  };
  const newId = await submitBooking(patched, !!raw.isBooking, { allowSalesEntry, isDuplicateCheck: true });
  return findBookingById(newId);
}

module.exports = { detectDuplicateIntent, resolveForDuplicate, performDuplicate };
