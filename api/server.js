const http = require('node:http');
const fs = require('node:fs');

const PORT = parseInt(process.env.PORT || '3001', 10);
const DELAY_MS = parseInt(process.env.RESPONSE_DELAY_MS || '100', 10);
const COMPANIES = parseInt(process.env.COMPANIES || '5', 10);
const PRODUCTS_PER_COMPANY = parseInt(process.env.PRODUCTS_PER_COMPANY || '5', 10);
const MAX_INFLIGHT = parseInt(process.env.MAX_INFLIGHT || '0', 10);

let active = 0;
let peak = 0;
let activeList = 0;
let peakList = 0;
let activeDetail = 0;
let peakDetail = 0;
let totalRequests = 0;
let rejected503 = 0;
let lastSampledPeak = 0;

const samples = [];

const sampler = setInterval(() => {
  if (active !== 0 || peak !== lastSampledPeak) {
    const now = Date.now();
    samples.push({ t: now, active, peak });
    lastSampledPeak = peak;
  }
}, 10);

const server = http.createServer((req, res) => {
  totalRequests++;

  if (MAX_INFLIGHT > 0 && active >= MAX_INFLIGHT) {
    rejected503++;
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'overloaded', inflight: active, limit: MAX_INFLIGHT }));
    return;
  }

  active++;
  if (active > peak) peak = active;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  const isList = /^\/api\/companies\/[^/]+\/products$/.test(path);
  const isDetail = /^\/api\/products\/[^/]+$/.test(path);
  if (isList) {
    activeList++;
    if (activeList > peakList) peakList = activeList;
  }
  if (isDetail) {
    activeDetail++;
    if (activeDetail > peakDetail) peakDetail = activeDetail;
  }

  setTimeout(() => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Connection', 'keep-alive');

    if (path === '/api/companies') {
      const companies = Array.from({ length: COMPANIES }, (_, i) => ({
        id: `company-${i + 1}`,
        name: `Company ${i + 1}`,
      }));
      res.end(JSON.stringify(companies));
    } else if (isList) {
      const companyId = path.split('/')[3];
      const products = Array.from({ length: PRODUCTS_PER_COMPANY }, (_, i) => ({
        id: `${companyId}-product-${i + 1}`,
        companyId,
      }));
      res.end(JSON.stringify(products));
    } else if (isDetail) {
      const productId = path.split('/')[3];
      res.end(
        JSON.stringify({
          id: productId,
          name: `Product ${productId}`,
          description: `Description for ${productId}`,
        }),
      );
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not Found' }));
    }

    active--;
    if (isList) activeList--;
    if (isDetail) activeDetail--;
  }, DELAY_MS);
});

server.keepAliveTimeout = 30_000;

server.listen(PORT, () => {
  console.log(
    `[API] http://localhost:${PORT} delay=${DELAY_MS}ms companies=${COMPANIES} products/company=${PRODUCTS_PER_COMPANY} maxInflight=${MAX_INFLIGHT || 'unlimited'}`,
  );
});

function shutdown() {
  clearInterval(sampler);
  const result = { peak, peakList, peakDetail, totalRequests, rejected503 };
  if (process.env.RESULT_FILE) {
    fs.writeFileSync(process.env.RESULT_FILE, JSON.stringify(result));
  }
  fs.writeSync(1, '\n[FINAL] ' + JSON.stringify(result, null, 2) + '\n');
  fs.writeSync(1, '[SAMPLES_LEN] ' + samples.length + '\n');
  if (process.env.DUMP_SAMPLES === '1') {
    fs.writeSync(1, '[SAMPLES] ' + JSON.stringify(samples) + '\n');
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
