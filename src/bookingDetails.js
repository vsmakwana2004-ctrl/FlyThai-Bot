const { getPool } = require('./db');

const FULL_CODE_RE = /\bFTQ?\d+\b/i;
// Bare-digits fallback for when the user drops the "FT"/"FTQ" prefix (e.g. "8261781" instead of
// "FT08261781") - schema.js already tells the SQL-planner to handle this via a partial LIKE match,
// so this deterministic path mirrors that same rule.
const BARE_NUMBER_RE = /\b\d{4,}\b/;
// Broad "give me everything" phrasing only - narrower asks (just hotel list, just payment status,
// just job sheet status) should keep going through the normal SQL-planner path so we don't dump
// unrelated sections into a focused answer.
const DETAIL_INTENT_RE = /\b(detail|details|full info|complete info|everything about)\b/i;

// "details of guest <name>" or just "details of <name>" (no FT/FTQ code and no digits at all) has
// no code to resolve, and previously fell through this whole module entirely into the generic LLM
// SQL-planner - reproduced live twice: once for "guest karan" (silently skipped the hotel/
// itinerary/cost joins this deterministic path exists to guarantee), and again for "booking detail
// of Devansh" (no "guest" keyword at all - the planner's own generated SQL then failed outright
// with "Multiple statements are not allowed"). Captures whatever follows "of"/"for" (an optional
// "guest"/"our guest" prefix is skipped), then trims trailing filler ("ka"/"ki"/"ke", "detail",
// "'s", ...) a natural sentence tacks on afterward - same pattern as accountTransactions.js's own
// guest-name lookup. NON_NAME_WORDS_RE guards against "details of the hotel bookings"-style phrasing
// (no guest name at all) being misread as one - those fall through to the SQL-planner as before,
// rather than confidently searching for a guest literally named "the hotel bookings".
const GUEST_NAME_RE = /\b(?:of|for)\s+(?:our\s+)?(?:guest\s+)?([a-zA-Z][a-zA-Z\s'.-]{1,40})/i;
const NON_NAME_WORDS_RE = /\b(booking|bookings|quotation|quotations|hotel|hotels|payment|payments|record|records|invoice|invoices|transaction|transactions|voucher|vouchers|itinerary|status|agent|agents|company|companies)\b/i;
function extractGuestName(text) {
  const m = text.match(GUEST_NAME_RE);
  if (!m) return null;
  let name = m[1].replace(/\b(ka|ki|ke|booking|account|accounts|detail|details|history|ledger|of|for)\b.*$/i, '').trim();
  name = name.replace(/'s$/i, '').trim();
  if (!name || NON_NAME_WORDS_RE.test(name)) return null;
  return name;
}

// Detects requests like "What is the booking detail of FT08261781?", "What is the booking detail
// of 8261781?" (bare digits, no FT/FTQ prefix), or "give me the booking details of guest karan"
// (name, no code at all). Deterministic (regex + fixed SQL), not LLM-authored, so hotel/itinerary/
// cost data is ALWAYS fetched together - the SQL-planner LLM was found to sometimes only query
// BookingMaster and skip the joins schema.js asks for, silently producing an incomplete answer.
function detectFullDetailIntent(text) {
  if (!DETAIL_INTENT_RE.test(text)) return null;
  const fullMatch = text.match(FULL_CODE_RE);
  if (fullMatch) return { code: fullMatch[0].toUpperCase(), exact: true };
  const bareMatch = text.match(BARE_NUMBER_RE);
  if (bareMatch) return { code: bareMatch[0], exact: false };
  const guestName = extractGuestName(text);
  if (guestName) return { guestName };
  return null;
}

// Resolves the intent to exactly one BookingMaster.Id.
// Returns { status: 'not_found' } | { status: 'ambiguous', matches: [...] } | { status: 'ok', id, row }
async function resolveBooking(pool, intent) {
  if (intent.exact) {
    // QuotationId is NOT guaranteed unique (see documents.js's resolveBookingByCode for the
    // confirmed live example of 3 rows sharing one code) - a bare TOP 1 here previously picked an
    // arbitrary one of them silently, showing the wrong guest's details. Same ambiguity check the
    // bare-digits branch below already does.
    const r = await pool.request().input('code', intent.code).query(`
      SELECT Id, BookingId, QuotationId, GuestName FROM BookingMaster
      WHERE IsDelete = 0 AND (BookingId = @code OR QuotationId = @code)
    `);
    if (r.recordset.length === 0) return { status: 'not_found' };
    if (r.recordset.length > 1) return { status: 'ambiguous', matches: r.recordset };
    return { status: 'ok', id: r.recordset[0].Id };
  }

  if (intent.guestName) {
    const r = await pool.request().input('name', `%${intent.guestName}%`).query(`
      SELECT Id, BookingId, QuotationId, GuestName FROM BookingMaster
      WHERE IsDelete = 0 AND GuestName LIKE @name
      ORDER BY CreatedOn DESC
    `);
    if (r.recordset.length === 0) return { status: 'not_found' };
    if (r.recordset.length > 1) return { status: 'ambiguous', matches: r.recordset };
    return { status: 'ok', id: r.recordset[0].Id };
  }

  // Bare digits - match anywhere inside the real code (never reconstruct the code by guessing the prefix).
  const r = await pool.request().input('digits', `%${intent.code}%`).query(`
    SELECT TOP 5 Id, BookingId, QuotationId, GuestName FROM BookingMaster
    WHERE IsDelete = 0 AND (BookingId LIKE @digits OR QuotationId LIKE @digits)
  `);
  if (r.recordset.length === 0) return { status: 'not_found' };
  if (r.recordset.length > 1) return { status: 'ambiguous', matches: r.recordset };
  return { status: 'ok', id: r.recordset[0].Id };
}

async function fetchFullBookingDetails(intent) {
  const pool = await getPool();
  const resolved = await resolveBooking(pool, intent);
  if (resolved.status !== 'ok') return resolved;

  const bookingResult = await pool.request().input('id', resolved.id).query(`
    SELECT TOP 1 bm.Id, bm.BookingId, bm.QuotationId, bm.IsBooking, bm.GuestName, bm.GuestPhoneNumber,
           bm.GuestEmail, bm.GuestCompany, bm.GuestAdults, bm.GuestChildrens, bm.GuestInfants,
           bm.TravelDate, bm.ReturnDate, bm.Currency, bm.ROERate, bm.ROECharge, bm.TaxAmount, bm.TaxPercentage,
           bm.LandSelling, bm.InvoiceDiscount, bm.TravelStatus, bm.InvoiceStatus, bm.VoucherStatus,
           bm.ItineraryStatus, bm.PaymentStatus, bm.BookingBy, bm.CreatedOn, bm.UpdatedOn,
           a.Name AS AgentName, a.Phone AS AgentPhone,
           STUFF((
             SELECT ', ' + d.Name
             FROM Destination d
             WHERE d.IsDelete = 0
               AND CHARINDEX(',' + CAST(d.Id AS VARCHAR) + ',', ',' + bm.Destinations + ',') > 0
             FOR XML PATH('')
           ), 1, 2, '') AS DestinationNames
    FROM BookingMaster bm
    LEFT JOIN Agents a ON a.Id = bm.AgentId AND a.IsDeleted = 0
    WHERE bm.IsDelete = 0 AND bm.Id = @id
  `);
  const booking = bookingResult.recordset[0];
  if (!booking) return { status: 'not_found' };

  const [hotelsResult, itineraryResult, membersResult] = await Promise.all([
    pool.request().input('id', booking.Id).query(`
      SELECT bh.Id, bh.Name AS HotelName, bh.RoomCategory, bh.TotalRooms, bh.TotalNights,
             bh.CheckInDate, bh.CheckOutDate, bh.HotelRatePerNight, bh.HotelRatePerNightCurrency,
             bh.TotalAmount
      FROM BookingHotel bh
      WHERE bh.BookingId = @id AND bh.IsDelete = 0
      ORDER BY bh.CheckInDate
    `),
    pool.request().input('id', booking.Id).query(`
      SELECT bi.Date, bi.Time, bi.Particular, bi.Type, bi.FlightNo, bi.TotalAdult, bi.TotalChild, bi.TotalInfant, bi.FinalPrice
      FROM BookingItineary bi
      WHERE bi.BookingId = @id AND bi.IsDelete = 0
      ORDER BY bi.Date, bi.Time
    `),
    pool.request().input('id', booking.Id).query(`
      SELECT bmt.Type, bmt.Price, bmt.PAX
      FROM BookingMemberType bmt
      WHERE bmt.BookingId = @id AND bmt.IsDelete = 0
    `),
  ]);

  const costRows = membersResult.recordset;
  // Precomputed here (not left for the LLM to calculate) so the ROE conversion always matches the
  // real invoice math exactly: Total Cost -> x ROE -> Total After ROE -> minus Discount -> Final
  // Amount. Formula verified against a real invoice PDF and matches financeReports.js's own
  // documented one: (TotalCost + Tax) x (ROERate + ROECharge) - a booking can have its rate set in
  // either field (ROERate is often left at 0 with the real rate entered as ROECharge instead), so
  // using ROERate alone (the previous bug here) silently dropped these rows for those bookings.
  let costSummary = null;
  if (costRows.length) {
    const round2 = (n) => Math.round(n * 100) / 100;
    const totalCost = costRows.reduce((sum, r) => sum + (Number(r.Price) || 0) * (Number(r.PAX) || 0), 0);
    const roeRate = Number(booking.ROERate) || 0;
    const roeCharge = Number(booking.ROECharge) || 0;
    const taxAmount = Number(booking.TaxAmount) || 0;
    const combinedRoe = roeRate + roeCharge;
    const totalAfterROE = combinedRoe ? (totalCost + taxAmount) * combinedRoe : null;
    const discount = Number(booking.InvoiceDiscount) || 0;
    costSummary = {
      currency: booking.Currency,
      totalCost: round2(totalCost),
      roeRate: booking.ROERate,
      roeCharge: booking.ROECharge,
      totalAfterROE: totalAfterROE !== null ? round2(totalAfterROE) : null,
      discountINR: discount,
      finalAmountINR: totalAfterROE !== null ? round2(totalAfterROE - discount) : null,
    };
  }

  let hotelExtras = [];
  const hotelIds = hotelsResult.recordset.map((h) => h.Id).filter(Number.isInteger);
  if (hotelIds.length) {
    // hotelIds come from our own prior parameterized query result (never user input), safe to inline.
    const extrasResult = await pool.request().query(`
      SELECT bham.BookingHotelId, at.Type AS AttributeType, bham.Adults, bham.Children, bham.Infants, bham.FinalPrice, bham.Currency
      FROM BookingHotelAttributeMapping bham
      JOIN AttributeType at ON at.Id = bham.AttributeTypeId
      WHERE bham.BookingHotelId IN (${hotelIds.join(',')}) AND bham.IsDeleted = 0 AND bham.IsActive = 1
    `);
    hotelExtras = extrasResult.recordset;
  }

  return {
    status: 'ok',
    data: {
      booking,
      hotels: hotelsResult.recordset,
      hotelExtras,
      itinerary: itineraryResult.recordset,
      costBreakdown: costRows,
      costSummary,
    },
  };
}

module.exports = { detectFullDetailIntent, fetchFullBookingDetails };
