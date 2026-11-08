// D 級最高權限單元測試（不用 live PostgreSQL / Ollama 也能跑）
// 執行：node server/agent-money.test.js
// 覆蓋規格 1.6 六條驗收：閘門擋下、上限 0 擋下、超上限擋下、
// 完整流程＋批准人為 user、執行中關開關中止、mock 標示。
// 假 DB 只實作 D 級程式實際發出的 SQL。
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
  constructor() {
    // key -> { value: boolean, value_num: number|null }
    this.settings = new Map();
    this.audit = []; // agent_audit_log rows
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
    throw new Error(`FakeDb 不支援的 SQL: ${s.slice(0, 120)}`);
  }
}

function seedDb() { return new FakeDb(); }

// 開啟 D 級三道閘門＋設上限（預設單筆 1000、每日 5000）
async function openGates(agent, db, caps = {}) {
  await agent.updateSettings(db, {
    agent_master: true,
    agent_high_privilege: true,
    agent_money_cap_single: caps.single ?? 1000,
    agent_money_cap_daily: caps.daily ?? 5000,
  });
}

async function main() {
  const agent = require('./agent.js');

  console.log('D 級最高權限單元測試：');

  await ok('預設值：原五開關不變，最高權限關、單筆／每日上限皆 0', async () => {
    const db = seedDb();
    const s = await agent.getSettings(db);
    assert.equal(s.agent_master, true);
    assert.equal(s.agent_diagnosis, true);
    assert.equal(s.agent_health_check, true);
    assert.equal(s.agent_execution, false);
    assert.equal(s.agent_notification, false);
    assert.equal(s.agent_high_privilege, false);
    assert.equal(s.agent_money_cap_single, 0);
    assert.equal(s.agent_money_cap_daily, 0);
  });

  await ok('updateSettings：上限接受非負數字，拒絕負數／非數字／未知 key；布林開關仍只接受布林', async () => {
    const db = seedDb();
    const s = await agent.updateSettings(db, { agent_money_cap_single: 1500, agent_money_cap_daily: 10000 });
    assert.equal(s.agent_money_cap_single, 1500);
    assert.equal(s.agent_money_cap_daily, 10000);
    await assert.rejects(() => agent.updateSettings(db, { agent_money_cap_single: -1 }), /non-negative number/);
    await assert.rejects(() => agent.updateSettings(db, { agent_money_cap_daily: '100' }), /non-negative number/);
    await assert.rejects(() => agent.updateSettings(db, { nope: 1 }), /unknown setting/);
    await assert.rejects(() => agent.updateSettings(db, { agent_high_privilege: 'yes' }), /must be boolean/);
    // 上限寫入後讀回仍是數字（不是布林）
    const s2 = await agent.getSettings(db);
    assert.equal(s2.agent_money_cap_single, 1500);
  });

  await ok('highPrivilegeDisabledReason：總開關關／最高權限關／全開', async () => {
    assert.equal(agent.highPrivilegeDisabledReason({ agent_master: false, agent_high_privilege: true }), '總開關已關閉');
    assert.match(agent.highPrivilegeDisabledReason({ agent_master: true, agent_high_privilege: false }), /最高權限開關/);
    assert.equal(agent.highPrivilegeDisabledReason({ agent_master: true, agent_high_privilege: true }), null);
  });

  await ok('驗收 1a：總開關關著，D 級請求被擋下、只寫稽核不執行', async () => {
    const db = seedDb();
    await agent.updateSettings(db, { agent_master: false, agent_high_privilege: true, agent_money_cap_single: 1000, agent_money_cap_daily: 5000 });
    const r = await agent.executeHighPrivilegeAction('money_transfer', { amount: 100, target: '測試對象' }, 'user', { db });
    assert.equal(r.blocked, true);
    assert.equal(db.audit.length, 1);
    assert.equal(db.audit[0].result, 'blocked');
    assert.match(db.audit[0].output_summary, /總開關/);
  });

  await ok('驗收 1b：最高權限開關關著，D 級請求被擋下', async () => {
    const db = seedDb();
    await agent.updateSettings(db, { agent_master: true, agent_money_cap_single: 1000, agent_money_cap_daily: 5000 });
    const r = await agent.executeHighPrivilegeAction('money_transfer', { amount: 100, target: '測試對象' }, 'user', { db });
    assert.equal(r.blocked, true);
    assert.match(r.error, /最高權限開關/);
    assert.equal(db.audit[0].result, 'blocked');
  });

  await ok('驗收 1c：D 級三道閘門不含執行開關（執行關著、最高權限開著仍可執行）', async () => {
    const db = seedDb();
    await openGates(agent, db);
    const s = await agent.getSettings(db);
    assert.equal(s.agent_execution, false);
    const r = await agent.executeHighPrivilegeAction('money_transfer', { amount: 100, target: '測試對象' }, 'user', { db });
    assert.equal(r.ok, true);
  });

  await ok('D 級動作送到 B 入口被擋下；非 D 級動作送到 D 入口也被擋下', async () => {
    const db = seedDb();
    await openGates(agent, db);
    const r1 = await agent.executeAgentAction('money_transfer', { amount: 100 }, 'user', { db });
    assert.equal(r1.blocked, true);
    const r2 = await agent.executeHighPrivilegeAction('trade', { amount: 100 }, 'user', { db });
    assert.equal(r2.blocked, true);
    const r3 = await agent.executeHighPrivilegeAction('do_evil', {}, 'user', { db });
    assert.equal(r3.blocked, true);
    assert.equal(db.audit.filter(a => a.result === 'blocked').length, 3);
  });

  await ok('驗收 2：上限為 0 時，任何金額都擋下', async () => {
    const db = seedDb();
    await agent.updateSettings(db, { agent_master: true, agent_high_privilege: true });
    const r = await agent.executeHighPrivilegeAction('money_transfer', { amount: 1, target: '測試對象' }, 'user', { db });
    assert.equal(r.blocked, true);
    assert.match(r.error, /單筆上限/);
    assert.equal(db.audit[0].result, 'blocked');
  });

  await ok('驗收 3a：超單筆上限擋下', async () => {
    const db = seedDb();
    await openGates(agent, db, { single: 1000, daily: 5000 });
    const r = await agent.executeHighPrivilegeAction('pay_invoice', { amount: 1001, target: '測試對象' }, 'user', { db });
    assert.equal(r.blocked, true);
    assert.match(r.error, /單筆上限/);
    assert.equal(db.audit[0].result, 'blocked');
  });

  await ok('驗收 3b：超每日上限擋下；剛好等於上限可執行；被擋下的不計入當日累計', async () => {
    const db = seedDb();
    await openGates(agent, db, { single: 1000, daily: 1000 });
    const r1 = await agent.executeHighPrivilegeAction('money_transfer', { amount: 600, target: '測試對象' }, 'user', { db });
    assert.equal(r1.ok, true);
    // 被單筆上限擋下的 2000 不應計入累計
    const rBlocked = await agent.executeHighPrivilegeAction('money_transfer', { amount: 2000, target: '測試對象' }, 'user', { db });
    assert.equal(rBlocked.blocked, true);
    // 600＋500＝1100 超每日上限 1000 → 擋下
    const r2 = await agent.executeHighPrivilegeAction('money_transfer', { amount: 500, target: '測試對象' }, 'user', { db });
    assert.equal(r2.blocked, true);
    assert.match(r2.error, /每日上限/);
    // 600＋400＝1000 剛好等於上限 → 可執行
    const r3 = await agent.executeHighPrivilegeAction('money_transfer', { amount: 400, target: '測試對象' }, 'user', { db });
    assert.equal(r3.ok, true);
    assert.equal(await agent.getTodayMoneySpent(db), 1000);
  });

  await ok('getTodayMoneySpent：只算今天 ok 的動錢，昨天的不算', async () => {
    const db = seedDb();
    await openGates(agent, db, { single: 10000, daily: 100000 });
    const r = await agent.executeHighPrivilegeAction('money_transfer', { amount: 300, target: '測試對象' }, 'user', { db });
    assert.equal(r.ok, true);
    // 手動塞一筆昨天的 ok 紀錄（金額再大也不該計入今天）
    db.audit.push({
      id: 99, created_at: new Date(Date.now() - 86400000 * 2),
      action_type: 'money_transfer', input_snapshot: JSON.stringify({ amount: 99999 }), result: 'ok',
    });
    assert.equal(await agent.getTodayMoneySpent(db), 300);
  });

  await ok('驗收 4：完整流程—請求→執行（mock）→稽核可查，批准人為 user', async () => {
    const db = seedDb();
    await openGates(agent, db);
    const r = await agent.executeHighPrivilegeAction('money_transfer', { amount: 500, target: '測試對象' }, 'user', { db });
    assert.equal(r.ok, true);
    assert.equal(r.mock, true);
    assert.match(r.summary, /mock/);
    assert.match(r.summary, /未真的轉帳/);
    assert.equal(db.audit.length, 1);
    assert.equal(db.audit[0].result, 'ok');
    assert.equal(db.audit[0].approved_by, 'user');
    assert.equal(db.audit[0].action_type, 'money_transfer');
    const snap = JSON.parse(db.audit[0].settings_snapshot);
    assert.equal(snap.agent_high_privilege, true);
    const input = JSON.parse(db.audit[0].input_snapshot);
    assert.equal(input.amount, 500);
  });

  await ok('驗收 6：mock 標示—付發票／換匯都標明未真的執行（place_external_order 第 3a 階段改走紙上交易，見 agent-paper-trade.test.js）', async () => {
    const db = seedDb();
    await openGates(agent, db);
    const r1 = await agent.executeHighPrivilegeAction('pay_invoice', { amount: 200, target: '測試對象' }, 'user', { db });
    assert.equal(r1.ok, true);
    assert.match(r1.summary, /mock/);
    assert.match(r1.summary, /未真的付款/);
    const r2 = await agent.executeHighPrivilegeAction('fx_convert', { amount: 200, target: '測試對象' }, 'user', { db });
    assert.equal(r2.ok, true);
    assert.match(r2.summary, /未真的換匯/);
  });

  await ok('update_high_setting：指名清單為空，任何設定改動都擋下', async () => {
    const db = seedDb();
    await openGates(agent, db);
    const r = await agent.executeHighPrivilegeAction('update_high_setting', { key: 'agent_money_cap_single', value: 9999 }, 'user', { db });
    assert.equal(r.blocked, true);
    assert.equal(db.audit[0].result, 'blocked');
    // 上限沒被改掉
    const s = await agent.getSettings(db);
    assert.equal(s.agent_money_cap_single, 1000);
  });

  await ok('金額無效（0、負數、缺失、非數字）一律擋下，不執行', async () => {
    const db = seedDb();
    await openGates(agent, db);
    for (const bad of [0, -50, undefined, 'abc']) {
      const r = await agent.executeHighPrivilegeAction('money_transfer', { amount: bad, target: '測試對象' }, 'user', { db });
      assert.equal(r.invalid, true);
      assert.equal(r.ok, false);
    }
    assert.equal(db.audit.filter(a => a.result === 'invalid').length, 4);
    assert.equal(await agent.getTodayMoneySpent(db), 0);
  });

  await ok('驗收 5：執行中最高權限開關被關掉 → 中止、不留半成品', async () => {
    const db = seedDb();
    await openGates(agent, db);
    const r = await agent.executeHighPrivilegeAction('money_transfer', { amount: 100, target: '測試對象' }, 'user', {
      db,
      mockExecutor: async () => {
        // 模擬執行途中使用者把最高權限開關關掉
        db.settings.set('agent_high_privilege', { value: false, value_num: null });
        return { ok: true, mock: true, summary: '半成品模擬結果' };
      },
    });
    assert.equal(r.cancelled, true);
    assert.equal(r.ok, false);
    assert.equal(db.audit.length, 1);
    assert.equal(db.audit[0].result, 'cancelled');
    assert.equal(await agent.getTodayMoneySpent(db), 0);
  });

  console.log(`\n${passed} 項測試通過，0 項失敗（exit code ${process.exitCode || 0}）`);
}

main().catch(err => { console.error(err); process.exit(1); });
