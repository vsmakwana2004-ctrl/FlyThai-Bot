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
const duplicateBooking = require('./duplicateBooking');
const bookingEditForms = require('./bookingEditForms');
const { findBookingById } = require('./bookingApi');
const { isAnyCancel } = require('./cancel');
const { findDestinations, listDestinations, findHotel, findHotelRoomType } = require('./lookups');
const jobSheetCopy = require('./jobSheetCopy');
const agentCreate = require('./agentCreate');

// Simple in-memory per-session state (server restarts clear it — fine for an internal tool).
const sessions = new Map();
const MAX_TURNS = 6; // user+assistant pairs kept for context

function getSession(sessionId) {
  if (!sessions.has(sessionId))
    sessions.set(sessionId, {
      history: [],
      draft: null,
      pendingItinerary: null,
      pendingDocChoice: null,
      pendingHotelChoice: null,
      pendingCodeChoice: null,
      pendingRecordChoice: null,
      pendingStatusChange: null,
      pendingCreateConfirm: null,
      pendingConvertConfirm: null,
      pendingFieldEditConfirm: null,
      pendingAgentCreate: null,
      pendingAddHotel: null,
      pendingAmbiguousDetail: null,
      lastBookingCode: null,
      // Interrupt-and-resume (see detectAnyFreshIntent/handleChatInner's interrupt check and
      // handleChat's resume check below): pausedFlows is a stack so a request can interrupt an
      // already-interrupted flow too, each popped back in reverse order. lastFlowSnapshot is
      // refreshed after every turn a flow is active, so whichever one is live always has an
      // up-to-date {reply, expecting, quickReplies} ready to pause if the very next message
      // turns out to be an interruption.
      pausedFlows: [],
      lastFlowSnapshot: null,
    });
  return sessions.get(sessionId);
}

// Single source of truth for every session field that represents "a guided flow is waiting on the
// next message" - isFlowActive/cancelFlows/activeStateKey (interrupt-and-resume, below) all derive
// from this same list so they can never drift out of sync with each other again.
const PENDING_STATE_KEYS = [
  'draft',
  'pendingStatusChange',
  'pendingItinerary',
  'pendingDocChoice',
  'pendingHotelChoice',
  'pendingCodeChoice',
  'pendingRecordChoice',
  'pendingCreateConfirm',
  'pendingConvertConfirm',
  'pendingFieldEditConfirm',
  'pendingDuplicateConfirm',
  'pendingPostDuplicateEdit',
  'pendingEditSectionChoice',
  'pendingBasicFieldChoice',
  'pendingHotelRowChoice',
  'pendingFieldValueEntry',
  'pendingDestinationsEntry',
  'pendingHotelFieldChoice',
  'pendingHotelFieldValue',
  'pendingHotelFieldConfirm',
  'pendingFieldSectionChoice',
  'pendingFieldSectionValue',
  'pendingFieldSectionConfirm',
  'pendingAgentCreate',
  'pendingAddHotel',
  'pendingAmbiguousDetail',
];

// True while the session is inside a guided multi-message flow, so the UI can offer a visible
// "Cancel" button instead of relying on the user knowing the right word to type.
function isFlowActive(session) {
  return PENDING_STATE_KEYS.some((key) => !!session[key]);
}

// Whichever ONE of PENDING_STATE_KEYS is currently truthy (this codebase never has more than one
// active at once - every entry point into a new flow only fires from a fully clean session), or
// null if none is. Used by the interrupt-and-resume mechanism to know which field to snapshot/
// restore without hardcoding a duplicate list of its own.
function activeStateKey(session) {
  return PENDING_STATE_KEYS.find((key) => !!session[key]) || null;
}

// Hard reset of every guided flow - what the UI's Cancel button calls. Deliberately unconditional
// so it can never itself get stuck on parsing.
function cancelFlows(sessionId) {
  const session = getSession(sessionId);
  const wasActive = isFlowActive(session);
  for (const key of PENDING_STATE_KEYS) session[key] = null;
  return wasActive;
}

// Cheap, synchronous "would ANY fresh-message intent fire for this text" check - reuses every
// intent detector the fresh-message dispatch chain in handleChatInner already calls, WITHOUT
// actually resolving/running any of them (no DB calls, no side effects). Used only to decide
// whether a message arriving while a flow is already active should interrupt it - see
// handleChatInner's interrupt check below, which (if this returns true) pauses the active flow and
// lets the SAME message fall through to that real dispatch chain afterward, unchanged.
// Deliberately does NOT fall back to "did nothing else match" (the generic SQL-planner path has no
// detector of its own - it's the last resort for everything else) - that would make literally any
// unrecognised text interrupt the active flow, including a plain answer like a guest's name that
// just doesn't happen to look like anything else. Only a SPECIFIC, high-precision intent match
// counts as an interruption.
function detectAnyFreshIntent(userMessage, session) {
  const specificMatch = !!(
    convertBooking.detectConvertIntent(userMessage, session.lastBookingCode) ||
    duplicateBooking.detectDuplicateIntent(userMessage, session.lastBookingCode) ||
    editBooking.detectSimpleFieldEditIntent(userMessage, session.lastBookingCode) ||
    editBooking.detectItineraryEditIntent(userMessage, session.lastBookingCode) ||
    detectEditMenuIntent(userMessage, session.lastBookingCode) ||
    bookingFlow.detectCreateIntent(userMessage) ||
    agentCreate.detectAgentCreateIntent(userMessage) ||
    statusUpdate.detectStatusUpdateIntent(userMessage, session.lastBookingCode) ||
    jobSheetCopy.detectJobSheetCopyIntent(userMessage, session.lastBookingCode, todayIST()) ||
    documents.detectDocumentIntent(userMessage, session.lastBookingCode) ||
    (!ANY_CODE_RE.test(userMessage) && financeReports.detectFinanceReportIntent(userMessage)) ||
    accountTransactions.detectAccountTransactionsIntent(userMessage, session.lastBookingCode) ||
    bookingDetails.detectFullDetailIntent(userMessage) ||
    bookingFlow.looksLikeStandaloneAgentPaste(userMessage)
  );
  if (specificMatch) return true;

  // A plain read-only question ("what is the status of FT08261803", "give me details of FTQ...")
  // often matches none of the specific detectors above by design - detectStatusUpdateIntent, for
  // instance, deliberately only fires on a change INSTRUCTION, never a question. Those questions
  // have no detector of their own; they're answered by the generic SQL-planner fallback, which this
  // function otherwise never treats as a signal (see the function's own top comment for why). But a
  // DIFFERENT FT/FTQ code than whatever the active flow already concerns itself with is still a
  // strong, low-risk signal of a genuine context switch on its own - the same "different code means
  // different intent" rule the narrower pendingXxx.code guard elsewhere in this file already uses.
  // Falling through to the fresh-dispatch chain with nothing else active naturally lands such a
  // question on that same SQL-planner path and answers it correctly.
  const codeMatch = userMessage.match(ANY_CODE_RE);
  if (!codeMatch) return false;
  const activeCode = getActiveFlowCode(session);
  return !activeCode || activeCode.toUpperCase() !== codeMatch[0].toUpperCase();
}

// The record code (if any) the currently active flow already concerns itself with - draft-based
// flows only carry one via editContext (an itinerary-edit draft seeded from a live record); a
// brand-new booking/quotation draft has no code yet at all. Every pendingXxx shape that's about a
// specific record stores it as a plain .code property.
function getActiveFlowCode(session) {
  const key = activeStateKey(session);
  if (!key) return null;
  if (key === 'draft') return (session.draft.editContext && session.draft.editContext.code) || null;
  const state = session[key];
  return (state && state.code) || null;
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
  if (!sawCodeColumn) return null;

  // Not every repeat of a Booking/Quotation ID is a join fan-out of the SAME record - a query about
  // a child table with many rows per booking (JobSheetMaster: one row per itinerary item, each with
  // its own lunch/dinner status; PaymentMaster/AccountTransaction: one row per transaction) legitimately
  // returns several real, distinct records that just happen to share a booking code. Collapsing those
  // down to "1 per booking" (as below) previously turned "1632 job sheets pending" into a wrong "46
  // bookings," contradicting the raw row count shown in the side drawer. A genuine surrogate primary
  // key column (JobSheetId, TransactionId, PaymentId, ...) is 100% unique across the whole result set
  // by definition - unlike a joined dimension's foreign key (DestinationId, HotelId), which repeats
  // whenever two different bookings share the same destination/hotel. If one is present, each row is
  // already its own distinct record - don't merge by booking code.
  const sample = rows[0] || {};
  for (const key of Object.keys(sample)) {
    if (key === 'BookingId' || key === 'QuotationId' || !/Id$/.test(key)) continue;
    const values = rows.map((r) => r && r[key]).filter((v) => v !== null && v !== undefined);
    if (values.length !== rows.length) continue;
    if (new Set(values.map(String)).size === rows.length) return null;
  }

  return codes.size;
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

// Runs BEFORE any SQL is written - asks the model to restate what the question is actually asking
// for, grounded in the real schema (which table(s), which columns, which filters, how tables relate
// if a join is needed), instead of jumping straight from question to query in one shot. Genuinely
// reduces wrong/half-right SQL on ambiguous or multi-step questions ("top agents by bookings last
// quarter" needs a GROUP BY + date filter + ORDER BY all correctly combined) by forcing the model to
// reason about intent first. Costs a second Groq call per question - this app's free-tier quota is
// already juggled across several models/keys (see llm.js) specifically because of that added load,
// so this is deliberately only used for the read-only Q&A path, not the booking-creation/status
// flows, which stay single-call and deterministic.
function understandSystemPrompt() {
  return `You are FlyThai's internal database assistant. Before any SQL gets written, restate what this question is actually asking for, in concrete terms grounded in the real schema below - which table(s), which columns, which filters (dates, statuses, IDs, names), and how multiple tables relate if a join is needed. If the question is ambiguous, state the most reasonable interpretation and any assumption you're making explicit (e.g. "this month" -> the current calendar month, "top agents" -> ranked by count of their bookings).
Today's date is ${todayIST()} and the current time is ${nowTimeIST()} (Asia/Kolkata timezone).

DATABASE SCHEMA:
${SCHEMA_DOC}

Reply with a short plain-text plan only (3-6 lines) - table(s)/columns/filters/joins needed and why. Do NOT write SQL here. If the message is a greeting, thanks, or general chit-chat that clearly needs no DB lookup, reply with exactly: NONE`;
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

// Always builds the "Cost Breakdown" section of a full-detail answer deterministically - the
// answerer LLM was found to sometimes drop the whole section, and sometimes keep it but compute a
// row wrong (reproduced live for booking FT08261794/Devansh: it showed each row's raw per-person
// Price instead of Price x PAX). Same "don't trust an LLM with financial output" risk documented in
// accountTransactions.js. Mirrors the exact table shape the prompt itself asks for (Traveller | Pax
// | Amount, one row per costBreakdown entry, then costSummary's own already-computed totals
// appended as further rows), so it reads identically to what a correct model answer would look like
// - the caller always uses this in place of whatever the model produced for this section, never
// only as a gap-filler.
function buildCostBreakdownSection(data) {
  const costBreakdown = data.costBreakdown || [];
  const costSummary = data.costSummary;
  if (costBreakdown.length === 0 && !costSummary) return '';
  const currency = (costSummary && costSummary.currency) || (data.booking && data.booking.Currency) || '';
  const fmt = (n, curr) => `${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${curr ? ` ${curr}` : ''}`;

  let out = '### Cost Breakdown\n\n| Traveller | Pax | Amount |\n|---|---|---|\n';
  for (const row of costBreakdown) {
    const amount = (Number(row.Price) || 0) * (Number(row.PAX) || 0);
    out += `| ${row.Type} | ${row.PAX} | ${fmt(amount, currency)} |\n`;
  }
  if (costSummary) {
    out += `| Total Cost | — | ${fmt(costSummary.totalCost, currency)} |\n`;
    out += `| ROE | — | ${costSummary.roeRate} |\n`;
    out += `| ROE Charges | — | ${costSummary.roeCharge} |\n`;
    if (costSummary.totalAfterROE != null) out += `| Total After ROE | — | ${fmt(costSummary.totalAfterROE, 'INR')} |\n`;
    out += `| Discount | — | ${fmt(costSummary.discountINR, 'INR')} |\n`;
    if (costSummary.finalAmountINR != null) out += `| Final Amount | — | ${fmt(costSummary.finalAmountINR, 'INR')} |\n`;
  }
  return out;
}

function answererSystemPrompt() {
  return `You are FlyThai's internal database assistant. You previously ran a SQL query against the live database to answer the staff member's question. Using ONLY the JSON data provided (never invent anything beyond it), write a clear, helpful answer.
- Always reply in English, regardless of what language the question was asked in.
- If there are multiple records, use a compact markdown table.
- If there are more than ~15 records, do NOT dump every row into the table. Instead give the total count, any useful summary/breakdown, and show only the first 10-15 rows as a sample, mentioning that more exist.

MULTI-RECORD LIST ANSWERS — read this before writing any table with more than one data row:
- The JSON you are given is the complete, already-deduplicated result. Write EXACTLY ONE table row per record in it. If the JSON holds 3 records, the table has exactly 3 data rows — no more, ever.
- NEVER repeat a record. Two rows with the same Booking/Quotation ID is USUALLY a mistake — UNLESS the COUNTS note appended after the JSON explicitly says the total is a count of distinct records rather than distinct bookings (this happens for child-level data like job sheets, transactions, or payments, where a booking can genuinely have several of its own). In that case each row is its own real record and must get its own table row — do not merge them.
- Otherwise (no such COUNTS override), if several JSON rows share the same Booking/Quotation ID, they are ONE booking that a join has split across rows (e.g. one row per destination or per hotel). Merge them into a single table row — combining the differing values into one cell where useful (e.g. "Bangkok, Pattaya") — never list that booking twice.
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
Use this same structure consistently whether the user asks for "full details," just "status," or a narrower slice (e.g. "hotel details only") — just include only the relevant section(s) in that case, with the same header/table style, not a different format.

JOB SHEET / VENDOR CONFIRMATION LIST ANSWERS — always use this fixed layout for any question about job sheets, vendor confirmation status, or customer update status (e.g. "today's pending vendor confirmation," "all bookings with vendor confirmation pending," "job sheets with lunch status pending"):
- One markdown table row per job sheet (JobSheetMaster row) — per the MULTI-RECORD LIST rule above, several job sheets sharing one Booking ID are separate real records here and each gets its own row, never merged.
- Table columns, in this order, including only the columns the JSON actually has data for: Booking ID | Guest Name | Vendor Name | Travel Date | Vendor Confirmation | Customer Update | Lunch Status | Dinner Status. (BookingSentStatus is "Vendor Confirmation", CustomerSentStatus is "Customer Update".)
- Open with the count exactly as the COUNTS note instructs (e.g. "Found 46 job sheets with vendor confirmation pending:").`;
}

// Turns a resolved (status 'ok') full-detail lookup into the final answer - shared by the first
// attempt (bookingDetails.detectFullDetailIntent matched unambiguously right away) and the
// pendingAmbiguousDetail continuation below (resolved via dropdown selection instead).
async function finishFullDetailAnswer(sessionId, userMessage, resolved) {
  const answererMessages = [
    { role: 'system', content: answererSystemPrompt() },
    {
      role: 'user',
      content: `User's question: ${userMessage}\n\nFull booking data, as JSON (booking = main record, hotels = hotel stays, hotelExtras = extra charges per hotel keyed by BookingHotelId, itinerary = day-by-day activities, costBreakdown = traveller-type pricing rows, costSummary = precomputed Total Cost/ROE/Total After ROE/Discount/Final Amount - already calculated correctly, just format it, do not recompute):\n${JSON.stringify(resolved.data)}`,
    },
  ];
  let answer = dedupeMarkdownTableRows(await callLLM(answererMessages, { temperature: 0.2 }));
  // See buildCostBreakdownSection's own comment - the model asked for this section sometimes drops
  // it entirely, and sometimes keeps the section but gets a row wrong (reproduced live for
  // FT08261794/Devansh: it showed each row's raw per-person Price instead of Price x PAX - e.g.
  // "THB 10,000" for a 3-pax row that should read 30,000 - a real financial figure staff could act
  // on, even though the Total Cost line taken straight from costSummary was correct). Always REPLACE
  // whatever the model produced for this section (or insert one if it produced none) with a
  // deterministically-built one, rather than only filling a gap - money math here is never trusted
  // to the model, matching the same standard accountTransactions.js already applies.
  const hasCostData = (resolved.data.costBreakdown && resolved.data.costBreakdown.length > 0) || resolved.data.costSummary;
  if (hasCostData) {
    const withoutLLMSection = answer.replace(/###\s*cost breakdown[\s\S]*?(?=\n###\s|$)/i, '').trim();
    const section = buildCostBreakdownSection(resolved.data);
    // Keeps the fixed section order the prompt itself specifies (Cost Breakdown before Payments/Job
    // Sheet/Other) when that section is present; otherwise just appends at the end.
    answer = /###\s*payments/i.test(withoutLLMSection)
      ? withoutLLMSection.replace(/(?=###\s*payments)/i, `${section}\n\n`)
      : `${withoutLLMSection}\n\n${section}`;
  }
  pushTurn(sessionId, userMessage, answer);
  return { answer, sql: null, rowCount: 1 };
}

// Same idea for a resolved (status 'ok') account-transactions lookup.
function finishAcctTxnAnswer(sessionId, userMessage, result) {
  const reply = accountTransactions.formatAccountTransactionsAnswer(result);
  const rows = [...result.salePurchase, ...result.receiptPayment];
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: rows.length, rows: rows.length ? rows : undefined, rowsTruncated: false };
}

const ANY_CODE_RE = /\bFTQ?\d+\b/i;

// Shared one-tap Yes/No confirmation chips - autoSend since each is a complete answer on its own,
// same convention quickRepliesFor's own yes/no gates (hotelAddAnother, the draft confirm phases)
// already use, just reused here for the record-level (duplicate/field-edit) confirmations that live
// outside a booking draft.
const YES_NO_CHIPS = [
  { label: 'Yes', value: 'yes', autoSend: true },
  { label: 'No', value: 'no', autoSend: true },
];

// "What would you like to update?" top-level menu shown after a duplicate (or any time editing a
// record is offered as a menu rather than typed from memory) - mirrors the real Edit Booking page's
// own section layout (Basic Details / Hotel Details / Itinerary Details / General Remarks / Price
// Details / Extra Note and Emergency Contact) so staff pick a section the same way they would on the
// real site, then a second chip step narrows to the specific field/form within it.
const EDIT_SECTION_CHIPS = [
  { label: 'Basic Details', value: 'basic details', autoSend: true },
  { label: 'Hotel Details', value: 'hotel details', autoSend: true },
  { label: 'Itinerary Details', value: 'itinerary details', autoSend: true },
  { label: 'General Remarks', value: 'general remarks', autoSend: true },
  { label: 'Price Details', value: 'price details', autoSend: true },
  { label: 'Extra Note & Emergency Contact', value: 'extra note', autoSend: true },
  { label: 'Nothing else', value: 'done', autoSend: true },
];

// Basic Details' own field picker - travel/return date are deliberately still excluded: changing
// them here wouldn't cascade to the hotel/itinerary rows already dated against the OLD dates (those
// live in separate tables this patch never touches), which could silently leave a booking with a
// hotel check-in outside its own travel window. Destinations carries a smaller version of that same
// risk (a hotel could reference a destination no longer on the list) but is common enough to edit
// (adding/dropping a stop) that it's included - handled specially below (pendingDestinationsEntry),
// not through the generic pendingFieldValueEntry text-value path, since it needs the same
// multi-select checklist + real-record resolution the new-booking creation flow uses.
const BASIC_FIELD_CHOICE_CHIPS = [
  { label: 'Guest Name', value: 'guest name', autoSend: true },
  { label: 'Phone Number', value: 'phone number', autoSend: true },
  { label: 'Email', value: 'email', autoSend: true },
  { label: 'Company Name', value: 'company name', autoSend: true },
  { label: 'Address', value: 'address', autoSend: true },
  { label: 'Destinations', value: 'destinations', autoSend: true },
  { label: 'Adults', value: 'adults', autoSend: true },
  { label: 'Children', value: 'children', autoSend: true },
  { label: 'Infants', value: 'infants', autoSend: true },
  { label: 'Back', value: 'back', autoSend: true },
];

// Matches a BASIC_FIELD_CHOICE_CHIPS pick (or free-typed equivalent) back to the exact field
// key/label editBooking.js's applySimpleFieldEdit expects - same small explicit list as
// editBooking.js's own FIELD_ALIASES, kept separate rather than imported so this file's chip
// wording can stay independent of that file's "update X to Y" sentence-parsing patterns. Does NOT
// include 'destinations' - that's matched and handled separately (its own resolution step), before
// this list is even consulted.
const EDIT_FIELD_KEY_BY_CHOICE = [
  { pattern: /\bcompany\b/i, key: 'guestCompany', label: 'Company name' },
  { pattern: /\bphone\b/i, key: 'guestPhoneNumber', label: 'Phone number' },
  { pattern: /\bemail\b/i, key: 'guestEmail', label: 'Email' },
  { pattern: /\bguest\s*name\b/i, key: 'guestName', label: 'Guest name' },
  { pattern: /\baddress\b/i, key: 'guestAddress', label: 'Address' },
  { pattern: /\badults\b/i, key: 'guestAdults', label: 'Adults' },
  { pattern: /\bchildren\b/i, key: 'guestChildrens', label: 'Children' },
  { pattern: /\binfants\b/i, key: 'guestInfants', label: 'Infants' },
];

// Detects a direct "edit the basic details of FT...", "edit hotel details of FT...", "update
// booking FT..." style command that should open the SAME section-menu system the post-duplicate
// offer opens, for an EXISTING record - not just reachable right after duplicating one. Checked
// after (and so loses to) the more specific detectSimpleFieldEditIntent ("...to <value>") and
// detectItineraryEditIntent ("add/edit itinerary...") intents further down, which already cover
// their own narrower phrasing with a direct save, not a menu.
const EDIT_MENU_VERB_RE = /\b(edit|update|modify|change)\b/i;
// Read-style questions ("what changed on FT...", "did anything update on FT...") legitimately
// contain these verbs without being an edit request - bail out on a leading question/lookup word,
// same guard bookingFlow.js's detectCreateIntent uses for its own read/write ambiguity.
const EDIT_MENU_READ_LEAD_RE = /^\s*(show|list|display|find|search|fetch|what|which|who|when|where|how\s+many|how\s+much|tell|is|are|do|does|did|has|have)\b/i;
function detectEditMenuIntent(text, lastBookingCode) {
  if (EDIT_MENU_READ_LEAD_RE.test(text)) return null;
  if (!EDIT_MENU_VERB_RE.test(text)) return null;
  const codeMatch = text.match(ANY_CODE_RE);
  const code = codeMatch ? codeMatch[0].toUpperCase() : lastBookingCode;
  if (!code) return null;
  return { code, sectionText: text };
}

// Hotel Details' own field picker - single-field-at-a-time like Basic Details, rather than one
// combined generic form, SPECIFICALLY so Room Category and the two dates get the same real
// dropdown/calendar UI bookingFlow.js's own hotelCollect step already gives them when adding a NEW
// hotel (roomType lookup scoped to this exact hotel, date picker bounded to the trip's travel
// window) - a plain text box for these was a visible step down from how every other lookup-backed
// field in the app already works.
const HOTEL_FIELD_CHOICE_CHIPS = [
  { label: 'Room Category', value: 'room category', autoSend: true },
  { label: 'Total Rooms', value: 'total rooms', autoSend: true },
  { label: 'Total Nights', value: 'total nights', autoSend: true },
  { label: 'Rate Per Night', value: 'rate per night', autoSend: true },
  { label: 'Check-in Date', value: 'check-in date', autoSend: true },
  { label: 'Check-out Date', value: 'check-out date', autoSend: true },
  { label: 'Breakfast', value: 'breakfast', autoSend: true },
  { label: 'Done', value: 'done', autoSend: true },
];

const HOTEL_FIELD_KEY_BY_CHOICE = [
  { pattern: /\broom\s*category\b/i, key: 'roomCategory', label: 'Room Category' },
  { pattern: /\btotal\s*rooms\b/i, key: 'totalRooms', label: 'Total Rooms' },
  { pattern: /\btotal\s*nights\b/i, key: 'totalNights', label: 'Total Nights' },
  { pattern: /\brate\b/i, key: 'ratePerNight', label: 'Rate Per Night' },
  { pattern: /\bcheck.?in\b/i, key: 'checkInDate', label: 'Check-in Date' },
  { pattern: /\bcheck.?out\b/i, key: 'checkOutDate', label: 'Check-out Date' },
  { pattern: /\bbreakfast\b/i, key: 'breakfast', label: 'Breakfast' },
];

// Price Details / General Remarks / Extra Note & Emergency Contact - like Hotel Details, edited one
// field at a time (openFieldSection/pendingFieldSectionChoice below) rather than one combined
// generic form, so a date field gets the real calendar and a yes/no field gets real Yes/No chips
// instead of typed text - same "look like the real booking flow, not a generic form" standard
// Hotel/Basic Details already follow. type drives both the `expecting`/quickReplies shown when
// asking for the value AND how the typed/picked answer is parsed (see pendingFieldSectionValue).
const FIELD_SECTIONS = {
  price: {
    title: 'Price Details',
    fields: [
      { key: 'roerate', label: 'ROE Rate', type: 'number' },
      { key: 'roecharge', label: 'ROE Charge', type: 'number' },
      { key: 'taxAmount', label: 'Tax Amount', type: 'number' },
      { key: 'taxPercentage', label: 'Tax %', type: 'number' },
      { key: 'landSelling', label: 'Land Selling', type: 'number' },
      { key: 'invoiceDiscount', label: 'Invoice Discount', type: 'number' },
      { key: 'invoiceDueDate', label: 'Invoice Due Date', type: 'date' },
    ],
  },
  remarks: {
    title: 'General Remarks',
    fields: [
      { key: 'lunchDetails', label: 'Lunch Details', type: 'text' },
      { key: 'lunchRemarks', label: 'Lunch Remarks', type: 'text' },
      { key: 'dinnerDetails', label: 'Dinner Details', type: 'text' },
      { key: 'dinnerRemarks', label: 'Dinner Remarks', type: 'text' },
    ],
  },
  extra: {
    title: 'Extra Note & Emergency Contact',
    fields: [
      { key: 'extraNote', label: 'Extra Note', type: 'text' },
      { key: 'emergencyContact', label: 'Emergency Contact', type: 'text' },
      { key: 'bookingBy', label: 'Booked By', type: 'text' },
      { key: 'isAllowForVoucher', label: 'Allow Voucher PDF', type: 'boolean' },
      { key: 'isAllowForInvoice', label: 'Allow Invoice PDF', type: 'boolean' },
      { key: 'isAllowForItinerary', label: 'Allow Itinerary PDF', type: 'boolean' },
    ],
  },
};

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
    const travelISO = ddmmyyyyToISO(draft.fields.travelDate);
    // A pasted itinerary with real "Day N:" lines (draft._agentItineraryQueue) means the return
    // date can't be earlier than that last day - Day 13 implies at least a 13-day trip, so every
    // date before travelDate + (maxDay - 1) is blanked out instead of just travelDate itself.
    const maxDay = bookingFlow.maxItineraryDay(draft);
    const min = maxDay && travelISO ? addDaysISO(travelISO, maxDay - 1) : travelISO || todayIST();
    return { field: 'date', params: { min } };
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
  // Optional per-item details (transfer/sightseeing/restaurant) - only reached once the user has
  // said yes to the gate question (see quickRepliesFor's *OptionalGate chips), same "gate before
  // form" pattern as extraGate/extraCollect below. One generic form, fields swapped per item type -
  // same LLM-parsed step*OptionalCollect() as before, just pre-composed instead of typed from memory.
  if (draft && draft.phase === 'transferOptionalCollect') {
    return {
      field: 'itineraryOptionalForm',
      params: {
        fields: [
          { key: 'time', label: 'Time', type: 'text', placeholder: 'e.g. 14:30' },
          { key: 'numberOfVehicles', label: 'Number of vehicles', type: 'number' },
          { key: 'vehiclePrice', label: 'Vehicle price', type: 'number' },
          { key: 'flightNo', label: 'Flight no', type: 'text' },
          { key: 'remarks', label: 'Remarks', type: 'text' },
        ],
      },
    };
  }
  if (draft && draft.phase === 'sightseeingOptionalCollect') {
    return {
      field: 'itineraryOptionalForm',
      params: {
        fields: [
          { key: 'totalAdult', label: 'Adults', type: 'number' },
          { key: 'adultPrice', label: 'Adult price', type: 'number' },
          { key: 'totalChild', label: 'Children', type: 'number' },
          { key: 'childPrice', label: 'Child price', type: 'number' },
          { key: 'remarks', label: 'Remarks', type: 'text' },
        ],
      },
    };
  }
  if (draft && draft.phase === 'restaurantOptionalCollect') {
    return {
      field: 'itineraryOptionalForm',
      params: {
        fields: [
          { key: 'lunchAdultCount', label: 'Lunch adults', type: 'number' },
          { key: 'lunchAdultPrice', label: 'Lunch adult price', type: 'number' },
          { key: 'lunchChildCount', label: 'Lunch children', type: 'number' },
          { key: 'lunchChildPrice', label: 'Lunch child price', type: 'number' },
          { key: 'dinnerAdultCount', label: 'Dinner adults', type: 'number' },
          { key: 'dinnerAdultPrice', label: 'Dinner adult price', type: 'number' },
          { key: 'dinnerChildCount', label: 'Dinner children', type: 'number' },
          { key: 'dinnerChildPrice', label: 'Dinner child price', type: 'number' },
          { key: 'remarks', label: 'Remarks', type: 'text' },
        ],
      },
    };
  }
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
  // The first question of a new booking/quotation (draft.phase === 'source') now asks directly for
  // the guest's name (or accepts a pasted travel-agent message) - see bookingFlow.js
  // stepSource/looksLikeAgentPaste - so there's no longer a separate manual-vs-agent choice to
  // render chips for here.
  if (draft && draft.phase === 'agentPasteConfirm') {
    return [
      { label: 'Yes, use these', value: 'yes, use these', autoSend: true },
      { label: 'No, enter manually', value: 'no, enter manually', autoSend: true },
    ];
  }
  // The guest's phone/email steps offer a "reply same to use the agent's own number/email"
  // shortcut (see bookingFlow.js's basicStepPrompt) - a one-tap chip beats typing "same" from
  // memory, and showing the actual number/email in the chip label means the value isn't hidden
  // behind the word "same". {label, value} lets the chip show the descriptive label while still
  // sending exactly "same" - the one word bookingFlow.js's stepBasic actually checks for.
  // autoSend: true because this is a single complete answer (not one of several fields to combine
  // in one message, the way the hotelOptionalCollect chips below are) - clicking it should submit
  // immediately, not just fill the box and wait for Send.
  if (draft && draft.phase === 'basic') {
    const next = bookingFlow.nextBasicStep(draft);
    if (next === 'guestPhoneNumber' && draft.resolvedAgent && draft.resolvedAgent.Phone) {
      return [{ label: `Same as agent (${draft.resolvedAgent.Phone})`, value: 'same', autoSend: true }];
    }
    if (next === 'guestEmail' && draft.resolvedAgent && draft.resolvedAgent.Email) {
      return [{ label: `Same as agent (${draft.resolvedAgent.Email})`, value: 'same', autoSend: true }];
    }
  }
  // A new agent/company's address is the one optional field in stepAgentCreate (phone/email are
  // validated and required) - "Skip" is a complete answer on its own, so it submits immediately
  // rather than filling the box.
  if (draft && draft.phase === 'agentCreate' && draft.agentCreateStep === 'address') {
    return [{ label: 'Skip', value: 'skip', autoSend: true }];
  }
  // "Use the same phone/email for the guest too?" gate, shown right after a brand-new agent/company
  // is created (see bookingFlow.js's stepAgentCreate) - plain yes/no gate, single-tap, auto-send.
  if (draft && draft.phase === 'agentCreate' && draft.agentCreateStep === 'sameAsGuest') {
    return [
      { label: 'Yes', value: 'yes', autoSend: true },
      { label: 'No', value: 'no', autoSend: true },
    ];
  }
  // Same "reply same" shortcut for a hotel row's rate-per-night, when the selected room type has
  // its own known rate (see hotelStepPrompt's 'ratePerNight' case).
  if (draft && draft.phase === 'hotelCollect' && draft.hotelStep === 'ratePerNight' && draft.currentHotelDraft && draft.currentHotelDraft._roomTypeRate != null) {
    const h = draft.currentHotelDraft;
    const currency = h._roomTypeCurrency || draft.fields.currency || 'THB';
    return [{ label: `Same as room type (${h._roomTypeRate} ${currency})`, value: 'same', autoSend: true }];
  }
  if (draft && draft.phase === 'hotelOptionalCollect') {
    // Skip is its own complete answer (there's nothing left to combine it with) so it submits
    // immediately - the other chips here stay fill-the-box, since picking one shouldn't cut off
    // the chance to also add another (e.g. "Breakfast included" + "Double sharing" together).
    return [
      { label: 'Skip', value: 'skip', autoSend: true },
      'Breakfast included',
      'No breakfast',
      'Single sharing',
      'Double sharing',
      'Triple sharing',
    ];
  }
  // "Add another hotel?" is a plain yes/no gate - single-tap, auto-send.
  if (draft && draft.phase === 'hotelAddAnother') {
    return [
      { label: 'Yes', value: 'yes', autoSend: true },
      { label: 'No', value: 'no', autoSend: true },
    ];
  }
  // The FIRST itinerary question (askItineraryChoice) offers 5 forks, each a complete answer -
  // auto-send like the other forks above.
  if (draft && draft.phase === 'itineraryChoice' && draft.itineraryItems && draft.itineraryItems.length === 0) {
    return [
      { label: 'Transfer', value: 'transfer', autoSend: true },
      { label: 'Sightseeing', value: 'sightseeing', autoSend: true },
      { label: 'Restaurant', value: 'restaurant', autoSend: true },
      { label: 'Leisure Day', value: 'leisure day', autoSend: true },
      { label: 'Self-booked', value: 'self-booked', autoSend: true },
    ];
  }
  // Once at least one item exists, this same phase re-asks via askAddMoreItinerary instead
  // (different wording, "done" instead of self-booked) - Done leads since staff wrap up an
  // itinerary far more often than they add a 3rd/4th item at this point.
  if (draft && draft.phase === 'itineraryChoice' && draft.itineraryItems && draft.itineraryItems.length > 0) {
    return [
      { label: 'Done', value: 'done', autoSend: true },
      { label: 'Transfer', value: 'transfer', autoSend: true },
      { label: 'Sightseeing', value: 'sightseeing', autoSend: true },
      { label: 'Restaurant', value: 'restaurant', autoSend: true },
      { label: 'Leisure Day', value: 'leisure day', autoSend: true },
    ];
  }
  // Self-booked vs add-details is a fork, not a field to combine with anything else - auto-send
  // like the phone/email "Same as..." chips above.
  if (draft && draft.phase === 'hotelChoice') {
    return [
      { label: 'Self-booked', value: 'self-booked', autoSend: true },
      { label: 'Add hotel details', value: 'add hotel details', autoSend: true },
    ];
  }
  // Traveller-type field: the real site's own #member-type autocomplete only ever offers these six
  // values (managebookings.js bindMemberType()) - chips beat typing one out from memory.
  if (draft && draft.phase === 'priceCollect' && draft.itemStep === 'type') {
    return ['Adult / Single', 'Adult / Double', 'Adult / Triple', 'Child With Bed', 'Child Without Bed', 'Infant'];
  }
  // First entry into pricing collection - "Skip" is a one-tap way out for staff with nothing to
  // add (the form below has no submit button of its own for an all-blank answer); "Add pricing
  // line" mirrors what typing anything other than a "no" here already does in stepPriceCollect.
  // Both are complete forks on their own - auto-send.
  if (draft && draft.phase === 'priceCollect' && !draft.currentItemDraft) {
    return [
      { label: 'Skip', value: 'skip', autoSend: true },
      { label: 'Add pricing line', value: 'add pricing line', autoSend: true },
    ];
  }
  // "Add another pricing line?" after one's just been added (stepPriceCollectAnother) - plain
  // yes/no gate, single-tap, auto-send, same as hotelAddAnother above.
  if (draft && draft.phase === 'priceCollectAnother') {
    return [
      { label: 'Yes', value: 'yes', autoSend: true },
      { label: 'No', value: 'no', autoSend: true },
    ];
  }
  if (draft && draft.phase === 'priceExtras') return ['Skip'];
  // Gate before the final note/emergency-contact/booked-by/PDF-permission form - most bookings
  // need none of it, so "Skip" goes straight to confirm without ever opening the form.
  if (draft && draft.phase === 'extraGate') {
    return [
      { label: 'Skip', value: 'skip', autoSend: true },
      { label: 'Yes, add details', value: 'yes, add details', autoSend: true },
    ];
  }
  if (draft && draft.phase === 'extraCollect') return ['Skip'];
  // Same gate-then-form pattern for each itinerary item's own optional details (time/vehicles/
  // price for a transfer, adults/children for sightseeing, lunch/dinner counts for a restaurant) -
  // most items need none of it, so "Skip" on the gate skips straight to "item added". Both replies
  // are complete answers on their own (yes opens the form below, no reason to hold off sending) -
  // auto-send, same as extraGate above.
  if (draft && (draft.phase === 'transferOptionalGate' || draft.phase === 'sightseeingOptionalGate' || draft.phase === 'restaurantOptionalGate')) {
    return [
      { label: 'Skip', value: 'skip', autoSend: true },
      { label: 'Yes, add details', value: 'yes, add details', autoSend: true },
    ];
  }
  if (draft && (draft.phase === 'transferOptionalCollect' || draft.phase === 'sightseeingOptionalCollect' || draft.phase === 'restaurantOptionalCollect')) {
    return ['Skip'];
  }
  // Final "Reply yes to save this, or no to cancel" confirmation (buildConfirmationSummary/
  // stepConfirm in bookingFlow.js) - a plain yes/no gate like hotelAddAnother above, so it gets
  // the same one-tap auto-send chips instead of making staff type "yes"/"no" by hand.
  if (draft && (draft.phase === 'confirm' || draft.phase === 'confirmNoSalesEntry' || draft.phase === 'confirmItineraryEdit')) {
    return [
      { label: 'Yes', value: 'yes', autoSend: true },
      { label: 'No', value: 'no', autoSend: true },
    ];
  }
  return null;
}

// Same "Skip" convenience for the standalone agent-creation flow's one optional field (see
// agentCreate.js) - address is skippable, name/phone/email are validated and required so there's
// nothing to render chips for on those steps.
function quickRepliesForAgentCreate(pending) {
  if (pending && pending.step === 'address') return [{ label: 'Skip', value: 'skip', autoSend: true }];
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
  let result = await handleChatInner(sessionId, userMessage);
  const session = getSession(sessionId);

  if (!isFlowActive(session) && session.pausedFlows.length > 0) {
    // Whatever just ran (the interruption, or a normal message with nothing paused before it) has
    // now fully finished on its own - resume the most recently paused flow by restoring its session
    // field and re-showing the exact question it was asking, so "continue back where we stopped"
    // means literally that, not just silently un-pausing state with no visible prompt.
    const paused = session.pausedFlows.pop();
    session[paused.stateKey] = paused.stateValue;
    result = {
      ...result,
      answer: `${result.answer}\n\n---\nContinuing where we left off:\n\n${paused.reply}`,
      expecting: paused.expecting,
      quickReplies: paused.quickReplies,
    };
    // Refreshed immediately so a SECOND interruption right after this one still has a correct,
    // up-to-date snapshot to pause in turn.
    session.lastFlowSnapshot = { reply: paused.reply, expecting: paused.expecting, quickReplies: paused.quickReplies };
  } else {
    const key = activeStateKey(session);
    if (key) session.lastFlowSnapshot = { reply: result.answer, expecting: result.expecting, quickReplies: result.quickReplies };
  }

  return { ...result, flowActive: isFlowActive(session) };
}

// Shared "which one did you mean?" prompt for a code that matched more than one real row (convert/
// field-edit/itinerary-edit/status-change all hit this the same way - see documents.js's
// resolveBookingByCode for why QuotationId isn't guaranteed unique). kind/extra are stashed on
// session.pendingRecordChoice so the next message can resume the right flow via resumeRecordChoice.
function askWhichRecord(sessionId, session, userMessage, code, matches, kind, extra) {
  const list = matches.map((m, i) => `${i + 1}. ${documents.describeMatch(m)}`).join('\n');
  const reply = `More than one record matches **${code}** — which one did you mean?\n\n${list}\n\n(Reply with the number.)`;
  session.pendingRecordChoice = { code, matches, kind, extra };
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: 0 };
}

// Same "which one did you mean?" situation as askWhichRecord above, but for the two read-only
// detail paths (full booking detail, account transactions) - rendered as a real dropdown popover
// (the same single-select lookup UI agent/hotel/destination already use) instead of a numbered
// list, since picking one is genuinely "select from these real records", not free text. Selecting
// an item sends back its own BookingId/QuotationId as plain text; pendingAmbiguousDetail below
// resolves it directly against pending.matches and re-runs the same lookup by internal Id - no
// re-parsing of "detail"/"account transactions" keywords needed.
function respondAmbiguousDetail(sessionId, session, userMessage, label, matches, kind) {
  // The list itself lives only in the dropdown below (expecting.options) - repeating it as text
  // here too was pure duplication, since selecting only ever happens from that dropdown anyway.
  const reply = `**${label}** matches more than one record — select the one you meant below.`;
  session.pendingAmbiguousDetail = { matches, kind };
  pushTurn(sessionId, userMessage, reply);
  return {
    answer: reply,
    sql: null,
    rowCount: matches.length,
    expecting: {
      field: 'ambiguousDetail',
      options: matches.map((m) => ({ Id: m.Id, Name: m.BookingId || m.QuotationId, ShortCode: m.GuestName })),
    },
  };
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
// .code/.field/.label/.value, plus optionally .displayValue (shown in messages instead of .value,
// for a field like destinations where the saved value - a comma Id list - isn't what a human should
// read back).
// Resolves a raw booking's comma-Id "destinations" string (e.g. "9,1") into real {Id, Name,
// ShortCode} rows, for pre-checking the destination checklist with the booking's CURRENT selection
// rather than starting it blank the way new-booking creation's own destinationNames step does.
async function resolveDestinationIdsToNames(destinationsCsv) {
  const ids = new Set((destinationsCsv || '').split(',').map((s) => s.trim()).filter(Boolean));
  if (ids.size === 0) return [];
  const all = await listDestinations('');
  return all.filter((d) => ids.has(String(d.Id)));
}

function finishFieldEditResolve(sessionId, session, userMessage, resolved, intentLike) {
  if (resolved.status === 'not_found') {
    const reply = `I couldn't find any booking or quotation matching **${intentLike.code}** in the database.`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }
  const shown = intentLike.displayValue != null ? intentLike.displayValue : intentLike.value;
  const reply = `Set **${intentLike.label}** for **${resolved.code}** (${resolved.guestName}) to "${shown}"? (yes/no)`;
  session.pendingFieldEditConfirm = {
    code: resolved.code,
    guestName: resolved.guestName,
    raw: resolved.raw,
    fieldKey: intentLike.field,
    label: intentLike.label,
    value: intentLike.value,
    displayValue: intentLike.displayValue,
    // Only set when this edit was reached via BASIC_FIELD_CHOICE_CHIPS (pendingFieldValueEntry
    // below) - true for that path, absent for the plain typed-from-scratch "update X to Y" path
    // further down, so only the menu-driven edit loops back to "anything else?" on success; a
    // one-off typed edit keeps its existing one-and-done behavior.
    viaMenu: !!intentLike.viaMenu,
  };
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
}

// After any menu-driven edit saves successfully, loop back to the top-level section menu instead
// of ending the chain - lets staff make several changes to the same record in one go.
function editSectionMenuAgain(sessionId, session, userMessage, doneMessage, code, guestName) {
  session.pendingEditSectionChoice = { code, guestName };
  const reply = `${doneMessage} Anything else you'd like to update on **${code}**?`;
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: 0, quickReplies: EDIT_SECTION_CHIPS };
}

// Opens whichever section `sectionText` names (basic/hotel/itinerary/price/remarks/extra), or the
// top-level EDIT_SECTION_CHIPS menu if none is named - the single place both entry points into this
// whole edit-menu system route through: the post-duplicate offer (pendingPostDuplicateEdit),
// EDIT_SECTION_CHIPS replies (pendingEditSectionChoice), AND a direct "edit the basic details of
// FT..." command typed from scratch (detectEditMenuIntent below), so a section named up front jumps
// straight to it instead of always showing the menu first. isReask=true only changes the "didn't
// understand" wording (pendingEditSectionChoice re-asking after an unclear reply reads oddly as a
// fresh "what would you like to update" greeting).
async function openEditSection(sessionId, session, userMessage, code, guestName, sectionText, isReask) {
  const t = sectionText.trim().toLowerCase();
  if (/\bdone\b|\bnothing\b|\bno(ne|thing)?\b/.test(t)) {
    const reply = `Okay, no changes made to **${code}**.`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }
  if (/\bbasic\b/.test(t)) {
    session.pendingBasicFieldChoice = { code, guestName };
    const reply = `Which basic detail would you like to update on **${code}**?`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, quickReplies: BASIC_FIELD_CHOICE_CHIPS };
  }
  if (/\bitinerary\b/.test(t)) {
    const resolved = await editBooking.resolveForEdit(code);
    if (resolved.status === 'ambiguous') {
      return askWhichRecord(sessionId, session, userMessage, code, resolved.matches, 'itineraryEdit', {});
    }
    return finishItineraryEditResolve(sessionId, session, userMessage, resolved, code);
  }
  if (/\bhotel\b/.test(t)) {
    const resolved = await editBooking.resolveForEdit(code);
    if (resolved.status !== 'ok') {
      const reply = `I couldn't find **${code}** in the database.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    const hotels = resolved.raw.hotelDetails || [];
    if (hotels.length === 0) {
      // Nothing existing to choose between (self-booked, or no hotel added yet) - go straight to
      // adding one instead of a dead-end "nothing to edit" message.
      return startAddHotel(sessionId, session, userMessage, resolved.code, resolved.guestName, resolved.raw);
    }
    // Always offers a choice, even with just one existing hotel - previously jumped straight into
    // editing that one hotel's fields, with no way to instead add a brand-new hotel to the booking
    // (there was no path to that at all from here). "Add new hotel" sits alongside whichever
    // existing hotel(s) are on file so picking one to edit is still just as fast as before.
    session.pendingHotelRowChoice = { code: resolved.code, guestName: resolved.guestName, raw: resolved.raw };
    const reply =
      hotels.length === 1
        ? `**${resolved.code}** has **${hotels[0].name}** on file — update it, or add a new hotel to this booking?`
        : `**${resolved.code}** has more than one hotel — which one would you like to update, or add a new one?`;
    pushTurn(sessionId, userMessage, reply);
    return {
      answer: reply,
      sql: null,
      rowCount: 0,
      quickReplies: [
        ...hotels.map((h, i) => ({ label: `${h.name} (${h.checkInDate} → ${h.checkOutDate})`, value: String(i + 1), autoSend: true })),
        { label: 'Add new hotel', value: 'add new hotel', autoSend: true },
      ],
    };
  }
  if (/\bprice\b/.test(t)) {
    const resolved = await editBooking.resolveForEdit(code);
    if (resolved.status !== 'ok') {
      const reply = `I couldn't find **${code}** in the database.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    return openFieldSection(sessionId, session, userMessage, resolved.code, resolved.guestName, resolved.raw, 'price');
  }
  if (/\bremarks\b/.test(t)) {
    const resolved = await editBooking.resolveForEdit(code);
    if (resolved.status !== 'ok') {
      const reply = `I couldn't find **${code}** in the database.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    return openFieldSection(sessionId, session, userMessage, resolved.code, resolved.guestName, resolved.raw, 'remarks');
  }
  if (/\bextra\b|\bemergency\b/.test(t)) {
    const resolved = await editBooking.resolveForEdit(code);
    if (resolved.status !== 'ok') {
      const reply = `I couldn't find **${code}** in the database.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    return openFieldSection(sessionId, session, userMessage, resolved.code, resolved.guestName, resolved.raw, 'extra');
  }
  session.pendingEditSectionChoice = { code, guestName };
  const reply = isReask
    ? `Sorry, I didn't catch that — please pick one of the options below for **${code}**.`
    : `What would you like to update on **${code}** (${guestName})?`;
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: 0, quickReplies: EDIT_SECTION_CHIPS };
}

// Opens the Hotel Details field picker for one specific hotel row (already resolved - either the
// booking's only hotel, or the one just chosen from pendingHotelRowChoice).
function openHotelFieldChoice(sessionId, session, userMessage, code, guestName, raw, hotelIndex) {
  session.pendingHotelFieldChoice = { code, guestName, raw, hotelIndex };
  const hotel = raw.hotelDetails[hotelIndex];
  const reply = `Which detail of **${hotel.name}** would you like to update on **${code}**?`;
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: 0, quickReplies: HOTEL_FIELD_CHOICE_CHIPS };
}

// ---------- add a brand-new hotel row to an already-saved booking/quotation ----------
// Mirrors bookingFlow.js's own hotelCollect step (same 7 required fields, same order, same real
// dropdown/calendar UI, same findHotel/findHotelRoomType lookups) for a NEW booking's hotel - this
// is that same collection, just appending the finished row onto a live record's raw.hotelDetails
// and resubmitting via bookingEditForms.saveRawPatch instead of building a fresh draft.

const ADD_HOTEL_WHOLE_NUMBER_RE = /^\d+$/;
const ADD_HOTEL_DECIMAL_NUMBER_RE = /^\d+(\.\d+)?$/;

// Same strict DD-MM-YYYY validation as bookingFlow.js's own parseDateDDMMYYYY (rejects impossible
// calendar dates like 31-02-2026, which new Date(y, m, d) alone would silently roll over instead
// of catching) - redefined here since bookingFlow.js doesn't export it.
function parseStrictDDMMYYYY(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.trim().split('-');
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const year = parseInt(parts[2], 10);
  if (Number.isNaN(day) || Number.isNaN(month) || Number.isNaN(year)) return null;
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

function isoToLocalDateOnly(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addHotelDestOptions(destinations) {
  return destinations.map((d) => (d.ShortCode ? `${d.Name} (${d.ShortCode})` : d.Name)).join(', ');
}

function addHotelStepPrompt(stepKey, pending) {
  switch (stepKey) {
    case 'destinationName':
      return `Which destination is this hotel for? Available: ${addHotelDestOptions(pending.destinations)}`;
    case 'hotelName':
      return "What is the hotel's name?";
    case 'checkInDate':
      return 'What is the check-in date? (DD-MM-YYYY)';
    case 'checkOutDate':
      return 'What is the check-out date? (DD-MM-YYYY)';
    case 'roomCategory':
      return 'What is the room category? (e.g. "Superior Room Sin/Dou")';
    case 'totalRooms':
      return 'How many rooms?';
    case 'ratePerNight': {
      const h = pending.current;
      if (h._roomTypeRate != null) {
        return `What is the rate per night? (reply "same" to use this room type's own rate: ${h._roomTypeRate} ${h._roomTypeCurrency || 'THB'})`;
      }
      return 'What is the rate per night? (just the number - currency defaults to THB)';
    }
    default:
      return '';
  }
}

const ADD_HOTEL_FIELD_ORDER = ['destinationName', 'hotelName', 'checkInDate', 'checkOutDate', 'roomCategory', 'totalRooms', 'ratePerNight'];

// Entry point - reached either when a booking/quotation has nothing existing to choose from
// (self-booked, or no hotel added yet) or by picking "Add new hotel" alongside existing ones (see
// the /\bhotel\b/ branch in openEditSection and the pendingHotelRowChoice handler below).
async function startAddHotel(sessionId, session, userMessage, code, guestName, raw) {
  const destinations = await resolveDestinationIdsToNames(raw.destinations);
  const current = {};
  let step;
  if (destinations.length === 1) {
    current.destinationId = destinations[0].Id;
    current.destinationName = destinations[0].Name;
    step = 'hotelName';
  } else {
    step = 'destinationName';
  }
  session.pendingAddHotel = { code, guestName, raw, destinations, step, current };
  const reply = `Let's add a new hotel to **${code}**. ${addHotelStepPrompt(step, session.pendingAddHotel)}`;
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: 0, expecting: expectingFieldForAddHotel(session.pendingAddHotel) };
}

// Same shape expectingField(draft) uses for bookingFlow.js's own hotelCollect step - real
// dropdown/calendar UI per field, just keyed off pending.step instead of draft.hotelStep.
function expectingFieldForAddHotel(pending) {
  const h = pending.current;
  switch (pending.step) {
    case 'destinationName':
      return { field: 'destination', options: pending.destinations.map((d) => ({ Id: d.Id, Name: d.Name, ShortCode: d.ShortCode })) };
    case 'hotelName':
      return { field: 'hotel', params: h.destinationId ? { destinationId: h.destinationId } : {} };
    case 'checkInDate':
      return { field: 'date', params: { min: pending.raw.travelDate, max: pending.raw.returnDate } };
    case 'checkOutDate': {
      const checkInISO = h.checkInDate ? ddmmyyyyToISO(h.checkInDate) : null;
      return { field: 'date', params: { min: checkInISO ? addDaysISO(checkInISO, 1) : pending.raw.travelDate, max: pending.raw.returnDate } };
    }
    case 'roomCategory':
      return h._resolvedHotelId ? { field: 'roomType', params: { hotelId: h._resolvedHotelId } } : undefined;
    default:
      return undefined;
  }
}

// Continues an in-progress add-hotel conversation - destinationName (only when the booking covers
// more than one) -> hotelName -> checkInDate -> checkOutDate -> roomCategory -> totalRooms ->
// ratePerNight -> confirm.
async function stepAddHotel(sessionId, session, userMessage, pending) {
  const { code, raw, destinations } = pending;
  const h = pending.current;
  const answer = userMessage.trim();

  if (pending.step === 'confirm') {
    const yn = bookingFlow.parseYesNo(answer);
    if (yn === true) {
      try {
        const checkIn = parseStrictDDMMYYYY(h.checkInDate);
        const checkOut = parseStrictDDMMYYYY(h.checkOutDate);
        const totalNights = Math.round((checkOut - checkIn) / 86400000);
        const newRow = {
          id: 0,
          destinationId: h.destinationId,
          hotelId: h._resolvedHotelId || 0,
          name: h.hotelName,
          roomCategory: h.roomCategory,
          totalRooms: h.totalRooms,
          totalNights,
          checkInDate: h.checkInDate,
          checkOutDate: h.checkOutDate,
          roomRemarks: '',
          address: '',
          contact: '',
          email: '',
          ratePerNight: h.ratePerNight,
          ratePerNightCurrency: 'THB',
          totalAdults: '0',
          children: 0,
          infants: 0,
          destinationname: h.destinationName,
          selfBooked: false,
          confirmationId: '',
          attributes: [],
          adultCostType: '',
          childCostType: '',
          breakfast: '',
        };
        const hotelDetails = [...(raw.hotelDetails || []), newRow];
        await bookingEditForms.saveRawPatch(raw, { hotelDetails });
        const reply = `Added **${h.hotelName}** (${h.roomCategory}, ${totalNights} night(s)) to **${code}**.`;
        pushTurn(sessionId, userMessage, reply);
        return { answer: reply, sql: null, rowCount: 0 };
      } catch (err) {
        const reply = `Sorry, saving that failed: ${err.message}`;
        pushTurn(sessionId, userMessage, reply);
        return { answer: reply, sql: null, rowCount: 0 };
      }
    }
    if (yn === false) {
      const reply = `Okay, cancelled — no new hotel was added to **${code}**.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    session.pendingAddHotel = pending;
    const reply = `Reply "yes" to add this hotel, or "no" to cancel.`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
  }

  // Resolve a pending "which hotel did you mean?" sub-question from the previous turn first - same
  // "show real matches, never silently accept whatever was typed" standard as bookingFlow.js's own
  // hotelCollect step.
  if (h._hotelNameOptions) {
    const picked = h._hotelNameOptions.find((o) => o.Name.toLowerCase() === answer.toLowerCase());
    if (picked) {
      h.hotelName = picked.Name;
      h._resolvedHotelId = picked.Id;
    } else if (/^new\b/i.test(answer)) {
      h._resolvedHotelId = 0;
    } else {
      session.pendingAddHotel = pending;
      const opts = h._hotelNameOptions.map((o) => `- ${o.Name}`).join('\n');
      const reply = `Please reply with the exact hotel name from the list, or "new" to add "${h.hotelName}" as a new entry:\n${opts}`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    delete h._hotelNameOptions;
  } else {
    switch (pending.step) {
      case 'destinationName': {
        const destQuery = answer.toLowerCase();
        const dest = destinations.find((d) => d.Name.toLowerCase() === destQuery || (d.ShortCode && d.ShortCode.toLowerCase() === destQuery));
        if (!dest) {
          session.pendingAddHotel = pending;
          const reply = `"${answer}" isn't one of this booking's destinations (${addHotelDestOptions(destinations)}). Which one is this hotel for?`;
          pushTurn(sessionId, userMessage, reply);
          return { answer: reply, sql: null, rowCount: 0 };
        }
        h.destinationId = dest.Id;
        h.destinationName = dest.Name;
        break;
      }
      case 'hotelName': {
        const found = await findHotel(answer);
        if (found.length > 1) {
          h._hotelNameOptions = found;
          h.hotelName = answer;
          session.pendingAddHotel = pending;
          const opts = found.map((o) => `- ${o.Name}`).join('\n');
          const reply = `A few hotels match "${answer}":\n${opts}\nWhich one did you mean? (or reply "new" to add "${answer}" as a new hotel entry)`;
          pushTurn(sessionId, userMessage, reply);
          return { answer: reply, sql: null, rowCount: 0 };
        }
        h.hotelName = found.length === 1 ? found[0].Name : answer;
        h._resolvedHotelId = found.length === 1 ? found[0].Id : 0;
        break;
      }
      case 'checkInDate': {
        const checkIn = parseStrictDDMMYYYY(answer);
        if (!checkIn) {
          session.pendingAddHotel = pending;
          const reply = 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?';
          pushTurn(sessionId, userMessage, reply);
          return { answer: reply, sql: null, rowCount: 0 };
        }
        const travelDate = isoToLocalDateOnly(raw.travelDate);
        const returnDate = isoToLocalDateOnly(raw.returnDate);
        if ((travelDate && checkIn < travelDate) || (returnDate && checkIn > returnDate)) {
          session.pendingAddHotel = pending;
          const reply = `Check-in needs to fall within the trip's own dates (${raw.travelDate} to ${raw.returnDate}) — could you re-enter it?`;
          pushTurn(sessionId, userMessage, reply);
          return { answer: reply, sql: null, rowCount: 0 };
        }
        h.checkInDate = answer;
        break;
      }
      case 'checkOutDate': {
        const checkOut = parseStrictDDMMYYYY(answer);
        if (!checkOut) {
          session.pendingAddHotel = pending;
          const reply = 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?';
          pushTurn(sessionId, userMessage, reply);
          return { answer: reply, sql: null, rowCount: 0 };
        }
        if (checkOut <= parseStrictDDMMYYYY(h.checkInDate)) {
          session.pendingAddHotel = pending;
          const reply = 'Check-out date must be after check-in date — could you re-enter it?';
          pushTurn(sessionId, userMessage, reply);
          return { answer: reply, sql: null, rowCount: 0 };
        }
        const returnDate = isoToLocalDateOnly(raw.returnDate);
        if (returnDate && checkOut > returnDate) {
          session.pendingAddHotel = pending;
          const reply = `Check-out can't be after the trip's return date (${raw.returnDate}) — could you re-enter it?`;
          pushTurn(sessionId, userMessage, reply);
          return { answer: reply, sql: null, rowCount: 0 };
        }
        h.checkOutDate = answer;
        break;
      }
      case 'roomCategory': {
        h.roomCategory = answer;
        const roomType = h._resolvedHotelId ? await findHotelRoomType(h._resolvedHotelId, answer) : null;
        if (roomType) {
          h._roomTypeRate = roomType.RatePerNight;
          h._roomTypeCurrency = roomType.Currency;
        }
        break;
      }
      case 'totalRooms': {
        if (!ADD_HOTEL_WHOLE_NUMBER_RE.test(answer)) {
          session.pendingAddHotel = pending;
          const reply = 'That needs to be digits only, no other text — how many rooms?';
          pushTurn(sessionId, userMessage, reply);
          return { answer: reply, sql: null, rowCount: 0 };
        }
        const n = parseInt(answer, 10);
        if (n <= 0) {
          session.pendingAddHotel = pending;
          const reply = 'That needs to be a whole number greater than 0 — how many rooms?';
          pushTurn(sessionId, userMessage, reply);
          return { answer: reply, sql: null, rowCount: 0 };
        }
        h.totalRooms = n;
        break;
      }
      case 'ratePerNight': {
        if (/^same$/i.test(answer) && h._roomTypeRate != null) {
          h.ratePerNight = Number(h._roomTypeRate);
          break;
        }
        if (!ADD_HOTEL_DECIMAL_NUMBER_RE.test(answer)) {
          session.pendingAddHotel = pending;
          const reply = 'That needs to be digits only, no currency symbol or other text — what is the rate per night?';
          pushTurn(sessionId, userMessage, reply);
          return { answer: reply, sql: null, rowCount: 0 };
        }
        h.ratePerNight = parseFloat(answer);
        break;
      }
      default:
        break;
    }
  }

  const next = ADD_HOTEL_FIELD_ORDER.find((k) => h[k] === undefined || h[k] === null || h[k] === '');
  if (next) {
    pending.step = next;
    session.pendingAddHotel = pending;
    const reply = addHotelStepPrompt(next, pending);
    pushTurn(sessionId, userMessage, reply);
    // Same one-tap "Same as room type" shortcut the other two hotel flows (new-booking creation,
    // and editing an existing hotel's rate) already offer - was missing here even though the
    // prompt text itself already mentioned replying "same".
    const quickReplies =
      next === 'ratePerNight' && h._roomTypeRate != null
        ? [{ label: `Same as room type (${h._roomTypeRate} ${h._roomTypeCurrency || 'THB'})`, value: 'same', autoSend: true }]
        : undefined;
    return { answer: reply, sql: null, rowCount: 0, expecting: expectingFieldForAddHotel(pending), quickReplies };
  }

  pending.step = 'confirm';
  session.pendingAddHotel = pending;
  const totalNightsPreview = Math.round((parseStrictDDMMYYYY(h.checkOutDate) - parseStrictDDMMYYYY(h.checkInDate)) / 86400000);
  const reply = `Add **${h.hotelName}** for **${h.destinationName}** (${h.roomCategory}, ${h.totalRooms} room(s), ${totalNightsPreview} night(s), ${h.checkInDate} → ${h.checkOutDate}, ${h.ratePerNight}/night) to **${code}**? (yes/no)`;
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
}

// Opens a FIELD_SECTIONS field picker (price/remarks/extra) - the flat-field counterpart to
// openHotelFieldChoice above (these patch a top-level raw key directly, not a nested hotelDetails
// row, so they share one generic implementation instead of three near-identical copies).
function openFieldSection(sessionId, session, userMessage, code, guestName, raw, sectionKey) {
  const section = FIELD_SECTIONS[sectionKey];
  session.pendingFieldSectionChoice = { code, guestName, raw, sectionKey };
  const reply = `Which **${section.title}** field would you like to update on **${code}**?`;
  pushTurn(sessionId, userMessage, reply);
  const chips = section.fields.map((f) => ({ label: f.label, value: f.label.toLowerCase(), autoSend: true }));
  chips.push({ label: 'Done', value: 'done', autoSend: true });
  return { answer: reply, sql: null, rowCount: 0, quickReplies: chips };
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
  // draft.phase is 'itineraryChoice' with an empty itineraryItems, same shape the new-booking
  // creation flow's own itinerary question uses - quickRepliesFor already has chips for exactly
  // this case (Transfer/Sightseeing/Restaurant/Leisure Day/Self-booked), this just wasn't wired up
  // to return them here. expectingField included too, matching every other draft-based response in
  // this file, though itineraryChoice itself has no special lookup UI to offer.
  return { answer: reply, sql: null, rowCount: 0, expecting: expectingField(draft), quickReplies: quickRepliesFor(draft) };
}

// Finishes a duplicate-booking resolve (not_found/ok) - shared by the fresh duplicateIntent path
// and the post-disambiguation continuation in resumeRecordChoice.
function finishDuplicateResolve(sessionId, session, userMessage, resolved, fallbackCode) {
  if (resolved.status === 'not_found') {
    const reply = `I couldn't find any booking or quotation matching **${fallbackCode}** in the database.`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }
  const booking = resolved.booking;
  const code = booking.BookingId || booking.QuotationId;
  const reply = `Duplicate **${code}** (${booking.GuestName})? This creates a brand-new ${booking.IsBooking ? 'booking' : 'quotation'} with the exact same details, which you can then edit.`;
  session.pendingDuplicateConfirm = { code, guestName: booking.GuestName, internalId: booking.Id };
  pushTurn(sessionId, userMessage, reply);
  return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
}

// Turns a jobSheetCopy.js result into the chat reply - each copy is its own fenced code block so
// it pastes cleanly (no markdown reformatting the blank lines the real template relies on) and the
// agent can grab just the one they need straight off the message.
function finishJobSheetCopyResult(sessionId, session, userMessage, intent, result) {
  const copyLabel = intent.copyType === 'booking' ? 'Booking' : 'Customer';
  if (result.status === 'not_found') {
    let reply;
    if (result.reason === 'date') reply = `No job sheets found for that day.`;
    else if (result.reason === 'no_job_sheets') reply = `**${result.code}** has no job sheets yet.`;
    else reply = `I couldn't find any booking or quotation matching **${intent.scope.code}** in the database.`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }
  if (result.copies.length === 0) {
    const reply = `Found matching job sheet(s), but couldn't fetch their details from the site just now - please try again.`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }
  const blocks = result.copies.map((c) => `**${c.label}**\n\`\`\`\n${c.text}\n\`\`\``).join('\n\n');
  const truncatedNote = result.truncated ? `\n\n(More may exist beyond the first ${result.copies.length} shown.)` : '';
  const reply = `Found ${result.copies.length} ${copyLabel} Copy ${result.copies.length === 1 ? 'text' : 'texts'}:\n\n${blocks}${truncatedNote}`;
  pushTurn(sessionId, userMessage, reply);
  // copyBlocks lets the frontend render a one-tap "Copy" chip per job sheet (see app.js's
  // addCopyButtons) instead of making the agent select-and-Ctrl+C out of the fenced code block
  // above by hand - the real Job Sheet page's own two modals both have exactly this kind of single
  // "Copy" button already, this just reproduces that same one-tap convenience here.
  return { answer: reply, sql: null, rowCount: 0, copyBlocks: result.copies };
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
  if (pending.kind === 'duplicate') {
    return finishDuplicateResolve(sessionId, session, userMessage, { status: 'ok', booking: chosen }, pending.code);
  }
  if (pending.kind === 'editMenu') {
    const resolved = await editBooking.resolveForEditBooking(chosen);
    if (resolved.status !== 'ok') {
      const reply = `I couldn't find **${pending.code}** in the database.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    return openEditSection(sessionId, session, userMessage, resolved.code, resolved.guestName, pending.extra.sectionText, false);
  }
  if (pending.kind === 'jobSheetCopy') {
    const result = await jobSheetCopy.resolveJobSheetCopiesForBooking(chosen, pending.extra.copyType);
    return finishJobSheetCopyResult(sessionId, session, userMessage, { copyType: pending.extra.copyType, scope: { code: pending.code } }, result);
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
  if (
    (session.pendingStatusChange ||
      session.pendingItinerary ||
      session.pendingDocChoice ||
      session.pendingHotelChoice ||
      session.pendingCodeChoice ||
      session.pendingRecordChoice ||
      session.pendingConvertConfirm ||
      session.pendingFieldEditConfirm ||
      session.pendingDuplicateConfirm ||
      session.pendingPostDuplicateEdit ||
      session.pendingEditSectionChoice ||
      session.pendingBasicFieldChoice ||
      session.pendingHotelRowChoice ||
      session.pendingFieldValueEntry ||
      session.pendingDestinationsEntry ||
      session.pendingHotelFieldChoice ||
      session.pendingHotelFieldValue ||
      session.pendingHotelFieldConfirm ||
      session.pendingFieldSectionChoice ||
      session.pendingFieldSectionValue ||
      session.pendingFieldSectionConfirm ||
      session.pendingAgentCreate ||
      session.pendingAddHotel ||
      session.pendingAmbiguousDetail) &&
    isAnyCancel(userMessage)
  ) {
    cancelFlows(sessionId);
    const reply = 'Okay, cancelled — nothing was changed. What would you like to know?';
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
  }

  // Interrupt-and-resume: a message that clearly wants something else entirely (a different
  // booking's status, a brand-new agent, a PDF, a totally different booking to create...) no longer
  // gets blindly swallowed as if it were the answer to whatever question is currently pending.
  // Pause the active flow onto session.pausedFlows (its own current session field, plus the exact
  // {reply, expecting, quickReplies} it last showed - see lastFlowSnapshot's own comment), clear
  // that field, and let this same message fall through to the normal fresh-dispatch chain below,
  // exactly as if nothing had been active. handleChat (the outer wrapper) pops and restores the
  // paused flow, replaying its last question, once whatever interrupted it fully finishes.
  if (isFlowActive(session) && !isAnyCancel(userMessage) && detectAnyFreshIntent(userMessage, session)) {
    const key = activeStateKey(session);
    if (key && session.lastFlowSnapshot) {
      session.pausedFlows.push({ stateKey: key, stateValue: session[key], ...session.lastFlowSnapshot });
      session[key] = null;
    }
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

  // Standalone "add a new agent/company" conversation (see agentCreate.js) - entirely separate
  // from the agent-creation flow embedded inside booking creation (bookingFlow.js's
  // stepAgentCreate), for when staff just want to register an agent with no booking involved.
  if (session.pendingAgentCreate) {
    const { reply, pending } = await agentCreate.step(session.pendingAgentCreate, userMessage);
    session.pendingAgentCreate = pending;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, quickReplies: quickRepliesForAgentCreate(pending) };
  }

  // In-progress "add a new hotel to this already-saved booking/quotation" conversation (see
  // startAddHotel/stepAddHotel above) - continues it. stepAddHotel builds the whole response and
  // re-arms session.pendingAddHotel itself when the flow isn't finished, same as the other
  // pendingHotelXxx handlers below.
  if (session.pendingAddHotel) {
    const pending = session.pendingAddHotel;
    session.pendingAddHotel = null;
    return stepAddHotel(sessionId, session, userMessage, pending);
  }

  // Resolves a respondAmbiguousDetail dropdown selection (or a typed code) against the matches it
  // was shown - by internal Id, never by re-resolving the shared code/name, which would just hit
  // the same ambiguity again (see bookingDetails.js/accountTransactions.js's own intent.id fast
  // path). An unrecognised reply re-shows the same dropdown rather than silently falling through to
  // an unrelated intent.
  if (session.pendingAmbiguousDetail) {
    const pending = session.pendingAmbiguousDetail;
    session.pendingAmbiguousDetail = null;
    const trimmed = userMessage.trim();
    const codeMatch = trimmed.match(ANY_CODE_RE);
    let chosen = codeMatch ? pending.matches.find((m) => (m.BookingId || m.QuotationId || '').toUpperCase() === codeMatch[0].toUpperCase()) : null;
    // No exact FT/FTQ code typed - fall back to the same substring rule the live dropdown itself
    // already filters by (e.g. "1803" narrows the list to just FT08261803), and commit it IF that
    // narrows to exactly one candidate - same "commit an unambiguous match" rule the destination
    // pills use, so bare digits or a partial guest name (with nothing left ambiguous) resolves
    // directly instead of just re-showing the same dropdown.
    if (!chosen && trimmed) {
      const q = trimmed.toLowerCase();
      const fuzzyMatches = pending.matches.filter((m) => {
        const code = (m.BookingId || m.QuotationId || '').toLowerCase();
        const name = (m.GuestName || '').toLowerCase();
        return code.includes(q) || name.includes(q);
      });
      if (fuzzyMatches.length === 1) chosen = fuzzyMatches[0];
    }
    if (!chosen) {
      const label = pending.matches[0].GuestName;
      return respondAmbiguousDetail(sessionId, session, userMessage, label, pending.matches, pending.kind);
    }
    if (pending.kind === 'fullDetail') {
      const resolved = await bookingDetails.fetchFullBookingDetails({ id: chosen.Id });
      if (resolved.status !== 'ok') {
        const reply = `I couldn't find **${chosen.BookingId || chosen.QuotationId}** in the database.`;
        pushTurn(sessionId, userMessage, reply);
        return { answer: reply, sql: null, rowCount: 0 };
      }
      return finishFullDetailAnswer(sessionId, userMessage, resolved);
    }
    const result = await accountTransactions.fetchAccountTransactions({ id: chosen.Id });
    if (result.status !== 'ok') {
      const reply = `I couldn't find **${chosen.BookingId || chosen.QuotationId}** in the database.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    return finishAcctTxnAnswer(sessionId, userMessage, result);
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

  // A "duplicate this booking?" confirmation was asked last turn - this answers it.
  if (session.pendingDuplicateConfirm) {
    const { code, guestName, internalId, allowSalesEntry = true } = session.pendingDuplicateConfirm;
    session.pendingDuplicateConfirm = null;
    const yn = bookingFlow.parseYesNo(userMessage);
    if (yn === true) {
      try {
        const created = await duplicateBooking.performDuplicate(internalId, { allowSalesEntry });
        const newCode = created ? created.BookingId || created.QuotationId : null;
        if (newCode) session.lastBookingCode = newCode;
        const reply = `Done — duplicated **${code}** (${guestName}) into a new record${newCode ? ` (**${newCode}**)` : ''}. Do you want to edit anything on it?`;
        // Rather than leaving "what to update" as a free-text question, offer it as its own
        // yes/no-then-menu step (pendingPostDuplicateEdit below) - the point of chip-driving this
        // whole chain is that nothing after "duplicate" requires typing a field name from memory.
        session.pendingPostDuplicateEdit = newCode ? { code: newCode, guestName } : null;
        pushTurn(sessionId, userMessage, reply);
        return { answer: reply, sql: null, rowCount: 0, quickReplies: newCode ? YES_NO_CHIPS : undefined };
      } catch (err) {
        if (err.code === 'AGENT_ACCOUNT_NOT_FOUND') {
          const reply = `**${code}**'s agent account wasn't found, so duplicating it would skip creating a sales entry. Duplicate anyway without a sales entry?`;
          session.pendingDuplicateConfirm = { code, guestName, internalId, allowSalesEntry: false };
          pushTurn(sessionId, userMessage, reply);
          return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
        }
        throw err;
      }
    }
    if (yn === false) {
      const reply = `Okay, cancelled — **${code}** was not duplicated.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    const reply = `Reply "yes" to duplicate **${code}**, or "no" to cancel.`;
    session.pendingDuplicateConfirm = { code, guestName, internalId };
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
  }

  // "Do you want to edit anything on it?" (asked right after a duplicate succeeds) - this answers
  // it. Yes opens the section-choice menu below; a clear no ends the chain; anything unclear re-asks.
  if (session.pendingPostDuplicateEdit) {
    const { code, guestName } = session.pendingPostDuplicateEdit;
    session.pendingPostDuplicateEdit = null;
    const yn = bookingFlow.parseYesNo(userMessage);
    if (yn === true) {
      session.pendingEditSectionChoice = { code, guestName };
      const reply = `What would you like to update on **${code}** (${guestName})?`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0, quickReplies: EDIT_SECTION_CHIPS };
    }
    if (yn === false) {
      const reply = `Okay, no changes made to **${code}**.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    const reply = `Reply "yes" to edit **${code}**, or "no" to leave it as is.`;
    session.pendingPostDuplicateEdit = { code, guestName };
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
  }

  // "What would you like to update?" TOP-LEVEL menu (EDIT_SECTION_CHIPS) was just shown - mirrors
  // the real Edit Booking page's own sections. Itinerary hands off to the existing guided
  // itinerary-edit draft; Basic Details, Hotel Details, Price Details, General Remarks, and Extra
  // Note & Emergency Contact each open their own field sub-menu (openEditSection below); "Nothing
  // else" ends the chain.
  if (session.pendingEditSectionChoice) {
    const { code, guestName } = session.pendingEditSectionChoice;
    session.pendingEditSectionChoice = null;
    return openEditSection(sessionId, session, userMessage, code, guestName, userMessage, true);
  }

  // BASIC_FIELD_CHOICE_CHIPS menu was just shown - a simple field asks for its new value next
  // (pendingFieldValueEntry below); "Back" returns to the top-level section menu.
  if (session.pendingBasicFieldChoice) {
    const { code, guestName } = session.pendingBasicFieldChoice;
    session.pendingBasicFieldChoice = null;
    const t = userMessage.trim().toLowerCase();
    if (/\bback\b/.test(t)) {
      session.pendingEditSectionChoice = { code, guestName };
      const reply = `What would you like to update on **${code}** (${guestName})?`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0, quickReplies: EDIT_SECTION_CHIPS };
    }
    // Destinations gets the same multi-select checklist expectingField(draft) shows during
    // new-booking creation's own destinationNames step (public/app.js's 'destination' lookup, ticked
    // checkboxes) - pre-checked here with the booking's CURRENT destinations (unlike the blank-start
    // creation-time checklist) so staff see and adjust the existing selection instead of re-picking
    // from scratch. Handled separately from EDIT_FIELD_KEY_BY_CHOICE because the saved value has to
    // be real resolved Destination Ids (comma-joined), not whatever text was typed/ticked.
    if (/\bdestinations?\b/.test(t)) {
      const resolved = await editBooking.resolveForEdit(code);
      if (resolved.status !== 'ok') {
        const reply = `I couldn't find **${code}** in the database.`;
        pushTurn(sessionId, userMessage, reply);
        return { answer: reply, sql: null, rowCount: 0 };
      }
      const preselected = await resolveDestinationIdsToNames(resolved.raw.destinations);
      session.pendingDestinationsEntry = { code: resolved.code, guestName: resolved.guestName, raw: resolved.raw };
      const reply = `Which destinations should **${resolved.code}** cover? Tick to change the selection, then press Enter/Send.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0, expecting: { field: 'destination', multi: true, preselected } };
    }
    const field = EDIT_FIELD_KEY_BY_CHOICE.find((f) => f.pattern.test(t));
    if (field) {
      session.pendingFieldValueEntry = { code, guestName, fieldKey: field.key, label: field.label };
      const reply = `What should the new **${field.label}** be for **${code}**?`;
      pushTurn(sessionId, userMessage, reply);
      // Company name gets the same live agent-lookup dropdown expectingField(draft) shows during
      // new-booking creation's own agentName step (public/app.js's LOOKUP_ENDPOINTS.agent) - picking
      // an item there auto-sends its Name as plain text, landing on pendingFieldValueEntry below
      // exactly like typing it would have. Missing here before - this field silently fell back to a
      // bare text box with no dropdown, unlike every other lookup-backed field in the app.
      const expecting = field.key === 'guestCompany' ? { field: 'agent' } : undefined;
      return { answer: reply, sql: null, rowCount: 0, expecting };
    }
    session.pendingBasicFieldChoice = { code, guestName };
    const reply = `Sorry, I didn't catch that — please pick one of the options below for **${code}**.`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, quickReplies: BASIC_FIELD_CHOICE_CHIPS };
  }

  // The destination checklist submission - same comma/and/& split and findDestinations()
  // resolution bookingFlow.js's own destinationNames step uses, so a bad/ambiguous name is rejected
  // here exactly like it would be during new-booking creation, never silently attaching the wrong
  // destination Id to a real record.
  if (session.pendingDestinationsEntry) {
    const { code, guestName, raw } = session.pendingDestinationsEntry;
    session.pendingDestinationsEntry = null;
    const names = userMessage
      .split(/,| and | & /i)
      .map((s) => s.trim())
      .filter(Boolean);
    const reask = async (problem) => {
      const preselected = await resolveDestinationIdsToNames(raw.destinations);
      session.pendingDestinationsEntry = { code, guestName, raw };
      const reply = `${problem} Please try again for **${code}**.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0, expecting: { field: 'destination', multi: true, preselected } };
    };
    if (names.length === 0) return reask('Please select at least one destination.');
    const { matches, notFound } = await findDestinations(names);
    const ambiguous = matches.filter((m) => m.ambiguous);
    if (notFound.length > 0) return reask(`I couldn't find a destination matching: ${notFound.join(', ')}.`);
    if (ambiguous.length > 0) {
      const opts = ambiguous.map((a) => `"${a.name}" could be: ${a.options.map((o) => o.Name).join(', ')}`).join('; ');
      return reask(`A couple of destinations are ambiguous: ${opts}.`);
    }
    const resolved = await editBooking.resolveForEdit(code);
    if (resolved.status !== 'ok') {
      const reply = `I couldn't find **${code}** in the database.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    return finishFieldEditResolve(sessionId, session, userMessage, resolved, {
      code,
      field: 'destinations',
      label: 'Destinations',
      value: matches.map((m) => m.Id).join(','),
      displayValue: matches.map((m) => m.Name).join(', '),
      viaMenu: true,
    });
  }

  // Which hotel row to edit, or add a new one - this answers it, then either opens that row's edit
  // form (same as the old single-hotel fast path did directly) or starts the add-hotel flow.
  if (session.pendingHotelRowChoice) {
    const { code, guestName, raw } = session.pendingHotelRowChoice;
    session.pendingHotelRowChoice = null;
    const hotels = raw.hotelDetails || [];
    if (/\badd\b/i.test(userMessage) && /\bhotel\b/i.test(userMessage)) {
      return startAddHotel(sessionId, session, userMessage, code, guestName, raw);
    }
    const n = Number(userMessage.trim());
    if (!Number.isInteger(n) || n < 1 || n > hotels.length) {
      session.pendingHotelRowChoice = { code, guestName, raw };
      const reply = `Please pick one of the hotels below for **${code}**, or add a new one.`;
      pushTurn(sessionId, userMessage, reply);
      return {
        answer: reply,
        sql: null,
        rowCount: 0,
        quickReplies: [
          ...hotels.map((h, i) => ({ label: `${h.name} (${h.checkInDate} → ${h.checkOutDate})`, value: String(i + 1), autoSend: true })),
          { label: 'Add new hotel', value: 'add new hotel', autoSend: true },
        ],
      };
    }
    return openHotelFieldChoice(sessionId, session, userMessage, code, guestName, raw, n - 1);
  }

  // HOTEL_FIELD_CHOICE_CHIPS menu was just shown - Room Category gets the real room-type dropdown
  // (scoped to this hotel's own hotelId, same lookup bookingFlow.js's hotelCollect step uses when
  // adding a new hotel); Check-in/Check-out get the real calendar, bounded to the booking's own
  // travel/return window (raw.travelDate/returnDate are already ISO - GetBookingById's own shape,
  // exactly what the date picker's min/max expect, no conversion needed); Breakfast gets its own
  // two-tap chips; everything else is plain text/number (no real lookup exists for these even in
  // bookingFlow.js's own creation-time flow). "Done" returns to the top-level section menu.
  if (session.pendingHotelFieldChoice) {
    const { code, guestName, raw, hotelIndex } = session.pendingHotelFieldChoice;
    session.pendingHotelFieldChoice = null;
    const t = userMessage.trim().toLowerCase();
    if (/\bdone\b/.test(t)) {
      session.pendingEditSectionChoice = { code, guestName };
      const reply = `What would you like to update on **${code}** (${guestName})?`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0, quickReplies: EDIT_SECTION_CHIPS };
    }
    const field = HOTEL_FIELD_KEY_BY_CHOICE.find((f) => f.pattern.test(t));
    if (field) {
      const hotel = raw.hotelDetails[hotelIndex];
      // Same "reply same to use this room type's own rate" shortcut bookingFlow.js's hotelCollect
      // step (and the add-hotel flow above) already offer when adding a hotel - previously missing
      // entirely when editing an EXISTING hotel's rate, even though the hotel's own roomCategory is
      // right there to look the room type up against.
      if (field.key === 'ratePerNight') {
        const roomType = hotel.hotelId ? await findHotelRoomType(hotel.hotelId, hotel.roomCategory) : null;
        const hint = roomType ? ` (reply "same" to use this room type's own rate: ${roomType.RatePerNight} ${roomType.Currency || 'THB'})` : '';
        session.pendingHotelFieldValue = {
          code,
          guestName,
          raw,
          hotelIndex,
          fieldKey: field.key,
          label: field.label,
          roomTypeRate: roomType ? roomType.RatePerNight : null,
          roomTypeCurrency: roomType ? roomType.Currency : null,
        };
        const reply = `What should the new **${field.label}** be for **${hotel.name}** on **${code}**?${hint}`;
        pushTurn(sessionId, userMessage, reply);
        return {
          answer: reply,
          sql: null,
          rowCount: 0,
          quickReplies: roomType ? [{ label: `Same as room type (${roomType.RatePerNight} ${roomType.Currency || 'THB'})`, value: 'same', autoSend: true }] : undefined,
        };
      }
      session.pendingHotelFieldValue = { code, guestName, raw, hotelIndex, fieldKey: field.key, label: field.label };
      const reply = `What should the new **${field.label}** be for **${hotel.name}** on **${code}**?`;
      pushTurn(sessionId, userMessage, reply);
      if (field.key === 'roomCategory' && hotel.hotelId) {
        return { answer: reply, sql: null, rowCount: 0, expecting: { field: 'roomType', params: { hotelId: hotel.hotelId } } };
      }
      if (field.key === 'checkInDate' || field.key === 'checkOutDate') {
        return { answer: reply, sql: null, rowCount: 0, expecting: { field: 'date', params: { min: raw.travelDate, max: raw.returnDate } } };
      }
      if (field.key === 'breakfast') {
        return {
          answer: reply,
          sql: null,
          rowCount: 0,
          quickReplies: [
            { label: 'Breakfast Included', value: 'Breakfast included', autoSend: true },
            { label: 'No Breakfast', value: 'No breakfast', autoSend: true },
          ],
        };
      }
      return { answer: reply, sql: null, rowCount: 0 };
    }
    session.pendingHotelFieldChoice = { code, guestName, raw, hotelIndex };
    const reply = `Sorry, I didn't catch that — please pick one of the options below.`;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, quickReplies: HOTEL_FIELD_CHOICE_CHIPS };
  }

  // The new value for whichever hotel field was picked (typed, or from the roomType/date/breakfast
  // UI above) - confirm before saving.
  if (session.pendingHotelFieldValue) {
    const { code, guestName, raw, hotelIndex, fieldKey, label, roomTypeRate, roomTypeCurrency } = session.pendingHotelFieldValue;
    session.pendingHotelFieldValue = null;
    const rawValue = userMessage.trim();
    // "same" resolves to the room type's own rate, set alongside the "Same as room type" chip when
    // this field was opened - only meaningful for ratePerNight, and only when that lookup found one.
    const value = /^same$/i.test(rawValue) && fieldKey === 'ratePerNight' && roomTypeRate != null ? String(roomTypeRate) : rawValue;
    const isNumericField = fieldKey === 'totalRooms' || fieldKey === 'totalNights' || fieldKey === 'ratePerNight';
    if (!value || (isNumericField && !Number.isFinite(Number(value)))) {
      session.pendingHotelFieldValue = { code, guestName, raw, hotelIndex, fieldKey, label, roomTypeRate, roomTypeCurrency };
      const reply = isNumericField ? `**${label}** needs to be a number — please try again.` : `Please provide a value for **${label}**.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    const patchValue = isNumericField ? Number(value) : value;
    const hotel = raw.hotelDetails[hotelIndex];
    const reply = `Set **${label}** for **${hotel.name}** on **${code}** to "${value}"? (yes/no)`;
    session.pendingHotelFieldConfirm = { code, guestName, raw, hotelIndex, fieldKey, label, value: patchValue };
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
  }

  // "Save this hotel change?" confirmation - patches just this one hotel row and resubmits the
  // whole record in place (same saveRawPatch used by the other section edits).
  if (session.pendingHotelFieldConfirm) {
    const { code, guestName, raw, hotelIndex, fieldKey, label, value } = session.pendingHotelFieldConfirm;
    session.pendingHotelFieldConfirm = null;
    const yn = bookingFlow.parseYesNo(userMessage);
    if (yn === true) {
      try {
        const hotelDetails = raw.hotelDetails.map((h, i) => (i === hotelIndex ? { ...h, [fieldKey]: value } : h));
        await bookingEditForms.saveRawPatch(raw, { hotelDetails });
        return editSectionMenuAgain(sessionId, session, userMessage, `Done — ${label} for **${code}** is now "${value}".`, code, guestName);
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
    const reply = `Reply "yes" to set ${label} to "${value}", or "no" to cancel.`;
    session.pendingHotelFieldConfirm = { code, guestName, raw, hotelIndex, fieldKey, label, value };
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
  }

  // A FIELD_SECTIONS chip menu (price/remarks/extra, opened by openFieldSection()) was just shown -
  // "Done" returns to the top-level section menu; picking a field asks for its new value next
  // (pendingFieldSectionValue below), with the real calendar for a date field or real Yes/No chips
  // for a boolean one (PDF permissions), matching Hotel/Basic Details' own per-type treatment.
  if (session.pendingFieldSectionChoice) {
    const { code, guestName, raw, sectionKey } = session.pendingFieldSectionChoice;
    session.pendingFieldSectionChoice = null;
    const section = FIELD_SECTIONS[sectionKey];
    const t = userMessage.trim().toLowerCase();
    if (/\bdone\b/.test(t)) {
      session.pendingEditSectionChoice = { code, guestName };
      const reply = `What would you like to update on **${code}** (${guestName})?`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0, quickReplies: EDIT_SECTION_CHIPS };
    }
    const field = section.fields.find((f) => t.includes(f.label.toLowerCase()));
    if (field) {
      session.pendingFieldSectionValue = { code, guestName, raw, sectionKey, fieldKey: field.key, label: field.label, type: field.type };
      const reply = `What should the new **${field.label}** be for **${code}**?`;
      pushTurn(sessionId, userMessage, reply);
      if (field.type === 'date') {
        return { answer: reply, sql: null, rowCount: 0, expecting: { field: 'date' } };
      }
      if (field.type === 'boolean') {
        return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
      }
      return { answer: reply, sql: null, rowCount: 0 };
    }
    session.pendingFieldSectionChoice = { code, guestName, raw, sectionKey };
    const reply = `Sorry, I didn't catch that — please pick one of the options below.`;
    pushTurn(sessionId, userMessage, reply);
    const chips = section.fields.map((f) => ({ label: f.label, value: f.label.toLowerCase(), autoSend: true }));
    chips.push({ label: 'Done', value: 'done', autoSend: true });
    return { answer: reply, sql: null, rowCount: 0, quickReplies: chips };
  }

  // The new value for whichever price/remarks/extra field was picked - confirm before saving.
  if (session.pendingFieldSectionValue) {
    const { code, guestName, raw, sectionKey, fieldKey, label, type } = session.pendingFieldSectionValue;
    session.pendingFieldSectionValue = null;
    const typed = userMessage.trim();
    let value;
    if (type === 'boolean') {
      const yn = bookingFlow.parseYesNo(typed);
      if (yn === null) {
        session.pendingFieldSectionValue = { code, guestName, raw, sectionKey, fieldKey, label, type };
        const reply = `Please reply yes or no for **${label}**.`;
        pushTurn(sessionId, userMessage, reply);
        return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
      }
      value = yn;
    } else if (type === 'number') {
      if (!typed || !Number.isFinite(Number(typed))) {
        session.pendingFieldSectionValue = { code, guestName, raw, sectionKey, fieldKey, label, type };
        const reply = `**${label}** needs to be a number — please try again.`;
        pushTurn(sessionId, userMessage, reply);
        return { answer: reply, sql: null, rowCount: 0 };
      }
      value = Number(typed);
    } else {
      if (!typed) {
        session.pendingFieldSectionValue = { code, guestName, raw, sectionKey, fieldKey, label, type };
        const reply = `Please provide a value for **${label}**.`;
        pushTurn(sessionId, userMessage, reply);
        return { answer: reply, sql: null, rowCount: 0, expecting: type === 'date' ? { field: 'date' } : undefined };
      }
      value = typed;
    }
    const shown = type === 'boolean' ? (value ? 'Yes' : 'No') : value;
    const reply = `Set **${label}** for **${code}** to "${shown}"? (yes/no)`;
    session.pendingFieldSectionConfirm = { code, guestName, raw, sectionKey, fieldKey, label, value, shown };
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
  }

  // "Save this change?" confirmation for a price/remarks/extra field edit - patches just that one
  // top-level raw key and resubmits in place (same saveRawPatch the Hotel Details edits use).
  if (session.pendingFieldSectionConfirm) {
    const { code, guestName, raw, fieldKey, label, value, shown } = session.pendingFieldSectionConfirm;
    session.pendingFieldSectionConfirm = null;
    const yn = bookingFlow.parseYesNo(userMessage);
    if (yn === true) {
      try {
        await bookingEditForms.saveRawPatch(raw, { [fieldKey]: value });
        return editSectionMenuAgain(sessionId, session, userMessage, `Done — ${label} for **${code}** is now "${shown}".`, code, guestName);
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
    const reply = `Reply "yes" to set ${label} to "${shown}", or "no" to cancel.`;
    session.pendingFieldSectionConfirm = { code, guestName, raw, fieldKey, label, value, shown };
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
  }

  // The new value for whichever field was picked from BASIC_FIELD_CHOICE_CHIPS - this message IS
  // that value (free text, not a chip). Feeds straight into the same resolve+confirm the
  // typed-from-scratch "update <field> to <value>" path below already uses.
  if (session.pendingFieldValueEntry) {
    const { code, guestName, fieldKey, label } = session.pendingFieldValueEntry;
    session.pendingFieldValueEntry = null;
    const value = userMessage.trim();
    const expecting = fieldKey === 'guestCompany' ? { field: 'agent' } : undefined;
    if (!value) {
      session.pendingFieldValueEntry = { code, guestName, fieldKey, label };
      const reply = `Please type the new value for **${label}**.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0, expecting };
    }
    const resolved = await editBooking.resolveForEdit(code);
    if (resolved.status === 'ambiguous') {
      return askWhichRecord(sessionId, session, userMessage, code, resolved.matches, 'fieldEdit', { field: fieldKey, label, value, viaMenu: true });
    }
    return finishFieldEditResolve(sessionId, session, userMessage, resolved, { code, field: fieldKey, label, value, viaMenu: true });
  }

  // A request to duplicate an existing booking/quotation into a brand-new one - same real
  // /booking/AddBooking write path bookingFlow.js/convertBooking.js already use, just with
  // isDuplicateCheck:true (see duplicateBooking.js). Deterministic resolve, always confirmed first.
  const duplicateIntent = duplicateBooking.detectDuplicateIntent(userMessage, session.lastBookingCode);
  if (duplicateIntent && !session.draft) {
    const resolved = await duplicateBooking.resolveForDuplicate(duplicateIntent);
    if (resolved.status === 'ambiguous') {
      return askWhichRecord(sessionId, session, userMessage, duplicateIntent.code, resolved.matches, 'duplicate', {});
    }
    return finishDuplicateResolve(sessionId, session, userMessage, resolved, duplicateIntent.code || duplicateIntent.guestName);
  }

  // A "set this field to X?" confirmation was asked last turn - this message answers it.
  if (session.pendingFieldEditConfirm) {
    const { code, guestName, raw, fieldKey, label, value, displayValue, viaMenu } = session.pendingFieldEditConfirm;
    session.pendingFieldEditConfirm = null;
    const shown = displayValue != null ? displayValue : value;
    const yn = bookingFlow.parseYesNo(userMessage);
    if (yn === true) {
      try {
        await editBooking.applySimpleFieldEdit(raw, fieldKey, value);
        const done = `Done — ${label} for **${code}** (${guestName}) is now "${shown}".`;
        if (viaMenu) return editSectionMenuAgain(sessionId, session, userMessage, done, code, guestName);
        pushTurn(sessionId, userMessage, done);
        return { answer: done, sql: null, rowCount: 0 };
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
    const reply = `Reply "yes" to set ${label} for **${code}** to "${shown}", or "no" to cancel.`;
    session.pendingFieldEditConfirm = { code, guestName, raw, fieldKey, label, value, displayValue, viaMenu };
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, quickReplies: YES_NO_CHIPS };
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

  // A direct "edit the basic details of FT...", "edit hotel details of FT...", "update booking
  // FT..." command - opens the same section-menu system the post-duplicate offer opens
  // (openEditSection), for ANY existing record, not just one just duplicated. A section named in
  // the message (basic/hotel/itinerary/price/remarks/extra) jumps straight to it; otherwise shows
  // the top-level menu.
  const editMenuIntent = detectEditMenuIntent(userMessage, session.lastBookingCode);
  if (editMenuIntent && !session.draft) {
    const resolved = await editBooking.resolveForEdit(editMenuIntent.code);
    if (resolved.status === 'not_found') {
      const reply = `I couldn't find any booking or quotation matching **${editMenuIntent.code}** in the database.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    if (resolved.status === 'ambiguous') {
      return askWhichRecord(sessionId, session, userMessage, resolved.code, resolved.matches, 'editMenu', { sectionText: editMenuIntent.sectionText });
    }
    return openEditSection(sessionId, session, userMessage, resolved.code, resolved.guestName, editMenuIntent.sectionText, false);
  }

  // If a booking/quotation is already being collected in this session, stay in that flow.
  if (session.draft) {
    const { reply, draft, createdCode } = await bookingFlow.step(session.draft, userMessage);
    session.draft = draft;
    if (createdCode) session.lastBookingCode = createdCode;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0, expecting: expectingField(draft), quickReplies: quickRepliesFor(draft) };
  }

  // A full travel-agent trip brief (real day-by-day itinerary) pasted with no "create a booking"
  // wording at all, and no active draft, is still unambiguously a create-booking request - skip
  // straight to extracting it instead of making the user say "create a new booking" first and then
  // paste the exact same message again as a second turn.
  if (!session.draft && bookingFlow.looksLikeStandaloneAgentPaste(userMessage)) {
    const newDraft = bookingFlow.startDraft('booking');
    newDraft.sourceStarted = true; // skip the "what's the guest's name" prompt - this message IS the paste
    const { reply, draft, createdCode } = await bookingFlow.step(newDraft, userMessage);
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

  // Or a standalone request to register a new agent/company with no booking involved (see
  // agentCreate.js) - separate from bookingFlow.js's own embedded agent-creation step, which only
  // triggers when a typed agent name has no match partway through booking creation.
  if (agentCreate.detectAgentCreateIntent(userMessage)) {
    const { reply, pending } = agentCreate.start();
    session.pendingAgentCreate = pending;
    pushTurn(sessionId, userMessage, reply);
    return { answer: reply, sql: null, rowCount: 0 };
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

  // A request for the real Job Sheet page's own "Copy For Customer"/"Copy Booking" text (see
  // jobSheetCopy.js) - by a specific FT/FTQ code, or by today/tomorrow/yesterday/a literal date.
  // Handled deterministically against the real /Jobsheet/GetBookingById endpoint, never guessed.
  const jobSheetCopyIntent = jobSheetCopy.detectJobSheetCopyIntent(userMessage, session.lastBookingCode, todayIST());
  if (jobSheetCopyIntent) {
    if (!jobSheetCopyIntent.scope) {
      const reply = `Copy for which job sheet(s)? Give me an FT/FTQ code, or a day (today/tomorrow/yesterday/a date).`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }
    const result = await jobSheetCopy.resolveJobSheetCopies(jobSheetCopyIntent);
    if (result.status === 'ambiguous') {
      return askWhichRecord(sessionId, session, userMessage, jobSheetCopyIntent.scope.code, result.matches, 'jobSheetCopy', { copyType: jobSheetCopyIntent.copyType });
    }
    return finishJobSheetCopyResult(sessionId, session, userMessage, jobSheetCopyIntent, result);
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
      return respondAmbiguousDetail(sessionId, session, userMessage, label, result.matches, 'acctTxn');
    }
    return finishAcctTxnAnswer(sessionId, userMessage, result);
  }

  // Broad "booking detail" requests are fetched deterministically (fixed SQL, not LLM-authored)
  // so hotel/itinerary/cost data is always included - never left to the planner LLM's judgment
  // on whether to join those tables (it was found to sometimes skip them).
  const fullDetailIntent = bookingDetails.detectFullDetailIntent(userMessage);
  if (fullDetailIntent) {
    const resolved = await bookingDetails.fetchFullBookingDetails(fullDetailIntent);
    // fullDetailIntent may have been resolved by an explicit FT/FTQ code, bare digits, OR a bare
    // guest name (e.g. "booking details of guest karan") - .code is only set in the first two cases.
    const label = fullDetailIntent.code || fullDetailIntent.guestName;

    if (resolved.status === 'not_found') {
      const reply = `I couldn't find any booking or quotation matching **${label}** in the database.`;
      pushTurn(sessionId, userMessage, reply);
      return { answer: reply, sql: null, rowCount: 0 };
    }

    if (resolved.status === 'ambiguous') {
      return respondAmbiguousDetail(sessionId, session, userMessage, label, resolved.matches, 'fullDetail');
    }

    return finishFullDetailAnswer(sessionId, userMessage, resolved);
  }

  // Understand-then-query: figure out what's actually needed before ever attempting SQL (see
  // understandSystemPrompt's own comment for why). Same conversation history as the planner gets,
  // so a follow-up ("and for last week?") is understood in context too. A plain "NONE" (chit-chat,
  // no DB lookup) is passed through unchanged - the planner below still makes that call itself, this
  // just saves folding a useless plan into its prompt.
  const understandMessages = [
    { role: 'system', content: understandSystemPrompt() },
    ...session.history,
    { role: 'user', content: userMessage },
  ];
  // FAST_STRUCTURED_MODEL: the understand and initial-SQL steps are structured/mechanical (restate
  // intent against a known schema, then translate an already-worked-out plan into SQL syntax) - a
  // small fast model handles that reliably, and by the time SQL gets written the hard reasoning
  // (what does this question actually need) has already been done by the understand step. The
  // default GROQ_MODEL stays on for the SQL-repair retry below and the final answerer call, so a
  // wrong query still gets corrected by the more capable model, and the actual prose the user reads
  // is never written by the fast model - this is a latency optimization, not an accuracy trade.
  const FAST_STRUCTURED_MODEL = 'llama-3.1-8b-instant';

  const understanding = await callLLM(understandMessages, { model: FAST_STRUCTURED_MODEL });
  const hasPlan = !/^\s*none\s*$/i.test(understanding.trim());

  const plannerMessages = [
    { role: 'system', content: plannerSystemPrompt() },
    ...session.history,
    {
      role: 'user',
      content: hasPlan ? `${userMessage}\n\n(Internal plan of what's needed, already worked out - use this to write accurate SQL: ${understanding.trim()})` : userMessage,
    },
  ];

  let plannerReply = await callLLM(plannerMessages, { model: FAST_STRUCTURED_MODEL });
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
