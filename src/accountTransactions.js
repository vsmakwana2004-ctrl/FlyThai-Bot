const { getPool } = require('./db');

const FULL_CODE_RE = /\bFTQ?\d+\b/i;
const ACCOUNT_TXN_INTENT_RE =
  /\b(account(?:ing)?\s+transactions?|ledger|transaction\s+(?:history|list|details?)|transactions?\s+(?:for|of)\b|sale\s*(?:vs\.?|\/|and)\s*purchase|receipt\s*(?:vs\.?|\/|and)\s*payment)\b/i;

// Detects "show account transactions for booking FT...", "ledger for FT...", "transaction history
// of FT...", "sale vs purchase for FT..." etc. Falls back to the session's last-mentioned booking
// code (same convention as statusUpdate.js) so a follow-up like "and its transactions?" resolves
// without repeating the code.
function detectAccountTransactionsIntent(text, lastBookingCode) {
  if (!ACCOUNT_TXN_INTENT_RE.test(text)) return null;
  const match = text.match(FULL_CODE_RE);
  const code = match ? match[0].toUpperCase() : lastBookingCode;
  if (!code) return null;
  return { code };
}

async function resolveBooking(pool, code) {
  const r = await pool.request().input('code', code).query(`
    SELECT TOP 1 Id, BookingId, QuotationId FROM BookingMaster
    WHERE IsDelete = 0 AND (BookingId = @code OR QuotationId = @code)
  `);
  return r.recordset[0] || null;
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

      paired.push({
        VoucherNo: ext.VoucherNo,
        TransactionDate: ext.TransactionDate,
        FromAccount: ext.AccountName,
        OppAccount: match ? match.AccountName : '—',
        TransactionFor: ext.TransactionFor,
        TransactionType: ext.TransactionType,
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
  const booking = await resolveBooking(pool, intent.code);
  if (!booking) return { status: 'not_found' };

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
