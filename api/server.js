const http = require('node:http');

const PORT = parseInt(process.env.PORT || '3001', 10);
const DELAY_MS = parseInt(process.env.RESPONSE_DELAY_MS || '100', 10);
const COMPANIES = parseInt(process.env.COMPANIES || '5', 10);
const PRODUCTS_PER_COMPANY = parseInt(process.env.PRODUCTS_PER_COMPANY || '5', 10);

let active = 0;
let peak = 0;
let totalRequests = 0;
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
  active++;
  totalRequests++;
  if (active > peak) peak = active;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  setTimeout(() => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Connection', 'keep-alive');

    if (path === '/api/companies') {
      const companies = Array.from({ length: COMPANIES }, (_, i) => ({
        id: `company-${i + 1}`,
        name: `Company ${i + 1}`,
      }));
      res.end(JSON.stringify(companies));
    } else if (path.match(/^\/api\/companies\/[^/]+\/products$/)) {
      const companyId = path.split('/')[3];
      const products = Array.from({ length: PRODUCTS_PER_COMPANY }, (_, i) => ({
        id: `${companyId}-product-${i + 1}`,
        companyId,
      }));
      res.end(JSON.stringify(products));
    } else if (path.match(/^\/api\/products\/[^/]+$/)) {
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
  }, DELAY_MS);
});

server.keepAliveTimeout = 30_000;

server.listen(PORT, () => {
  console.log(
    `[API] http://localhost:${PORT} delay=${DELAY_MS}ms companies=${COMPANIES} products/company=${PRODUCTS_PER_COMPANY}`,
  );
});

function shutdown() {
  clearInterval(sampler);
  console.log('\n[FINAL]', JSON.stringify({ peak, totalRequests }, null, 2));
  console.log('[SAMPLES_LEN]', samples.length);
  if (process.env.DUMP_SAMPLES === '1') {
    console.log('[SAMPLES]', JSON.stringify(samples));
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
