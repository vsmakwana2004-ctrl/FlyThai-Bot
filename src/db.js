const sql = require('mssql');

const config = {
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  options: {
    encrypt: false,
    trustServerCertificate: true,
  },
  connectionTimeout: 15000,
  requestTimeout: 20000,
  // min:0 let the pool close every connection after 30s idle, so the first question after a short
  // pause paid a full reconnect - measured at ~2.7s, against ~0.5s for the same query on a warm
  // pool. Keeping one connection alive removes that stall from the common case.
  pool: { max: 10, min: 1, idleTimeoutMillis: 300000 },
};

let poolPromise = null;
function getPool() {
  if (!poolPromise) {
    // If the connection attempt fails, clear the cached promise so the *next* call gets a fresh
    // attempt instead of forever replaying the same failure (SQL Server hiccups are often transient).
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .then((pool) => {
        // mssql's ConnectionPool is an EventEmitter that emits 'error' on background acquire
        // failures even after the initial connect succeeded (e.g. a sustained SQL Server outage) -
        // without this listener that error was unhandled and the pool was cached forever with no
        // way to recover, so every later getPool() kept returning the same stale, broken pool.
        pool.on('error', (err) => {
          console.warn('SQL pool error, will reconnect on next query:', err.message);
          poolPromise = null;
        });
        return pool;
      })
      .catch((err) => {
        poolPromise = null;
        throw err;
      });
  }
  return poolPromise;
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|exec|execute|merge|truncate|create|grant|revoke|xp_|sp_executesql|into\s+outfile)\b/i;

// SQL Server only skips comments while PARSING, not while EXECUTING - a second complete statement
// sitting after a "--" comment still runs. Strips comments before every check below so text hidden
// in a comment can never smuggle a second statement past the old semicolon-only check. Reproduced
// live: an LLM-written reply included its own scratch reasoning (with an earlier, wrong attempt at
// the query) as SQL comments inside the same code fence as its real final query - the "SQL" that
// reached this function was really two full SELECT statements back to back with no semicolon
// between them, and the WRONG first one is what the database actually ran.
function stripSqlComments(sql) {
  return sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

// Blanks the CONTENTS of every '...' string literal (keeping the quotes) before the structural scan
// below, so a value that happens to contain a word like "select" (e.g. a guest remark) can never be
// mistaken for a second statement.
function stripStringLiterals(sql) {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

// Counts how many statement-starting keywords (SELECT/INSERT/UPDATE/DELETE/MERGE/WITH) appear at
// PAREN-DEPTH ZERO - i.e. not inside a subquery, EXISTS(...)/IN(...), or a CTE's own parenthesized
// definition, which all legitimately contain their own nested SELECT. A single scan tracks depth up
// to each match position rather than counting matches and parens separately, since only their
// relative order (was depth already back to 0 by the time this keyword appears) matters.
function countTopLevelStatementStarts(sql) {
  const re = /\b(select|insert|update|delete|merge|with)\b/gi;
  let depth = 0;
  let count = 0;
  let scanned = 0;
  let match;
  while ((match = re.exec(sql))) {
    for (let i = scanned; i < match.index; i++) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
    }
    scanned = match.index;
    if (depth === 0) count++;
  }
  return count;
}

// Only a single read-only SELECT / WITH(cte) statement is allowed. No stacked statements.
function assertSafeSelect(query) {
  const q = stripSqlComments(query).trim().replace(/;\s*$/, ''); // allow one trailing semicolon
  if (!q) throw new Error('Empty query');
  if (q.includes(';')) throw new Error('Multiple statements are not allowed');
  if (!/^(select|with)\b/i.test(q)) throw new Error('Only SELECT queries are allowed');
  if (FORBIDDEN.test(q)) throw new Error('Query contains a forbidden keyword');

  // A WITH(cte) query legitimately has 2 depth-0 hits: the leading WITH itself, then its own final
  // result-producing SELECT after the CTE definitions close. A bare SELECT query gets exactly 1.
  // Anything beyond that is a second statement that snuck past the semicolon check above.
  const scanned = stripStringLiterals(q);
  const maxAllowed = /^with\b/i.test(scanned) ? 2 : 1;
  if (countTopLevelStatementStarts(scanned) > maxAllowed) throw new Error('Multiple statements are not allowed');

  return q;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runReadOnlyQuery(query, maxRows = 200) {
  const safeQuery = assertSafeSelect(query);

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const pool = await getPool();
      const result = await pool.request().query(safeQuery);
      const rows = result.recordset || [];
      const truncated = rows.length > maxRows;
      return { rows: truncated ? rows.slice(0, maxRows) : rows, truncated, rowCount: rows.length };
    } catch (err) {
      lastErr = err;
      // Only retry connection-level hiccups, not query errors (bad SQL should surface immediately).
      if (err.name !== 'ConnectionError' || attempt === 2) throw err;
      await sleep(800);
    }
  }
  throw lastErr;
}

module.exports = { getPool, runReadOnlyQuery, assertSafeSelect };
