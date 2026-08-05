const { getPool } = require('./db');

const CODE_RE = /\bFTQ?\d+\b/i;

// Plain Levenshtein edit distance, used below so a typo'd trigger word ("downlode", "qutaion")
// still matches instead of silently falling through to a completely different (wrong) response
// path - reproduced live: "downlode qutaion of FTQ09260005" matched none of these words exactly,
// so the message fell through to an ordinary detail lookup instead of offering a PDF link, with no
// error or sign anything had gone wrong.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// True if any word in `text` is an exact or near-exact (typo-tolerant) match for one of `targets`.
// Tolerance scales with word length so short words ("pdf") still require an exact/near-exact hit
// rather than matching almost anything.
function fuzzyWordMatch(text, targets) {
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  for (const w of words) {
    for (const target of targets) {
      if (w === target) return true;
      const maxDist = target.length <= 4 ? 1 : 2;
      if (Math.abs(w.length - target.length) <= maxDist && levenshtein(w, target) <= maxDist) return true;
    }
  }
  return false;
}

// "Invoice" and "quotation" both mean the same underlying cost-report PDF (GetReportPdf) - a
// BookingMaster row is a Booking or a Quotation (IsBooking flag), and staff naturally call that
// report by whichever name matches the record type. Match both words as one "report" intent and
// let handleDocumentRequest pick the right label from the real record, not the user's wording.
const REPORT_WORDS = ['invoice', 'quotation', 'quote', 'bill'];
const ITINERARY_WORDS = ['itinerary', 'itineary'];
const HOTEL_VOUCHER_RE = /\bhotel\s*voucher\b/i;
// Deliberately narrow: only "download"/"pdf"/"generate" count as a real file request. Words like
// "share"/"send"/"get" are too ambiguous - "share the invoice details" means give the information
// as text, NOT hand over a raw PDF link. Only explicit file language should trigger the PDF path.
const DOWNLOAD_VERB_WORDS = ['download', 'pdf', 'generate'];
const REPORT_RE = { test: (text) => fuzzyWordMatch(text, REPORT_WORDS) };
const ITINERARY_RE = { test: (text) => fuzzyWordMatch(text, ITINERARY_WORDS) };
const DOWNLOAD_VERB_RE = { test: (text) => fuzzyWordMatch(text, DOWNLOAD_VERB_WORDS) };

// Verified against the real site's "Download PDF" popup (options query param on GetItineraryPdf):
// 1 = With FlyThai Logo (also the old default before this 3-way choice existed), 2 = With Agent
// Logo, 3 = No Logo. This choice only applies to the itinerary PDF - the invoice PDF has no such popup.
const LOGO_LABELS = { 1: 'With FlyThai Logo', 2: 'With Agent Logo', 3: 'No Logo' };

// Detects requests like "download invoice for FT08261781", "get itinerary pdf FTQ05260001", or
// "give me quotation of FTQ12260001 in pdf". Deliberately narrow/regex-based (not LLM) so we
// never construct a document link from a hallucinated booking id - a code must either be literally
// present in the user's message, or resolvable from fallbackCode (the last booking/quotation code
// mentioned in this chat session - same convention statusUpdate.js/accountTransactions.js use), so
// a follow-up like "give me invoice of this" right after discussing a booking still resolves
// instead of erroring out with no code to work with.
function detectDocumentIntent(text, fallbackCode) {
  const codeMatch = text.match(CODE_RE);
  const isHotelVoucher = HOTEL_VOUCHER_RE.test(text);
  const isItinerary = ITINERARY_RE.test(text);
  const isReport = REPORT_RE.test(text);

  // "download"/"pdf"/"generate" alone are always a strong enough signal, even for a vague/unknown
  // document type (handled below). "give"/"send" are too ambiguous on their own - "give me the
  // details" is a normal text lookup, not a file request - so those only count when paired with a
  // specific document word (invoice/itinerary/hotel voucher) that removes the ambiguity.
  const hasStrongVerb = DOWNLOAD_VERB_RE.test(text);
  const hasWeakVerb = (isHotelVoucher || isItinerary || isReport) && fuzzyWordMatch(text, ['give', 'send']);
  if (!hasStrongVerb && !hasWeakVerb) return null;

  // A real file request was made (strong or weak verb matched above) but there's no code to work
  // with - neither in this message nor from an earlier one in the session. Rather than let this
  // fall through to the LLM planner (which has no booking to build a query around and was seen
  // failing with a confusing raw DB error - "Multiple statements are not allowed" - instead of a
  // clear ask), hand back a distinct signal so chat.js can ask for the code directly.
  const code = codeMatch ? codeMatch[0].toUpperCase() : fallbackCode;
  if (!code) return { type: 'needsCode' };

  if (isHotelVoucher) return { type: 'hotelVoucher', code };
  if (isItinerary) return { type: 'itinerary', code };
  if (isReport) return { type: 'report', code };
  // An explicit file request ("... in pdf") was made but it's unclear which document is meant -
  // ask instead of silently falling back to a plain-text answer.
  return { type: 'unknown', code };
}

async function resolveBookingByCode(code) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('code', code)
    .query(`
      SELECT TOP 1 Id, BookingId, QuotationId, GuestName, IsBooking
      FROM BookingMaster
      WHERE IsDelete = 0 AND (BookingId = @code OR QuotationId = @code)
    `);
  return result.recordset[0] || null;
}

// The hotel voucher PDF is keyed by BookingHotel.Id, not BookingMaster.Id (a booking can have
// several hotel stays) - confirmed from the real site's own bookingHotelManagement.js, which calls
// GenerateHotelVourcherPdf with id = the hotel row's own Id, never the booking's.
async function resolveBookingHotels(internalBookingId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', internalBookingId)
    .query(`
      SELECT Id, Name AS HotelName, CheckInDate, CheckOutDate, ConfirmationId
      FROM BookingHotel
      WHERE BookingId = @id AND IsDelete = 0
      ORDER BY CheckInDate
    `);
  return result.recordset;
}

function buildInvoiceLink(internalId, allowWithCost = false) {
  const base = process.env.FLYTHAI_BASE_URL || 'https://flythai.arkinfosoft.in';
  return `${base}/booking/GetReportPdf?bookingId=${internalId}&allowWithCost=${allowWithCost}`;
}

function buildItineraryLink(internalId, options = 1) {
  const base = process.env.FLYTHAI_BASE_URL || 'https://flythai.arkinfosoft.in';
  return `${base}/booking/GetItineraryPdf?bookingId=${internalId}&options=${options}`;
}

// Matches the real "Hotel and OTA Details" page's own download button exactly (found in its
// bookingHotelManagement.js, not guessed): a plain GET, blob response, no other request chained in
// the success handler - same trust model as the invoice/itinerary links above (the download only
// happens in the STAFF MEMBER's OWN browser when they click it; we never call this ourselves).
// flag=true is that page's own hardcoded default (its "Hotel Details" mode, vs "OTA Details").
function buildHotelVoucherLink(bookingHotelId, options = 1) {
  const base = process.env.FLYTHAI_BASE_URL || 'https://flythai.arkinfosoft.in';
  return `${base}/booking/GenerateHotelVourcherPdf?id=${bookingHotelId}&flag=true&options=${options}`;
}

// Parses a reply to "which logo version?" into an options value (1/2/3), or null if unclear.
function parseLogoChoice(text) {
  const t = text.toLowerCase().trim();
  if (/\bagent\b/.test(t)) return 2;
  if (/\bno\s*logo\b|\bnone\b|\bwithout\s*(a\s*)?logo\b/.test(t)) return 3;
  if (/\bfly\s*thai\b/.test(t)) return 1;
  if (t === '1') return 1;
  if (t === '2') return 2;
  if (t === '3') return 3;
  return null;
}

// A Booking's report is called "Invoice"; a Quotation's is called "Quotation" - same endpoint,
// the label just follows the real record type (IsBooking), not whatever word the user happened
// to type ("invoice"/"quotation"/"bill" are all treated as the same request).
function reportLabel(isBooking) {
  return isBooking ? 'Invoice' : 'Quotation';
}

async function handleDocumentRequest(intent) {
  const booking = await resolveBookingByCode(intent.code);
  if (!booking) {
    return { reply: `I couldn't find any booking or quotation with code **${intent.code}** in the database.` };
  }
  const code = booking.BookingId || booking.QuotationId;

  if (intent.type === 'report') {
    const link = buildInvoiceLink(booking.Id, false);
    const label = reportLabel(booking.IsBooking);
    return { reply: `Here's the ${label.toLowerCase()} for **${code}** (${booking.GuestName}):\n\n[Download ${label} PDF](${link})\n\nIt'll open using your existing FlyThai login session in a new tab.` };
  }

  if (intent.type === 'unknown') {
    const label = reportLabel(booking.IsBooking);
    return {
      reply: `For **${code}** (${booking.GuestName}), which PDF would you like?\n\n- ${label}\n- Itinerary\n- Hotel Voucher\n\n(Reply with one of these.)`,
      pendingDocChoice: { code, internalId: booking.Id, guestName: booking.GuestName, isBooking: booking.IsBooking },
    };
  }

  if (intent.type === 'hotelVoucher') {
    const hotels = await resolveBookingHotels(booking.Id);
    if (hotels.length === 0) {
      return { reply: `**${code}** (${booking.GuestName}) doesn't have any hotel entries yet, so there's no voucher to generate.` };
    }
    if (hotels.length === 1) {
      return hotelVoucherLogoPrompt(code, booking.GuestName, hotels[0]);
    }
    // Same "which one?" pattern as bookingDetails.js's ambiguous-code case - never guess which
    // hotel stay was meant when a booking covers more than one.
    const list = hotels.map((h, i) => `${i + 1}. **${h.HotelName}** (${fmtDate(h.CheckInDate)} – ${fmtDate(h.CheckOutDate)}${h.ConfirmationId ? `, confirmation ${h.ConfirmationId}` : ''})`).join('\n');
    return {
      reply: `**${code}** (${booking.GuestName}) has ${hotels.length} hotel stays — which one's voucher would you like?\n\n${list}\n\n(Reply with the number or the hotel name.)`,
      pendingHotelChoice: { code, guestName: booking.GuestName, hotels },
    };
  }

  // itinerary - the real site always pops up a 3-way logo choice first, so mirror that here
  // instead of silently picking a default. The chosen value is applied once the user replies.
  return {
    reply: `Which version of the itinerary PDF for **${code}** (${booking.GuestName}) would you like?\n\n- With FlyThai Logo\n- With Agent Logo\n- No Logo\n\n(Reply with one of these, or just 1 / 2 / 3.)`,
    pendingItinerary: { kind: 'itinerary', code, internalId: booking.Id, guestName: booking.GuestName },
  };
}

function fmtDate(d) {
  if (!d) return '?';
  const dt = new Date(d);
  return `${String(dt.getUTCDate()).padStart(2, '0')}-${dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })}-${dt.getUTCFullYear()}`;
}

function hotelVoucherLogoPrompt(code, guestName, hotel) {
  return {
    reply: `Which version of the hotel voucher for **${hotel.HotelName}** on **${code}** (${guestName}) would you like?\n\n- With FlyThai Logo\n- With Agent Logo\n- No Logo\n\n(Reply with one of these, or just 1 / 2 / 3.)`,
    pendingItinerary: { kind: 'hotelVoucher', code, guestName, bookingHotelId: hotel.Id, hotelName: hotel.HotelName },
  };
}

// Continues a pending "which hotel's voucher?" question (only asked when a booking has more than
// one hotel stay) with the user's reply - by number ("2") or by matching the hotel's name.
function stepHotelChoice(pending, userMessage) {
  const t = userMessage.trim().toLowerCase();
  const byNumber = /^\d+$/.test(t) ? pending.hotels[Number(t) - 1] : null;
  const byName = pending.hotels.find((h) => h.HotelName.toLowerCase().includes(t) || t.includes(h.HotelName.toLowerCase()));
  const chosen = byNumber || byName;

  if (!chosen) {
    return {
      reply: `Sorry, I didn't catch which hotel you meant. Please reply with the number or the hotel's name.`,
      pendingHotelChoice: pending,
    };
  }
  const { reply, pendingItinerary } = hotelVoucherLogoPrompt(pending.code, pending.guestName, chosen);
  return { reply, pendingHotelChoice: null, pendingItinerary };
}

// Continues a pending "which PDF - report, itinerary, or hotel voucher?" question with the reply.
// async because the hotel-voucher branch needs a fresh DB lookup (this pending state was never
// given a bookingHotelId to work with, since hotel vouchers didn't exist when pendingDocChoice was
// first designed) - chat.js awaits this call.
async function stepDocChoice(pending, userMessage) {
  if (HOTEL_VOUCHER_RE.test(userMessage) || /\bhotel\b/i.test(userMessage)) {
    const booking = await resolveBookingByCode(pending.code);
    const hotels = await resolveBookingHotels(booking.Id);
    if (hotels.length === 0) {
      return { reply: `**${pending.code}** (${pending.guestName}) doesn't have any hotel entries yet, so there's no voucher to generate.`, pendingDocChoice: null };
    }
    if (hotels.length === 1) {
      return { ...hotelVoucherLogoPrompt(pending.code, pending.guestName, hotels[0]), pendingDocChoice: null };
    }
    const list = hotels.map((h, i) => `${i + 1}. **${h.HotelName}** (${fmtDate(h.CheckInDate)} – ${fmtDate(h.CheckOutDate)}${h.ConfirmationId ? `, confirmation ${h.ConfirmationId}` : ''})`).join('\n');
    return {
      reply: `**${pending.code}** (${pending.guestName}) has ${hotels.length} hotel stays — which one's voucher would you like?\n\n${list}\n\n(Reply with the number or the hotel name.)`,
      pendingDocChoice: null,
      pendingHotelChoice: { code: pending.code, guestName: pending.guestName, hotels },
    };
  }
  if (ITINERARY_RE.test(userMessage)) {
    return {
      reply: `Which version of the itinerary PDF for **${pending.code}** (${pending.guestName}) would you like?\n\n- With FlyThai Logo\n- With Agent Logo\n- No Logo\n\n(Reply with one of these, or just 1 / 2 / 3.)`,
      pendingDocChoice: null,
      pendingItinerary: { kind: 'itinerary', code: pending.code, internalId: pending.internalId, guestName: pending.guestName },
    };
  }
  if (REPORT_RE.test(userMessage)) {
    const link = buildInvoiceLink(pending.internalId, false);
    const label = reportLabel(pending.isBooking);
    return {
      reply: `Here's the ${label.toLowerCase()} for **${pending.code}** (${pending.guestName}):\n\n[Download ${label} PDF](${link})\n\nIt'll open using your existing FlyThai login session in a new tab.`,
      pendingDocChoice: null,
    };
  }
  const label = reportLabel(pending.isBooking);
  return {
    reply: `Sorry, I didn't catch that. Please reply **${label}**, **Itinerary**, or **Hotel Voucher**.`,
    pendingDocChoice: pending,
  };
}

// Continues a pending "which logo version?" question with the user's reply. Shared by the
// itinerary flow and the hotel-voucher flow - both PDFs offer the same 3-way logo choice on the
// real site, they just call a different endpoint (pending.kind picks which).
function stepLogoChoice(pending, userMessage) {
  const choice = parseLogoChoice(userMessage);
  if (!choice) {
    return {
      reply: `Sorry, I didn't catch that. Please choose one: **With FlyThai Logo**, **With Agent Logo**, or **No Logo** (or reply 1, 2, or 3).`,
      pending, // stay in the same pending state and ask again
    };
  }

  if (pending.kind === 'hotelVoucher') {
    const link = buildHotelVoucherLink(pending.bookingHotelId, choice);
    return {
      reply: `Here's the hotel voucher (${LOGO_LABELS[choice]}) for **${pending.hotelName}** on **${pending.code}** (${pending.guestName}):\n\n[Download Hotel Voucher PDF](${link})\n\nIt'll open using your existing FlyThai login session in a new tab.`,
      pending: null,
    };
  }

  const link = buildItineraryLink(pending.internalId, choice);
  return {
    reply: `Here's the itinerary (${LOGO_LABELS[choice]}) for **${pending.code}** (${pending.guestName}):\n\n[Download Itinerary PDF](${link})\n\nIt'll open using your existing FlyThai login session in a new tab.`,
    pending: null,
  };
}

module.exports = {
  detectDocumentIntent,
  handleDocumentRequest,
  stepLogoChoice,
  stepDocChoice,
  stepHotelChoice,
  parseLogoChoice,
  resolveBookingByCode,
  buildInvoiceLink,
  buildItineraryLink,
  buildHotelVoucherLink,
};
