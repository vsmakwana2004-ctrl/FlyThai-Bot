const { getPool } = require('./db');

const FULL_CODE_RE = /\bFTQ?\d+\b/i;
// "account history"/"account details" was missing - reproduced live: "show me the account history
// of FT..." didn't match, so it fell through to the generic LLM SQL-planner instead of this
// module's own verified pairVoucherLegs merge logic, producing raw unmerged Credit/Debit legs with
// no FROM/OPP account pairing and no Total Sale/Purchase/Revenue or Credit/Debit/Balance summary -
// silently wrong-shaped output compared to the real site's own Account screen for the same booking.
const ACCOUNT_TXN_INTENT_RE =
  /\b(account(?:ing)?\s+(?:transactions?|history|details?)|ledger|transaction\s+(?:history|list|details?)|transactions?\s+(?:for|of)\b|sale\s*(?:vs\.?|\/|and)\s*purchase|receipt\s*(?:vs\.?|\/|and)\s*payment)\b/i;

// "guest <name>" phrasing - e.g. "account detail of our guest karan" - or just a bare name after
// "of"/"for" ("account transactions of Devansh", no "guest" keyword at all) has no FT/FTQ code at
// all (by design; the user is naming the person, not the record), so falls through this far without
// a code to resolve. Captures whatever follows "of"/"for" (an optional "guest"/"our guest" prefix
// is skipped) and trims off trailing filler ("ka"/"ki"/"ke", "account", "details", "'s", ...) that a
// natural sentence tacks on afterward. NON_NAME_WORDS_RE guards against a phrase with no real guest
// name at all ("transactions of the whole account") being misread as one.
const GUEST_NAME_RE = /\b(?:of|for)\s+(?:our\s+)?(?:guest\s+)?([a-zA-Z][a-zA-Z\s'.-]{1,40})/i;
const NON_NAME_WORDS_RE = /\b(booking|bookings|quotation|quotations|hotel|hotels|payment|payments|record|records|invoice|invoices|transaction|transactions|voucher|vouchers|itinerary|status|agent|agents|company|companies|account|accounts)\b/i;
function extractGuestName(text) {
  const m = text.match(GUEST_NAME_RE);
  if (!m) return null;
  let name = m[1].replace(/\b(ka|ki|ke|account|accounts|detail|details|history|ledger|transaction|transactions|of|for)\b.*$/i, '').trim();
  name = name.replace(/'s$/i, '').trim();
  if (!name || NON_NAME_WORDS_RE.test(name)) return null;
  return name;
}

// Detects "show account transactions for booking FT...", "ledger for FT...", "transaction history
// of FT...", "sale vs purchase for FT...", "account detail of guest <name>" etc. Falls back to the
// session's last-mentioned booking code (same convention as statusUpdate.js) so a follow-up like
// "and its transactions?" resolves without repeating the code.
function detectAccountTransactionsIntent(text, lastBookingCode) {
  if (!ACCOUNT_TXN_INTENT_RE.test(text)) return null;
  const codeMatch = text.match(FULL_CODE_RE);
  if (codeMatch) return { code: codeMatch[0].toUpperCase() };
  const guestName = extractGuestName(text);
  if (guestName) return { guestName };
  if (lastBookingCode) return { code: lastBookingCode };
  return null;
}

// Returns { status: 'not_found' } | { status: 'ambiguous', matches } | { status: 'ok', booking }.
async function resolveBooking(pool, intent) {
  // Direct by internal Id - used when a caller already resolved one exact row out of a previous
  // ambiguous match (see chat.js's pendingAmbiguousDetail), so re-running the ambiguity check
  // against the shared code/name would just hit the same ambiguity again.
  if (intent.id != null) {
    const r = await pool.request().input('id', intent.id).query(`
      SELECT Id, BookingId, QuotationId, GuestName FROM BookingMaster WHERE IsDelete = 0 AND Id = @id
    `);
    if (r.recordset.length === 0) return { status: 'not_found' };
    return { status: 'ok', booking: r.recordset[0] };
  }
  // QuotationId is NOT guaranteed unique (see documents.js's resolveBookingByCode for the
  // confirmed live example of 3 rows sharing one code) - a bare TOP 1 here previously picked an
  // arbitrary one of them silently, showing the wrong guest's ledger. Same "ask, don't guess"
  // standard applies to a guest-name lookup - two different guests can share a first name.
  const r = intent.code
    ? await pool.request().input('code', intent.code).query(`
        SELECT Id, BookingId, QuotationId, GuestName FROM BookingMaster
        WHERE IsDelete = 0 AND (BookingId = @code OR QuotationId = @code)
      `)
    : await pool.request().input('name', `%${intent.guestName}%`).query(`
        SELECT Id, BookingId, QuotationId, GuestName FROM BookingMaster
        WHERE IsDelete = 0 AND GuestName LIKE @name
        ORDER BY CreatedOn DESC
      `);
  if (r.recordset.length === 0) return { status: 'not_found' };
  if (r.recordset.length > 1) return { status: 'ambiguous', matches: r.recordset };
  return { status: 'ok', booking: r.recordset[0] };
}

const SALE_PURCHASE_FOR = new Set(['Sale Form', 'Purchase Form']);
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Matches the real site's own "Account" screen for a booking (FT Code lookup). Verified against
// 3 real vouchers spanning THB and INR, exact match to the cent:
// - AccountTransaction stores every voucher as TWO rows sharing one VoucherNo (one Credit leg, one
//   Debit leg - standard double-entry). The site merges each pair into ONE display row; a plain
//   SELECT that doesn't do this shows every voucher twice.
// - The "FROM ACCOUNT" is always the leg whose AccountMaster.AccountType IS NOT NULL (the real
//   counterparty - Hotel/Agent/Vendor). The "OPP. ACCOUNT" is the other leg, always an internal
//   control account (AccountType IS NULL, e.g. "Fly Thai - Revenue" / "Fly Thai - Expense").
// - TransactionAmount is stored in INR regardless of the voucher's own Currency - confirmed by
//   back-computing TransactionAmount / ROE for several THB rows and getting clean, plausible THB
//   service prices (e.g. 91140 / 3.1 = 29400.00) every time. The CURRENCY column on the real site
//   additionally shows that back-computed original-currency figure; the CREDIT/DEBIT columns show
//   TransactionAmount itself (already INR), which is why summing it across rows of different
//   Currency values (as TOTAL SALE/PURCHASE do) is safe here - unlike most other money columns.
// Pairs each voucher's external (real-world) legs with their internal (Fly Thai control account)
// counterparts. Done in JS, not as a SQL self-join, because some vouchers are multi-line - one
// VoucherNo batching several hotels together as separate line items (verified: voucher '567' held
// 2 external legs - Sofitel 44,134 and Amari 1,02,442 - against 2 internal "Fly Thai - Expense"
// legs). A self-join on VoucherNo alone cross-products every external leg against every internal
// leg in that group (2x2=4), which is exactly what produced duplicate-looking rows in testing.
// Matching by TransactionAmount within the group re-pairs each leg with its actual counterpart;
// falling back to positional pairing only if amounts don't disambiguate (rare, but never crashes).
function pairVoucherLegs(rows) {
  const byVoucher = new Map();
  for (const r of rows) {
    const key = r.VoucherNo;
    if (!byVoucher.has(key)) byVoucher.set(key, []);
    byVoucher.get(key).push(r);
  }

  const paired = [];
  for (const legs of byVoucher.values()) {
    const external = legs.filter((r) => r.AccountType !== null);
    const internal = legs.filter((r) => r.AccountType === null);
    const usedInternal = new Set();

    for (const ext of external) {
      let match = internal.find(
        (i, idx) => !usedInternal.has(idx) && Number(i.TransactionAmount) === Number(ext.TransactionAmount)
      );
      let matchIdx = match ? internal.indexOf(match) : -1;
      if (!match) {
        // No exact-amount match left (unusual) - take any unused internal leg rather than drop the row.
        matchIdx = internal.findIndex((_, idx) => !usedInternal.has(idx));
        match = matchIdx >= 0 ? internal[matchIdx] : null;
      }
      if (matchIdx >= 0) usedInternal.add(matchIdx);

      // Which leg is shown as FROM (and whose own Credit/Debit is displayed) depends on the
      // transaction category - confirmed by querying the raw AccountTransaction/AccountMaster
      // rows directly for a real booking (FT07261770) and comparing against the real site's own
      // Account screen for that same booking: Sale Form/Purchase Form entries show the EXTERNAL
      // (real-world counterparty - Agent/Hotel/Vendor) leg as FROM, with the INTERNAL (Fly Thai
      // control account, e.g. "Fly Thai - Revenue"/"Fly Thai - Expense") leg's OWN Credit/Debit
      // displayed. Bank Payment/Receipt entries show the OPPOSITE - the INTERNAL leg (Fly Thai's
      // own bank account) as FROM, with the EXTERNAL leg's own Credit/Debit displayed. Previously
      // this always used the external leg for both FROM and the displayed Credit/Debit, which
      // matched Bank Payment/Receipt but was backwards for Sale/Purchase Form - reproduced live:
      // FT07261770's Sale Form row showed Debit here vs Credit on the real site (and vice versa
      // for its Purchase Form row), while its Bank Payment rows already matched.
      const isSalePurchase = SALE_PURCHASE_FOR.has(ext.TransactionFor);
      const fromLeg = isSalePurchase ? ext : match || ext;
      const oppLeg = isSalePurchase ? match : ext;

      paired.push({
        VoucherNo: ext.VoucherNo,
        TransactionDate: ext.TransactionDate,
        FromAccount: fromLeg.AccountName,
        OppAccount: oppLeg ? oppLeg.AccountName : '—',
        TransactionFor: ext.TransactionFor,
        TransactionType: oppLeg ? oppLeg.TransactionType : ext.TransactionType,
        TransactionAmount: ext.TransactionAmount,
        Currency: ext.Currency,
        ROE: ext.ROE,
      });
    }
  }
  return paired;
}

async function fetchAccountTransactions(intent) {
  const pool = await getPool();
  const resolved = await resolveBooking(pool, intent);
  if (resolved.status !== 'ok') return resolved;
  const booking = resolved.booking;

  const result = await pool.request().input('id', booking.Id).query(`
    SELECT at.VoucherNo, at.TransactionDate, at.TransactionFor, at.TransactionType,
           at.TransactionAmount, at.Currency, at.ROE, am.Name AS AccountName, am.AccountType
    FROM AccountTransaction at
    JOIN AccountMaster am ON at.AccountId = am.Id
    WHERE at.BookingId = @id AND at.IsDeleted = 0
    ORDER BY at.TransactionDate, at.VoucherNo, at.Id
  `);

  const rows = pairVoucherLegs(result.recordset);
  const salePurchase = rows.filter((r) => SALE_PURCHASE_FOR.has(r.TransactionFor));
  const receiptPayment = rows.filter((r) => !SALE_PURCHASE_FOR.has(r.TransactionFor));

  const sumBy = (list, pred) => round2(list.filter(pred).reduce((s, r) => s + Number(r.TransactionAmount || 0), 0));
  const totalSale = sumBy(salePurchase, (r) => r.TransactionFor === 'Sale Form');
  const totalPurchase = sumBy(salePurchase, (r) => r.TransactionFor === 'Purchase Form');
  // Mirrors the Sale/Purchase totals pattern above by analogy (sum the FROM leg's own amount,
  // grouped by its own Credit/Debit side) - unlike Sale/Purchase this half was NOT checked against
  // a real non-zero example (this booking has no Receipt/Payment rows), so treat the Balance sign
  // as inferred, not verified, until confirmed against a booking that actually has some.
  const totalCredit = sumBy(receiptPayment, (r) => r.TransactionType === 'Credit');
  const totalDebit = sumBy(receiptPayment, (r) => r.TransactionType === 'Debit');

  return {
    status: 'ok',
    code: booking.BookingId || booking.QuotationId,
    salePurchase,
    receiptPayment,
    totals: {
      totalSale,
      totalPurchase,
      totalRevenue: round2(totalSale - totalPurchase),
      totalCredit,
      totalDebit,
      totalBalance: round2(totalDebit - totalCredit),
    },
  };
}

function formatINR(n) {
  return `₹${round2(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCurrencyCell(row) {
  if (row.Currency === 'INR') return 'INR';
  const roe = Number(row.ROE) || 0;
  const original = roe > 0 ? Number(row.TransactionAmount) / roe : Number(row.TransactionAmount);
  return `${round2(original).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.Currency} (${roe.toFixed(2)})`;
}

function formatDate(d) {
  const dt = new Date(d);
  const day = String(dt.getUTCDate()).padStart(2, '0');
  const month = dt.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${day}-${month}-${dt.getUTCFullYear()}`;
}

function buildSection(title, rows, emptyText) {
  let out = `**${title}**\n\n`;
  if (rows.length === 0) {
    out += `${emptyText}\n`;
    return out;
  }
  out += '| Date | From Account | Opp. Account | Transaction For | Currency | Credit | Debit |\n';
  out += '|---|---|---|---|---|---|---|\n';
  for (const r of rows) {
    const amount = formatINR(r.TransactionAmount);
    const credit = r.TransactionType === 'Credit' ? amount : '—';
    const debit = r.TransactionType === 'Debit' ? amount : '—';
    out += `| ${formatDate(r.TransactionDate)} | ${r.FromAccount} | ${r.OppAccount} | ${r.TransactionFor} | ${formatCurrencyCell(r)} | ${credit} | ${debit} |\n`;
  }
  return out;
}

// Built directly as markdown, not sent through the LLM - this is a fixed report format matching a
// real accounting screen to the cent, and the merge/arithmetic above is exactly why: an LLM asked
// to "format" pre-merged financial rows still occasionally reorders or restates a number, which is
// tolerable for a booking summary but not for a ledger total.
function formatAccountTransactionsAnswer(result) {
  const t = result.totals;
  let md = `### Account Transactions — ${result.code}\n\n`;
  md += buildSection('Sale vs Purchase', result.salePurchase, 'No sale/purchase transactions found for this booking.');
  md += `\n**Total Sale:** ${formatINR(t.totalSale)}  **Total Purchase:** ${formatINR(t.totalPurchase)}  **Total Revenue:** ${formatINR(t.totalRevenue)}\n\n`;
  md += buildSection('Receipt vs Payment', result.receiptPayment, 'No receipt/payment transactions found for this booking.');
  md += `\n**Total Credit:** ${formatINR(t.totalCredit)}  **Total Debit:** ${formatINR(t.totalDebit)}  **Total Balance:** ${formatINR(t.totalBalance)}\n`;
  return md;
}

module.exports = { detectAccountTransactionsIntent, fetchAccountTransactions, formatAccountTransactionsAnswer };
