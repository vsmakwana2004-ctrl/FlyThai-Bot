const { submitBooking } = require('./bookingApi');
const { resolveQuotation, fetchRawRecord } = require('./convertBooking');

const CODE_RE = /\bFTQ?\d+\b/i;

// Maps the words a user would naturally say to the exact field GetBookingById/AddBooking use, plus
// a human label for confirmation/reply text. Deliberately small and explicit rather than a fuzzy
// match - a wrong field guess would silently edit the wrong thing on a real record.
const FIELD_ALIASES = [
  { pattern: /\bcompany\s*name|guest\s*company|agent\s*name\b/i, key: 'guestCompany', label: 'Company name' },
  { pattern: /\bphone\s*(number)?\b/i, key: 'guestPhoneNumber', label: 'Phone number' },
  { pattern: /\bemail\b/i, key: 'guestEmail', label: 'Email' },
  { pattern: /\bguest\s*name\b/i, key: 'guestName', label: 'Guest name' },
  { pattern: /\baddress\b/i, key: 'guestAddress', label: 'Address' },
];

// Detects "update/set/change the company name of FTQ... to X", "set FT...'s email to y@z.com" -
// requires an explicit "to <value>" so the new value is never ambiguous. Falls back to the
// session's last-mentioned code (same convention as the other edit-adjacent flows in this file).
function detectSimpleFieldEditIntent(text, lastBookingCode) {
  if (!/\b(update|set|change)\b/i.test(text)) return null;
  const toMatch = text.match(/\bto\s+(.+)$/i);
  if (!toMatch) return null;
  const value = toMatch[1].trim().replace(/^["']|["']$/g, '');
  if (!value) return null;

  const field = FIELD_ALIASES.find((f) => f.pattern.test(text));
  if (!field) return null;

  const codeMatch = text.match(CODE_RE);
  const code = codeMatch ? codeMatch[0].toUpperCase() : lastBookingCode;
  if (!code) return null;

  return { code, field: field.key, label: field.label, value };
}

// Verb list was just "add" - missed "edit itinerary of FTQ..."/"update the itinerary for FT..."
// even though that's exactly what this flow does (the only way to "edit" an itinerary here is by
// adding new items - there's no remove/modify-existing yet). Noun list now also covers sightseeing/
// leisure (added as itinerary item types later, but never added here) and common misspellings of
// "itinerary" - "itineary" is literally how the real DB/API spell it (BookingItineary,
// itinearyDetails), and "itenary"/"itinery" are common everyday typos.
const ITINERARY_EDIT_RE = /\b(add|append|edit|update|modify|change)\b[\s\S]*\b(itinerary|itineary|itenary|itinery|transfer|sight ?seeing|restaurant|leisure)\b/i;

// Detects "add itinerary to FTQ...", "edit the itinerary for FT...", "add a transfer to FT...".
// Deliberately distinct from bookingFlow.js's own create-intent detection - EXISTING_CODE_RE there
// already means "a message naming a real code is about THAT record, never a new one", so this only
// ever fires alongside a real, resolvable code.
function detectItineraryEditIntent(text, lastBookingCode) {
  // "update/change the ITINERARY STATUS of FT..." is a completely different, already-working
  // feature (statusUpdate.js) - broadening the verb list above to include update/change/edit made
  // it collide with that phrasing (itinerary is one of the 5 real status types), so bail out
  // whenever "status" appears anywhere in the message rather than trying to out-guess word order.
  if (/\bstatus\b/i.test(text)) return null;
  if (!ITINERARY_EDIT_RE.test(text)) return null;
  const codeMatch = text.match(CODE_RE);
  const code = codeMatch ? codeMatch[0].toUpperCase() : lastBookingCode;
  if (!code) return null;
  return { code };
}

// Shared first step for both edit paths: resolve the code to a real record and pull its current
// live state (same GetBookingById-based read convertBooking.js's conversion check already uses).
async function resolveForEdit(code) {
  const booking = await resolveQuotation(code);
  if (!booking) return { status: 'not_found', code };
  const raw = await fetchRawRecord(booking.Id);
  return { status: 'ok', code: booking.BookingId || booking.QuotationId, guestName: booking.GuestName, raw };
}

async function applySimpleFieldEdit(raw, fieldKey, value) {
  const patched = { ...raw, [fieldKey]: value };
  const trySave = (allowSalesEntry) => submitBooking(patched, !!patched.isBooking, { allowSalesEntry });
  try {
    await trySave(true);
  } catch (err) {
    if (err.code !== 'AGENT_ACCOUNT_NOT_FOUND') throw err;
    await trySave(false);
  }
}

module.exports = { detectSimpleFieldEditIntent, detectItineraryEditIntent, resolveForEdit, applySimpleFieldEdit };
