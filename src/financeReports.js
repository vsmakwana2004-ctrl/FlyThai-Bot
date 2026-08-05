const { getPool } = require('./db');

// Cross-booking financial totals (income for a period, total receivable right now). The real
// admin panel has NO screen that produces either of these as a single number - every report it
// has (dbo.GetAccountReport, dbo.GetFilterReports) is per-booking/per-account and paginated, with
// totalling left to a human. Rather than let the general LLM->SQL planner improvise a query here
// (exactly the mistake accountTransactions.js was built to avoid for per-booking ledgers - a naive
// SUM over AccountTransaction double-counts every voucher's two double-entry legs), this module
// replicates the real system's own formulas verbatim, found in the actual stored procedures:
//   - GetAccountReport.sql: FinalRevenue = SUM(Sale Form/Debit legs) - SUM(Purchase Form/Credit legs)
//   - GetFilterPaymentPage.sql + GetFilterReports.sql: per-booking outstanding =
//     (SUM(BookingMemberType.PAX*Price) + TaxAmount) * (ROECharge + ROERate) - PaymentMaster.PaidAmount
// then sums across the whole period/all bookings instead of grouping - the real procs never do that.

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isoDate(y, m, d) {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}

function todayDateIST() {
  const [y, m, d] = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).split('-').map(Number);
  return { year: y, month: m - 1, day: d };
}

function monthRange(y, m) {
  const to = m === 11 ? isoDate(y + 1, 0, 1) : isoDate(y, m + 1, 1);
  return { label: `${MONTH_NAMES[m]} ${y}`, fromISO: isoDate(y, m, 1), toISO: to };
}

// No "quarter" concept exists anywhere in the real system (confirmed by grep across its whole
// codebase) - this defines a plain calendar quarter (Jan-Mar, Apr-Jun, ...) since there's no real
// precedent to mirror instead.
function quarterRange(y, q) {
  const startMonth = q * 3;
  const endMonth = startMonth + 3;
  const to = endMonth >= 12 ? isoDate(y + 1, endMonth - 12, 1) : isoDate(y, endMonth, 1);
  return { label: `Q${q + 1} ${y} (${MONTH_NAMES[startMonth]}-${MONTH_NAMES[startMonth + 2]})`, fromISO: isoDate(y, startMonth, 1), toISO: to };
}

function yearRange(y) {
  return { label: String(y), fromISO: isoDate(y, 0, 1), toISO: isoDate(y + 1, 0, 1) };
}

// Recognizes only common, unambiguous period phrases (English + Hinglish) - anything else falls
// back to "all time" rather than guessing at what an unrecognised date word meant.
function parsePeriod(text) {
  const t = text.toLowerCase();
  const now = todayDateIST();
  if (/\bthis\s+month\b|\bis\s+mahine?\b/.test(t)) return monthRange(now.year, now.month);
  if (/\blast\s+month\b|\bpichle\s+mahine?\b/.test(t)) {
    const m = now.month === 0 ? 11 : now.month - 1;
    const y = now.month === 0 ? now.year - 1 : now.year;
    return monthRange(y, m);
  }
  if (/\bthis\s+quarter\b|\bis\s*quarter\b/.test(t)) return quarterRange(now.year, Math.floor(now.month / 3));
  if (/\blast\s+quarter\b|\bpichle\s+quarter\b/.test(t)) {
    const q = Math.floor(now.month / 3) - 1;
    return q < 0 ? quarterRange(now.year - 1, 3) : quarterRange(now.year, q);
  }
  if (/\bthis\s+year\b|\bis\s+s(?:aa?)l\b/.test(t)) return yearRange(now.year);
  if (/\blast\s+year\b|\bpichle\s+s(?:aa?)l\b/.test(t)) return yearRange(now.year - 1);
  return null; // all-time
}

const INCOME_RE = /\b(income|revenue|earnings?|total\s+sale|net\s+revenue|kamai|kamaya|kama(?:ye)?)\b/i;
const RECEIVABLE_RE =
  /\b(receivables?|outstanding\s+(?:amount|balance|payments?)?|pending\s+payments?\s+total|amount\s+due|due\s+amount|balance\s+due|paisa\s+(?:aana|lena)\s+baki|kitna\s+paisa\s+(?:aana|lena)|kitna\s+lena\s+(?:hai|he|baki)?)\b/i;
// "Payment(s) received/came in" - money ALREADY collected, the opposite of RECEIVABLE_RE (money
// NOT yet collected). Deliberately narrower than a bare "payment" so it doesn't swallow ordinary
// per-booking payment-status questions ("what's the payment status of FT...") which have nothing
// to do with this cross-booking total.
const PAYMENT_RECEIVED_RE = /\b(payments?\s+(?:received|came\s+in|collected)|receipts?\s+(?:received|total)|money\s+(?:received|came\s+in)|paisa\s+(?:mila|aaya))\b/i;
// The real system's ProfitReport (hotel-selling-minus-hotel-cost + land-selling-minus-land-cost)
// only ever exists per single FT/FTQ code (ReportsRepository.GetProfitReportById requires one) -
// there is no period-total variant anywhere in the real code. Rather than invent a formula with no
// real precedent (the same trap "quarter" would have been without a clear calendar definition),
// this is caught separately so it gets an honest "not available as a total" answer instead of a
// fabricated number from the general planner.
const PROFIT_RE = /\b(profit|munafa|margin)\b/i;
// Catches everything else finance/account-shaped that isn't one of the three specific asks above -
// "total purchase", "total expenses", "how much did we pay hotels", "net balance", "cash flow" -
// and answers with the FULL breakdown (fetchAccountSummary) rather than trying to keep matching
// ever-more-specific phrasings 1:1. Whatever specific figure the user actually meant is somewhere
// in that table, so this is deliberately a wide net rather than a precise one.
const ACCOUNT_SUMMARY_RE =
  /\b(total\s+(?:purchase|expenses?|payments?)|purchase(?:s)?\s+total|expenses?\s+total|payments?\s+made|money\s+(?:paid|spent)|hotel\s+purchase|hotel\s+payment|net\s+balance|cash\s+flow|account(?:ing)?\s+summary|financial\s+summary|kharch(?:a|e)?|khareed(?:ari)?|kitna\s+(?:diya|pay\s+kiya|kharch))\b/i;

// Checked before the account-transactions (per-booking ledger) intent and well before the generic
// planner - a bare "income"/"receivable"/"payment received" question has no FT/FTQ code to anchor
// it to, so it must never fall through to bookingDetails/accountTransactions (which require one)
// or the LLM planner (which would silently double-count/mis-sign these numbers, or - as verified
// live - report a THB voucher's INR-converted TransactionAmount as if it were the THB figure,
// per the module comment above).
function detectFinanceReportIntent(text) {
  if (RECEIVABLE_RE.test(text)) return { kind: 'receivable', period: null };
  if (PAYMENT_RECEIVED_RE.test(text)) return { kind: 'paymentReceived', period: parsePeriod(text) };
  if (PROFIT_RE.test(text)) return { kind: 'profitUnsupported', period: null };
  if (INCOME_RE.test(text)) return { kind: 'income', period: parsePeriod(text) };
  if (ACCOUNT_SUMMARY_RE.test(text)) return { kind: 'summary', period: parsePeriod(text) };
  return null;
}

async function fetchIncomeReport(period) {
  const pool = await getPool();
  const request = pool.request();
  let dateFilter = '';
  if (period) {
    request.input('from', period.fromISO).input('to', period.toISO);
    dateFilter = 'AND TransactionDate >= @from AND TransactionDate < @to';
  }
  const result = await request.query(`
    SELECT
      ISNULL(SUM(CASE WHEN TransactionFor = 'Sale Form' AND TransactionType = 'Debit' THEN TransactionAmount END), 0) AS TotalSale,
      ISNULL(SUM(CASE WHEN TransactionFor = 'Purchase Form' AND TransactionType = 'Credit' THEN TransactionAmount END), 0) AS TotalPurchase
    FROM AccountTransaction
    WHERE IsDeleted = 0 ${dateFilter}
  `);
  const row = result.recordset[0];
  const totalSale = Number(row.TotalSale) || 0;
  const totalPurchase = Number(row.TotalPurchase) || 0;
  return { period, totalSale, totalPurchase, finalRevenue: totalSale - totalPurchase };
}

function formatMoney(n) {
  return n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function formatIncomeAnswer({ period, totalSale, totalPurchase, finalRevenue }) {
  const periodLabel = period ? period.label : 'all time';
  return `**Income for ${periodLabel}** (amounts in INR — AccountTransaction always stores them converted to INR, regardless of the voucher's own currency):
- Total Sale: ₹${formatMoney(totalSale)}
- Total Purchase: ₹${formatMoney(totalPurchase)}
- **Net Revenue (Sale − Purchase): ₹${formatMoney(finalRevenue)}**

This mirrors the real site's own Account Report "FinalRevenue" formula (Sale Form minus Purchase Form transaction legs), just totalled across the whole period instead of split by booking/account the way that screen shows it.`;
}

// Money actually collected (Bank/Cash Receipt Credit legs), broken down by the voucher's OWN
// currency - not just AccountTransaction.Currency grouped with the raw TransactionAmount, which
// looks plausible but is wrong: TransactionAmount is always stored converted to INR, so a THB
// voucher's raw amount is really its INR-equivalent, not a THB figure (verified live: a "THB total"
// computed that naive way was off by 3x, matching exactly the account-ledger's own average ROE).
// Dividing back by each row's own ROE undoes that conversion; INR-native rows store ROE=0 (no
// conversion applied), so those are left as-is rather than divided by zero.
async function fetchPaymentReceivedReport(period) {
  const pool = await getPool();
  const request = pool.request();
  let dateFilter = '';
  if (period) {
    request.input('from', period.fromISO).input('to', period.toISO);
    dateFilter = 'AND TransactionDate >= @from AND TransactionDate < @to';
  }
  const result = await request.query(`
    SELECT TransactionAmount, Currency, ROE
    FROM AccountTransaction
    WHERE IsDeleted = 0 AND TransactionType = 'Credit' AND TransactionFor IN ('Bank Receipt', 'Cash Receipt') ${dateFilter}
  `);

  const byCurrency = new Map();
  let totalINR = 0;
  for (const row of result.recordset) {
    const amt = Number(row.TransactionAmount) || 0;
    totalINR += amt; // TransactionAmount is always the INR-equivalent, so this sum is always safe.
    const roe = Number(row.ROE) || 0;
    const currency = row.Currency || 'INR';
    const nativeAmt = roe > 0 ? amt / roe : amt;
    byCurrency.set(currency, (byCurrency.get(currency) || 0) + nativeAmt);
  }
  return {
    period,
    totalINR,
    byCurrency: Array.from(byCurrency.entries())
      .map(([currency, amount]) => ({ currency, amount }))
      .sort((a, b) => b.amount - a.amount),
  };
}

function formatPaymentReceivedAnswer({ period, totalINR, byCurrency }) {
  const periodLabel = period ? period.label : 'all time';
  if (byCurrency.length === 0) return `No payments were received for ${periodLabel}.`;
  const rows = byCurrency.map((c) => `| ${c.currency} | ${formatMoney(c.amount)} |`).join('\n');
  return `**Payments received for ${periodLabel}** (Bank/Cash Receipt entries), by the voucher's own original currency:

| Currency | Total Amount |
|---|---|
${rows}

Combined, that's **₹${formatMoney(totalINR)}** in INR-equivalent terms (AccountTransaction stores every amount converted to INR internally — the table above undoes that per voucher's own ROE, so each currency shows its real native figure rather than a mislabeled INR amount).`;
}

function formatProfitUnsupportedAnswer() {
  return `I don't have a "total profit" figure to give you here — the real site itself only computes profit per single booking/quotation (hotel selling price minus hotel cost, plus land selling minus land cost), never as a period total. If you give me a specific booking/quotation code I can look at what's available for it; otherwise this isn't something I can answer accurately, so I'd rather say that than guess.`;
}

// Full breakdown matching dbo.GetAccountReport.sql's own CASE-based bucketing exactly (Sale/
// Purchase/Receipt/Payment, Purchase and Payment each split Hotel vs Other via AccountMaster.
// AccountType), summed across the whole period into one row instead of GROUP BY account/booking
// like the real proc does. Used whenever a finance question doesn't match one of the three more
// specific formats above (income/receivable/payment-received) - showing everything at once means
// whatever the user actually meant by "expenses"/"total purchase"/"net balance"/etc. is in here,
// rather than needing to keep guessing exact phrasings.
async function fetchAccountSummary(period) {
  const pool = await getPool();
  const request = pool.request();
  let dateFilter = '';
  if (period) {
    request.input('from', period.fromISO).input('to', period.toISO);
    dateFilter = 'AND at.TransactionDate >= @from AND at.TransactionDate < @to';
  }
  const result = await request.query(`
    SELECT
      ISNULL(SUM(CASE WHEN at.TransactionFor = 'Sale Form' AND at.TransactionType = 'Debit' THEN at.TransactionAmount END), 0) AS TotalSale,
      ISNULL(SUM(CASE WHEN at.TransactionFor = 'Purchase Form' AND at.TransactionType = 'Credit' AND am.AccountType = 'Hotel' THEN at.TransactionAmount END), 0) AS TotalHotelPurchase,
      ISNULL(SUM(CASE WHEN at.TransactionFor = 'Purchase Form' AND at.TransactionType = 'Credit' AND (am.AccountType IS NULL OR am.AccountType <> 'Hotel') THEN at.TransactionAmount END), 0) AS TotalOtherPurchase,
      ISNULL(SUM(CASE WHEN at.TransactionFor IN ('Bank Receipt', 'Cash Receipt') AND at.TransactionType = 'Credit' THEN at.TransactionAmount END), 0) AS TotalReceipt,
      ISNULL(SUM(CASE WHEN at.TransactionFor IN ('Bank Payment', 'Cash Payment') AND at.TransactionType = 'Debit' AND am.AccountType = 'Hotel' THEN at.TransactionAmount END), 0) AS TotalHotelPayment,
      ISNULL(SUM(CASE WHEN at.TransactionFor IN ('Bank Payment', 'Cash Payment') AND at.TransactionType = 'Debit' AND (am.AccountType IS NULL OR am.AccountType <> 'Hotel') THEN at.TransactionAmount END), 0) AS TotalOtherPayment
    FROM AccountTransaction at
    LEFT JOIN AccountMaster am ON am.Id = at.AccountId
    WHERE at.IsDeleted = 0 ${dateFilter}
  `);
  const row = result.recordset[0];
  const totalSale = Number(row.TotalSale) || 0;
  const totalHotelPurchase = Number(row.TotalHotelPurchase) || 0;
  const totalOtherPurchase = Number(row.TotalOtherPurchase) || 0;
  const totalReceipt = Number(row.TotalReceipt) || 0;
  const totalHotelPayment = Number(row.TotalHotelPayment) || 0;
  const totalOtherPayment = Number(row.TotalOtherPayment) || 0;
  const totalPurchase = totalHotelPurchase + totalOtherPurchase;
  const totalPayment = totalHotelPayment + totalOtherPayment;
  return {
    period,
    totalSale,
    totalHotelPurchase,
    totalOtherPurchase,
    totalPurchase,
    totalReceipt,
    totalHotelPayment,
    totalOtherPayment,
    totalPayment,
    finalRevenue: totalSale - totalPurchase,
    finalBalance: totalReceipt - totalPayment,
  };
}

function formatAccountSummaryAnswer(s) {
  const periodLabel = s.period ? s.period.label : 'all time';
  const fm = formatMoney;
  return `**Account summary for ${periodLabel}** (amounts in INR — AccountTransaction always stores them converted to INR):

| | Amount |
|---|---|
| Total Sale | ₹${fm(s.totalSale)} |
| Total Purchase (Hotel: ₹${fm(s.totalHotelPurchase)} + Other: ₹${fm(s.totalOtherPurchase)}) | ₹${fm(s.totalPurchase)} |
| **Net Revenue (Sale − Purchase)** | **₹${fm(s.finalRevenue)}** |
| Total Receipts (Bank/Cash received) | ₹${fm(s.totalReceipt)} |
| Total Payments (Hotel: ₹${fm(s.totalHotelPayment)} + Other: ₹${fm(s.totalOtherPayment)}) | ₹${fm(s.totalPayment)} |
| **Net Cash Balance (Receipts − Payments)** | **₹${fm(s.finalBalance)}** |

This mirrors the real site's own Account Report bucketing exactly (Sale/Purchase Form legs for revenue, Bank/Cash Receipt/Payment legs for cash movement, Purchase/Payment each split Hotel vs Other vendor), just totalled across the whole period instead of split per booking/account.`;
}

async function fetchReceivableReport() {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT bm.Id, bm.BookingId, bm.GuestName,
      ISNULL(mt.MemberTotal, 0) AS MemberTotal,
      ISNULL(bm.TaxAmount, 0) AS TaxAmount,
      ISNULL(bm.ROECharge, 0) AS ROECharge,
      ISNULL(bm.ROERate, 0) AS ROERate,
      ISNULL(pm.PaidAmount, 0) AS PaidAmount
    FROM BookingMaster bm
    LEFT JOIN (
      SELECT BookingId, SUM(PAX * Price) AS MemberTotal
      FROM BookingMemberType WHERE IsDelete = 0
      GROUP BY BookingId
    ) mt ON mt.BookingId = bm.Id
    LEFT JOIN PaymentMaster pm ON pm.BookingId = bm.Id AND pm.IsDelete = 0
    WHERE bm.IsDelete = 0 AND bm.IsBooking = 1
  `);

  // Done in JS, not SQL, same reasoning as accountTransactions.js's leg-pairing - only positive
  // (still-owed) balances are summed, so one overpaid booking can never net against and hide
  // another's real outstanding balance.
  let totalReceivable = 0;
  let count = 0;
  for (const r of result.recordset) {
    const finalAmount = (Number(r.MemberTotal) + Number(r.TaxAmount)) * (Number(r.ROECharge) + Number(r.ROERate));
    const receivable = finalAmount - Number(r.PaidAmount);
    if (receivable > 0.5) {
      totalReceivable += receivable;
      count++;
    }
  }
  return { totalReceivable, count };
}

function formatReceivableAnswer({ totalReceivable, count }) {
  if (count === 0) return `No confirmed bookings currently have an outstanding balance — everything is fully paid.`;
  return `**Total receivable (money still owed to you): ₹${formatMoney(totalReceivable)}** (INR), across **${count}** confirmed booking(s) with an outstanding balance.

This is the same Final Amount − Paid Amount calculation the real site's own Reports screen shows per booking, totalled across every booking that still owes something (fully-paid and overpaid bookings aren't counted in the total).`;
}

module.exports = {
  detectFinanceReportIntent,
  fetchIncomeReport,
  formatIncomeAnswer,
  fetchPaymentReceivedReport,
  formatPaymentReceivedAnswer,
  fetchReceivableReport,
  formatReceivableAnswer,
  fetchAccountSummary,
  formatAccountSummaryAnswer,
  formatProfitUnsupportedAnswer,
};
