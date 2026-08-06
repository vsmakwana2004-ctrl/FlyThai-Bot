const { callLLM } = require('./llm');
const { runReadOnlyQuery } = require('./db');
const { SCHEMA_DOC } = require('./schema');
const bookingFlow = require('./bookingFlow');
const documents = require('./documents');
const bookingDetails = require('./bookingDetails');
const statusUpdate = require('./statusUpdate');
const accountTransactions = require('./accountTransactions');
const financeReports = require('./financeReports');
const convertBooking = require('./convertBooking');
const editBooking = require('./editBooking');
const { findBookingById } = require('./bookingApi');
const { isAnyCancel } = require('./cancel');

// Simple in-memory per-session state (server restarts clear it — fine for an internal tool).
const sessions = new Map();
const MAX_TURNS = 6; // user+assistant pairs kept for context

function getSession(sessionId) {
  if (!sessions.has(sessionId)) sessions.set(sessionId, { history: [], draft: null, pendingItinerary: null, pendingDocChoice: null, pendingHotelChoice: null, pendingCodeChoice: null, pendingRecordChoice: null, pendingStatusChange: null, pendingCreateConfirm: null, pendingConvertConfirm: null, pendingFieldEditConfirm: null, lastBookingCode: null });
  return sessions.get(sessionId);
}

// True while the session is inside a guided multi-message flow, so the UI can offer a visible
// "Cancel" button instead of relying on the user knowing the right word to type.
function isFlowActive(session) {
  return !!(session.draft || session.pendingStatusChange || session.pendingItinerary || session.pendingDocChoice || session.pendingHotelChoice || session.pendingCodeChoice || session.pendingRecordChoice || session.pendingCreateConfirm || session.pendingConvertConfirm || session.pendingFieldEditConfirm);
}

// Hard reset of every guided flow - what the UI's Cancel button calls. Deliberately unconditional
// so it can never itself get stuck on parsing.
function cancelFlows(sessionId) {
  const session = getSession(sessionId);
  const wasActive = isFlowActive(session);
  session.draft = null;
  session.pendingItinerary = null;
  session.pendingDocChoice = null;
  session.pendingHotelChoice = null;
  session.pendingCodeChoice = null;
  session.pendingRecordChoice = null;
  session.pendingStatusChange = null;
  session.pendingCreateConfirm = null;
  session.pendingConvertConfirm = null;
  session.pendingFieldEditConfirm = null;
  return wasActive;
}

const TABLE_LINE_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

// The answerer model is small and fast, and occasionally falls into a repetition loop while
// emitting markdown table rows - a 3-record result was observed rendering as a 10-row table with
// the same booking repeated five times. The prompt now forbids it, but a prompt is not a
// guarantee. Two byte-identical data rows carry no information, so dropping exact repeats is
// always safe and makes the failure impossible rather than merely unlikely.
function dedupeMarkdownTableRows(text) {
  if (!text || !text.includes('|')) return text;
  const lines = text.split(/\r?\n/);
  const out = [];
  let seen = null; // non-null while inside a table block
  let dropped = 0;

  for (const line of lines) {
    if (!TABLE_LINE_RE.test(line)) {
      seen = null;
      out.push(line);
      continue;
    }
    if (seen === null) {
      seen = new Set(); // this line is the header row of a new table
      out.push(line);
      continue;
    }
    if (TABLE_SEPARATOR_RE.test(line)) {
      out.push(line);
      continue;
    }
    const key = line.replace(/\s+/g, ' ').trim().toLowerCase();
    if (seen.has(key)) {
      dropped++;
      continue;
    }
    seen.add(key);
    out.push(line);
  }

  if (dropped > 0) console.warn(`[answer] dropped ${dropped} duplicate table row(s) from model output`);
  return dropped > 0 ? out.join('\n') : text;
}

// History is only ever fed to the planner, never shown to the user. Storing the full formatted
// answer put a context full of table rows and "Created On:" lines in front of the planner, which
// measurably biased later turns (it started filtering on CreatedOn instead of TravelDate, and
// repeated table rows). Tables collapse to a one-line summary that keeps the record IDs, so
// follow-ups like "and the payment status of FT08261762?" still resolve.
function compactForHistory(text) {
  if (!text) return text;
  const lines = text.split(/\r?\n/);
  const out = [];
  let i = 0;

  while (i < lines.length) {
    if (!TABLE_LINE_RE.test(lines[i])) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const ids = [];
    let rows = 0;
    while (i < lines.length && TABLE_LINE_RE.test(lines[i])) {
      if (!TABLE_SEPARATOR_RE.test(lines[i])) {
        const first = lines[i].trim().replace(/^\||\|$/g, '').split('|')[0].trim();
        const code = first.match(ANY_CODE_RE);
        if (code) ids.push(code[0]);
        rows++;
      }
      i++;
    }
    const dataRows = Math.max(rows - 1, 0); // minus the header row
    out.push(
      ids.length
        ? `[table of ${dataRows} record(s): ${ids.slice(0, 15).join(', ')}${ids.length > 15 ? ', …' : ''}]`
        : `[table of ${dataRows} row(s) omitted]`
    );
  }

  const compact = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return compact.length > 1200 ? `${compact.slice(0, 1200)}\n…` : compact;
}

// Collapses rows that are fully identical across every selected column - the artefact of a JOIN
// against a one-to-many table (itinerary items, hotels, ...) that the query never actually SELECTed
// anything from, so the fan-out produces exact copies of the same row instead of genuinely
// different ones. A row that differs in ANY column is left alone - this only removes true
// duplicates, never a legitimately distinct sub-row (e.g. one row per hotel with different names).
function dedupeExactRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

// A LEFT JOIN to Destination (or hotels/itinerary) returns one row per joined child, so the same
// booking legitimately appears several times in a result set - a 3-booking query was seen coming
// back as 7 rows because one trip covers four destinations. The planner is told to aggregate those
// away, but when it forgets, the answerer must still list each booking once. Counting the distinct
// codes here is deterministic, so the model is given the exact number of rows to emit instead of
// having to work it out from the JSON.
function distinctRecordCount(rows) {
  const codes = new Set();
  let sawCodeColumn = false;
  for (const row of rows) {
    const code = row && (row.BookingId || row.QuotationId);
    if (typeof code === 'string' && ANY_CODE_RE.test(code)) {
      sawCodeColumn = true;
      codes.add(code.toUpperCase());
    }
  }
  return sawCodeColumn ? codes.size : null;
}

// A join can repeat one booking across many rows, so a naive "first 20 rows" slice can end up
// holding only two or three distinct bookings out of dozens - and the model then confidently
// reports that smaller number as the total ("Found 2 bookings" when there were 3). Take one row
// per distinct record first, then top up with the leftovers, so the sample always represents as
// many real records as it can fit.
function buildSample(rows, limit) {
  if (rows.length <= limit) return rows;

  const seen = new Set();
  const firstOfEach = [];
  const rest = [];
  for (const row of rows) {
    const code = row && (row.BookingId || row.QuotationId);
    const key = typeof code === 'string' && ANY_CODE_RE.test(code) ? code.toUpperCase() : null;
    if (key === null || seen.has(key)) {
      rest.push(row);
      continue;
    }
    seen.add(key);
    firstOfEach.push(row);
  }

  if (firstOfEach.length === 0) return rows.slice(0, limit); // no code column - nothing to spread
  const sample = firstOfEach.slice(0, limit);
  for (const row of rest) {
    if (sample.length >= limit) break;
    sample.push(row);
  }
  return sample;
}

// The single source of truth for "how many rows should the answer's table have". Computed from the
// FULL result set, never from the sample - deriving it from the sample is exactly what made the
// model report the sample size as the total.
function rowCountRule(sampleRows, allRows) {
  const totalDistinct = distinctRecordCount(allRows);
  const shownDistinct = distinctRecordCount(sampleRows);

  if (totalDistinct === null) {
    // Aggregates, counts, sums - no record codes to reason about.
    return `\n\nThe JSON above contains exactly ${sampleRows.length} row(s)${allRows.length > sampleRows.length ? ` out of ${allRows.length} total — state the true total of ${allRows.length}` : ''}. Do not repeat a row.`;
  }

  if (shownDistinct < totalDistinct) {
    return `\n\nCOUNTS: the query matched ${totalDistinct} distinct booking(s)/quotation(s) in total, but only ${shownDistinct} of them are included above. Your answer MUST state the true total of ${totalDistinct}, show the ${shownDistinct} included as a sample in exactly ${shownDistinct} data row(s), and say that more exist. NEVER report ${shownDistinct} as the total.`;
  }

  if (totalDistinct < allRows.length) {
    return `\n\nCOUNTS: those ${allRows.length} rows cover only ${totalDistinct} distinct booking(s)/quotation(s) — the repeats are an artefact of a join, not separate records. Merge rows sharing a Booking/Quotation ID into one line. State the total as ${totalDistinct} and give EXACTLY ${totalDistinct} data row(s).`;
  }

  return `\n\nCOUNTS: there are exactly ${totalDistinct} record(s). State that total and give exactly ${totalDistinct} data row(s), each listed once, then stop.`;
}

function pushTurn(sessionId, userText, assistantText) {
  const session = getSession(sessionId);
  session.history.push({ role: 'user', content: userText });
  session.history.push({ role: 'assistant', content: compactForHistory(assistantText) });
  while (session.history.length > MAX_TURNS * 2) session.history.shift();
}

function todayIST() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD
}

function nowTimeIST() {
  return new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }); // HH:MM:SS
}

// Converts a stored DD-MM-YYYY field value to the YYYY-MM-DD an HTML <input type="date">'s min/
// value attributes need. Pads single-digit day/month since a raw user answer like "5-1-2026" is
// stored as-is, unpadded.
function ddmmyyyyToISO(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.trim().split('-');
  if (parts.length !== 3) return null;
  const [d, m, y] = parts;
  return `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function addDaysISO(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Shared min/max for every itinerary-item date field (hotel check-in/out, transfer/sightseeing/
// restaurant/leisure-day date) - matches validateItineraryItemDate's own rule that an item date
// can't fall before the trip's travel date or after its return date. minOverride lets check-out
// tighten the floor to the day after check-in instead of the trip's travel date.
function itineraryDateParams(draft, minOverride) {
  const min = minOverride || ddmmyyyyToISO(draft.fields.travelDate) || todayIST();
  const max = ddmmyyyyToISO(draft.fields.returnDate);
  return max ? { min, max } : { min };
}

function extractSql(text) {
  const m = text.match(/```sql\s*([\s\S]*?)```/i);
  if (m) return m[1].trim();
  // fallback: whole response looks like a bare SELECT
  if (/^\s*(select|with)\b/i.test(text)) return text.trim();
  return null;
}

function plannerSystemPrompt() {
  return `You are FlyThai's internal database assistant, used by travel-agency staff to look up quotations, bookings, hotels, job sheets, accounts, agents and inquiries.
You must answer ONLY using real data fetched from the company's live SQL Server database. Never invent, guess, or assume data that isn't returned by a query.
Today's date is ${todayIST()} and the current time is ${nowTimeIST()} (Asia/Kolkata timezone).

DATABASE SCHEMA:
${SCHEMA_DOC}

For every user message decide one of two things:
1. If answering needs database data, reply with ONLY a single read-only T-SQL SELECT statement, wrapped exactly like this and nothing else (no explanation):
\`\`\`sql
SELECT ...
\`\`\`
2. If the message is a greeting, thanks, or general chit-chat that clearly needs no DB lookup, reply with a short plain-text reply (no SQL block).

Rules: exactly one statement, must start with SELECT or WITH, never INSERT/UPDATE/DELETE/DROP/ALTER/EXEC/MERGE/TRUNCATE. Always filter soft-deleted rows (IsDelete=0 / IsDeleted=0) unless the user explicitly asks for deleted records.
(Note: requests to create a new booking, or to change a booking's Travel/Invoice/Voucher/Itinerary/Payment status, are handled by separate flows before this prompt ever runs — you will not see those here.)
CRITICAL: you have NO ability to write/update/change anything in the database or anywhere else from this point in the code. If a message reaches you asking to change/update/set/mark/create something and it wasn't intercepted before this prompt, that means it could NOT be handled automatically (e.g. the booking code was unclear). NEVER reply claiming you made a change, updated a status, or saved anything — that would be false. Instead reply honestly that you can't perform updates from here, and ask for the exact booking code so it can be handled correctly (e.g. "change payment status of FT07261782 to done").`;
}

function answererSystemPrompt() {
  return `You are FlyThai's internal database assistant. You previously ran a SQL query against the live database to answer the staff member's question. Using ONLY the JSON data provided (never invent anything beyond it), write a clear, helpful answer.
- Always reply in English, regardless of what language the question was asked in.
- If there are multiple records, use a compact markdown table.
- If there are more than ~15 records, do NOT dump every row into the table. Instead give the total count, any useful summary/breakdown, and show only the first 10-15 rows as a sample, mentioning that more exist.

MULTI-RECORD LIST ANSWERS — read this before writing any table with more than one data row:
- The JSON you are given is the complete, already-deduplicated result. Write EXACTLY ONE table row per record in it. If the JSON holds 3 records, the table has exactly 3 data rows — no more, ever.
- NEVER repeat a record. Two rows with the same Booking/Quotation ID is always a mistake, even if the records look similar. Each ID appears at most once in the whole table.
- If several JSON rows share the same Booking/Quotation ID, they are ONE booking that a join has split across rows (e.g. one row per destination or per hotel). Merge them into a single table row — combining the differing values into one cell where useful (e.g. "Bangkok, Pattaya") — never list that booking twice.
- Open with the count, e.g. "Found 3 bookings travelling on 02-Aug-2026:", then the table.
- Once every record has been written, STOP. Do not continue the row pattern, do not pad the table, do not re-list records you have already written.
- If the data array is empty, clearly say no matching record was found in the database.
- Keep money amounts together with their currency code exactly as given.
- Do not mention SQL, table names, or that you ran a query — just answer naturally, like a knowledgeable colleague.

SINGLE-BOOKING/QUOTATION "DETAILS" ANSWERS — always use this fixed layout, every time, never a different style (no plain paragraphs, no random bullet lists instead of this):
When the question is about one specific booking/quotation (by FT/FTQ code) and asks for its details/status/full info — not a list of many bookings — format the answer as markdown section headers, in this order, INCLUDING ONLY the sections for which the JSON actually has data (skip a section entirely rather than inventing or leaving it blank):
### Booking Summary
Guest Name, Company/Agent, Booking/Quotation ID, Travel Date, Return Date, Travel Count, current statuses (Travel/Invoice/Voucher/Payment) as "Label: Value" lines.
### Hotel Details
ALWAYS a markdown table (Hotel Name | Check-in | Room Type | Rooms | PAX | Nights) if any hotel rows are present — even if there is only ONE hotel row, still use a table with a single data row, NEVER a bullet list or "Label: Value" lines for hotel details. Include any extra charges (extra bed/breakfast/meals) as a note under the table if present in the data.
### Itinerary Details
A bullet list of itinerary/inclusion items if present.
### Cost Breakdown
ALWAYS a SINGLE markdown table if costBreakdown rows or costSummary is present — even if there is only ONE traveller-type row, still use a table, NEVER separate "Label: Value" lines for this section. Table columns: Traveller | Pax | Amount. First one row per costBreakdown entry (Type | PAX | Price, computed as Price x PAX shown with the currency), then when costSummary is present append these as further rows in that SAME table (Traveller column blank/"—" for these): Total Cost, ROE, Total After ROE, Discount (INR), Final Amount (INR) — using the exact numbers given in costSummary, never recalculate them yourself.
### Payments / Job Sheet / Other
Any remaining requested data (payment status, job sheet status, transactions, etc.) as short "Label: Value" lines or a small table.
Use this same structure consistently whether the user asks for "full details," just "status," or a narrower slice (e.g. "hotel details only") — just include only the relevant section(s) in that case, with the same header/table style, not a different format.`;
}

const ANY_CODE_RE = /\bFTQ?\d+\b/i;

// The itinerary/hotel-voucher "which logo version?" question - same fixed 3-way choice every
// time. Shown as chips (quickReplies) rather than the lookup dropdown, but unlike every other
// quickReplies chip set (which fill the input for a multi-field message) the frontend auto-sends
// on click here - it's a single, complete, unambiguous answer, and parseLogoChoice in documents.js
// already accepts the label text exactly as-is - so there's nothing to add to before sending.
const LOGO_CHOICE_LABELS = ['With FlyThai Logo', 'With Agent Logo', 'No Logo'];
function logoChoiceExpecting(session) {
  return session.pendingItinerary ? { field: 'logoChoice' } : null;
}
function logoChoiceQuickReplies(session) {
  return session.pendingItinerary ? LOGO_CHOICE_LABELS : null;
}

// Tells the frontend which live-lookup dropdown (if any) to show above the chat input, so the
// user can pick from real registered records instead of typing blind - mirrors the real site's
// own autocomplete fields. Covers the agent/company field and, during hotel collection, the
// hotel-name field (scoped to the destination already picked for that hotel row, if resolved).
function expectingField(draft) {
  if (draft && draft.phase === 'basic' && draft.basicCurrentStep === 'agentName') return { field: 'agent' };
  if (draft && draft.phase === 'basic' && draft.basicCurrentStep === 'destinationNames') return { field: 'destination', multi: true };
  // Travel/return date steps get a real calendar picker instead of free typing - min is today's
  // date for travel date, and the trip's own travel date for return date (matching the same
  // "can't be in the past" / "return can't be before travel" rules bookingFlow.js enforces itself).
  if (draft && draft.phase === 'basic' && draft.basicCurrentStep === 'travelDate') {
    return { field: 'date', params: { min: todayIST() } };
  }
  if (draft && draft.phase === 'basic' && draft.basicCurrentStep === 'returnDate') {
    return { field: 'date', params: { min: ddmmyyyyToISO(draft.fields.travelDate) || todayIST() } };
  }
  // Adults/children/infants step gets three number spinners instead of free-text counting -
  // adults is enforced to be at least 1 (a booking needs at least one adult traveller).
  if (draft && draft.phase === 'basic' && draft.basicCurrentStep === 'travelCount') return { field: 'pax' };
  if (draft && draft.phase === 'hotelCollect' && draft.hotelStep === 'hotelName') {
    const destinationId = draft.currentHotelDraft && draft.currentHotelDraft._destId;
    return { field: 'hotel', params: destinationId ? { destinationId } : {} };
  }
  // Room category dropdown, scoped to whichever hotel was just resolved - only shown when that
  // hotel has a real Id (a brand-new hotel typed fresh has none yet, so this just falls through
  // to plain typing, same as before).
  if (draft && draft.phase === 'hotelCollect' && draft.hotelStep === 'roomCategory') {
    const hotelId = draft.currentHotelDraft && draft.currentHotelDraft._resolvedHotelId;
    if (hotelId) return { field: 'roomType', params: { hotelId } };
  }
  // A hotel row's destination question only comes up at all when the trip has more than one
  // destination (bookingFlow.js auto-picks the single one otherwise) - a plain single-select
  // dropdown, not the multi-checklist basic collection uses, scoped to just this trip's own
  // destinations rather than every destination in the database.
  if (draft && draft.phase === 'hotelCollect' && draft.hotelStep === 'destinationName') {
    return { field: 'destination', options: draft.resolvedDestinations.map((d) => ({ Id: d.Id, Name: d.Name, ShortCode: d.ShortCode })) };
  }
  // Check-in/check-out get the same calendar picker as travel/return date, bounded to stay inside
  // the trip's own travel/return range - matching validateItineraryItemDate's own rules (check-in
  // can't be before travel date or after return date; check-out must be strictly after check-in).
  if (draft && draft.phase === 'hotelCollect' && draft.hotelStep === 'checkInDate') {
    return { field: 'date', params: itineraryDateParams(draft) };
  }
  if (draft && draft.phase === 'hotelCollect' && draft.hotelStep === 'checkOutDate') {
    const checkInISO = draft.currentHotelDraft && ddmmyyyyToISO(draft.currentHotelDraft.checkInDate);
    return { field: 'date', params: itineraryDateParams(draft, checkInISO ? addDaysISO(checkInISO, 1) : null) };
  }
  // Add Transfer step - same Pickup Point / DropOff Point / Transfer Code+Name / Vehicle Type
  // dropdowns the real site's own Add Transfer form shows, resolved against draft.itemStep
  // (the field currently being collected) rather than draft.phase alone. The date field (asked
  // first, before any of those) gets the same trip-bounded calendar as every other itinerary date.
  if (draft && draft.phase === 'transferCollect') {
    if (draft.itemStep === 'date') return { field: 'date', params: itineraryDateParams(draft) };
    if (draft.itemStep === 'pickupPointName' || draft.itemStep === 'dropOffPointName') return { field: 'pickup' };
    if (draft.itemStep === 'transferName') return { field: 'transfer' };
    if (draft.itemStep === 'vehicleTypeName') return { field: 'vehicle' };
  }
  // Add Sightseeing step - Pickup Point / Sightseeing Code+Name dropdowns, the latter scoped to
  // the weekday of the date already picked for this item (mirrors the real form's own filtering).
  if (draft && draft.phase === 'sightseeingCollect') {
    if (draft.itemStep === 'date') return { field: 'date', params: itineraryDateParams(draft) };
    // A grid of common 30-min tour-start slots above the input, instead of typing "HH:MM" blind.
    if (draft.itemStep === 'time') return { field: 'time' };
    if (draft.itemStep === 'pickupPointName') return { field: 'pickup' };
    if (draft.itemStep === 'sightseeingName') {
      const weekday = weekdayNameFromDDMMYYYY(draft.currentItemDraft && draft.currentItemDraft.date);
      return { field: 'sightseeing', params: weekday ? { weekday } : {} };
    }
  }
  // Add Restaurant step - was the one itinerary-item field with no dropdown at all, so a wrong
  // guess just repeated "couldn't find a restaurant matching ..." with no way to discover a real
  // name, reading as a stuck loop.
  if (draft && draft.phase === 'restaurantCollect') {
    if (draft.itemStep === 'date') return { field: 'date', params: itineraryDateParams(draft) };
    if (draft.itemStep === 'restaurantName') return { field: 'restaurant' };
  }
  // Leisure Day is a single-question phase (just the date) - draft.phase alone identifies it,
  // there's no itemStep to check.
  if (draft && draft.phase === 'leisureDayCollect') {
    return { field: 'date', params: itineraryDateParams(draft) };
  }
  // Optional pricing extras (ROE/tax/discount/due date/final rate) get one small multi-field form
  // instead of a single free-text message the user has to phrase from memory - it still lands on
  // the same LLM-parsed stepPriceExtras() as before, just pre-composed for them.
  if (draft && draft.phase === 'priceExtras') return { field: 'priceExtras' };
  // Final optional details (note/emergency contact/booked by/PDF permissions) - same idea, only
  // shown once the user has actually said they want to add any (see the extraGate quick replies).
  if (draft && draft.phase === 'extraCollect') return { field: 'extraDetails' };
  return null;
}

// Tap-to-answer shortcuts for steps that are otherwise a single free-text message covering several
// optional fields at once ("breakfast option, adults/children/infants staying, currency..."). The
// user still CAN type a longer answer - these are just common one-line answers rendered as chips
// above the input, same idea as the lookup dropdowns above but for LLM-extracted free-text steps
// rather than a DB-backed field. Clicking one sends its exact text, same as typing it.
function quickRepliesFor(draft) {
  // First question of any new booking/quotation - manual entry vs pre-filling from a pasted
  // travel-agent message (see bookingFlow.js stepSource/stepAgentPaste).
  if (draft && draft.phase === 'source') {
    return ['Manual Booking', 'Travel Agent Booking'];
  }
  if (draft && draft.phase === 'agentPasteConfirm') {
    return ['Yes, use these', 'No, enter manually'];
  }
  if (draft && draft.phase === 'hotelOptionalCollect') {
    return ['Skip', 'Breakfast included', 'No breakfast', 'Single sharing', 'Double sharing', 'Triple sharing'];
  }
  if (draft && draft.phase === 'hotelChoice') {
    return ['Self-booked', 'Add hotel details'];
  }
  // Traveller-type field: the real site's own #member-type autocomplete only ever offers these six
  // values (managebookings.js bindMemberType()) - chips beat typing one out from memory.
  if (draft && draft.phase === 'priceCollect' && draft.itemStep === 'type') {
    return ['Adult / Single', 'Adult / Double', 'Adult / Triple', 'Child With Bed', 'Child Without Bed', 'Infant'];
  }
  // First entry into pricing collection - "Skip" is a one-tap way out for staff with nothing to
  // add (the form below has no submit button of its own for an all-blank answer); "Add pricing
  // line" mirrors what typing anything other than a "no" here already does in stepPriceCollect.
  if (draft && draft.phase === 'priceCollect' && !draft.currentItemDraft) return ['Skip', 'Add pricing line'];
  if (draft && draft.phase === 'priceExtras') return ['Skip'];
  // Gate before the final note/emergency-contact/booked-by/PDF-permission form - most bookings
  // need none of it, so "Skip" goes straight to confirm without ever opening the form.
  if (draft && draft.phase === 'extraGate') return ['Skip', 'Yes, add details'];
  if (draft && draft.phase === 'extraCollect') return ['Skip'];
  return null;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function weekdayNameFromDDMMYYYY(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const parts = dateStr.trim().split('-');
  if (parts.length !== 3) return null;
  const [day, month, year] = parts.map(Number);
  const d = new Date(year, month - 1, day);
  return Number.isNaN(d.getTime()) ? null : WEEKDAY_NAMES[d.getDay()];
}

async function handleChat(sessionId, userMessage) {
  const result = await handleChatInner(sessionId, userMessage);
  return { ...result, flowActive: isFlowActive(getSession(sessionId)) };
}

// Shared "which one did you mean?" prompt for a code that matched more than one real row (convert/
// field-edit/itinerary-edit/status-change all hit this the same way - see documents.js's
// resolveBookingByCode for why QuotationId isn't guaranteed unique). kind/extra are stashed on
// session.pendingRecordChoice so the next message can resume the right flow via resumeRecordChoice.
function askWhichRecord(sessionId, session, userMessage, code, matches, kind, extra) {
  const list = matches.map((m, i) => `${i + 1}. ${documents.describeMatch(m)}`).join('\n');
  const reply = `More than one record uses the code **${code}** — which one did you mean?\n\n${list}\n\n(Reply with the number.)`;
  session.pendingRecordChoice = { code, matches, kind, extra };
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: 0 };
}

// Finishes a convert-to-booking check (not_found/already_booking/invalid/ok) - shared by the fresh
// convertIntent path and the post-disambiguation continuation in resumeRecordChoice.
function finishConvertResult(sessionId, session, userMessage, result) {
  if (result.status === 'not_found') {
    const reply = `I couldn't find any quotation matching **${result.code}** in the database.`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }
  if (result.status === 'already_booking') {
    const reply = `**${result.code}** is already a booking, not a quotation — there's nothing to convert.`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }
  if (result.status === 'invalid') {
    const list = result.errors.map((e) => `- ${e}`).join('\n');
    const reply = `Please correct the following before **${result.code}** (${result.guestName}) can be converted to a booking:\n\n${list}`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }
  const reply = `**${result.code}** (${result.guestName}) has everything required and is ready to convert to a booking. This cannot be undone from here — proceed? (yes/no)`;
  session.pendingConvertConfirm = { code: result.code, guestName: result.guestName, raw: result.raw };
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: 0 };
}

// Finishes a simple field-edit resolve (not_found/ok) - shared by the fresh fieldEditIntent path
// and the post-disambiguation continuation in resumeRecordChoice. `intentLike` just needs
// .code/.field/.label/.value.
function finishFieldEditResolve(sessionId, session, userMessage, resolved, intentLike) {
  if (resolved.status === 'not_found') {
    const reply = `I couldn't find any booking or quotation matching **${intentLike.code}** in the database.`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }
  const reply = `Set **${intentLike.label}** for **${resolved.code}** (${resolved.guestName}) to "${intentLike.value}"? (yes/no)`;
  session.pendingFieldEditConfirm = {
    code: resolved.code,
    guestName: resolved.guestName,
    raw: resolved.raw,
    fieldKey: intentLike.field,
    label: intentLike.label,
    value: intentLike.value,
  };
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: 0 };
}

// Finishes an itinerary-edit resolve (not_found/ok) - shared by the fresh itineraryEditIntent path
// and the post-disambiguation continuation in resumeRecordChoice.
function finishItineraryEditResolve(sessionId, session, userMessage, resolved, fallbackCode) {
  if (resolved.status === 'not_found') {
    const reply = `I couldn't find any booking or quotation matching **${fallbackCode}** in the database.`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }
  const draft = bookingFlow.startItineraryEditDraft(resolved.raw, resolved.code, resolved.guestName);
  session.draft = draft;
  const reply = `Let's add itinerary details to **${resolved.code}** (${resolved.guestName}).\n\n${bookingFlow.askItineraryChoice()}`;
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: 0 };
}

// Resumes whichever flow asked "which one did you mean?" (session.pendingRecordChoice) once the
// user has picked a specific row - dispatches by .kind to the same "finish" helper the fresh-intent
// path itself uses, so the two paths can never drift apart.
async function resumeRecordChoice(sessionId, session, pending, chosen, userMessage) {
  if (pending.kind === 'convert') {
    const result = await convertBooking.checkConversionForBooking(chosen);
    return finishConvertResult(sessionId, session, userMessage, result);
  }
  if (pending.kind === 'fieldEdit') {
    const resolved = await editBooking.resolveForEditBooking(chosen);
    return finishFieldEditResolve(sessionId, session, userMessage, resolved, { code: pending.code, ...pending.extra });
  }
  if (pending.kind === 'itineraryEdit') {
    const resolved = await editBooking.resolveForEditBooking(chosen);
    return finishItineraryEditResolve(sessionId, session, userMessage, resolved, pending.code);
  }
  // 'statusUpdate'
  const result = await statusUpdate.startWithBooking(chosen, pending.extra.userMessage);
  session.pendingStatusChange = result.pending;
  pushTurn(sessionId, userMessage, result.reply);
  return { answer: result.reply, sql: null, rowCount: 0 };
}

async function handleChatInner(sessionId, userMessage) {
  const session = getSession(sessionId);

  // Any pending question ("which logo?", "which status?") is a dead end if the user changes their
  // mind — each of those handlers just re-asks forever on an unrecognised reply. One shared check
  // in front of all of them means "cancel" always works, whatever we happen to be waiting on.
  if ((session.pendingStatusChange || session.pendingItinerary || session.pendingDocChoice || session.pendingHotelChoice || session.pendingCodeChoice || session.pendingRecordChoice || session.pendingConvertConfirm || session.pendingFieldEditConfirm) && isAnyCancel(userMessage)) {
    cancelFlows(sessionId);
    const reply = 'Okay, cancelled — nothing was changed. What would you like to know?';
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }

  // Remember the last booking/quotation code mentioned in this session, so a pronoun follow-up
  // ("change that to done", "and its payment status?") can still resolve which booking is meant,
  // without requiring the code to be repeated every message.
  const codeInMessage = userMessage.match(ANY_CODE_RE);
  if (codeInMessage) session.lastBookingCode = codeInMessage[0].toUpperCase();

  // A pending narrow follow-up question ("which PDF type?", "which logo?", "confirm converting
  // X?") only makes sense as a reply about the SAME record it was originally asked about. If this
  // message names a DIFFERENT FT/FTQ code, the user has moved on to a new request rather than
  // answering the old one - reproduced live: asking "get itinerary pdf for FTQ12260001" while a
  // "which PDF type?" question about an unrelated earlier booking was still pending got silently
  // answered using that STALE booking's code (wrong guest, wrong PDF), because stepDocChoice only
  // pattern-matches keywords in the reply and never re-checks which record it's actually about.
  // Each pending state's own .code is compared independently and cleared only on a mismatch, so a
  // reply that doesn't name a code at all ("1", "agent logo", "yes") still lands on whatever's
  // still pending exactly as before - this only interrupts on a genuinely different explicit code.
  if (codeInMessage) {
    const newCode = codeInMessage[0].toUpperCase();
    for (const key of ['pendingStatusChange', 'pendingDocChoice', 'pendingHotelChoice', 'pendingCodeChoice', 'pendingRecordChoice', 'pendingItinerary', 'pendingConvertConfirm', 'pendingFieldEditConfirm']) {
      if (session[key] && session[key].code && session[key].code !== newCode) {
        session[key] = null;
      }
    }
    // An active itinerary-edit draft (session.draft with editMode true) carries its own record's
    // code the same way the pending-question states above do, but wasn't covered by this guard -
    // a stray message naming a DIFFERENT booking mid-edit could otherwise get swallowed into the
    // itinerary Q&A instead of interrupting it (see bookingFlow.js's editContext).
    if (session.draft && session.draft.editContext && session.draft.editContext.code && session.draft.editContext.code !== newCode) {
      session.draft = null;
    }
  }

  // If a status-change request is mid-conversation (collecting fields, or awaiting yes/no
  // confirmation), this message continues that - checked first so it can't be misread as
  // something else while we're mid-flow.
  if (session.pendingStatusChange) {
    const { reply, pending } = await statusUpdate.step(session.pendingStatusChange, userMessage);
    session.pendingStatusChange = pending;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }

  // If we previously asked "which record did you mean?" (the same code matched more than one real
  // row - see documents.js's resolveBookingByCode), this message answers that, then continues into
  // whatever that record's document request itself produces (a direct answer, or a further "which
  // PDF type?"/"which logo?"/"which hotel?" question).
  if (session.pendingCodeChoice) {
    const { reply, pendingCodeChoice, pendingDocChoice, pendingItinerary, pendingHotelChoice } = await documents.stepCodeChoice(session.pendingCodeChoice, userMessage);
    session.pendingCodeChoice = pendingCodeChoice;
    if (pendingDocChoice) session.pendingDocChoice = pendingDocChoice;
    if (pendingItinerary) session.pendingItinerary = pendingItinerary;
    if (pendingHotelChoice) session.pendingHotelChoice = pendingHotelChoice;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, expecting: logoChoiceExpecting(session), quickReplies: logoChoiceQuickReplies(session) };
  }

  // If we previously asked "which logo version?" for an itinerary PDF, this message answers that.
  if (session.pendingItinerary) {
    const { reply, pending } = documents.stepLogoChoice(session.pendingItinerary, userMessage);
    session.pendingItinerary = pending;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, expecting: logoChoiceExpecting(session), quickReplies: logoChoiceQuickReplies(session) };
  }

  // If we previously asked "which PDF - invoice/quotation, itinerary, or hotel voucher?" this
  // message answers that.
  if (session.pendingDocChoice) {
    const { reply, pendingDocChoice, pendingItinerary, pendingHotelChoice } = await documents.stepDocChoice(session.pendingDocChoice, userMessage);
    session.pendingDocChoice = pendingDocChoice;
    if (pendingItinerary) session.pendingItinerary = pendingItinerary;
    if (pendingHotelChoice) session.pendingHotelChoice = pendingHotelChoice;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, expecting: logoChoiceExpecting(session), quickReplies: logoChoiceQuickReplies(session) };
  }

  // If a booking has more than one hotel stay, we previously asked "which hotel's voucher?" -
  // this message answers that, then moves on to the same logo-choice step as the single-hotel case.
  if (session.pendingHotelChoice) {
    const { reply, pendingHotelChoice, pendingItinerary } = documents.stepHotelChoice(session.pendingHotelChoice, userMessage);
    session.pendingHotelChoice = pendingHotelChoice;
    if (pendingItinerary) session.pendingItinerary = pendingItinerary;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, expecting: logoChoiceExpecting(session), quickReplies: logoChoiceQuickReplies(session) };
  }

  // A "shall I create one?" question was asked last turn — this message answers it. Checked here,
  // grouped with the other "continue a pending question" handlers above/below (not further down
  // near createIntent detection, where it used to live) - convertIntent/fieldEditIntent/
  // itineraryEditIntent detection all run further below and none of them used to clear this on a
  // match, so a reply that happened to match one of THOSE instead left this dangling indefinitely;
  // a later, unrelated "yes" could then silently resurrect it and start an unwanted new booking.
  if (session.pendingCreateConfirm) {
    const { kind, originalMessage } = session.pendingCreateConfirm;
    session.pendingCreateConfirm = null;
    if (bookingFlow.parseYesNo(userMessage) === true) {
      const newDraft = bookingFlow.startDraft(kind);
      const { reply, draft, createdCode } = await bookingFlow.step(newDraft, originalMessage);
      session.draft = draft;
      if (createdCode) session.lastBookingCode = createdCode;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0, expecting: expectingField(draft), quickReplies: quickRepliesFor(draft) };
    }
    // Anything that isn't a clear "yes" simply falls through and is answered as a normal question -
    // so a mis-detected create intent costs the user one extra line, never a stuck conversation.
  }

  // If we previously asked "which one did you mean?" for a convert/field-edit/itinerary-edit/
  // status-change request whose code matched more than one real row (QuotationId isn't guaranteed
  // unique - see documents.js's resolveBookingByCode), this message answers that, then resumes
  // whichever of those flows asked the question in the first place.
  if (session.pendingRecordChoice) {
    const pending = session.pendingRecordChoice;
    const t = userMessage.trim();
    const chosen = /^\d+$/.test(t) ? pending.matches[Number(t) - 1] : null;
    if (!chosen) {
      const list = pending.matches.map((m, i) => `${i + 1}. ${documents.describeMatch(m)}`).join('\n');
      const reply = `Please reply with just the number of the record you meant:\n\n${list}`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    session.pendingRecordChoice = null;
    return resumeRecordChoice(sessionId, session, pending, chosen, userMessage);
  }

  // A "convert this quotation to a booking?" confirmation was asked last turn - this answers it.
  // Only reached after checkConversion() already returned 'ok' (all required fields present), so
  // the only remaining question is whether the user actually wants to go ahead - matching the real
  // site's own "Convert? Are you sure!" modal.
  if (session.pendingConvertConfirm) {
    const { code, guestName, raw, allowSalesEntry = true } = session.pendingConvertConfirm;
    session.pendingConvertConfirm = null;
    const yn = bookingFlow.parseYesNo(userMessage);
    if (yn === true) {
      try {
        const newId = await convertBooking.performConversion(raw, { allowSalesEntry });
        const created = await findBookingById(newId);
        const newCode = created ? created.BookingId : null;
        const reply = `Done — **${code}** (${guestName}) has been converted to a booking${newCode ? ` (**${newCode}**)` : ''}. This cannot be undone from here; use the FlyThai site if anything needs correcting.`;
        pushTurn(sessionId, userMessage, reply);
        return { answer: reply, sql: null, rowCount: 0 };
      } catch (err) {
        if (err.code === 'AGENT_ACCOUNT_NOT_FOUND') {
          const reply = `**${code}**'s agent account wasn't found, so converting it would skip creating a sales entry. Convert anyway without a sales entry? (yes/no)`;
          session.pendingConvertConfirm = { code, guestName, raw, allowSalesEntry: false };
          pushTurn(sessionId, userMessage, reply);
          return { answer: reply, sql: null, rowCount: 0 };
        }
        throw err;
      }
    }
    if (yn === false) {
      const reply = `Okay, cancelled — **${code}** was not converted.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    const reply = `Reply "yes" to convert **${code}** to a booking, or "no" to cancel.`;
    session.pendingConvertConfirm = { code, guestName, raw };
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }

  // A request to convert a quotation into a confirmed booking - checked deterministically (no
  // LLM/SQL) so the required-field validation always matches the real site's own rules exactly,
  // and so the actual write only ever happens after an explicit yes.
  const convertIntent = convertBooking.detectConvertIntent(userMessage, session.lastBookingCode);
  if (convertIntent && !session.draft) {
    const result = await convertBooking.checkConversion(convertIntent.code);
    if (result.status === 'ambiguous') {
      return askWhichRecord(sessionId, session, userMessage, result.code, result.matches, 'convert', {});
    }
    return finishConvertResult(sessionId, session, userMessage, result);
  }

  // A "set this field to X?" confirmation was asked last turn - this message answers it.
  if (session.pendingFieldEditConfirm) {
    const { code, guestName, raw, fieldKey, label, value } = session.pendingFieldEditConfirm;
    session.pendingFieldEditConfirm = null;
    const yn = bookingFlow.parseYesNo(userMessage);
    if (yn === true) {
      try {
        await editBooking.applySimpleFieldEdit(raw, fieldKey, value);
        const reply = `Done — ${label} for **${code}** (${guestName}) is now "${value}".`;
        pushTurn(sessionId, userMessage, reply);
        return { answer: reply, sql: null, rowCount: 0 };
      } catch (err) {
        const reply = `Sorry, saving that failed: ${err.message}`;
        pushTurn(sessionId, userMessage, reply);
        return { answer: reply, sql: null, rowCount: 0 };
      }
    }
    if (yn === false) {
      const reply = `Okay, cancelled — nothing was changed on **${code}**.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    const reply = `Reply "yes" to set ${label} for **${code}** to "${value}", or "no" to cancel.`;
    session.pendingFieldEditConfirm = { code, guestName, raw, fieldKey, label, value };
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }

  // A request to update one simple field (company name, phone, email, guest name, address) on an
  // existing booking/quotation - deterministic (regex, no LLM), reusing the same live-record
  // read/write path as convert-to-booking so the "current state" it edits is never stale/guessed.
  const fieldEditIntent = editBooking.detectSimpleFieldEditIntent(userMessage, session.lastBookingCode);
  if (fieldEditIntent && !session.draft) {
    const resolved = await editBooking.resolveForEdit(fieldEditIntent.code);
    if (resolved.status === 'ambiguous') {
      return askWhichRecord(sessionId, session, userMessage, resolved.code, resolved.matches, 'fieldEdit', {
        field: fieldEditIntent.field,
        label: fieldEditIntent.label,
        value: fieldEditIntent.value,
      });
    }
    return finishFieldEditResolve(sessionId, session, userMessage, resolved, fieldEditIntent);
  }

  // A request to add itinerary items to an existing booking/quotation - hands off to the SAME
  // guided Q&A bookingFlow.js already uses when creating one from scratch (startItineraryEditDraft
  // seeds it from the record's current live state instead of a blank draft), then drives it
  // through the ordinary `session.draft` handling right below, unchanged.
  const itineraryEditIntent = editBooking.detectItineraryEditIntent(userMessage, session.lastBookingCode);
  if (itineraryEditIntent && !session.draft) {
    const resolved = await editBooking.resolveForEdit(itineraryEditIntent.code);
    if (resolved.status === 'ambiguous') {
      return askWhichRecord(sessionId, session, userMessage, resolved.code, resolved.matches, 'itineraryEdit', {});
    }
    return finishItineraryEditResolve(sessionId, session, userMessage, resolved, itineraryEditIntent.code);
  }

  // If a booking/quotation is already being collected in this session, stay in that flow.
  if (session.draft) {
    const { reply, draft, createdCode } = await bookingFlow.step(session.draft, userMessage);
    session.draft = draft;
    if (createdCode) session.lastBookingCode = createdCode;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, expecting: expectingField(draft), quickReplies: quickRepliesFor(draft) };
  }

  // Otherwise check if this message wants to start a new booking/quotation.
  const createIntent = bookingFlow.detectCreateIntent(userMessage);
  if (createIntent) {
    // Ambiguous phrasing ("the new booking") gets confirmed first — starting a 15-question flow by
    // mistake used to be effectively unrecoverable.
    if (!createIntent.confident) {
      session.pendingCreateConfirm = { kind: createIntent.kind, originalMessage: userMessage };
      const reply = `Just to confirm — do you want me to **create a brand-new ${createIntent.kind}** and collect its details? (yes/no)\n\nIf you meant to look something up instead, just say no or ask again in other words.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    const newDraft = bookingFlow.startDraft(createIntent.kind);
    const { reply, draft, createdCode } = await bookingFlow.step(newDraft, userMessage);
    session.draft = draft;
    if (createdCode) session.lastBookingCode = createdCode;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, expecting: expectingField(draft), quickReplies: quickRepliesFor(draft) };
  }

  // Or a request to change one of a booking's status dropdowns (Travel/Invoice/Voucher/
  // Itinerary/Payment) - the only write path besides booking creation. Uses the real site's own
  // updateStatus endpoint with allow-listed values only, and always confirms before submitting.
  const statusIntent = statusUpdate.detectStatusUpdateIntent(userMessage, session.lastBookingCode);
  if (statusIntent) {
    const result = await statusUpdate.start(statusIntent, userMessage);
    if (result.ambiguous) {
      return askWhichRecord(sessionId, session, userMessage, statusIntent.code, result.matches, 'statusUpdate', { userMessage });
    }
    session.pendingStatusChange = result.pending;
    pushTurn(sessionId, userMessage, result.reply);
    return { answer: result.reply, sql: null, rowCount: 0 };
  }

  // Or a request for an invoice/itinerary/hotel voucher PDF - handled deterministically (no
  // LLM/SQL needed), since the download link must be built from a real, verified booking id (and
  // for hotel vouchers, a real BookingHotel id), never guessed.
  const docIntent = documents.detectDocumentIntent(userMessage, session.lastBookingCode);
  if (docIntent) {
    if (docIntent.type === 'needsCode') {
      const reply = `Which booking or quotation is that for? Please give me the code (e.g. FT08261781 or FTQ05260001).`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    const { reply, pendingItinerary, pendingDocChoice, pendingHotelChoice, pendingCodeChoice } = await documents.handleDocumentRequest(docIntent);
    if (pendingItinerary) session.pendingItinerary = pendingItinerary;
    if (pendingDocChoice) session.pendingDocChoice = pendingDocChoice;
    if (pendingHotelChoice) session.pendingHotelChoice = pendingHotelChoice;
    if (pendingCodeChoice) session.pendingCodeChoice = pendingCodeChoice;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, expecting: logoChoiceExpecting(session), quickReplies: logoChoiceQuickReplies(session) };
  }

  // Cross-booking financial totals ("this month's income", "how much is receivable") - checked
  // before the per-booking account-transactions/full-detail intents below and well before the
  // generic LLM planner, which would silently double-count AccountTransaction's paired debit/
  // credit legs or mis-sign the numbers - the same risk class the ledger module below and
  // financeReports.js itself were built to avoid. Skipped entirely when an FT/FTQ code is present -
  // "amount due for FT08261781" is a per-booking question (handled below/by the planner), not an
  // aggregate one, even though it matches the same wording.
  const financeIntent = !ANY_CODE_RE.test(userMessage) ? financeReports.detectFinanceReportIntent(userMessage) : null;
  if (financeIntent) {
    if (financeIntent.kind === 'income') {
      const result = await financeReports.fetchIncomeReport(financeIntent.period);
      const reply = financeReports.formatIncomeAnswer(result);
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    if (financeIntent.kind === 'paymentReceived') {
      const result = await financeReports.fetchPaymentReceivedReport(financeIntent.period);
      const reply = financeReports.formatPaymentReceivedAnswer(result);
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: result.byCurrency.length, rows: result.byCurrency.length ? result.byCurrency : undefined };
    }
    if (financeIntent.kind === 'receivable') {
      const result = await financeReports.fetchReceivableReport();
      const reply = financeReports.formatReceivableAnswer(result);
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    if (financeIntent.kind === 'profitUnsupported') {
      const reply = financeReports.formatProfitUnsupportedAnswer();
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    // 'summary' - the catch-all for any other finance/account-shaped question (total purchase,
    // expenses, net balance, ...) that isn't one of the three specific formats above.
    const result = await financeReports.fetchAccountSummary(financeIntent.period);
    const reply = financeReports.formatAccountSummaryAnswer(result);
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }

  // A request for a booking's ledger/account transactions - handled deterministically end to end
  // (fixed SQL + hand-built markdown, no LLM step at all). This mirrors a real accounting screen
  // to the cent: AccountTransaction stores every voucher as 2 rows (Credit leg + Debit leg) that
  // the site merges into 1 display row, and getting that merge (and the INR-vs-foreign-currency
  // formatting) right is exactly the kind of thing an LLM was shown to occasionally get wrong
  // elsewhere in this file - not a risk worth taking on financial totals.
  const acctTxnIntent = accountTransactions.detectAccountTransactionsIntent(userMessage, session.lastBookingCode);
  if (acctTxnIntent) {
    const result = await accountTransactions.fetchAccountTransactions(acctTxnIntent);
    // acctTxnIntent may have been resolved by an explicit FT/FTQ code OR by a bare guest name
    // (e.g. "account detail of guest karan") - .code is only set in the former case.
    const label = acctTxnIntent.code || acctTxnIntent.guestName;
    if (result.status === 'not_found') {
      const reply = `I couldn't find any booking or quotation matching **${label}** in the database.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    if (result.status === 'ambiguous') {
      const list = result.matches.map((m) => `- **${m.BookingId || m.QuotationId}** (${m.GuestName})`).join('\n');
      const hint = acctTxnIntent.code ? 'Please ask again including the guest\'s name too.' : 'Please ask again using the specific FT/FTQ code.';
      const reply = `More than one record matches **${label}** — which one did you mean?\n\n${list}\n\n${hint}`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: result.matches.length };
    }
    const reply = accountTransactions.formatAccountTransactionsAnswer(result);
    const rows = [...result.salePurchase, ...result.receiptPayment];
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: rows.length, rows: rows.length ? rows : undefined, rowsTruncated: false };
  }

  // Broad "booking detail" requests are fetched deterministically (fixed SQL, not LLM-authored)
  // so hotel/itinerary/cost data is always included - never left to the planner LLM's judgment
  // on whether to join those tables (it was found to sometimes skip them).
  const fullDetailIntent = bookingDetails.detectFullDetailIntent(userMessage);
  if (fullDetailIntent) {
    const resolved = await bookingDetails.fetchFullBookingDetails(fullDetailIntent);

    if (resolved.status === 'not_found') {
      const reply = `I couldn't find any booking or quotation matching **${fullDetailIntent.code}** in the database.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }

    if (resolved.status === 'ambiguous') {
      const list = resolved.matches
        .map((m) => `- **${m.BookingId || m.QuotationId}** (${m.GuestName})`)
        .join('\n');
      const reply = `That number matches more than one record — did you mean one of these?\n\n${list}\n\nPlease ask again with the full code.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: resolved.matches.length };
    }

    const answererMessages = [
      { role: 'system', content: answererSystemPrompt() },
      {
        role: 'user',
        content: `User's question: ${userMessage}\n\nFull booking data, as JSON (booking = main record, hotels = hotel stays, hotelExtras = extra charges per hotel keyed by BookingHotelId, itinerary = day-by-day activities, costBreakdown = traveller-type pricing rows, costSummary = precomputed Total Cost/ROE/Total After ROE/Discount/Final Amount - already calculated correctly, just format it, do not recompute):\n${JSON.stringify(resolved.data)}`,
      },
    ];
    const answer = dedupeMarkdownTableRows(await callLLM(answererMessages, { temperature: 0.2 }));
    pushTurn(sessionId, userMessage, answer);
    return { answer, sql: null, rowCount: 1 };
  }

  const plannerMessages = [
    { role: 'system', content: plannerSystemPrompt() },
    ...session.history,
    { role: 'user', content: userMessage },
  ];

  let plannerReply = await callLLM(plannerMessages);
  let sql = extractSql(plannerReply);

  if (!sql) {
    // Direct chit-chat style reply, no DB involved.
    pushTurn(sessionId, userMessage, plannerReply);
    return { answer: plannerReply, sql: null, rowCount: 0 };
  }

  let queryResult;
  let lastError = null;
  for (let attempt = 0; attempt < 2 && !queryResult; attempt++) {
    try {
      // Fetch a generous number of rows so the UI's "Show more" table has real data to expand into,
      // but only a small sample of that goes into the LLM prompt below (see SAMPLE_ROWS_FOR_LLM) -
      // Groq's free tier has a tokens-per-minute limit, so we keep what we send the model small.
      queryResult = await runReadOnlyQuery(sql, 300);
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        // give the model one chance to fix its query
        const fixReply = await callLLM([
          { role: 'system', content: plannerSystemPrompt() },
          { role: 'user', content: userMessage },
          { role: 'assistant', content: plannerReply },
          { role: 'user', content: `That query failed with this database error: "${err.message}". Please reply with ONLY a corrected single SELECT query in a \`\`\`sql code block.` },
        ]);
        const fixedSql = extractSql(fixReply);
        if (fixedSql) sql = fixedSql;
        else break;
      }
    }
  }

  if (!queryResult) {
    const apology = `Sorry, I ran into trouble fetching that data from the database (${lastError ? lastError.message : 'unknown error'}). Could you try rephrasing your question?`;
    pushTurn(sessionId, userMessage, apology);
    return { answer: apology, sql, rowCount: 0, error: lastError?.message };
  }

  // A JOIN across a one-to-many table (itinerary items, hotels, etc.) that the query didn't need
  // to actually SELECT anything from still fans a booking out into several rows - byte-identical
  // across every column that WAS selected. That's invisible to the prose answer (rowCountRule
  // already tells the model to merge them into one line there), but the raw rows/rowCount sent to
  // the client feed the "View N records" side-drawer directly - reproduced live: a 2-booking answer
  // whose drawer showed "20 records" with the same row repeated up to 10x. Only collapses rows that
  // are fully identical (every selected column, not just the booking code), so a query that
  // legitimately returns several different rows per booking (e.g. one per hotel) is untouched.
  const dedupedRows = dedupeExactRows(queryResult.rows);
  queryResult = {
    ...queryResult,
    rows: dedupedRows,
    // rowCount otherwise feeds the "Showing X of Y total" truncated-result message - only safe to
    // replace with the deduped count when rows is the COMPLETE result (untruncated), since we can't
    // know how much duplication is hiding beyond whatever we capped the fetch at.
    rowCount: queryResult.truncated ? queryResult.rowCount : dedupedRows.length,
  };

  const SAMPLE_ROWS_FOR_LLM = 20;
  const sampleRows = buildSample(queryResult.rows, SAMPLE_ROWS_FOR_LLM);

  // The old wording ("N row(s) total, only the first M are shown") described raw rows, which after
  // a join fan-out is not the number of bookings and contradicted the counting rule appended
  // below. rowCountRule is now the only place that talks about totals.
  const answererMessages = [
    { role: 'system', content: answererSystemPrompt() },
    {
      role: 'user',
      content: `User's question: ${userMessage}\n\nQuery result rows:\n${JSON.stringify(sampleRows)}${rowCountRule(sampleRows, queryResult.rows)}`,
    },
  ];
  const answer = dedupeMarkdownTableRows(await callLLM(answererMessages, { temperature: 0.2 }));

  pushTurn(sessionId, userMessage, answer);
  return {
    answer,
    sql,
    rowCount: queryResult.rowCount,
    rows: queryResult.rows,
    rowsTruncated: queryResult.truncated,
  };
}

module.exports = { handleChat, cancelFlows };
