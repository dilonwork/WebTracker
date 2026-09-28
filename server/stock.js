// NOTE: lazy-require db so this module can be unit-tested without a live PostgreSQL.
const getDb = () => require('./database');

const YAHOO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const YAHOO_HOSTS = ['https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// GET JSON with retries on transient failures (429 / 5xx / network).
async function getJsonWithRetry(url, retries = 3, delay = 1500) {
  for (let i = 0; i < retries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': YAHOO_UA },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 || (res.status >= 500 && res.status <= 599)) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} (non-retryable)`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      const retryable = /HTTP (429|5\d\d)/.test(err.message) || err.name === 'AbortError' || /fetch failed|network/i.test(err.message);
      if (retryable && i < retries - 1) {
        console.warn(`[STOCK] ${err.message}, retrying in ${delay}ms... (attempt ${i + 1}/${retries})`);
        await sleep(delay);
        delay *= 2;
      } else {
        throw err;
      }
    }
  }
}

// Fetch latest price for a ticker from Yahoo Finance (unofficial chart API).
// Returns { price, currency } or null on failure.
async function fetchYahooQuote(ticker) {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return null;
  const path = `/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=5d`;
  for (const host of YAHOO_HOSTS) {
    try {
      const data = await getJsonWithRetry(host + path);
      const result = data && data.chart && data.chart.result && data.chart.result[0];
      const meta = result && result.meta;
      const price = meta && (meta.regularMarketPrice ?? meta.previousClose ?? meta.chartPreviousClose);
      if (price == null || Number.isNaN(Number(price))) continue;
      return { price: Number(price), currency: (meta.currency || '').toUpperCase() };
    } catch (err) {
      console.error(`[STOCK] Yahoo fetch failed for ${t} via ${host}:`, err.message);
    }
  }
  console.warn(`[STOCK] No price available for ${t}`);
  return null;
}

// FX rate FROM -> TO via Yahoo (e.g. USD -> TWD uses ticker USDTWD=X).
async function fetchFxRate(from, to) {
  from = String(from || '').toUpperCase();
  to = String(to || '').toUpperCase();
  if (!from || !to || from === to) return 1;
  const q = await fetchYahooQuote(`${from}${to}=X`);
  if (q && q.price) return q.price;
  const inv = await fetchYahooQuote(`${to}${from}=X`);
  if (inv && inv.price) return 1 / inv.price;
  return null;
}

// Update balances for all stock accounts that have ticker + shares set.
// balance = price * shares, converted into the account's currency.
async function updateStockPrices() {
  console.log('[STOCK] Hourly price update started');
  const db = getDb();
  let updated = 0;
  try {
    const { rows } = await db.query(
      `SELECT * FROM fin_accounts WHERE subtype = 'stock' AND ticker IS NOT NULL AND ticker <> '' AND shares > 0`
    );
    for (const acc of rows) {
      const quote = await fetchYahooQuote(acc.ticker);
      if (!quote) continue;
      let balance = quote.price * Number(acc.shares);
      if (quote.currency && quote.currency !== String(acc.currency).toUpperCase()) {
        const fx = await fetchFxRate(quote.currency, acc.currency);
        if (fx == null) {
          console.warn(`[STOCK] FX unavailable ${quote.currency}->${acc.currency}, skipping ${acc.ticker}`);
          continue;
        }
        balance = balance * fx;
      }
      balance = Math.round(balance * 100) / 100;
      await db.query(
        'UPDATE fin_accounts SET balance = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [balance, acc.id]
      );
      await db.query(
        'INSERT INTO fin_account_history (account_id, balance) VALUES ($1, $2)',
        [acc.id, balance]
      );
      console.log(`[STOCK] ${acc.ticker}: ${quote.price} x ${acc.shares} = ${balance} ${acc.currency}`);
      updated++;
    }
  } catch (err) {
    console.error('[STOCK] Update failed:', err.message);
  }
  console.log(`[STOCK] Hourly price update finished, ${updated} account(s) updated`);
  return updated;
}

module.exports = { fetchYahooQuote, fetchFxRate, updateStockPrices };
