// Agent 總開關與白名單單元測試（不用 live PostgreSQL / Ollama 也能跑）
// 執行：node server/agent.test.js
// 假 DB 實作 agent.js 實際發出的 SQL；Ollama 用假函式注入，
// 只有 callOllama 重試次數是用本機假 HTTP 伺服器驗真實邏輯。
const assert = require('node:assert/strict');
const http = require('node:http');

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
    this.settings = new Map(); // key -> boolean
    this.audit = [];           // agent_audit_log rows
    this.alerts = [];          // fin_price_alerts rows
    this.accounts = [];        // fin_accounts rows
    this.sepaChecks = [];      // fin_sepa_checks rows
    this.pages = [];
    this.reports = [];         // fin_ai_reports rows
    this.failSelect1 = false;
  }
  async recordHistoryIfChanged() { return true; }
  async query(sql, params = []) {
    const s = String(sql);
    if (s.includes('FROM agent_settings') && s.trimStart().startsWith('SELECT')) {
      return { rows: [...this.settings.entries()].map(([key, value]) => ({ key, value })) };
    }
    if (s.includes('INSERT INTO agent_settings')) {
      this.settings.set(params[0], params[1]);
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('INSERT INTO agent_audit_log')) {
      const row = {
        id: this.audit.length + 1,
        action_type: params[0], account_id: params[1], ticker: params[2],
        page_id: params[3], alert_id: params[4],
        settings_snapshot: params[5], input_snapshot: params[6],
        model: params[7], output_summary: params[8],
        approved_by: params[9], result: params[10],
      };
      this.audit.push(row);
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (s.includes('FROM fin_price_alerts a JOIN fin_accounts')) {
      const alert = this.alerts.find(a => a.id === params[0]);
      if (!alert) return { rows: [] };
      const acc = this.accounts.find(a => a.id === alert.account_id) || {};
      return { rows: [{ ...alert, account_name: acc.name, ticker: acc.ticker, cost_price: acc.cost_price, last_price: acc.last_price }] };
    }
    if (s.includes('FROM fin_sepa_checks WHERE account_id')) {
      const rows = this.sepaChecks.filter(c => c.account_id === params[0])
        .sort((a, b) => (a.check_date < b.check_date ? 1 : -1));
      return { rows: rows.slice(0, 1) };
    }
    if (s.includes("UPDATE fin_price_alerts SET diagnosis_status = 'skipped'")) {
      const a = this.alerts.find(x => x.id === params[0]);
      if (a) a.diagnosis_status = 'skipped';
      return { rowCount: a ? 1 : 0 };
    }
    if (s.includes("UPDATE fin_price_alerts SET diagnosis_status = 'stale'")) {
      const a = this.alerts.find(x => x.id === params[0]);
      if (a) a.diagnosis_status = 'stale';
      return { rowCount: a ? 1 : 0 };
    }
    if (s.includes("diagnosis = NULL, diagnosis_status = 'missing'")) {
      const a = this.alerts.find(x => x.id === params[0]);
      if (a) { a.diagnosis = null; a.diagnosis_status = 'missing'; }
      return { rowCount: a ? 1 : 0 };
    }
    if (s.includes("diagnosis = NULL, diagnosis_status = 'cancelled'")) {
      const a = this.alerts.find(x => x.id === params[0]);
      if (a) { a.diagnosis = null; a.diagnosis_status = 'cancelled'; }
      return { rowCount: a ? 1 : 0 };
    }
    if (s.includes("UPDATE fin_price_alerts SET diagnosis = $1, diagnosis_status = 'done'")) {
      const a = this.alerts.find(x => x.id === params[1]);
      if (a) { a.diagnosis = params[0]; a.diagnosis_status = 'done'; }
      return { rowCount: a ? 1 : 0 };
    }
    if (s.trim() === 'SELECT 1') {
      if (this.failSelect1) throw new Error('db down');
      return { rows: [{ '?column?': 1 }] };
    }
    if (s.includes('MAX(check_date::text)')) {
      const dates = this.sepaChecks.map(c => c.check_date).sort();
      return { rows: [{ latest: dates.length ? dates[dates.length - 1] : null }] };
    }
    if (s.trim() === 'SELECT * FROM fin_accounts') return { rows: this.accounts };
    if (s.includes('FROM fin_cash_demands')) return { rows: [] };
    if (s.includes('FROM results r JOIN pages p')) return { rows: [] };
    if (s.includes('INSERT INTO fin_ai_reports')) {
      this.reports.push({ id: this.reports.length + 1, analysis: params[0] });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('SELECT * FROM fin_accounts WHERE id')) {
      return { rows: this.accounts.filter(a => a.id === params[0]) };
    }
    if (s.includes('UPDATE fin_accounts SET balance')) {
      const a = this.accounts.find(x => x.id === params[2]);
      if (a) { a.balance = params[0]; a.last_price = params[1]; }
      return { rowCount: a ? 1 : 0 };
    }
    if (s.includes('UPDATE fin_price_alerts SET acknowledged = TRUE')) {
      const a = this.alerts.find(x => x.id === params[0]);
      if (a) a.acknowledged = true;
      return { rowCount: a ? 1 : 0 };
    }
    if (s.includes('SELECT * FROM pages WHERE id')) {
      return { rows: this.pages.filter(p => p.id === params[0]) };
    }
    throw new Error(`FakeDb 不支援的 SQL: ${s.slice(0, 120)}`);
  }
}

function seedDb() {
  const db = new FakeDb();
  db.accounts.push({
    id: 1, name: '台積電', ticker: '2330.TW', shares: 100,
    cost_price: 1000, last_price: 1100, currency: 'TWD', balance: 110000,
  });
  return db;
}

function todayPhoenix() {
  return new Date().toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/Phoenix' });
}
function yesterdayPhoenix() {
  const d = new Date(Date.now() - 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/Phoenix' });
}

async function main() {
  // 假 Ollama 伺服器：第一次 500、第二次成功（驗重試一次）；另一個永遠失敗
  let flakyHits = 0;
  const flaky = http.createServer((req, res) => {
    flakyHits++;
    if (flakyHits === 1) { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ response: 'flaky-ok' }));
  });
  let deadHits = 0;
  const dead = http.createServer((req, res) => { deadHits++; res.writeHead(500); res.end('boom'); });
  await new Promise(r => flaky.listen(0, r));
  await new Promise(r => dead.listen(0, r));
  const flakyUrl = `http://127.0.0.1:${flaky.address().port}`;
  const deadUrl = `http://127.0.0.1:${dead.address().port}`;

  // agent.js 在載入時讀 OLLAMA_URL：先指向 flaky server 測重試，再換 dead server
  process.env.OLLAMA_URL = flakyUrl;
  delete require.cache[require.resolve('./agent.js')];
  const agent = require('./agent.js');

  console.log('Agent 單元測試：');

  await ok('開關預設值：master/diagnosis/health on，execution/notification off', async () => {
    const db = seedDb();
    const s = await agent.getSettings(db);
    assert.equal(s.agent_master, true);
    assert.equal(s.agent_diagnosis, true);
    assert.equal(s.agent_health_check, true);
    assert.equal(s.agent_execution, false);
    assert.equal(s.agent_notification, false);
  });

  await ok('updateSettings 寫入＋拒絕未知 key／非布林值', async () => {
    const db = seedDb();
    const s = await agent.updateSettings(db, { agent_execution: true });
    assert.equal(s.agent_execution, true);
    assert.equal(db.settings.get('agent_execution'), true);
    await assert.rejects(() => agent.updateSettings(db, { nope: true }), /unknown setting/);
    await assert.rejects(() => agent.updateSettings(db, { agent_master: 'yes' }), /must be boolean/);
  });

  await ok('agentEnabled：總開關關掉就壓過全部', async () => {
    assert.equal(agent.agentEnabled({ agent_master: false, agent_diagnosis: true }, 'agent_diagnosis'), false);
    assert.equal(agent.agentEnabled({ agent_master: true, agent_diagnosis: false }, 'agent_diagnosis'), false);
    assert.equal(agent.agentEnabled({ agent_master: true, agent_diagnosis: true }, 'agent_diagnosis'), true);
  });

  await ok('actionDisabledReason：master 關／execution 關／全開', async () => {
    assert.equal(agent.actionDisabledReason({ agent_master: false, agent_execution: true }), '總開關已關閉');
    assert.match(agent.actionDisabledReason({ agent_master: true, agent_execution: false }), /執行開關/);
    assert.equal(agent.actionDisabledReason({ agent_master: true, agent_execution: true }), null);
  });

  await ok('C 級動作 update_stop_loss 被擋下，只寫稽核不執行', async () => {
    const db = seedDb();
    await agent.updateSettings(db, { agent_master: true, agent_execution: true });
    const r = await agent.executeAgentAction('update_stop_loss', { account_id: 1 }, 'user', { db });
    assert.equal(r.blocked, true);
    assert.equal(db.accounts[0].stop_loss, undefined);
    assert.equal(db.audit.length, 1);
    assert.equal(db.audit[0].result, 'blocked');
    assert.equal(db.audit[0].action_type, 'update_stop_loss');
  });

  await ok('未知動作也被擋下（預設拒絕）', async () => {
    const db = seedDb();
    const r = await agent.executeAgentAction('do_evil', {}, 'user', { db });
    assert.equal(r.blocked, true);
    assert.equal(db.audit[0].result, 'blocked');
  });

  await ok('執行開關關著：白名單動作被拒、不執行、不排隊', async () => {
    const db = seedDb();
    db.alerts.push({ id: 1, account_id: 1, alert_type: 'target', threshold: 1200, price_at_trigger: 1200, triggered_at: new Date(), acknowledged: false });
    const r = await agent.executeAgentAction('acknowledge_alert', { alert_id: 1 }, 'user', { db });
    assert.equal(r.disabled, true);
    assert.match(r.reason, /執行開關/);
    assert.equal(db.alerts[0].acknowledged, false);
    assert.equal(db.audit[0].result, 'disabled');
  });

  await ok('執行開關開著：acknowledge 執行成功並寫稽核', async () => {
    const db = seedDb();
    await agent.updateSettings(db, { agent_execution: true });
    db.alerts.push({ id: 1, account_id: 1, alert_type: 'target', threshold: 1200, price_at_trigger: 1200, triggered_at: new Date(), acknowledged: false });
    const r = await agent.executeAgentAction('acknowledge_alert', { alert_id: 1 }, 'user', { db });
    assert.equal(r.ok, true);
    assert.equal(db.alerts[0].acknowledged, true);
    assert.equal(db.audit[0].result, 'ok');
    assert.equal(db.audit[0].approved_by, 'user');
  });

  await ok('rerun_sepa_check 經白名單執行（注入假函式）', async () => {
    const db = seedDb();
    await agent.updateSettings(db, { agent_execution: true });
    const r = await agent.executeAgentAction('rerun_sepa_check', {}, 'user', { db, runSepaCheck: async () => 2 });
    assert.equal(r.ok, true);
    assert.equal(r.checked, 2);
  });

  await ok('總開關關掉：新告警不產生診斷（驗收 1）', async () => {
    const db = seedDb();
    await agent.updateSettings(db, { agent_master: false });
    db.alerts.push({ id: 1, account_id: 1, alert_type: 'target', threshold: 900, price_at_trigger: 890, triggered_at: new Date(), diagnosis_status: 'pending' });
    let called = 0;
    const r = await agent.diagnoseAlert(1, { db, callOllama: async () => { called++; return 'x'; } });
    assert.equal(r.skipped, true);
    assert.equal(called, 0);
    assert.equal(db.alerts[0].diagnosis_status, 'skipped');
    assert.equal(db.audit[0].result, 'skipped');
  });

  await ok('診斷成功：寫入告警旁邊，稽核含模型與輸入快照', async () => {
    const db = seedDb();
    db.alerts.push({ id: 1, account_id: 1, alert_type: 'sepa_50ma_break', threshold: 1000, price_at_trigger: 990, triggered_at: new Date(), diagnosis_status: 'pending' });
    db.sepaChecks.push({ account_id: 1, check_date: todayPhoenix(), ma50: 1000, ma150: 950, ma200: 900, wma10: 990, template: { t1: true, t2: true, t3: true, t4: true, t5: false, t6: true, t7: true, t8: true } });
    const r = await agent.diagnoseAlert(1, { db, callOllama: async () => '收盤跌破 50 日線，模板 7/8。' });
    assert.equal(r.ok, true);
    assert.equal(db.alerts[0].diagnosis_status, 'done');
    assert.match(db.alerts[0].diagnosis, /跌破 50 日線/);
    assert.equal(db.audit[0].result, 'ok');
    assert.equal(db.audit[0].model, agent.MODEL_NAME);
    const snap = JSON.parse(db.audit[0].input_snapshot);
    assert.equal(snap.template_score, 7);
  });

  await ok('資料日期對不上觸發日：標示資料過期，不出診斷、不叫 Ollama', async () => {
    const db = seedDb();
    db.alerts.push({ id: 1, account_id: 1, alert_type: 'sepa_50ma_break', threshold: 1000, price_at_trigger: 990, triggered_at: new Date(), diagnosis_status: 'pending' });
    db.sepaChecks.push({ account_id: 1, check_date: yesterdayPhoenix(), ma50: 1000, template: {} });
    let called = 0;
    const r = await agent.diagnoseAlert(1, { db, callOllama: async () => { called++; return 'x'; } });
    assert.equal(r.stale, true);
    assert.equal(called, 0);
    assert.equal(db.alerts[0].diagnosis_status, 'stale');
    assert.equal(db.audit[0].result, 'stale');
  });

  await ok('Ollama 連不上：診斷缺件、不編造（驗收 5）', async () => {
    const db = seedDb();
    db.alerts.push({ id: 1, account_id: 1, alert_type: 'target', threshold: 1200, price_at_trigger: 1210, triggered_at: new Date(), diagnosis_status: 'pending' });
    const r = await agent.diagnoseAlert(1, { db, callOllama: async () => { throw new Error('connect ECONNREFUSED'); } });
    assert.equal(r.missing, true);
    assert.equal(db.alerts[0].diagnosis_status, 'missing');
    assert.equal(db.alerts[0].diagnosis, null);
    assert.equal(db.audit[0].result, 'error');
  });

  await ok('執行中開關被關掉：中止、不留半成品診斷', async () => {
    const db = seedDb();
    db.alerts.push({ id: 1, account_id: 1, alert_type: 'target', threshold: 1200, price_at_trigger: 1210, triggered_at: new Date(), diagnosis_status: 'pending' });
    const r = await agent.diagnoseAlert(1, {
      db,
      callOllama: async () => {
        // 模擬生成途中使用者把診斷開關關掉
        db.settings.set('agent_diagnosis', false);
        return '半成品診斷文字';
      },
    });
    assert.equal(r.cancelled, true);
    assert.equal(db.alerts[0].diagnosis, null);
    assert.equal(db.alerts[0].diagnosis_status, 'cancelled');
    assert.equal(db.audit[0].result, 'cancelled');
  });

  await ok('通知開關關著：告警觸發也不對外發送（驗收 3）', async () => {
    const db = seedDb();
    const r = await agent.notifyExternal({ alert_id: 1, account_id: 1, ticker: '2330.TW', alert_type: 'target' }, { db });
    assert.equal(r.sent, false);
    assert.equal(db.audit[0].result, 'suppressed');
  });

  await ok('通知開關開著但 v1 無通道：仍不發送，稽核註明 no_channel', async () => {
    const db = seedDb();
    await agent.updateSettings(db, { agent_notification: true });
    const r = await agent.notifyExternal({ alert_id: 1, account_id: 1, ticker: '2330.TW', alert_type: 'target' }, { db });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'no_channel');
    assert.equal(db.audit[0].result, 'no_channel');
  });

  await ok('健檢全正常：結果 ok，稽核列出各元件', async () => {
    const db = seedDb();
    db.sepaChecks.push({ account_id: 1, check_date: todayPhoenix() });
    const r = await agent.runHealthCheck({ db, checkOllama: async () => ({ ok: true }) });
    assert.equal(r.result, 'ok');
    assert.match(r.summary, /資料庫正常/);
    assert.match(r.summary, /Ollama 正常/);
    assert.equal(db.audit[0].action_type, 'health_check');
  });

  await ok('健檢 Ollama 異常：標 degraded、摘要點名 Ollama 異常', async () => {
    const db = seedDb();
    db.sepaChecks.push({ account_id: 1, check_date: todayPhoenix() });
    const r = await agent.runHealthCheck({ db, checkOllama: async () => ({ ok: false, error: 'ECONNREFUSED' }) });
    assert.equal(r.result, 'degraded');
    assert.match(r.summary, /Ollama 異常/);
  });

  await ok('健檢開關關著：跳過並寫稽核', async () => {
    const db = seedDb();
    await agent.updateSettings(db, { agent_health_check: false });
    const r = await agent.runHealthCheck({ db, checkOllama: async () => ({ ok: true }) });
    assert.equal(r.skipped, true);
    assert.equal(db.audit[0].result, 'skipped');
  });

  await ok('generateAdvisorReport：寫入 fin_ai_reports', async () => {
    const db = seedDb();
    const advice = await agent.generateAdvisorReport({ db, analyzeFinancialPortfolio: async () => '測試報告' });
    assert.equal(advice, '測試報告');
    assert.equal(db.reports.length, 1);
  });

  await ok('callOllama：第一次失敗、重試一次後成功（共 2 次請求）', async () => {
    const text = await agent.callOllama('hi');
    assert.equal(text, 'flaky-ok');
    assert.equal(flakyHits, 2);
  });

  // 換成永遠失敗的 server，驗「同一觸發不自動重試超過一次」
  process.env.OLLAMA_URL = deadUrl;
  delete require.cache[require.resolve('./agent.js')];
  const agentDead = require('./agent.js');
  await ok('callOllama：一直失敗時只試 2 次就拋錯（初次＋1 次重試）', async () => {
    await assert.rejects(() => agentDead.callOllama('hi'));
    assert.equal(deadHits, 2);
  });

  flaky.close();
  dead.close();
  console.log(`\n${passed} 項測試通過，0 項失敗（exit code ${process.exitCode || 0}）`);
}

main().catch(err => { console.error(err); process.exit(1); });
