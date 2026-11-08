// 第 3a 階段紙上交易單元測試（不用 live PostgreSQL / Yahoo 也能跑）
// 執行：node server/agent-paper-trade.test.js
// 覆蓋：紙上成交標示、超上限擋下、非交易時段擋下、不在清單的標的擋下、
// 數量非正整數擋下、放空擋下、限價未達可成交條件擋下、取不到價、閘門、每日累計。
// 假 DB 只實作紙上交易程式實際發出的 SQL。
const assert = require('node:assert/strict');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// ---- 假 DB（in-memory）----
class FakeDb {
  // tickers：fin_accounts 的持倉代碼（raw 值，SQL 層會 UPPER／TRIM，這裡照實回傳）
  constructor(tickers = ['QQQ', 'TSM', 'LITE']) {
    this.settings = new Map();
    this.audit = []; // agent_audit_log rows
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

// 開啟 D 級三道閘門＋設上限（預設單筆 10000、每日 50000，夠紙上單測試用）
async function openGates(agent, db, caps = {}) {
  await agent.updateSettings(db, {
    agent_master: true,
    agent_high_privilege: true,
    agent_money_cap_single: caps.single ?? 10000,
    agent_money_cap_daily: caps.daily ?? 50000,
  });
}

// 假 Yahoo 報價（價格寫死，不對外發請求）
function fakeStock(prices = { QQQ: 250, TSM: 200, LITE: 650 }) {
  const fake = { calls: [] };
  fake.fetchYahooQuote = async (ticker) => {
    const t = String(ticker || '').toUpperCase();
    fake.calls.push(t);
    const price = prices[t];
    if (price == null) return null;
    return { price, currency: 'USD' };
  };
  return fake;
}

// 2026-11-09 是週一；15:00 UTC＝10:00 美東時間（EST，UTC-5），交易時段內
const MON_10AM_ET = new Date('2026-11-09T15:00:00Z');
// 2026-11-07 是週六
const SAT_10AM_ET = new Date('2026-11-07T15:00:00Z');

function paperOrder(agent, db, stock, overrides = {}) {
  return agent.executeHighPrivilegeAction('place_external_order', {
    ticker: 'QQQ', side: 'BUY', quantity: 10, order_type: 'MARKET', duration: 'DAY',
    ...overrides,
  }, 'user', { db, stock, now: MON_10AM_ET });
}

async function main() {
  const agent = require('./agent.js');

  console.log('第 3a 階段紙上交易單元測試：');

  await ok('isUsRegularSession：週一 09:29 擋、09:30 過、15:59 過、16:00 擋、週六日擋', async () => {
    assert.equal(agent.isUsRegularSession(new Date('2026-11-09T14:29:00Z')), false); // 09:29 EST
    assert.equal(agent.isUsRegularSession(new Date('2026-11-09T14:30:00Z')), true);  // 09:30 EST
    assert.equal(agent.isUsRegularSession(new Date('2026-11-09T20:59:00Z')), true);  // 15:59 EST
    assert.equal(agent.isUsRegularSession(new Date('2026-11-09T21:00:00Z')), false); // 16:00 EST
    assert.equal(agent.isUsRegularSession(new Date('2026-11-07T15:00:00Z')), false); // 週六
    assert.equal(agent.isUsRegularSession(new Date('2026-11-08T15:00:00Z')), false); // 週日
    assert.equal(agent.isUsRegularSession(new Date('2026-11-09T13:00:00Z')), false); // 08:00 EST
  });

  await ok('getAllowedTickers：去重、大寫、去空白、空值排除', async () => {
    const db = seedDb(['qqq', ' QQQ ', 'TSM', '', '  ', null, 'LITE']);
    const tickers = await agent.getAllowedTickers(db);
    assert.deepEqual(tickers.sort(), ['LITE', 'QQQ', 'TSM']);
  });

  await ok('紙上成交標示正確：BUY MARKET 10 股 QQQ，Yahoo 現價 $250 模擬成交', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db);
    const r = await paperOrder(agent, db, stock);
    assert.equal(r.ok, true);
    assert.equal(r.paper_trade, true);
    assert.equal(r.fill_price, 250);
    assert.equal(r.notional, 2500);
    assert.match(r.summary, /紙上買進 10 股 QQQ/);
    assert.match(r.summary, /模擬成交價 \$250/);
    assert.match(r.summary, /總金額 \$2500/);
    assert.match(r.summary, /paper trade/);
    assert.match(r.summary, /未真的下單/);
    assert.equal(db.audit.length, 1);
    assert.equal(db.audit[0].result, 'ok');
    assert.equal(db.audit[0].approved_by, 'user');
    assert.equal(db.audit[0].ticker, 'QQQ');
    const input = JSON.parse(db.audit[0].input_snapshot);
    assert.equal(input.ticker, 'QQQ');
    assert.equal(input.side, 'BUY');
    assert.equal(input.quantity, 10);
    assert.equal(input.order_type, 'MARKET');
    assert.equal(input.fill_price, 250);
    assert.equal(input.amount, 2500);
    assert.equal(input.paper_trade, true);
  });

  await ok('紙上賣出成交：SELL MARKET 5 股 TSM，總金額 $1000', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db);
    const r = await paperOrder(agent, db, stock, { ticker: 'TSM', side: 'SELL', quantity: 5 });
    assert.equal(r.ok, true);
    assert.equal(r.notional, 1000);
    assert.match(r.summary, /紙上賣出 5 股 TSM/);
  });

  await ok('超單筆上限擋下：10 股 QQQ 總金額 $2500 超單筆 $1000', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db, { single: 1000, daily: 50000 });
    const r = await paperOrder(agent, db, stock);
    assert.equal(r.blocked, true);
    assert.match(r.error, /單筆上限/);
    assert.equal(db.audit[0].result, 'blocked');
    assert.equal(await agent.getTodayMoneySpent(db), 0);
  });

  await ok('超每日上限擋下：第一筆 $2500 成交，第二筆 $2500 超每日 $3000', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db, { single: 10000, daily: 3000 });
    const r1 = await paperOrder(agent, db, stock);
    assert.equal(r1.ok, true);
    const r2 = await paperOrder(agent, db, stock);
    assert.equal(r2.blocked, true);
    assert.match(r2.error, /每日上限/);
    assert.equal(await agent.getTodayMoneySpent(db), 2500);
  });

  await ok('上限 0 時紙上單也擋下', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await agent.updateSettings(db, { agent_master: true, agent_high_privilege: true });
    const r = await paperOrder(agent, db, stock);
    assert.equal(r.blocked, true);
    assert.match(r.error, /單筆上限/);
  });

  await ok('非交易時段擋下：週六、平日 08:00、平日 20:00 美東時間', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db);
    const cases = [
      SAT_10AM_ET,
      new Date('2026-11-09T13:00:00Z'), // 週一 08:00 EST
      new Date('2026-11-10T01:00:00Z'), // 週一 20:00 EST
    ];
    for (const now of cases) {
      const r = await agent.executeHighPrivilegeAction('place_external_order',
        { ticker: 'QQQ', side: 'BUY', quantity: 1, order_type: 'MARKET', duration: 'DAY' },
        'user', { db, stock, now });
      assert.equal(r.blocked, true);
      assert.match(r.error, /非交易時段|交易時段/);
    }
    assert.equal(db.audit.filter(a => a.result === 'blocked').length, 3);
    assert.equal(stock.calls.length, 0); // 時段不符時不取價
  });

  await ok('不在持倉清單的標的擋下：AAPL', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db);
    const r = await paperOrder(agent, db, stock, { ticker: 'AAPL' });
    assert.equal(r.blocked, true);
    assert.match(r.error, /不在持倉清單內/);
    assert.equal(db.audit[0].result, 'blocked');
  });

  await ok('數量非正整數擋下：0、-5、2.5、abc', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db);
    for (const bad of [0, -5, 2.5, 'abc', undefined]) {
      const r = await paperOrder(agent, db, stock, { quantity: bad });
      assert.equal(r.invalid, true);
      assert.equal(r.ok, false);
    }
    assert.equal(db.audit.filter(a => a.result === 'invalid').length, 5);
  });

  await ok('放空擋下：SELL_SHORT；方向非法值也擋下', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db);
    const r1 = await paperOrder(agent, db, stock, { side: 'SELL_SHORT' });
    assert.equal(r1.invalid, true);
    assert.match(r1.error, /不支援放空/);
    const r2 = await paperOrder(agent, db, stock, { side: 'HOLD' });
    assert.equal(r2.invalid, true);
  });

  await ok('限價單：BUY 限價高於現價可成交（以現價成交）；限價低於現價擋下', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db);
    const r1 = await paperOrder(agent, db, stock, { order_type: 'LIMIT', limit_price: 260 });
    assert.equal(r1.ok, true);
    assert.equal(r1.fill_price, 250); // 限價是防線，成交價仍是現價
    assert.match(r1.summary, /限價 \$260/);
    const r2 = await paperOrder(agent, db, stock, { order_type: 'LIMIT', limit_price: 240 });
    assert.equal(r2.blocked, true);
    assert.match(r2.error, /未達可成交條件/);
  });

  await ok('限價單：SELL 限價低於現價可成交；限價高於現價擋下；缺限價擋下', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db);
    const r1 = await paperOrder(agent, db, stock, { side: 'SELL', order_type: 'LIMIT', limit_price: 240 });
    assert.equal(r1.ok, true);
    assert.equal(r1.fill_price, 250);
    const r2 = await paperOrder(agent, db, stock, { side: 'SELL', order_type: 'LIMIT', limit_price: 260 });
    assert.equal(r2.blocked, true);
    assert.match(r2.error, /未達可成交條件/);
    const r3 = await paperOrder(agent, db, stock, { order_type: 'LIMIT', limit_price: null });
    assert.equal(r3.invalid, true);
    assert.match(r3.error, /限價/);
  });

  await ok('order_type／duration 非法值擋下', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db);
    const r1 = await paperOrder(agent, db, stock, { order_type: 'STOP' });
    assert.equal(r1.invalid, true);
    const r2 = await paperOrder(agent, db, stock, { duration: 'FOK' });
    assert.equal(r2.invalid, true);
  });

  await ok('Yahoo 取不到價 → error，未寫入 ok 稽核、不計入當日累計', async () => {
    const db = seedDb();
    const stock = fakeStock({ QQQ: null }); // 報價回 null
    await openGates(agent, db);
    const r = await paperOrder(agent, db, stock);
    assert.equal(r.ok, false);
    assert.match(r.error, /無法取得 .* 現價/);
    assert.equal(db.audit[0].result, 'error');
    assert.equal(await agent.getTodayMoneySpent(db), 0);
  });

  await ok('閘門仍擋下紙上單：總開關關／最高權限關', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await agent.updateSettings(db, { agent_master: false, agent_high_privilege: true, agent_money_cap_single: 10000, agent_money_cap_daily: 50000 });
    const r1 = await paperOrder(agent, db, stock);
    assert.equal(r1.blocked, true);
    assert.match(r1.error, /總開關/);
    await agent.updateSettings(db, { agent_master: true, agent_high_privilege: false });
    const r2 = await paperOrder(agent, db, stock);
    assert.equal(r2.blocked, true);
    assert.match(r2.error, /最高權限開關/);
  });

  await ok('每日累計含紙上交易：成交後 getTodayMoneySpent 含總金額', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db);
    await paperOrder(agent, db, stock); // $2500
    await paperOrder(agent, db, stock, { ticker: 'TSM', side: 'SELL', quantity: 5 }); // $1000
    assert.equal(await agent.getTodayMoneySpent(db), 3500);
  });

  await ok('執行中最高權限開關被關掉 → 中止、不留半成品', async () => {
    const db = seedDb();
    const stock = {
      fetchYahooQuote: async () => {
        // 模擬取價途中使用者把最高權限開關關掉
        db.settings.set('agent_high_privilege', { value: false, value_num: null });
        return { price: 250, currency: 'USD' };
      },
    };
    await openGates(agent, db);
    const r = await paperOrder(agent, db, stock);
    assert.equal(r.cancelled, true);
    assert.equal(r.ok, false);
    assert.equal(db.audit.length, 1);
    assert.equal(db.audit[0].result, 'cancelled');
    assert.equal(await agent.getTodayMoneySpent(db), 0);
  });

  await ok('其餘 D 級動錢行為不變：money_transfer 仍走原本 mock 流程', async () => {
    const db = seedDb();
    const stock = fakeStock();
    await openGates(agent, db);
    const r = await agent.executeHighPrivilegeAction('money_transfer', { amount: 100, target: '測試對象' }, 'user', { db, stock, now: MON_10AM_ET });
    assert.equal(r.ok, true);
    assert.equal(r.mock, true);
    assert.match(r.summary, /mock/);
  });

  console.log(`\n${passed} 項測試通過，0 項失敗（exit code ${process.exitCode || 0}）`);
}

main().catch(err => { console.error(err); process.exit(1); });
