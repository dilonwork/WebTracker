// SEPA 趨勢模板每日體檢 + 規則告警
// 資料來源：Yahoo Finance 日線（非官方 chart API，與 stock.js 共用請求邏輯）
// NOTE: lazy-require db so this module can be unit-tested without a live PostgreSQL.
const getDb = () => require('./database');
const { getJsonWithRetry, YAHOO_HOSTS } = require('./stock');

// 8 條趨勢模板中文標籤
const TEMPLATE_LABELS = [
  '股價 > 150/200 日線',
  '150 日線 > 200 日線',
  '200 日線上升中',
  '50 日線 > 150/200 日線',
  '股價 > 50 日線',
  '較 52 週低點 +30%',
  '距 52 週高點 25% 內',
  '相對強度轉強（參考）',
];

// SEPA 規則告警中文標籤
const RULE_ALERT_LABELS = {
  sepa_50ma_break: { icon: '⚠️', text: '收盤破 50 日線（SEPA 出場訊號）' },
  sepa_10w_break: { icon: '⚠️', text: '跌破 10 週線（第一級減半訊號）' },
  sepa_200ma_break: { icon: '⛔', text: '跌破 200 日線（出清訊號）' },
  sepa_stop_7pct: { icon: '🛑', text: '距成本 -7%（停損）' },
  sepa_overheat: { icon: '🔥', text: '過熱（距 50 日線 +20%）' },
};

function sma(values, n) {
  if (!values || values.length < n) return null;
  const slice = values.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

const gt = (a, b) => a != null && b != null && a > b;
const gte = (a, b) => a != null && b != null && a >= b;

// ISO week key for weekly resampling
function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const fday = (first.getUTCDay() + 6) % 7;
  first.setUTCDate(first.getUTCDate() - fday + 3);
  const week = 1 + Math.round((t - first) / (7 * 24 * 3600 * 1000));
  return `${t.getUTCFullYear()}-W${week}`;
}

function weeklyCloses(bars) {
  const weeks = [];
  let curKey = null, cur = null;
  for (const b of bars) {
    const key = isoWeekKey(b.date);
    if (key !== curKey) { if (cur) weeks.push(cur); curKey = key; cur = b; }
    else cur = b;
  }
  if (cur) weeks.push(cur);
  return weeks.map(w => w.adjclose);
}

// Fetch 1y daily bars from Yahoo chart API. Returns { bars, currency } or null.
async function fetchDailyBars(ticker, range = '1y') {
  const t = String(ticker || '').trim().toUpperCase();
  if (!t) return null;
  const path = `/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=${range}`;
  for (const host of YAHOO_HOSTS) {
    try {
      const data = await getJsonWithRetry(host + path);
      const result = data && data.chart && data.chart.result && data.chart.result[0];
      if (!result) continue;
      const ts = result.timestamp || [];
      const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
      const adj = result.indicators && result.indicators.adjclose && result.indicators.adjclose[0] && result.indicators.adjclose[0].adjclose;
      const bars = [];
      for (let i = 0; i < ts.length; i++) {
        const close = q.close && q.close[i];
        if (close == null) continue;
        bars.push({
          date: new Date(ts[i] * 1000),
          high: (q.high && q.high[i]) ?? null,
          low: (q.low && q.low[i]) ?? null,
          close,
          adjclose: (adj && adj[i]) ?? close,
        });
      }
      if (bars.length >= 60) {
        return { bars, currency: ((result.meta && result.meta.currency) || '').toUpperCase() };
      }
    } catch (err) {
      console.error(`[SEPA] bars fetch failed for ${t} via ${host}:`, err.message);
    }
  }
  console.warn(`[SEPA] No bars available for ${t}`);
  return null;
}

// Compute SEPA trend-template check from daily bars.
// indexBars: benchmark daily bars for RS proxy (optional).
function computeSepa(bars, indexBars) {
  const closes = bars.map(b => b.adjclose);
  const price = closes[closes.length - 1];
  const ma50 = sma(closes, 50);
  const ma150 = sma(closes, 150);
  const ma200 = sma(closes, 200);
  const ma200prev = sma(closes.slice(0, -20), 200);
  const wma10 = sma(weeklyCloses(bars), 10);
  const windowN = Math.min(252, bars.length);
  const high52w = Math.max(...bars.slice(-windowN).map(b => b.high ?? b.close));
  const low52w = Math.min(...bars.slice(-windowN).map(b => b.low ?? b.close));

  // RS proxy: 3-month relative return vs benchmark (參考值，非 Minervini 原版全市場百分位)
  let rsProxy = null;
  if (indexBars && indexBars.length > 10) {
    const ic = indexBars.map(b => b.adjclose);
    const n = Math.min(63, closes.length, ic.length);
    if (n > 10) {
      rsProxy = closes[closes.length - 1] / closes[closes.length - n] - 1
              - (ic[ic.length - 1] / ic[ic.length - n] - 1);
    }
  }

  const t = {
    t1: gt(price, ma150) && gt(price, ma200),
    t2: gt(ma150, ma200),
    t3: gt(ma200, ma200prev),
    t4: gt(ma50, ma150) && gt(ma50, ma200),
    t5: gt(price, ma50),
    t6: gte(price, low52w == null ? null : low52w * 1.3),
    t7: gte(price, high52w == null ? null : high52w * 0.75),
    t8: rsProxy == null ? null : rsProxy > 0,
  };
  const score = ['t1','t2','t3','t4','t5','t6','t7','t8'].filter(k => t[k] === true).length;
  const lastDate = bars[bars.length - 1].date.toISOString().slice(0, 10);
  return { price, ma50, ma150, ma200, wma10, high52w, low52w, rsProxy, template: t, score, lastDate };
}

async function insertRuleAlert(db, accountId, type, threshold, price) {
  await db.query(
    `INSERT INTO fin_price_alerts (account_id, alert_type, threshold, price_at_trigger)
     VALUES ($1, $2, $3, $4)`,
    [accountId, type, threshold, price]
  );
  const label = RULE_ALERT_LABELS[type];
  console.log(`[SEPA] ${label.icon} ${label.text}（現價 ${price}）`);
}

// Edge-triggered rule alerts vs previous check.
async function checkSepaAlerts(db, acc, sepa, prev, quoteCurrency) {
  if (!prev) return; // 首次體檢不告警
  const c = sepa.price;
  const pc = Number(prev.close);
  const n = v => (v == null ? null : Number(v));
  const pma50 = n(prev.ma50), pma200 = n(prev.ma200), pwma10 = n(prev.wma10);

  if (pma50 && pc > pma50 && sepa.ma50 && c <= sepa.ma50) {
    await insertRuleAlert(db, acc.id, 'sepa_50ma_break', sepa.ma50, c);
  }
  if (pwma10 && pc > pwma10 && sepa.wma10 && c <= sepa.wma10) {
    await insertRuleAlert(db, acc.id, 'sepa_10w_break', sepa.wma10, c);
  }
  if (pma200 && pc > pma200 && sepa.ma200 && c <= sepa.ma200) {
    await insertRuleAlert(db, acc.id, 'sepa_200ma_break', sepa.ma200, c);
  }
  // -7% 停損：僅報價幣別 == 帳戶幣別時檢查（成本以帳戶幣別計）
  const cost = Number(acc.cost_price || 0);
  if (cost > 0 && quoteCurrency && quoteCurrency === String(acc.currency).toUpperCase()) {
    const prevRet = (pc - cost) / cost, ret = (c - cost) / cost;
    if (prevRet > -0.07 && ret <= -0.07) {
      await insertRuleAlert(db, acc.id, 'sepa_stop_7pct', cost * 0.93, c);
    }
  }
  // 過熱：距 50 日線 +20%
  if (pma50 && sepa.ma50) {
    const prevHot = (pc - pma50) / pma50, hot = (c - sepa.ma50) / sepa.ma50;
    if (prevHot < 0.20 && hot >= 0.20) {
      await insertRuleAlert(db, acc.id, 'sepa_overheat', sepa.ma50 * 1.2, c);
    }
  }
}

// Daily SEPA check for all stock accounts.
async function runSepaCheck() {
  console.log('[SEPA] Daily check started');
  const db = getDb();
  let checked = 0;
  try {
    const { rows } = await db.query(
      `SELECT * FROM fin_accounts WHERE subtype = 'stock' AND ticker IS NOT NULL AND ticker <> '' AND shares > 0`
    );
    const indexCache = {};
    for (const acc of rows) {
      try {
        const res = await fetchDailyBars(acc.ticker);
        if (!res) continue;
        const idxTicker = acc.ticker.toUpperCase().endsWith('.TW') ? '^TWII' : '^GSPC';
        if (!indexCache[idxTicker]) indexCache[idxTicker] = await fetchDailyBars(idxTicker);
        const sepa = computeSepa(res.bars, indexCache[idxTicker] && indexCache[idxTicker].bars);
        const prevQ = await db.query(
          `SELECT close, ma50, ma200, wma10 FROM fin_sepa_checks
           WHERE account_id = $1 AND check_date < $2 ORDER BY check_date DESC LIMIT 1`,
          [acc.id, sepa.lastDate]
        );
        await db.query(
          `INSERT INTO fin_sepa_checks
             (account_id, check_date, close, ma50, ma150, ma200, wma10, high_52w, low_52w, rs_proxy, template)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (account_id, check_date) DO UPDATE SET
             close = EXCLUDED.close, ma50 = EXCLUDED.ma50, ma150 = EXCLUDED.ma150,
             ma200 = EXCLUDED.ma200, wma10 = EXCLUDED.wma10,
             high_52w = EXCLUDED.high_52w, low_52w = EXCLUDED.low_52w,
             rs_proxy = EXCLUDED.rs_proxy, template = EXCLUDED.template`,
          [acc.id, sepa.lastDate, sepa.price, sepa.ma50, sepa.ma150, sepa.ma200,
           sepa.wma10, sepa.high52w, sepa.low52w, sepa.rsProxy, JSON.stringify(sepa.template)]
        );
        await checkSepaAlerts(db, acc, sepa, prevQ.rows[0] || null, res.currency);
        console.log(`[SEPA] ${acc.ticker}: 模板 ${sepa.score}/8（${sepa.lastDate}）`);
        checked++;
      } catch (err) {
        console.error(`[SEPA] Check failed for ${acc.ticker}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[SEPA] Check failed:', err.message);
  }
  console.log(`[SEPA] Daily check finished, ${checked} account(s) checked`);
  return checked;
}

module.exports = {
  fetchDailyBars, computeSepa, runSepaCheck,
  TEMPLATE_LABELS, RULE_ALERT_LABELS,
};
