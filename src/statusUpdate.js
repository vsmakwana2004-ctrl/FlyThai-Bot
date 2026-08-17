const { getPool } = require('./db');
const { updateBookingStatus } = require('./bookingApi');
const { callLLM } = require('./llm');
const { resolveBookingByCode, resolveBookingByGuestName, extractGuestName } = require('./documents');

const CODE_RE = /\bFTQ?\d+\b/i;
const BARE_NUMBER_RE = /\b\d{4,}\b/;
// Needs a change-verb, AND either the word "status" or one of the real status values, so plain
// read questions ("what is the payment status of FT...") never get routed into the write flow,
// while short pronoun follow-ups ("change that to done") still get caught.
const CHANGE_VERB_RE = /\b(change|update|set|mark|make)\b/i;
const STATUS_WORD_RE = /\bstatus\b/i;
const VALUE_WORD_RE = /\b(done|sent|pending|cancelled|canceled|closed|created|self\s*booked|partial[- ]?paid|on[- ]?tour|up[- ]?coming|upcoming)\b/i;
// A message that's clearly asking something, not telling us to do something - never treat these
// as an action even if they happen to contain a status value word (e.g. "is payment pending?").
const QUESTION_LEAD_RE = /^\s*(what|is|are|show|list|tell|give|kya|status)\b/i;
function looksLikeQuestion(text) {
  return /\?\s*$/.test(text.trim()) || QUESTION_LEAD_RE.test(text.trim());
}

// Same "for X"/"of X" convention as documents.js's extractGuestName, but status-change phrasing
// commonly has a trailing "to <value>"/"as <value>" clause right after the name (mirroring this
// module's own confirmation wording, "...status to sent") that extractGuestName's generic
// trailing-word trim doesn't know about - strip it here so "status for vandit to sent" resolves the
// name "vandit", not "vandit to sent" (which would never match anything in the database).
function extractGuestNameForStatus(text) {
  const raw = extractGuestName(text);
  if (!raw) return null;
  const name = raw.replace(/\s+\b(to|as)\b.*$/i, '').trim();
  return name || null;
}

// Exact allowed values per status type, scraped from the real site's own dropdown HTML
// (BookingList.js) - never accept free-text here, only these.
const STATUS_TYPES = {
  Travel: ['up-coming', 'on-tour', 'booking-cancelled', 'closed'],
  Invoice: ['pending', 'created', 'sent'],
  Voucher: ['pending', 'created', 'sent', 'selfBooked'],
  Itinerary: ['pending', 'created', 'sent'],
  Payment: ['pending', 'done', 'partial-paid'],
};

// fallbackCode: the last booking/quotation code mentioned in this chat session, used when the
// current message refers to it by pronoun ("change that to done") instead of repeating the code.
// allowFuzzy: false when checked purely to decide whether to INTERRUPT another already-active flow
// (see chat.js's detectAnyFreshIntent) - a bare completion word like "done"/"skip"/"pending" is
// exactly as likely to mean "finish the step I'm already answering" as a status change, so only an
// EXPLICIT change instruction (a real change-verb) is trusted to interrupt something else already
// running. Real dispatch-time calls (nothing else active) keep the default fuzzy matching.
function detectStatusUpdateIntent(text, fallbackCode, { allowFuzzy = true } = {}) {
  const hasChangeVerb = CHANGE_VERB_RE.test(text);
  const hasStatusWord = STATUS_WORD_RE.test(text);
  const hasValueWord = VALUE_WORD_RE.test(text);

  const explicitSignal = hasChangeVerb && (hasStatusWord || hasValueWord);
  // Fuzzy follow-up: no clean change-verb match (covers typos like "chnge", or phrasing like
  // "done kar do") - only trust this when we already know which booking is being discussed, the
  // message is short (a real instruction, not a long unrelated sentence), and it isn't a question.
  const wordCount = text.trim().split(/\s+/).length;
  const fuzzyFollowUp = allowFuzzy && !explicitSignal && hasValueWord && !!fallbackCode && wordCount <= 8 && !looksLikeQuestion(text);

  if (!explicitSignal && !fuzzyFollowUp) return null;

  const fullMatch = text.match(CODE_RE);
  if (fullMatch) return { code: fullMatch[0].toUpperCase(), exact: true };
  const bareMatch = text.match(BARE_NUMBER_RE);
  if (bareMatch) return { code: bareMatch[0], exact: false };
  // No code in this message - try a guest name ("set invoice status for vandit to sent") before
  // falling back to whatever booking was last discussed, since an explicit name here is a more
  // specific signal than reusing older context.
  const guestName = extractGuestNameForStatus(text);
  if (guestName) return { guestName };
  if (fallbackCode) return { code: fallbackCode, exact: true };
  return null;
}

// Returns { status: 'not_found' } | { status: 'ambiguous', matches } | { status: 'ok', booking }.
async function resolveBooking(intent) {
  if (intent.guestName) {
    // Same "ask, don't pick" standard as the same-code case below - a shared name can genuinely be
    // two different real guests (see documents.js's resolveBookingByGuestName).
    const matches = await resolveBookingByGuestName(intent.guestName);
    if (matches.length === 0) return { status: 'not_found' };
    if (matches.length > 1) return { status: 'ambiguous', matches };
    return { status: 'ok', booking: matches[0] };
  }
  if (intent.exact) {
    // QuotationId is NOT guaranteed unique (see documents.js's resolveBookingByCode, which this
    // reuses, for the confirmed live example of 3 rows sharing one code) - a bare TOP 1 here
    // previously picked an arbitrary one of them silently, risking changing a completely different
    // booking's status than the one asked about. Callers must handle 'ambiguous' themselves.
    const matches = await resolveBookingByCode(intent.code);
    if (matches.length === 0) return { status: 'not_found' };
    if (matches.length > 1) return { status: 'ambiguous', matches };
    return { status: 'ok', booking: matches[0] };
  }
  const pool = await getPool();
  const r = await pool.request().input('digits', `%${intent.code}%`).query(`
    SELECT TOP 5 Id, BookingId, QuotationId, GuestName, IsBooking FROM BookingMaster
    WHERE IsDelete = 0 AND (BookingId LIKE @digits OR QuotationId LIKE @digits)
  `);
  if (r.recordset.length !== 1) return { status: 'not_found' }; // not found or ambiguous - fail closed, ask for the full code
  return { status: 'ok', booking: r.recordset[0] };
}

async function extractStatusChange(userMessage) {
  const prompt = `You extract a booking status-change request into strict JSON. Valid status types and their EXACT allowed values:
Travel: up-coming, on-tour, booking-cancelled, closed
Invoice: pending, created, sent
Voucher: pending, created, sent, selfBooked
Itinerary: pending, created, sent
Payment: pending, done, partial-paid

The user's message may be in Hindi/Hinglish/English. Figure out which status TYPE they mean and which VALUE, mapping natural phrasing to one of the EXACT values above (e.g. "payment done kar do" -> Payment/done, "voucher bhej diya" -> Voucher/sent, "trip cancel kar do" -> Travel/booking-cancelled). If either is not confidently determinable, use null for it.
Reply with ONLY this JSON, nothing else: {"statusType": "<Travel|Invoice|Voucher|Itinerary|Payment|null>", "value": "<exact value from the list above, or null>"}`;

  const reply = await callLLM([
    { role: 'system', content: prompt },
    { role: 'user', content: userMessage },
  ]);
  try {
    const start = reply.indexOf('{');
    const end = reply.lastIndexOf('}');
    const parsed = JSON.parse(reply.slice(start, end + 1));
    return { statusType: parsed.statusType || null, value: parsed.value || null };
  } catch {
    return { statusType: null, value: null };
  }
}

function askForType(pending) {
  return { reply: `Which status do you want to change for **${pending.code}** — Travel, Invoice, Voucher, Itinerary, or Payment?`, pending };
}

function askForValue(pending) {
  return {
    reply: `For **${pending.statusType}** status on **${pending.code}**, valid values are: ${STATUS_TYPES[pending.statusType].join(', ')}. Which one?`,
    pending,
  };
}

function askForConfirmation(pending) {
  pending.awaitingConfirm = true;
  return {
    reply: `Change **${pending.code}**'s **${pending.statusType}** status to **${pending.value}**? Reply "yes" to confirm or "no" to cancel.`,
    pending,
  };
}

function mergeAndAdvance(pending, statusType, value) {
  if (statusType && STATUS_TYPES[statusType]) pending.statusType = statusType;
  if (value && pending.statusType && STATUS_TYPES[pending.statusType].includes(value)) pending.value = value;

  if (!pending.statusType) return askForType(pending);
  if (!pending.value) return askForValue(pending);
  return askForConfirmation(pending);
}

// Runs the actual "start collecting statusType/value" step once a single, unambiguous row has
// already been resolved - shared by start() below and by chat.js's post-disambiguation
// continuation (once the user has picked which of several same-coded records they meant).
async function startWithBooking(booking, userMessage) {
  const code = booking.BookingId || booking.QuotationId;

  if (!booking.IsBooking) {
    return { reply: `**${code}** is a quotation, not a confirmed booking — status changes don't apply to quotations.`, pending: null };
  }

  const { statusType, value } = await extractStatusChange(userMessage);
  const pending = { internalId: booking.Id, code, statusType: null, value: null, awaitingConfirm: false };
  return mergeAndAdvance(pending, statusType, value);
}

// Entry point - called once when detectStatusUpdateIntent first matches a fresh message.
// Returns { reply, pending } normally, or { ambiguous: true, matches } when the code needs
// disambiguating first - chat.js must check for that before touching .reply/.pending.
async function start(intent, userMessage) {
  const resolved = await resolveBooking(intent);
  if (resolved.status === 'not_found') {
    const reply = intent.guestName
      ? `I couldn't find any booking or quotation for a guest named "${intent.guestName}". Please give the exact booking code instead (e.g. FT07261782).`
      : `I couldn't uniquely find that booking. Please give the full booking code (e.g. FT07261782).`;
    return { reply, pending: null };
  }
  if (resolved.status === 'ambiguous') {
    return { ambiguous: true, matches: resolved.matches };
  }
  return startWithBooking(resolved.booking, userMessage);
}

// Normalizes away spaces/hyphens/case so "self booked" / "self-booked" / "selfBooked" all match.
function normalizeValue(s) {
  return s.trim().toLowerCase().replace(/[\s-]+/g, '');
}

// Continues an in-progress status-change conversation (collecting missing fields, or confirming).
async function step(pending, userMessage) {
  if (pending.awaitingConfirm) {
    if (/^\s*(yes|y|confirm|ok|okay|go ahead|haan|kar do|karo)\b/i.test(userMessage)) {
      try {
        const ok = await updateBookingStatus(pending.internalId, pending.statusType, pending.value);
        if (!ok) return { reply: `The update didn't go through (FlyThai returned an error). Nothing was changed.`, pending: null };
        return { reply: `Done — **${pending.code}**'s ${pending.statusType} status is now **${pending.value}**.`, pending: null };
      } catch (err) {
        return { reply: `Couldn't update the status: ${err.message}`, pending: null };
      }
    }
    if (/^\s*(no|n|cancel|stop|nahi)\b/i.test(userMessage)) {
      return { reply: `Okay, cancelled — nothing was changed.`, pending: null };
    }
    return {
      reply: `Please reply "yes" to confirm changing **${pending.code}**'s ${pending.statusType} status to ${pending.value}, or "no" to cancel.`,
      pending,
    };
  }

  // Fast path: the user is answering a specific field we just asked about with a bare word
  // (e.g. "sent"). Match it directly against the allowed list instead of asking the LLM, which
  // has no idea which field is pending and can't disambiguate a value word shared by multiple
  // status types (e.g. "sent" is valid for Invoice, Voucher, and Itinerary alike).
  const normalized = normalizeValue(userMessage);
  if (pending.statusType && !pending.value) {
    const match = STATUS_TYPES[pending.statusType].find((v) => normalizeValue(v) === normalized);
    if (match) return mergeAndAdvance(pending, null, match);
  } else if (!pending.statusType) {
    const match = Object.keys(STATUS_TYPES).find((t) => normalizeValue(t) === normalized);
    if (match) return mergeAndAdvance(pending, match, null);
  }

  const { statusType, value } = await extractStatusChange(userMessage);
  return mergeAndAdvance(pending, statusType, value);
}

module.exports = { detectStatusUpdateIntent, start, startWithBooking, step };
