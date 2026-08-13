const { submitBooking, safeFetch } = require('./bookingApi');
const { resolveBookingByCode } = require('./documents');
const { getFlythaiCookie } = require('./requestContext');

const CODE_RE = /\bFTQ?\d+\b/i;
const CONVERT_RE = /\bconvert\b[\s\S]*\bbooking\b/i;

// Detects "convert FTQ05260001 to booking", "convert this quotation to a booking", etc. Falls back
// to the session's last-mentioned code (same convention as statusUpdate.js/accountTransactions.js)
// so "convert it to booking" works as a follow-up without repeating the code.
function detectConvertIntent(text, lastBookingCode) {
  if (!CONVERT_RE.test(text)) return null;
  const match = text.match(CODE_RE);
  const code = match ? match[0].toUpperCase() : lastBookingCode;
  if (!code) return null;
  return { code };
}

function buildHeaders() {
  const cookie = getFlythaiCookie() || process.env.FLYTHAI_SESSION_COOKIE;
  if (!cookie) {
    const err = new Error('Not logged in, and FLYTHAI_SESSION_COOKIE is not set in .env either.');
    err.code = 'NO_SESSION_COOKIE';
    throw err;
  }
  const base = process.env.FLYTHAI_BASE_URL || 'https://flythai.arkinfosoft.in';
  return { base, headers: { accept: 'application/json', cookie, 'x-requested-with': 'XMLHttpRequest' } };
}

// Returns { status: 'not_found' } | { status: 'ambiguous', code, matches } | { status: 'ok', booking }.
// QuotationId is NOT guaranteed unique (see documents.js's resolveBookingByCode, which this reuses,
// for the confirmed live example of 3 rows sharing one code) - a bare TOP 1 here previously picked
// an arbitrary one of them silently, risking converting/editing a completely different guest's
// record than the one asked about. Callers must handle 'ambiguous' themselves rather than ever
// picking one on the caller's behalf.
async function resolveQuotation(code) {
  const matches = await resolveBookingByCode(code);
  if (matches.length === 0) return { status: 'not_found', code };
  if (matches.length > 1) return { status: 'ambiguous', code, matches };
  return { status: 'ok', booking: matches[0] };
}

// Pulls the record in the EXACT shape the real "Convert to Booking" button itself submits back -
// confirmed by fetching /Booking/GetBookingById (the same endpoint the edit page's own JS calls to
// populate the form) and comparing its hotelDetails/itinearyDetails against what /booking/AddBooking
// expects (managebookings.js's buildBookingPayload). Using the site's own live representation
// avoids reconstructing those arrays field-by-field ourselves, which would risk silently
// submitting incomplete hotel/itinerary data on a real record - the exact field mapping for a
// transfer/restaurant itinerary item (pickup point, vehicle, etc.) doesn't map 1:1 onto the
// columns documented in schema.js, so guessing it independently was not safe enough to trust.
async function fetchRawRecord(internalId) {
  const { base, headers } = buildHeaders();
  const res = await safeFetch(`${base}/Booking/GetBookingById?id=${internalId}`, { headers });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`GetBookingById returned ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (res.url && /\/Login/i.test(res.url)) {
    const err = new Error('The session cookie appears to be expired (redirected to login). Please re-capture FLYTHAI_SESSION_COOKIE.');
    err.code = 'SESSION_EXPIRED';
    throw err;
  }
  return JSON.parse(text);
}

// Mirrors managebookings.js's validateBooking() rule-for-rule, including its exact wording, so the
// chatbot's error list matches what staff already see on the real "Convert to Booking" screen.
function validateForConversion(raw) {
  const errors = [];

  if (!raw.destinations || String(raw.destinations).trim() === '') errors.push('Please select at least one destination.');
  if (!raw.guestName || String(raw.guestName).trim() === '') errors.push('Guest name is required.');
  if (!raw.guestCompany || String(raw.guestCompany).trim() === '') errors.push('Company name is required.');
  if (!raw.guestPhoneNumber || String(raw.guestPhoneNumber).trim() === '') errors.push('Phone number is required.');

  if (!raw.guestEmail || String(raw.guestEmail).trim() === '') {
    errors.push('Email is required.');
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.guestEmail)) {
    errors.push('Please enter a valid email address.');
  }

  let travelDate = null;
  let returnDate = null;
  if (!raw.travelDate) {
    errors.push('Travel date is required.');
  } else {
    travelDate = new Date(raw.travelDate);
    if (Number.isNaN(travelDate.getTime())) errors.push('Travel date must be in dd-MM-yyyy format.');
  }
  if (!raw.returnDate) {
    errors.push('Return date is required.');
  } else {
    returnDate = new Date(raw.returnDate);
    if (Number.isNaN(returnDate.getTime())) errors.push('Return date must be in dd-MM-yyyy format.');
  }
  if (travelDate && returnDate && !Number.isNaN(travelDate.getTime()) && !Number.isNaN(returnDate.getTime())) {
    if (returnDate <= travelDate) errors.push('Return date must be later than travel date.');
  }

  const hasHotels = Array.isArray(raw.hotelDetails) && raw.hotelDetails.length > 0;
  if (!hasHotels && !raw.selfBookedHotel) errors.push('At least one hotel must be added.');

  const hasItinerary = raw.itinearyDetails && typeof raw.itinearyDetails === 'object' && Object.keys(raw.itinearyDetails).length > 0;
  if (!hasItinerary && !raw.selfBookedItineary) errors.push('At least one itinerary must be added.');

  return errors;
}

// Checks whether a quotation is ready to convert, without writing anything - safe to call any
// number of times. Returns the raw record too, so a caller that gets 'ok' doesn't need to
// re-fetch it before actually converting.
// Runs the actual "is this ready to convert?" checks once a single, unambiguous row has already
// been resolved - shared by checkConversion() below and by chat.js's post-disambiguation
// continuation (once the user has picked which of several same-coded records they meant).
async function checkConversionForBooking(booking) {
  if (booking.IsBooking) return { status: 'already_booking', code: booking.BookingId, guestName: booking.GuestName };

  const raw = await fetchRawRecord(booking.Id);
  const errors = validateForConversion(raw);
  if (errors.length > 0) {
    return { status: 'invalid', code: booking.QuotationId, guestName: booking.GuestName, errors };
  }
  return { status: 'ok', code: booking.QuotationId, guestName: booking.GuestName, internalId: booking.Id, raw };
}

async function checkConversion(code) {
  const resolved = await resolveQuotation(code);
  if (resolved.status !== 'ok') return resolved;
  return checkConversionForBooking(resolved.booking);
}

// GetBookingById returns travelDate/returnDate as ISO ("2026-12-25"). Quotation-mode saves (the
// simple field/itinerary edits above) tolerate that fine, but converting to a BOOKING silently
// fails on it - proven live: the exact same payload returns a real new id with dates reformatted
// to DD-MM-YYYY, and "0" (a bare rejection, no error text) with them left as ISO. Booking-mode
// evidently does date-dependent processing (financial year / invoice due date, most likely) that
// needs the same dd-MM-yyyy string format the real form's own date field would submit - matching
// what's already correctly used inside hotelDetails[].checkInDate/checkOutDate in this same payload.
function isoToDDMMYYYY(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
}

// Actually performs the conversion - only call this after the user has explicitly confirmed.
// Resubmits the record fetched by checkConversion via the real site's own /booking/AddBooking
// endpoint (the same one bookingFlow.js already uses for new bookings) with type=true - what the
// real "Convert to Booking" button itself does under the hood, with the one date-format fix above.
async function performConversion(raw, { allowSalesEntry = true } = {}) {
  const patched = { ...raw, travelDate: isoToDDMMYYYY(raw.travelDate), returnDate: isoToDDMMYYYY(raw.returnDate) };
  return submitBooking(patched, true, { allowSalesEntry });
}

module.exports = { detectConvertIntent, checkConversion, checkConversionForBooking, performConversion, validateForConversion, fetchRawRecord, resolveQuotation };
