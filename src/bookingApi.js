const { getPool } = require('./db');

function buildHeaders() {
  const cookie = process.env.FLYTHAI_SESSION_COOKIE;
  if (!cookie) {
    const err = new Error('FLYTHAI_SESSION_COOKIE is not set in .env. Capture it from the browser (F12 -> Network -> Copy as cURL on Add Booking) and add it.');
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
async function submitBooking(model, isBooking, { allowSalesEntry = true } = {}) {
  const { base, headers } = buildHeaders();
  const body = {
    model,
    type: isBooking,
    isDuplicateCheck: false,
    allowSalesEntry,
  };

  const res = await fetch(`${base}/booking/AddBooking`, {
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

  const res = await fetch(`${base}/booking/updateStatus`, {
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

module.exports = { submitBooking, findBookingById, updateBookingStatus };
