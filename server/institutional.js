// 三大法人買賣超（證交所 T86 日報）
// 資料來源：https://www.twse.com.tw/rwd/zh/fund/T86?date=YYYYMMDD&selectType=ALL
// 公開 JSON、免登入；每天收盤後公布（約 18:00 後），僅上市台股。
// 金額 = 買賣超股數 × 當日收盤價（收盤價取 Yahoo 日線），以「億元」呈現。
// 每天 14:00 隨 SEPA 體檢補最近 5 日；首次開啟無資料時背景補抓前 6 個月。
// NOTE: lazy-require db so this module can be unit-tested without a live PostgreSQL.
const getDb = () => require('./database');
const { getJsonWithRetry } = require('./stock');
const { fetchDailyBars } = require('./sepa');

const TWSE_T86_URL = 'https://www.twse.com.tw/rwd/zh/fund/T86';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 背景補抓狀態（給前端顯示進度；重啟後歸零，資料本身在 DB 不受影響）
const backfillState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  error: null,
};

// T86 數字帶千分位逗號；空值／非數字回 null
function parseNum(v) {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/,/g, '').trim(), 10);
  return Number.isNaN(n) ? null : n;
}

// T86 一列（fields 順序固定）：
// [0]證券代號 [1]證券名稱 [2]外陸資買進 [3]外陸資賣出 [4]外陸資買賣超
// [5-7]外資自營商買進／賣出／買賣超 [8]投信買進 [9]投信賣出 [10]投信買賣超
// [11]自營商買賣超（自行＋避險合計） [12-17]自營商自行／避險細項 [18]三大法人買賣超
function parseT86Row(row) {
  if (!Array.isArray(row) || row.length < 19) return null;
  return {
    code: String(row[0]).trim(),
    foreign: parseNum(row[4]),
    trust: parseNum(row[10]),
    dealer: parseNum(row[11]),
    total: parseNum(row[18]),
  };
}

// Date -> 'YYYYMMDD'（Asia/Taipei；server TZ 是 America/Phoenix，不能直接取本地日期）
function twDateStr(d) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const g = {};
  for (const p of parts) g[p.type] = p.value;
  return `${g.year}${g.month}${g.day}`;
}

// 抓某日 T86 全市場，回 {代號: {foreign, trust, dealer, total}}；休市／無資料回 null
async function fetchT86(dateStr) {
  const data = await getJsonWithRetry(`${TWSE_T86_URL}?date=${dateStr}&selectType=ALL`, 2, 1000);
  if (!data || data.stat !== 'OK' || !Array.isArray(data.data)) return null;
  const map = {};
  for (const row of data.data) {
    const p = parseT86Row(row);
    if (p && p.code) map[p.code] = p;
  }
  return map;
}

// 已投資的上市台股（ticker 以 .TW 結尾、持有股數 > 0）
async function getTwAccounts(db) {
  const { rows } = await db.query(
    `SELECT id, name, ticker, shares FROM fin_accounts
     WHERE subtype = 'stock' AND ticker ILIKE '%.TW' AND shares > 0 ORDER BY id`
  );
  return rows.map((r) => ({ ...r, code: String(r.ticker).split('.')[0].toUpperCase() }));
}

// Yahoo 6 個月日線 -> { 'YYYY-MM-DD': 收盤價 }（日期以 UTC 取，Yahoo timestamp 為台北 09:00，當日相同）
async function fetchClosesMap(ticker) {
  const res = await fetchDailyBars(ticker, '6mo');
  if (!res) return {};
  const map = {};
  for (const b of res.bars) map[b.date.toISOString().slice(0, 10)] = b.close;
  return map;
}

async function upsertFlow(db, accountId, tradeDate, close, f) {
  await db.query(
    `INSERT INTO fin_institutional_flow
       (account_id, trade_date, close, foreign_net_shares, trust_net_shares, dealer_net_shares, total_net_shares)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (account_id, trade_date) DO UPDATE SET
       close = EXCLUDED.close,
       foreign_net_shares = EXCLUDED.foreign_net_shares,
       trust_net_shares = EXCLUDED.trust_net_shares,
       dealer_net_shares = EXCLUDED.dealer_net_shares,
       total_net_shares = EXCLUDED.total_net_shares`,
    [accountId, tradeDate, close, f.foreign, f.trust, f.dealer, f.total]
  );
}

// 抓某日 T86 並寫入所有持有標的（該日已齊全時跳過不抓）
async function fetchAndStoreDay(db, accounts, closes, iso) {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM fin_institutional_flow
     WHERE trade_date = $1 AND account_id = ANY($2)`,
    [iso, accounts.map((a) => a.id)]
  );
  if (rows[0].n >= accounts.length) return 'skipped';
  const dateStr = iso.replace(/-/g, '');
  let map = null;
  try {
    map = await fetchT86(dateStr);
  } catch (err) {
    console.error(`[FLOW] T86 ${dateStr} failed:`, err.message);
    return 'failed';
  }
  if (!map) return 'nodata'; // 休市或當日尚未公布
  let n = 0;
  for (const acc of accounts) {
    const f = map[acc.code];
    if (!f) continue;
    await upsertFlow(db, acc.id, iso, closes[acc.code][iso] ?? null, f);
    n++;
  }
  return n > 0 ? 'stored' : 'nodata';
}

// 每日補抓：最近 daysBack 個日曆日（T86 當晚才公布，14:00 體檢時最新為前一交易日）
async function refreshDailyFlow(db, daysBack = 5) {
  const accounts = await getTwAccounts(db);
  if (!accounts.length) return { updated: 0 };
  const closes = {};
  for (const acc of accounts) closes[acc.code] = await fetchClosesMap(acc.ticker);
  let updated = 0;
  const today = new Date();
  for (let i = 0; i < daysBack; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const ds = twDateStr(d);
    const iso = `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`;
    const r = await fetchAndStoreDay(db, accounts, closes, iso);
    if (r === 'stored') updated++;
    if (r === 'stored' || r === 'nodata' || r === 'failed') await sleep(400);
  }
  console.log(`[FLOW] Daily refresh finished, ${updated} day(s) updated`);
  return { updated };
}

// 背景補抓前 months 個月（交易日取自 Yahoo 6 個月日線；不 await，跑完才寫 DB 進度）
function backfillFlow(db, months = 6) {
  if (backfillState.running) return { started: false, reason: 'already running' };
  backfillState.running = true;
  backfillState.startedAt = new Date().toISOString();
  backfillState.finishedAt = null;
  backfillState.error = null;
  backfillState.done = 0;
  backfillState.total = 0;
  (async () => {
    try {
      const accounts = await getTwAccounts(db);
      if (!accounts.length) return;
      const closes = {};
      const daySet = new Set();
      for (const acc of accounts) {
        closes[acc.code] = await fetchClosesMap(acc.ticker);
        for (const d of Object.keys(closes[acc.code])) daySet.add(d);
      }
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - months);
      const cutoffIso = cutoff.toISOString().slice(0, 10);
      const days = [...daySet].filter((d) => d >= cutoffIso).sort();
      backfillState.total = days.length;
      for (const iso of days) {
        await fetchAndStoreDay(db, accounts, closes, iso);
        backfillState.done++;
        await sleep(400);
      }
      console.log(`[FLOW] Backfill done: ${backfillState.done}/${backfillState.total} days`);
    } catch (err) {
      backfillState.error = err.message;
      console.error('[FLOW] Backfill failed:', err.message);
    } finally {
      backfillState.running = false;
      backfillState.finishedAt = new Date().toISOString();
    }
  })();
  return { started: true };
}

// 各帳戶資料覆蓋範圍（最早／最晚／筆數）
async function getFlowCoverage(db) {
  const { rows } = await db.query(
    `SELECT account_id, MIN(trade_date) AS earliest, MAX(trade_date) AS latest, COUNT(*)::int AS count
     FROM fin_institutional_flow GROUP BY account_id`
  );
  const out = {};
  for (const r of rows) {
    out[r.account_id] = {
      earliest: r.earliest,
      latest: r.latest,
      count: r.count,
    };
  }
  return out;
}

module.exports = {
  parseNum,
  parseT86Row,
  twDateStr,
  fetchT86,
  getTwAccounts,
  fetchClosesMap,
  refreshDailyFlow,
  backfillFlow,
  backfillState,
  getFlowCoverage,
};
