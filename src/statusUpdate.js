const { getPool } = require('./db');
const { updateBookingStatus } = require('./bookingApi');
const { callLLM } = require('./llm');

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
function detectStatusUpdateIntent(text, fallbackCode) {
  const hasChangeVerb = CHANGE_VERB_RE.test(text);
  const hasStatusWord = STATUS_WORD_RE.test(text);
  const hasValueWord = VALUE_WORD_RE.test(text);

  const explicitSignal = hasChangeVerb && (hasStatusWord || hasValueWord);
  // Fuzzy follow-up: no clean change-verb match (covers typos like "chnge", or phrasing like
  // "done kar do") - only trust this when we already know which booking is being discussed, the
  // message is short (a real instruction, not a long unrelated sentence), and it isn't a question.
  const wordCount = text.trim().split(/\s+/).length;
  const fuzzyFollowUp = !explicitSignal && hasValueWord && !!fallbackCode && wordCount <= 8 && !looksLikeQuestion(text);

  if (!explicitSignal && !fuzzyFollowUp) return null;

  const fullMatch = text.match(CODE_RE);
  if (fullMatch) return { code: fullMatch[0].toUpperCase(), exact: true };
  const bareMatch = text.match(BARE_NUMBER_RE);
  if (bareMatch) return { code: bareMatch[0], exact: false };
  if (fallbackCode) return { code: fallbackCode, exact: true };
  return null;
}

async function resolveBooking(intent) {
  const pool = await getPool();
  if (intent.exact) {
    const r = await pool.request().input('code', intent.code).query(`
      SELECT TOP 1 Id, BookingId, QuotationId, GuestName, IsBooking FROM BookingMaster
      WHERE IsDelete = 0 AND (BookingId = @code OR QuotationId = @code)
    `);
    return r.recordset[0] || null;
  }
  const r = await pool.request().input('digits', `%${intent.code}%`).query(`
    SELECT TOP 5 Id, BookingId, QuotationId, GuestName, IsBooking FROM BookingMaster
    WHERE IsDelete = 0 AND (BookingId LIKE @digits OR QuotationId LIKE @digits)
  `);
  if (r.recordset.length !== 1) return null; // not found or ambiguous - fail closed, ask for the full code
  return r.recordset[0];
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

// Entry point - called once when detectStatusUpdateIntent first matches a fresh message.
async function start(intent, userMessage) {
  const booking = await resolveBooking(intent);
  if (!booking) {
    return { reply: `I couldn't uniquely find that booking. Please give the full booking code (e.g. FT07261782).`, pending: null };
  }
  const code = booking.BookingId || booking.QuotationId;

  if (!booking.IsBooking) {
    return { reply: `**${code}** is a quotation, not a confirmed booking — status changes don't apply to quotations.`, pending: null };
  }

  const { statusType, value } = await extractStatusChange(userMessage);
  const pending = { internalId: booking.Id, code, statusType: null, value: null, awaitingConfirm: false };
  return mergeAndAdvance(pending, statusType, value);
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

  const { statusType, value } = await extractStatusChange(userMessage);
  return mergeAndAdvance(pending, statusType, value);
}

module.exports = { detectStatusUpdateIntent, start, step };
