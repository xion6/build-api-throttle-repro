const http = require('node:http');
const fs = require('node:fs');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '3001', 10);
const DELAY_MS = parseInt(process.env.RESPONSE_DELAY_MS || '100', 10);
const COMPANIES = parseInt(process.env.COMPANIES || '5', 10);
const PRODUCTS_PER_COMPANY = parseInt(process.env.PRODUCTS_PER_COMPANY || '5', 10);

const PG_HOST = process.env.PG_HOST || 'localhost';
const PG_PORT = parseInt(process.env.PG_PORT || '5432', 10);
const PG_USER = process.env.PG_USER || 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD || 'postgres';
const PG_DATABASE = process.env.PG_DATABASE || 'throttle';
const DB_POOL_MAX = parseInt(process.env.DB_POOL_MAX || '10', 10);
const DB_POOL_TIMEOUT_MS = parseInt(process.env.DB_POOL_TIMEOUT_MS || '5000', 10);

const pool = new Pool({
  host: PG_HOST,
  port: PG_PORT,
  user: PG_USER,
  password: PG_PASSWORD,
  database: PG_DATABASE,
  max: DB_POOL_MAX,
  connectionTimeoutMillis: DB_POOL_TIMEOUT_MS,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[POOL ERROR]', err.message);
});

let active = 0;
let peak = 0;
let activeList = 0;
let peakList = 0;
let activeDetail = 0;
let peakDetail = 0;
let totalRequests = 0;
let rejected503 = 0;
let poolTimeouts = 0;
let dbConnectErrors = 0;

let waitCount = 0;
let waitSumMs = 0;
let waitMaxMs = 0;
const waitSamples = [];

function recordWait(ms) {
  waitCount++;
  waitSumMs += ms;
  if (ms > waitMaxMs) waitMaxMs = ms;
  waitSamples.push(ms);
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100));
  return sorted[idx];
}

async function seed() {
  const client = await pool.connect();
  try {
    await client.query('TRUNCATE companies, products RESTART IDENTITY CASCADE');
    await client.query(
      `INSERT INTO companies (id, name)
       SELECT 'company-' || gs::text, 'Company ' || gs::text
       FROM generate_series(1, $1) gs`,
      [COMPANIES],
    );
    await client.query(
      `INSERT INTO products (id, company_id, name, description)
       SELECT c.id || '-product-' || gs::text,
              c.id,
              'Product ' || c.id || '-product-' || gs::text,
              'Description for ' || c.id || '-product-' || gs::text
       FROM companies c, generate_series(1, $1) gs`,
      [PRODUCTS_PER_COMPANY],
    );
    console.log(
      `[SEED] companies=${COMPANIES} products=${COMPANIES * PRODUCTS_PER_COMPANY}`,
    );
  } finally {
    client.release();
  }
}

async function holdAndQuery(client, sql, params) {
  if (DELAY_MS > 0) {
    await client.query('SELECT pg_sleep($1)', [DELAY_MS / 1000]);
  }
  const result = await client.query(sql, params);
  return result.rows;
}

const server = http.createServer(async (req, res) => {
  totalRequests++;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;
  const isList = /^\/api\/companies\/[^/]+\/products$/.test(path);
  const isDetail = /^\/api\/products\/[^/]+$/.test(path);
  const isCompanies = path === '/api/companies';

  if (!isList && !isDetail && !isCompanies) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  const acquireStart = process.hrtime.bigint();
  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    const msg = err.message || String(err);
    if (/timeout/i.test(msg) || /timed out/i.test(msg)) {
      poolTimeouts++;
    } else {
      dbConnectErrors++;
    }
    rejected503++;
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'overloaded', detail: msg }));
    return;
  }
  const waitMs = Number(process.hrtime.bigint() - acquireStart) / 1e6;
  recordWait(waitMs);

  active++;
  if (active > peak) peak = active;
  if (isList) {
    activeList++;
    if (activeList > peakList) peakList = activeList;
  }
  if (isDetail) {
    activeDetail++;
    if (activeDetail > peakDetail) peakDetail = activeDetail;
  }

  try {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Connection', 'keep-alive');

    if (isCompanies) {
      const rows = await holdAndQuery(
        client,
        'SELECT id, name FROM companies ORDER BY id',
        [],
      );
      res.end(JSON.stringify(rows));
    } else if (isList) {
      const companyId = path.split('/')[3];
      const rows = await holdAndQuery(
        client,
        `SELECT id, company_id AS "companyId" FROM products WHERE company_id = $1 ORDER BY id`,
        [companyId],
      );
      res.end(JSON.stringify(rows));
    } else if (isDetail) {
      const productId = path.split('/')[3];
      const rows = await holdAndQuery(
        client,
        'SELECT id, name, description FROM products WHERE id = $1',
        [productId],
      );
      if (rows.length === 0) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'Not Found' }));
      } else {
        res.end(JSON.stringify(rows[0]));
      }
    }
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  } finally {
    client.release();
    active--;
    if (isList) activeList--;
    if (isDetail) activeDetail--;
  }
});

server.keepAliveTimeout = 30_000;

(async () => {
  try {
    await seed();
  } catch (err) {
    console.error('[SEED FAILED]', err.message);
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log(
      `[API-DB] http://localhost:${PORT} delay=${DELAY_MS}ms companies=${COMPANIES} products/company=${PRODUCTS_PER_COMPANY} poolMax=${DB_POOL_MAX} poolTimeout=${DB_POOL_TIMEOUT_MS}ms`,
    );
  });
})();

function shutdown() {
  const result = {
    peak,
    peakList,
    peakDetail,
    totalRequests,
    rejected503,
    poolTimeouts,
    dbConnectErrors,
    poolWait: {
      count: waitCount,
      avgMs: waitCount ? +(waitSumMs / waitCount).toFixed(2) : 0,
      maxMs: +waitMaxMs.toFixed(2),
      p50Ms: +percentile(waitSamples, 50).toFixed(2),
      p95Ms: +percentile(waitSamples, 95).toFixed(2),
      p99Ms: +percentile(waitSamples, 99).toFixed(2),
    },
  };
  if (process.env.RESULT_FILE) {
    fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify(result));
  }
  fs.writeSync(1, '\n[FINAL] ' + JSON.stringify(result, null, 2) + '\n');
  pool.end().finally(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
