// 第 3a 階段擴充：台股紙上交易單元測試（不用 live PostgreSQL / Yahoo 也能跑）
// 執行：node server/agent-paper-trade-tw.test.js
// 覆蓋：台股時段（台北 09:00–13:30）、台股代碼辨識與裸代碼補 .TW、
// 台幣報價＋折合美元核對上限、漲跌幅 ±10% 限價檢查、台美時段分流、
// 換不到匯率不執行、當日累計以美元計。
// 假 DB 只實作紙上交易程式實際發出的 SQL。
const assert = require('node:assert/strict');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// ---- 假 DB（in-memory，與 agent-paper-trade.test.js 同型）----
class FakeDb {
  constructor(tickers = ['2330.TW', '0050.TW', 'QQQ']) {
    this.settings = new Map();
    this.audit = [];
    this.tickers = tickers;
  }
  async query(sql, params = []) {
    const s = String(sql);
    if (s.includes('FROM agent_settings') && s.trimStart().startsWith('SELECT')) {
      return { rows: [...this.settings.entries()].map(([key, v]) => ({ key, value: v.value, value_num: v.value_num })) };
    }
    if (s.includes('INSERT INTO agent_settings')) {
      if (params.length === 3) this.settings.set(params[0], { value: false, value_num: params[2] });
      else this.settings.set(params[0], { value: params[1], value_num: null });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('INSERT INTO agent_audit_log')) {
      const row = {
        id: this.audit.length + 1,
        created_at: new Date(),
        action_type: params[0], account_id: params[1], ticker: params[2],
        page_id: params[3], alert_id: params[4],
        settings_snapshot: params[5], input_snapshot: params[6],
        model: params[7], output_summary: params[8],
        approved_by: params[9], result: params[10],
      };
      this.audit.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (s.includes('FROM agent_audit_log') && s.includes('action_type = ANY')) {
      const types = params[0];
      const since = new Date(params[1]);
      const rows = this.audit
        .filter(r => types.includes(r.action_type) && r.result === 'ok' && r.created_at >= since)
        .map(r => ({ input_snapshot: r.input_snapshot }));
      return { rows };
    }
    if (s.includes('FROM fin_accounts')) {
      return { rows: this.tickers.map(t => ({ ticker: t })) };
    }
    throw new Error(`FakeDb 不支援的 SQL: ${s.slice(0, 120)}`);
  }
}

function seedDb(tickers) { return new FakeDb(tickers); }

// 開啟 D 級三道閘門＋設上限（金額皆為美元；台股單先折合美元再比對）
async function openGates(agent, db, caps = {}) {
  await agent.updateSettings(db, {
    agent_master: true,
    agent_high_privilege: true,
    agent_money_cap_single: caps.single ?? 100000,
    agent_money_cap_daily: caps.daily ?? 500000,
  });
}

// 假 Yahoo 報價＋假匯率（不對外發請求）
// 2330.TW：現價 2135 TWD，前收 2000（漲跌幅區間 1800–2200）；0050.TW：116 TWD，前收 115
// 匯率：1 TWD = 0.031 USD
function fakeStockTw(overrides = {}) {
  const fake = { calls: [], fxCalls: [] };
  const quotes = {
    '2330.TW': { price: 2135, currency: 'TWD', previousClose: 2000 },
    '0050.TW': { price: 116, currency: 'TWD', previousClose: 115 },
    'QQQ': { price: 250, currency: 'USD', previousClose: 245 },
    ...(overrides.quotes || {}),
  };
  fake.fetchYahooQuote = async (ticker) => {
    const t = String(ticker || '').toUpperCase();
    fake.calls.push(t);
    const q = quotes[t];
    if (q == null) return null;
    return { ...q };
  };
  fake.fetchFxRate = async (from, to) => {
    fake.fxCalls.push(`${from}->${to}`);
    if (overrides.fxRate === null) return null;
    if (from === 'TWD' && to === 'USD') return overrides.fxRate ?? 0.031;
    if (from === 'USD' && to === 'TWD') return 1 / (overrides.fxRate ?? 0.031);
    return null;
  };
  return fake;
}

// 2026-11-09 是週一；02:00 UTC＝10:00 台北時間（台股交易時段內），
// 同一時刻美東是週日 21:00（美股休市）——正好驗台美時段分流。
const MON_10AM_TPE = new Date('2026-11-09T02:00:00Z');

function twOrder(agent, db, stock, overrides = {}, now = MON_10AM_TPE) {
  return agent.executeHighPrivilegeAction('place_external_order', {
    ticker: '2330.TW', side: 'BUY', quantity: 1000, order_type: 'MARKET', duration: 'DAY',
    ...overrides,
  }, 'user', { db, stock, now });
}

async function main() {
  const agent = require('./agent.js');

  console.log('第 3a 階段擴充：台股紙上交易單元測試：');

  await ok('isTwRegularSession：週一 08:59 擋、09:00 過、13:29 過、13:30 擋、週六日擋、平日 14:00 擋', async () => {
    assert.equal(agent.isTwRegularSession(new Date('2026-11-09T00:59:00Z')), false); // 08:59 台北
    assert.equal(agent.isTwRegularSession(new Date('2026-11-09T01:00:00Z')), true);  // 09:00 台北
    assert.equal(agent.isTwRegularSession(new Date('2026-11-09T05:29:00Z')), true);  // 13:29 台北
    assert.equal(agent.isTwRegularSession(new Date('2026-11-09T05:30:00Z')), false); // 13:30 台北
    assert.equal(agent.isTwRegularSession(new Date('2026-11-07T02:00:00Z')), false); // 週六 10:00 台北
    assert.equal(agent.isTwRegularSession(new Date('2026-11-08T02:00:00Z')), false); // 週日 10:00 台北
    assert.equal(agent.isTwRegularSession(new Date('2026-11-09T06:00:00Z')), false); // 週一 14:00 台北
  });

  await ok('isTwTicker 與 resolveTicker：2330.TW 是台股、QQQ 不是；裸代碼 2330 補 .TW', async () => {
    assert.equal(agent.isTwTicker('2330.TW'), true);
    assert.equal(agent.isTwTicker('0050.TW'), true);
    assert.equal(agent.isTwTicker('2330'), false);
    assert.equal(agent.isTwTicker('QQQ'), false);
    assert.equal(agent.isTwTicker('TSM'), false);
    assert.equal(agent.resolveTicker('2330', ['2330.TW', 'QQQ']), '2330.TW');
    assert.equal(agent.resolveTicker('2330.TW', ['2330.TW', 'QQQ']), '2330.TW');
    assert.equal(agent.resolveTicker('QQQ', ['2330.TW', 'QQQ']), 'QQQ');
    assert.equal(agent.resolveTicker('AAPL', ['2330.TW', 'QQQ']), 'AAPL');
  });

  await ok('台股成交標示正確：BUY MARKET 1000 股 2330.TW，現價 NT$2135，總金額 NT$2,135,000（折合 $66185）', async () => {
    const db = seedDb();
    const stock = fakeStockTw();
    await openGates(agent, db);
    const r = await twOrder(agent, db, stock);
    assert.equal(r.ok, true);
    assert.equal(r.paper_trade, true);
    assert.equal(r.fill_price, 2135);
    assert.equal(r.currency, 'TWD');
    assert.equal(r.notional, 2135000);
    assert.equal(r.notional_usd, 66185);
    assert.match(r.summary, /紙上買進 1000 股 2330\.TW/);
    assert.match(r.summary, /模擬成交價 NT\$2135/);
    assert.match(r.summary, /總金額 NT\$2,135,000/);
    assert.match(r.summary, /折合 \$66185/);
    assert.match(r.summary, /paper trade/);
    assert.match(r.summary, /未真的下單/);
    assert.equal(db.audit.length, 1);
    assert.equal(db.audit[0].result, 'ok');
    assert.equal(db.audit[0].ticker, '2330.TW');
    const input = JSON.parse(db.audit[0].input_snapshot);
    assert.equal(input.ticker, '2330.TW');
    assert.equal(input.amount, 66185); // 稽核 amount 存折合美元（當日累計用）
    assert.equal(input.amount_local, 2135000);
    assert.equal(input.currency, 'TWD');
    assert.equal(await agent.getTodayMoneySpent(db), 66185);
  });

  await ok('裸代碼 2330 下單：自動補 .TW 成交，稽核標的為 2330.TW', async () => {
    const db = seedDb();
    const stock = fakeStockTw();
    await openGates(agent, db);
    const r = await twOrder(agent, db, stock, { ticker: '2330' });
    assert.equal(r.ok, true);
    assert.equal(r.ticker, '2330.TW');
    assert.equal(db.audit[0].ticker, '2330.TW');
  });

  await ok('台股非交易時段擋下：週日、週一 08:59、週一 13:30 台北時間；時段不符時不取價', async () => {
    const db = seedDb();
    const stock = fakeStockTw();
    await openGates(agent, db);
    const cases = [
      new Date('2026-11-08T02:00:00Z'), // 週日 10:00 台北
      new Date('2026-11-09T00:59:00Z'), // 週一 08:59 台北
      new Date('2026-11-09T05:30:00Z'), // 週一 13:30 台北
    ];
    for (const now of cases) {
      const r = await twOrder(agent, db, stock, {}, now);
      assert.equal(r.blocked, true);
      assert.match(r.error, /台股.*交易時段/);
    }
    assert.equal(db.audit.filter(a => a.result === 'blocked').length, 3);
    assert.equal(stock.calls.length, 0);
  });

  await ok('台美時段分流：週一 10:00 台北時間（美東週日 21:00），台股可下、美股 QQQ 擋下', async () => {
    const db = seedDb();
    const stock = fakeStockTw();
    await openGates(agent, db);
    const rTw = await twOrder(agent, db, stock);
    assert.equal(rTw.ok, true);
    const rUs = await twOrder(agent, db, stock, { ticker: 'QQQ', quantity: 10 });
    assert.equal(rUs.blocked, true);
    assert.match(rUs.error, /美股.*交易時段/);
  });

  await ok('台股漲跌幅 ±10%：前收 2000，BUY 限價 2200 可成交、2201 擋下；SELL 限價 1800 可成交、1799 擋下', async () => {
    const db = seedDb();
    const stock = fakeStockTw();
    await openGates(agent, db);
    const r1 = await twOrder(agent, db, stock, { order_type: 'LIMIT', limit_price: 2200 });
    assert.equal(r1.ok, true);
    assert.equal(r1.fill_price, 2135); // 限價是防線，成交價仍是現價
    const r2 = await twOrder(agent, db, stock, { order_type: 'LIMIT', limit_price: 2201 });
    assert.equal(r2.blocked, true);
    assert.match(r2.error, /漲跌幅/);
    const r3 = await twOrder(agent, db, stock, { side: 'SELL', order_type: 'LIMIT', limit_price: 1800 });
    assert.equal(r3.ok, true);
    const r4 = await twOrder(agent, db, stock, { side: 'SELL', order_type: 'LIMIT', limit_price: 1799 });
    assert.equal(r4.blocked, true);
    assert.match(r4.error, /漲跌幅/);
  });

  await ok('拿不到前收時漲跌幅檢查跳過：BUY 限價 9999 照常成交（只受限價防線管）', async () => {
    const db = seedDb();
    const stock = fakeStockTw({ quotes: { '2330.TW': { price: 2135, currency: 'TWD' } } });
    await openGates(agent, db);
    const r = await twOrder(agent, db, stock, { order_type: 'LIMIT', limit_price: 9999 });
    assert.equal(r.ok, true);
  });

  await ok('超單筆上限擋下：台股單折合 $66185 超單筆 $10000（比的是美元，不是台幣金額）', async () => {
    const db = seedDb();
    const stock = fakeStockTw();
    await openGates(agent, db, { single: 10000, daily: 500000 });
    const r = await twOrder(agent, db, stock);
    assert.equal(r.blocked, true);
    assert.match(r.error, /單筆上限/);
    assert.match(r.error, /折合 \$66185/);
    assert.equal(await agent.getTodayMoneySpent(db), 0);
  });

  await ok('超每日上限擋下：第一筆 $66185 成交，第二筆超每日 $70000（累計以美元計）', async () => {
    const db = seedDb();
    const stock = fakeStockTw();
    await openGates(agent, db, { single: 100000, daily: 70000 });
    const r1 = await twOrder(agent, db, stock);
    assert.equal(r1.ok, true);
    const r2 = await twOrder(agent, db, stock);
    assert.equal(r2.blocked, true);
    assert.match(r2.error, /每日上限/);
    assert.equal(await agent.getTodayMoneySpent(db), 66185);
  });

  await ok('換不到匯率 → error，不執行、不計入當日累計', async () => {
    const db = seedDb();
    const stock = fakeStockTw({ fxRate: null });
    await openGates(agent, db);
    const r = await twOrder(agent, db, stock);
    assert.equal(r.ok, false);
    assert.match(r.error, /匯率/);
    assert.equal(db.audit[0].result, 'error');
    assert.equal(await agent.getTodayMoneySpent(db), 0);
  });

  await ok('台股賣出成交：SELL MARKET 1000 股 0050.TW，總金額 NT$116,000（折合 $3596）', async () => {
    const db = seedDb();
    const stock = fakeStockTw();
    await openGates(agent, db);
    const r = await twOrder(agent, db, stock, { ticker: '0050.TW', side: 'SELL', quantity: 1000 });
    assert.equal(r.ok, true);
    assert.equal(r.notional, 116000);
    assert.equal(r.notional_usd, 3596);
    assert.match(r.summary, /紙上賣出 1000 股 0050\.TW/);
  });

  console.log(`\n${passed} 項測試通過，0 項失敗（exit code ${process.exitCode || 0}）`);
}

main().catch(err => { console.error(err); process.exit(1); });
