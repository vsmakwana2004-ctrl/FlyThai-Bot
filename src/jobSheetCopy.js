const { getPool } = require('./db');
const { safeFetch } = require('./bookingApi');
const { resolveBookingByCode } = require('./documents');
const { getFlythaiCookie } = require('./requestContext');
const { fuzzyWordMatch } = require('./fuzzyMatch');

const CODE_RE = /\bFTQ?\d+\b/i;

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

// "Copy For Customer" and "Copy Booking" are two real buttons on the live Job Sheet grid
// (managejobsheet.js's CopyBookingForCustomer()/CopyBooking()) - each fetches one job sheet's data
// from /Jobsheet/GetBookingById and drops it into a fixed plain-text template the agent then
// pastes straight into a message to the customer/vendor. copyType picks which template; scope
// picks WHICH job sheet(s) - by a specific FT/FTQ code (every job sheet on that booking) or by a
// date word (every job sheet whose itinerary item falls on that day) - "vendor copy" is accepted as
// a synonym for "booking copy" since that's what the booking-copy template is actually used for.
// Typo-tolerant word presence (see ./fuzzyMatch) rather than the exact adjacent-phrase match this
// used before - same word-presence-only trade-off documents.js's own fuzzy REPORT_RE/ITINERARY_RE/
// DOWNLOAD_VERB_RE already make (no known false-positive collisions for these particular words yet,
// so no exclude list needed). Lets a typo'd trigger ("cpoy for customer", "boking copy") still match
// instead of silently falling through to a completely different response.
function matchesCopyRequest(text, otherWords) {
  return fuzzyWordMatch(text, ['copy']) && fuzzyWordMatch(text, otherWords);
}
const DATE_LITERAL_RE = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/;

function addDaysISO(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Only the unambiguous English date words are auto-resolved here - "kal" (Hindi) means both
// "tomorrow" and "yesterday" depending on context, so guessing which one risks quietly generating
// the wrong day's customer copies; better to not match at all and let the caller ask.
function parseDateScope(text, todayISO) {
  const t = text.toLowerCase();
  if (/\btoday\b/.test(t)) return todayISO;
  if (/\btomorrow\b/.test(t)) return addDaysISO(todayISO, 1);
  if (/\byesterday\b/.test(t)) return addDaysISO(todayISO, -1);
  const m = text.match(DATE_LITERAL_RE);
  if (m) {
    const [, dd, mm, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return null;
}

// Returns null (not this intent), or { copyType: 'customer'|'booking', scope: { type: 'code', code }
// | { type: 'date', dateISO } | null }. scope is null when neither a code nor a date word/literal
// was found and there's no lastBookingCode to fall back on - the caller must ask which one is meant.
function detectJobSheetCopyIntent(text, lastBookingCode, todayISO) {
  const isBookingCopy = matchesCopyRequest(text, ['booking', 'vendor']);
  const isCustomerCopy = !isBookingCopy && matchesCopyRequest(text, ['customer']);
  if (!isBookingCopy && !isCustomerCopy) return null;
  const copyType = isBookingCopy ? 'booking' : 'customer';

  const codeMatch = text.match(CODE_RE);
  if (codeMatch) return { copyType, scope: { type: 'code', code: codeMatch[0].toUpperCase() } };

  const dateISO = parseDateScope(text, todayISO);
  if (dateISO) return { copyType, scope: { type: 'date', dateISO } };

  if (lastBookingCode) return { copyType, scope: { type: 'code', code: lastBookingCode } };

  return { copyType, scope: null };
}

const MAX_JOB_SHEETS = 30;

// Every job sheet whose linked itinerary item falls on the given day - a job sheet links to
// EITHER a transfer/sightseeing item (JobSheetMaster.ItineraryId -> BookingItineary.Id) OR a
// meal/restaurant item (JobSheetMaster.ItineraryRestaurantId -> BookingItineraryRestaurant.Id,
// undocumented in schema.js, found only by inspecting a real row - "Dinner Coupon"-style job
// sheets have ItineraryId NULL and ONLY this column set). Missing this second join previously
// undercounted every date-scoped request by however many meal job sheets fell on that day -
// reproduced live: "copy booking for tomorrow" returned 2 when the real Job Sheet grid, filtered to
// the same date, showed 3 (the missing one a Dinner Coupon). Verified against the full table: every
// job sheet has exactly one of these two links set, none are truly linkless.
async function findJobSheetsByDate(dateISO) {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('date', dateISO)
    .query(`
      SELECT TOP ${MAX_JOB_SHEETS} jsm.Id, jsm.GeneralRemarks, bm.BookingId AS Code, bm.GuestName
      FROM JobSheetMaster jsm
      JOIN BookingMaster bm ON bm.Id = jsm.BookingId AND bm.IsDelete = 0
      LEFT JOIN BookingItineary bi ON bi.Id = jsm.ItineraryId AND bi.IsDelete = 0
      LEFT JOIN BookingItineraryRestaurant bir ON bir.Id = jsm.ItineraryRestaurantId AND bir.IsDelete = 0
      WHERE jsm.IsDelete = 0 AND (bi.Date = @date OR bir.Date = @date)
      ORDER BY COALESCE(bi.Time, '00:00')
    `);
  return r.recordset;
}

async function findJobSheetsByInternalBookingId(internalId) {
  const pool = await getPool();
  const r = await pool
    .request()
    .input('id', internalId)
    .query(`
      SELECT TOP ${MAX_JOB_SHEETS} jsm.Id, jsm.GeneralRemarks
      FROM JobSheetMaster jsm
      WHERE jsm.BookingId = @id AND jsm.IsDelete = 0
      ORDER BY jsm.Id
    `);
  return r.recordset;
}

// Mirrors the real Job Sheet grid's own $.get('/Jobsheet/GetBookingById', {id}) call exactly (same
// endpoint managejobsheet.js's CopyBooking()/CopyBookingForCustomer() use) - a plain read, so the
// text built from it always matches what the real "Copy" button would have produced.
async function fetchJobSheetData(jobSheetId) {
  const { base, headers } = buildHeaders();
  const res = await safeFetch(`${base}/Jobsheet/GetBookingById?id=${jobSheetId}`, { headers });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Jobsheet GetBookingById returned ${res.status}: ${text.slice(0, 300)}`);
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

function formatDateDMY(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

// Mirrors managejobsheet.js's own timeformate() (12-hour conversion), except a blank/unset time -
// which the real site feeds straight into that function unguarded - produces a literal "12:NaN AM"
// there (reproduced live: job sheet 2038's popup). Returning null here instead lets the caller show
// something readable rather than carrying that bug into the copy text.
function formatTime12(time24) {
  if (!time24) return null;
  const [hStr, mStr] = time24.split(':');
  let h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Exact field order/wording of the real "Copy Booking" modal (#copyJobSheetModal in the Job Sheet
// page) - found in its HTML template, not guessed.
function buildBookingCopyText(data) {
  const time12 = formatTime12(data.time);
  const timeLine = data.time ? `${data.time} Hrs (${time12})` : 'Time not specified';
  return [
    'FlyThai',
    '',
    data.bookingId || '',
    data.guestName || '',
    data.totalGuest || '',
    '',
    formatDateDMY(data.date),
    timeLine,
    '',
    data.pickUpPoint || '',
    data.particular || '',
    [data.particularRemark, data.flightNo].filter(Boolean).join(' '),
    data.vehicleName || '',
    data.pickUpRemark || '',
    '',
    data.dropoffPoint || '',
    '',
    'Please Confirm',
  ].join('\n');
}

// Exact field order/wording of the real "Copy For Customer" modal (#copyJobSheetModalForCustomer) -
// the non_restaurant-classed lines (time/pickup/remarks/flight/dropoff) are hidden on the real page
// whenever the particular text mentions lunch/dinner, so this drops them the same way rather than
// showing pickup details for a meal.
function buildCustomerCopyText(data, generalRemarks) {
  const isMeal = /lunch|dinner/i.test(data.particular || '');
  const title = isMeal ? 'Tomorrow Lunch/Dinner' : 'Tomorrow Pickup';
  const time12 = formatTime12(data.time);
  const lines = [title, '', data.guestName || '', data.totalGuest || '', `Date: ${formatDateDMY(data.date)}`];
  if (!isMeal) {
    lines.push(data.time ? `Time: ${data.time} Hrs (${time12})` : 'Time: Not specified');
    lines.push('', `Pickup from: ${data.pickUpPoint || ''}`);
    if (data.pickUpRemark) lines.push(`Remarks: ${data.pickUpRemark}`);
    if (data.flightNo) lines.push(data.flightNo);
  }
  lines.push(`Details: ${data.particular || ''}`);
  if (data.particularRemark) lines.push(data.particularRemark);
  if (data.vehicleName) lines.push(data.vehicleName);
  if (generalRemarks && generalRemarks.trim()) lines.push('', `General Remarks: ${generalRemarks.trim()}`);
  if (!isMeal) lines.push('', `Dropoff Point: ${data.dropoffPoint || ''}`);
  lines.push('', 'Please be ready in lobby on time');
  return lines.join('\n');
}

// Shared by resolveJobSheetCopies below and the post-disambiguation continuation in chat.js
// (resumeRecordChoice's 'jobSheetCopy' kind) - once a set of job sheet rows is known, fetch each
// one's real data and build its copy text. One bad row (e.g. a stale/deleted job sheet) doesn't
// sink every other copy in the batch.
async function buildCopiesForRows(rows, copyType) {
  const copies = [];
  for (const row of rows) {
    let data;
    try {
      data = await fetchJobSheetData(row.Id);
    } catch (err) {
      continue;
    }
    const label = `${data.bookingId || row.Code || ''} — ${data.particular || 'Job Sheet'} (${formatDateDMY(data.date)})`;
    const text = copyType === 'booking' ? buildBookingCopyText(data) : buildCustomerCopyText(data, row.GeneralRemarks);
    copies.push({ label, text });
  }
  return copies;
}

// Returns { status: 'not_found' } | { status: 'ambiguous', matches } | { status: 'ok', copies: [{
// label, text }], truncated }.
async function resolveJobSheetCopies(intent) {
  let rows;
  let truncated = false;
  if (intent.scope.type === 'date') {
    rows = await findJobSheetsByDate(intent.scope.dateISO);
    truncated = rows.length >= MAX_JOB_SHEETS;
    if (rows.length === 0) return { status: 'not_found', reason: 'date' };
  } else {
    const matches = await resolveBookingByCode(intent.scope.code);
    if (matches.length === 0) return { status: 'not_found', reason: 'code' };
    if (matches.length > 1) return { status: 'ambiguous', matches };
    rows = await findJobSheetsByInternalBookingId(matches[0].Id);
    if (rows.length === 0) return { status: 'not_found', reason: 'no_job_sheets', code: matches[0].BookingId || matches[0].QuotationId };
  }
  const copies = await buildCopiesForRows(rows, intent.copyType);
  return { status: 'ok', copies, truncated };
}

// Resumes a 'jobSheetCopy' ambiguous-code disambiguation once the user picked which record was
// meant (chat.js's resumeRecordChoice) - `chosen` is that one real BookingMaster row.
async function resolveJobSheetCopiesForBooking(chosen, copyType) {
  const rows = await findJobSheetsByInternalBookingId(chosen.Id);
  if (rows.length === 0) return { status: 'not_found', reason: 'no_job_sheets', code: chosen.BookingId || chosen.QuotationId };
  const copies = await buildCopiesForRows(rows, copyType);
  return { status: 'ok', copies, truncated: false };
}

module.exports = { detectJobSheetCopyIntent, resolveJobSheetCopies, resolveJobSheetCopiesForBooking };
