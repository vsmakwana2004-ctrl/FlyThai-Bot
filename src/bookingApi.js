const { getPool } = require('./db');
const { getFlythaiCookie } = require('./requestContext');

// Node's built-in fetch (undici) throws a bare "fetch failed" TypeError for ANY network-level
// failure before a response arrives (DNS lookup, connection refused/reset, TLS handshake, timeout)
// - the actual reason lives in err.cause, which every caller here was silently losing, so a real
// network hiccup surfaced to staff as an unhelpful "fetch failed" with nothing to act on and
// nothing in the server logs to diagnose from. Wraps the error with the cause's own code/message
// (e.g. "ECONNRESET", "ETIMEDOUT") and always logs server-side so a repeat failure is diagnosable.
async function safeFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (err) {
    console.error('FlyThai API request failed:', url, err.cause || err);
    const cause = err.cause;
    const detail = cause && (cause.code || cause.message) ? ` (${cause.code || cause.message})` : '';
    const wrapped = new Error(`Could not reach the FlyThai booking site${detail}. Please check the connection and try again.`);
    wrapped.cause = err;
    throw wrapped;
  }
}

function buildHeaders() {
  // The logged-in chat session's own FlyThai cookie (see requestContext.js) takes priority, so
  // FlyThai records the real person as who made this change - falls back to the one shared
  // FLYTHAI_SESSION_COOKIE only when nobody's logged in for this call (e.g. not wrapped in a
  // request context at all).
  const cookie = getFlythaiCookie() || process.env.FLYTHAI_SESSION_COOKIE;
  if (!cookie) {
    const err = new Error('Not logged in, and FLYTHAI_SESSION_COOKIE is not set in .env either. Please log in, or capture a fallback cookie (F12 -> Network -> Copy as cURL on Add Booking) and add it.');
    err.code = 'NO_SESSION_COOKIE';
    throw err;
  }
  const base = process.env.FLYTHAI_BASE_URL || 'https://flythai.arkinfosoft.in';
  return {
    base,
    headers: {
      accept: '*/*',
      'content-type': 'application/json',
      cookie,
      origin: base,
      referer: `${base}/Booking/Index`,
      'x-requested-with': 'XMLHttpRequest',
    },
  };
}

// Submits a booking/quotation using the same endpoint the real Add Booking page uses.
// model.id must be 0 for a new record. isBooking=true -> "type":true (Booking), false -> Quotation.
// Returns the new record's internal Id on success. The real site's own JS treats the response
// body as a raw integer: >0 is the new id, -1 means "agent account not found" (the real UI asks
// to confirm saving anyway without a sales entry), anything else is a rejected/failed save.
// isDuplicateCheck: true is how the real "Duplicate Booking" action (managebookings.js) tells this
// same endpoint to insert a brand-new row instead of updating the one model.id points at - confirmed
// live from the real site's own JS, which resubmits the original record's own id unchanged either
// way, so this flag (not a zeroed id) is what the server keys off. Defaults to false so every
// existing caller (new-booking create, quotation convert, field/itinerary edit) is unaffected.
async function submitBooking(model, isBooking, { allowSalesEntry = true, isDuplicateCheck = false } = {}) {
  const { base, headers } = buildHeaders();
  const body = {
    model,
    type: isBooking,
    isDuplicateCheck,
    allowSalesEntry,
  };

  const res = await safeFetch(`${base}/booking/AddBooking`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`Booking API returned ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (res.url && /\/Login/i.test(res.url)) {
    const err = new Error('The session cookie appears to be expired (redirected to login). Please re-capture FLYTHAI_SESSION_COOKIE.');
    err.code = 'SESSION_EXPIRED';
    throw err;
  }

  const newId = Number(text.trim());
  if (!Number.isFinite(newId)) {
    throw new Error(`FlyThai returned an unexpected response (expected a numeric id): ${text.slice(0, 300)}`);
  }
  if (newId === -1) {
    const err = new Error("Agent account not found for this booking - the real site would ask to confirm saving without a sales entry.");
    err.code = 'AGENT_ACCOUNT_NOT_FOUND';
    throw err;
  }
  if (newId <= 0) {
    throw new Error('FlyThai rejected the booking (no valid id returned) - nothing was saved.');
  }

  return newId;
}

// Looks up the just-created record directly by the internal Id the API handed back - reliable,
// no guessing by guest name/phone (which could theoretically collide between concurrent creates).
async function findBookingById(internalId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', internalId)
    .query(`SELECT TOP 1 Id, BookingId, QuotationId, GuestName FROM BookingMaster WHERE IsDelete = 0 AND Id = @id`);
  return result.recordset[0] || null;
}

// Updates one of the 5 status dropdowns on the Booking list grid, using the exact same endpoint
// and payload shape as the real site's updateStatus(this, id, type) JS function.
// Returns true on success (the site's own JS checks `data === 1`).
async function updateBookingStatus(internalId, statusType, value) {
  const { base, headers } = buildHeaders();
  const body = new URLSearchParams({ value, id: String(internalId), status: statusType }).toString();

  const res = await safeFetch(`${base}/booking/updateStatus`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`Status update API returned ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (res.url && /\/Login/i.test(res.url)) {
    const err = new Error('The session cookie appears to be expired (redirected to login). Please re-capture FLYTHAI_SESSION_COOKIE.');
    err.code = 'SESSION_EXPIRED';
    throw err;
  }

  return text.trim() === '1';
}

// Creates a new agent/company record via the real Agent master page's own save endpoint
// (/Agent/AddEditAgent, confirmed live from that page's manageagent.js). Phone/Email/Address are
// all optional at the API level despite the real form marking them required client-side (verified
// live: a blank Phone/Email round-trip creates the record fine, with those columns left null) - so
// a brand-new agent typed straight from the booking flow can be created from just its name.
// Returns 'created' (raw response "1"), 'duplicate' (raw response "3" - the API's own
// case-insensitive exact-name check, same one the real UI shows "Agent already exists" for), or
// throws for anything else (raw response "0" or an unexpected body).
async function createAgent({ name, phone = '', email = '', address = '' }) {
  const { base, headers } = buildHeaders();
  const form = new FormData();
  form.append('Id', '');
  form.append('Name', name);
  form.append('Phone', phone);
  form.append('Email', email);
  form.append('Address', address);
  form.append('AgentLogo', '');

  // content-type must come from FormData's own multipart boundary, not the shared JSON default.
  const { 'content-type': _drop, ...rest } = headers;

  const res = await safeFetch(`${base}/Agent/AddEditAgent`, {
    method: 'POST',
    headers: rest,
    body: form,
  });

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`Agent create API returned ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  if (res.url && /\/Login/i.test(res.url)) {
    const err = new Error('The session cookie appears to be expired (redirected to login). Please re-capture FLYTHAI_SESSION_COOKIE.');
    err.code = 'SESSION_EXPIRED';
    throw err;
  }

  const code = text.trim();
  if (code === '1') return 'created';
  if (code === '3') return 'duplicate';
  throw new Error(`FlyThai rejected the new agent (unexpected response "${code}") - nothing was saved.`);
}

module.exports = { submitBooking, findBookingById, updateBookingStatus, createAgent, safeFetch };
