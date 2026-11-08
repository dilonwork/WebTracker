// Agent 總開關與白名單（server/agent.js）
// 規格：五個開關存 agent_settings（DB，非環境變數），改了立即生效；
// 三級權限：A 自動（唯讀＋寫診斷／健檢／稽核）、B 白名單（人點一次做一次）、
// C 永遠禁止（server 端強制擋下，只寫稽核不執行）。
// D 級最高權限（動錢／改關鍵設定／對外下單）：獨立入口 executeHighPrivilegeAction，
// 三道閘門（總開關＋最高權限開關＋逐筆點頭二次確認）＋金額上限（預設 0＝一律擋下）。
// 第 1 階段動錢只接 mock，不接 Stripe SDK、不碰金鑰、不發網路請求。
// 總開關關掉：agent 的診斷、健檢、待批准動作全部停；每小時 Yahoo 抓價、
// 每天 14:00 SEPA 體檢、網站爬取照常寫資料（那是資料層，不歸 agent 管）。
// NOTE: lazy-require db / sepa / scheduler / stock so this module can be
// unit-tested without a live PostgreSQL (same pattern as sepa.js / stock.js).
const axios = require('axios');

const getDb = () => require('./database');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL_NAME = process.env.OLLAMA_MODEL || 'batiai/gemma4-e4b:q4';

// 五個開關：key、預設值、中文標籤
const SETTING_KEYS = ['agent_master', 'agent_diagnosis', 'agent_health_check', 'agent_execution', 'agent_notification', 'agent_high_privilege'];
const SETTING_DEFAULTS = {
  agent_master: true,        // 總開關：關掉就壓過下面全部
  agent_diagnosis: true,     // 告警診斷
  agent_health_check: true,  // 每日健檢（正常不打擾）
  agent_execution: false,    // 人批准動作執行（試點穩定後 Dylan 手動開）
  agent_notification: false, // 對外通知（v1 只有站內告警，推播路徑未驗證通）
  agent_high_privilege: false, // D 級最高權限：動錢／改關鍵設定／對外下單（預設關）
};
const SETTING_LABELS = {
  agent_master: { label: '總開關', desc: '關掉就壓過下面全部，agent 診斷、健檢、待批准動作全部停' },
  agent_diagnosis: { label: '告警診斷', desc: '新告警產生時，用 Ollama 寫一段診斷附在告警旁邊' },
  agent_health_check: { label: '每日健檢', desc: '每天檢查資料庫、Ollama、SEPA 體檢新鮮度，正常不打擾' },
  agent_execution: { label: '批准動作執行', desc: '人點白名單按鈕才執行動作；關著時按鈕停用並講明原因' },
  agent_notification: { label: '對外通知', desc: '告警觸發時對外發送；v1 只有站內告警，推播路徑驗證通了再開' },
  agent_high_privilege: { label: '最高權限（動錢／改設定／對外下單）', desc: 'D 級總開關；關著時動錢、改關鍵設定、對外下單全部擋下，開著還要逐筆點頭＋二次確認' },
};

// D 級金額上限：數字（非布林），存 agent_settings.value_num，預設 0＝一律擋下
// agent_settings.value 是 BOOLEAN 欄位，數字放不進去，所以上限另用 value_num 欄位存。
const CAP_KEYS = ['agent_money_cap_single', 'agent_money_cap_daily'];
const CAP_DEFAULTS = {
  agent_money_cap_single: 0, // 單筆上限（預設 0：任何金額都擋下）
  agent_money_cap_daily: 0,  // 每日上限（預設 0：任何金額都擋下）
};
const CAP_LABELS = {
  agent_money_cap_single: { label: '單筆上限', desc: '單筆動錢金額上限（0＝一律擋下）' },
  agent_money_cap_daily: { label: '每日上限', desc: '當日動錢累計金額上限（0＝一律擋下）' },
};

// B 白名單：人點一次、只做一次，不批次
const WHITELIST_ACTIONS = [
  'acknowledge_alert',      // 確認告警
  'rerun_sepa_check',       // 重跑 SEPA 體檢
  'refetch_yahoo_price',    // 單檔重抓 Yahoo 股價
  'rerun_page_crawl',       // 單頁重跑爬取
  'generate_advisor_report',// 產生 advisor 報告
];

// C 永遠禁止：就算人在聊天室叫它做也不行（server 端強制擋下）
const BLOCKED_ACTIONS = [
  'update_stop_loss', 'update_target_price', 'update_threshold',
  'update_tier', 'update_cost_price', 'update_shares',
  'mute_alert', 'delete_alert', 'delete_sepa_record',
  'update_page_url', 'update_page_prompt', 'update_page_cron',
  'trade', 'alter_schema', 'restart_service',
];

// D 級最高權限動作白名單（獨立入口 executeHighPrivilegeAction，不走 B 白名單）
// 沒列上的就是禁止；D 級動作送到 B 入口也會被擋下。
const HIGH_PRIVILEGE_ACTIONS = [
  'money_transfer',       // 轉帳（第 1 階段只接 mock）
  'pay_invoice',          // 付發票（第 1 階段只接 mock）
  'fx_convert',           // 換匯（第 1 階段只接 mock）
  'place_external_order', // 對外下單（第 1 階段只接 mock，已記錄待執行）
  'update_high_setting',  // 改關鍵設定（限指名清單）
];
// 動錢類動作：要驗金額與單筆／每日上限（place_external_order 對外下單也算動錢）
const MONEY_ACTIONS = ['money_transfer', 'pay_invoice', 'fx_convert', 'place_external_order'];
// D 級可改的關鍵設定指名清單：第 1 階段為空，任何設定改動都直接擋下
const HIGH_PRIVILEGE_SETTINGS = [];

// 鳳凰城今天 00:00 的 ISO 字串（每日上限累計的起算點；鳳凰城無日光節約，UTC-7）
function phoenixMidnightISO(d = new Date()) {
  return `${phoenixDate(d)}T00:00:00-07:00`;
}

// 鳳凰城日期字串 YYYY-MM-DD（資料新鮮度比對用）
function phoenixDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'America/Phoenix' });
}

// 讀取六個開關＋兩個金額上限（缺列時補預設值）
// 注意：舊資料庫可能還沒有 value_num 欄位（database.js 啟動時會補建），
// SELECT 失敗時沿用舊行為：直接回預設值。
async function getSettings(db = getDb()) {
  const settings = { ...SETTING_DEFAULTS, ...CAP_DEFAULTS };
  try {
    const { rows } = await db.query('SELECT key, value, value_num FROM agent_settings');
    for (const r of rows) {
      if (SETTING_KEYS.includes(r.key)) settings[r.key] = r.value === true || r.value === 't';
      else if (CAP_KEYS.includes(r.key)) {
        const n = Number(r.value_num);
        settings[r.key] = Number.isFinite(n) && n >= 0 ? n : CAP_DEFAULTS[r.key];
      }
    }
  } catch (err) {
    console.error('[AGENT] getSettings failed, using defaults:', err.message);
  }
  return settings;
}

// 更新開關／上限（只接受已知 key；開關限布林值，上限限非負數字；未知 key 直接 400 概念：丟錯）
async function updateSettings(db, patch) {
  const keys = Object.keys(patch || {});
  for (const k of keys) {
    if (SETTING_KEYS.includes(k)) {
      if (typeof patch[k] !== 'boolean') throw new Error(`setting ${k} must be boolean`);
    } else if (CAP_KEYS.includes(k)) {
      if (typeof patch[k] !== 'number' || !Number.isFinite(patch[k]) || patch[k] < 0) {
        throw new Error(`setting ${k} must be a non-negative number`);
      }
    } else {
      throw new Error(`unknown setting: ${k}`);
    }
  }
  for (const k of keys) {
    if (CAP_KEYS.includes(k)) {
      // 上限是數字，存 value_num；value 欄位是 BOOLEAN NOT NULL，放 false 當佔位
      await db.query(
        `INSERT INTO agent_settings (key, value, value_num, updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value_num = EXCLUDED.value_num, updated_at = CURRENT_TIMESTAMP`,
        [k, false, patch[k]]
      );
    } else {
      await db.query(
        `INSERT INTO agent_settings (key, value, updated_at) VALUES ($1, $2, CURRENT_TIMESTAMP)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
        [k, patch[k]]
      );
    }
  }
  return getSettings(db);
}

// 單一功能是否可用：總開關壓過全部
function agentEnabled(settings, feature) {
  return settings.agent_master === true && settings[feature] === true;
}

// D 級按鈕停用原因（前端顯示用；null 表示可執行）
// 注意：D 級三道閘門是總開關＋最高權限開關＋逐筆點頭，不經過 agent_execution
//（B 白名單才看執行開關；D 級有自己的最高權限開關把關）。
function highPrivilegeDisabledReason(settings) {
  if (settings.agent_master !== true) return '總開關已關閉';
  if (settings.agent_high_privilege !== true) return '最高權限開關已關閉，請先開啟「最高權限（動錢／改設定／對外下單）」';
  return null;
}

// 當日已執行的動錢累計（只算今天鳳凰城 00:00 後、result='ok' 的 D 級動錢）
// 供每日上限檢查用；稽核 input_snapshot 裡的 amount 是當時批准的金額。
async function getTodayMoneySpent(db = getDb(), sinceISO = phoenixMidnightISO()) {
  const { rows } = await db.query(
    `SELECT input_snapshot FROM agent_audit_log
     WHERE action_type = ANY($1) AND result = 'ok' AND created_at >= $2`,
    [MONEY_ACTIONS, sinceISO]
  );
  let spent = 0;
  for (const r of rows) {
    try {
      const snap = typeof r.input_snapshot === 'string' ? JSON.parse(r.input_snapshot) : r.input_snapshot;
      const amt = Number(snap && snap.amount);
      if (Number.isFinite(amt) && amt > 0) spent += amt;
    } catch (e) { /* 快照損毀就跳過，不擋流程 */ }
  }
  return spent;
}

// 第 1 階段動錢 mock：不接 Stripe SDK、不碰金鑰、不發任何網路請求，
// 只回傳一段標明 mock 的模擬結果。真的金流要等第 2 階段 Stripe 原型。
function defaultMockExecutor(type, params) {
  const amount = Number(params.amount);
  const target = params.target || params.recipient || '未指定對象';
  switch (type) {
    case 'money_transfer':
      return { ok: true, mock: true, summary: `模擬轉帳已記錄（mock，未真的轉帳）：$${amount} → ${target}` };
    case 'pay_invoice':
      return { ok: true, mock: true, summary: `模擬付發票已記錄（mock，未真的付款）：$${amount} → ${target}` };
    case 'fx_convert':
      return { ok: true, mock: true, summary: `模擬換匯已記錄（mock，未真的換匯）：$${amount} → ${target}` };
    case 'place_external_order':
      return { ok: true, mock: true, summary: `對外下單已記錄待執行（mock，未真的對外下單）：$${amount} → ${target}` };
    default:
      throw new Error(`未實作的 D 級動作：${type}`);
  }
}

// D 級最高權限執行入口（server 端強制把關，與 executeAgentAction 分開）：
// - 非 D 級動作 → 直接擋下，只寫稽核，不執行
// - 三道閘門（總開關／最高權限開關）任一不通過 → 擋下寫稽核
// - 動錢類：金額無效 → 擋下；超過單筆上限（含上限 0）或當日累計超每日上限 → 擋下寫稽核
// - update_high_setting：指名清單目前為空，一律擋下
// - 執行前後重讀開關：執行中被關掉 → 中止，不留半成品（驗收 5）
// - 每筆請求不論成功、擋下、取消都寫稽核，approved_by=user
async function executeHighPrivilegeAction(type, params = {}, source = 'user', deps = {}) {
  const db = deps.db || getDb();
  const settings = await getSettings(db);
  const base = {
    action_type: type,
    account_id: params.account_id ?? null,
    ticker: params.ticker ?? null,
    page_id: params.page_id ?? null,
    alert_id: params.alert_id ?? null,
    settings_snapshot: settings,
    input_snapshot: params,
    approved_by: source === 'user' ? 'user' : 'auto',
  };

  // 非 D 級動作（或未知動作）：預設拒絕
  if (!HIGH_PRIVILEGE_ACTIONS.includes(type)) {
    await writeAudit(db, {
      ...base, result: 'blocked',
      output_summary: `非 D 級動作（${type}），已擋下，未執行`,
    });
    return { ok: false, blocked: true, error: `動作 ${type} 不在 D 級白名單，禁止執行` };
  }

  // 三道閘門（總開關／最高權限開關）
  const gateReason = highPrivilegeDisabledReason(settings);
  if (gateReason) {
    await writeAudit(db, { ...base, result: 'blocked', output_summary: `未執行：${gateReason}` });
    return { ok: false, blocked: true, reason: gateReason, error: gateReason };
  }

  // update_high_setting：指名清單為空，一律擋下
  if (type === 'update_high_setting') {
    await writeAudit(db, {
      ...base, result: 'blocked',
      output_summary: `改關鍵設定未開放（${params.key || '未指定設定'} 不在 D 級指名清單），已擋下，未執行`,
    });
    return { ok: false, blocked: true, error: '目前沒有開放以最高權限修改的設定' };
  }

  // 動錢類：金額必須是正數，否則擋下
  const amount = Number(params.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    await writeAudit(db, { ...base, result: 'invalid', output_summary: '未執行：金額必須是正數' });
    return { ok: false, invalid: true, error: '金額必須是正數' };
  }

  // 單筆上限（預設 0：任何金額都擋下）
  if (amount > settings.agent_money_cap_single) {
    await writeAudit(db, {
      ...base, result: 'blocked',
      output_summary: `未執行：金額 $${amount} 超過單筆上限 $${settings.agent_money_cap_single}`,
    });
    return { ok: false, blocked: true, error: `金額超過單筆上限 $${settings.agent_money_cap_single}` };
  }

  // 每日上限（當日已執行累計＋本筆）
  const spentToday = await getTodayMoneySpent(db);
  if (spentToday + amount > settings.agent_money_cap_daily) {
    await writeAudit(db, {
      ...base, result: 'blocked',
      output_summary: `未執行：當日累計 $${spentToday}＋本筆 $${amount} 超過每日上限 $${settings.agent_money_cap_daily}`,
    });
    return { ok: false, blocked: true, error: `當日累計超過每日上限 $${settings.agent_money_cap_daily}` };
  }

  // 執行（第 1 階段只接 mock）
  let execResult;
  try {
    const executor = deps.mockExecutor || defaultMockExecutor;
    execResult = await executor(type, params);
  } catch (err) {
    await writeAudit(db, { ...base, result: 'error', output_summary: `執行失敗：${err.message}` });
    return { ok: false, error: err.message };
  }

  // 執行後再檢查一次開關：執行中被關掉 → 中止，不留半成品
  const settingsNow = await getSettings(db);
  if (highPrivilegeDisabledReason(settingsNow)) {
    await writeAudit(db, {
      ...base, settings_snapshot: settingsNow, result: 'cancelled',
      output_summary: '執行中開關被關閉，已中止，未寫入執行結果',
    });
    return { ok: false, cancelled: true };
  }

  await writeAudit(db, { ...base, result: 'ok', output_summary: execResult.summary });
  return { ok: true, mock: true, summary: execResult.summary };
}

// 白名單按鈕停用原因（前端顯示用；null 表示可執行）
function actionDisabledReason(settings) {
  if (settings.agent_master !== true) return '總開關已關閉';
  if (settings.agent_execution !== true) return '執行開關已關閉，請先開啟「批准動作執行」';
  return null;
}

// 寫稽核紀錄（每次 agent 動作一筆）
async function writeAudit(db, entry) {
  const { rows } = await db.query(
    `INSERT INTO agent_audit_log
       (action_type, account_id, ticker, page_id, alert_id, settings_snapshot, input_snapshot, model, output_summary, approved_by, result)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      entry.action_type,
      entry.account_id ?? null,
      entry.ticker ?? null,
      entry.page_id ?? null,
      entry.alert_id ?? null,
      entry.settings_snapshot ? JSON.stringify(entry.settings_snapshot) : null,
      entry.input_snapshot ? JSON.stringify(entry.input_snapshot) : null,
      entry.model ?? null,
      entry.output_summary ?? null,
      entry.approved_by ?? 'auto',
      entry.result ?? null,
    ]
  );
  return rows[0].id;
}

// Ollama 連通探測（GET /api/tags，一次，不重試）
async function checkOllama() {
  try {
    await axios.get(`${OLLAMA_URL}/api/tags`, { timeout: 5000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Ollama 生成：最多重試一次（初次 + 1 次），超過就直接失敗，不硬編
async function callOllama(prompt, attempts = 2) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await axios.post(
        `${OLLAMA_URL}/api/generate`,
        { model: MODEL_NAME, prompt, stream: false },
        { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
      );
      if (res.data && res.data.response) return res.data.response;
      throw new Error('Ollama 回傳為空');
    } catch (err) {
      lastErr = err;
      const retryable = !err.response || err.response.status === 429 || (err.response.status >= 500 && err.response.status <= 599);
      if (retryable && i < attempts - 1) {
        console.warn(`[AGENT] Ollama 呼叫失敗，重試一次… (${err.message})`);
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

// 告警診斷：新告警產生後由呼叫端觸發（fire-and-forget，不擋主流程）。
// 失敗處理：Ollama 連不上 → 診斷缺件（不准用舊資料編一段）；
// 資料日期對不上觸發日 → 標示資料過期，不出診斷；
// 執行中開關被關掉 → 直接中止，不留半成品診斷。
async function diagnoseAlert(alertId, deps = {}) {
  const db = deps.db || getDb();
  const ollama = deps.callOllama || callOllama;
  const settings = await getSettings(db);

  const { rows } = await db.query(
    `SELECT a.*, acc.name AS account_name, acc.ticker, acc.cost_price, acc.last_price
     FROM fin_price_alerts a JOIN fin_accounts acc ON acc.id = a.account_id
     WHERE a.id = $1`,
    [alertId]
  );
  if (rows.length === 0) return { ok: false, error: 'Alert not found' };
  const alert = rows[0];
  if (alert.diagnosis_status === 'done') return { ok: true, already: true };

  const base = {
    action_type: 'diagnosis',
    account_id: alert.account_id,
    ticker: alert.ticker,
    alert_id: alert.id,
    settings_snapshot: settings,
    model: MODEL_NAME,
    approved_by: 'auto',
  };

  // 總開關或診斷開關關著：不產生診斷（驗收 1）
  if (!agentEnabled(settings, 'agent_diagnosis')) {
    const reason = settings.agent_master !== true ? '總開關已關閉' : '告警診斷開關已關閉';
    await db.query(`UPDATE fin_price_alerts SET diagnosis_status = 'skipped' WHERE id = $1`, [alertId]);
    await writeAudit(db, { ...base, result: 'skipped', output_summary: `未產生診斷：${reason}` });
    return { ok: false, skipped: true, reason };
  }

  // 最新 SEPA 體檢（新鮮度比對＋診斷上下文）
  const { rows: sepaRows } = await db.query(
    `SELECT check_date::text AS check_date, close, ma50, ma150, ma200, wma10, template
     FROM fin_sepa_checks WHERE account_id = $1 ORDER BY check_date DESC LIMIT 1`,
    [alert.account_id]
  );
  const sepa = sepaRows[0] || null;
  const triggerDate = phoenixDate(new Date(alert.triggered_at));

  // SEPA 類告警：資料日期對不上觸發日 → 標示資料過期，不出診斷
  if (String(alert.alert_type).startsWith('sepa_')) {
    if (!sepa || sepa.check_date !== triggerDate) {
      const have = sepa ? sepa.check_date : '無體檢紀錄';
      await db.query(`UPDATE fin_price_alerts SET diagnosis_status = 'stale' WHERE id = $1`, [alertId]);
      await writeAudit(db, {
        ...base,
        input_snapshot: { alert_type: alert.alert_type, triggered_date: triggerDate, sepa_check_date: have },
        result: 'stale',
        output_summary: `資料過期：最新體檢 ${have} 與觸發日 ${triggerDate} 不符，未產生診斷`,
      });
      return { ok: false, stale: true };
    }
  }

  const score = sepa && sepa.template
    ? ['t1','t2','t3','t4','t5','t6','t7','t8'].filter(k => (typeof sepa.template === 'string' ? JSON.parse(sepa.template) : sepa.template)[k] === true).length
    : null;
  const inputSnapshot = {
    alert_type: alert.alert_type,
    threshold: Number(alert.threshold),
    price_at_trigger: Number(alert.price_at_trigger),
    triggered_date: triggerDate,
    cost_price: Number(alert.cost_price || 0),
    last_price: Number(alert.last_price || 0),
    ma50: sepa ? Number(sepa.ma50) : null,
    ma150: sepa ? Number(sepa.ma150) : null,
    ma200: sepa ? Number(sepa.ma200) : null,
    wma10: sepa ? Number(sepa.wma10) : null,
    template_score: score,
  };

  const prompt = `你是一位股票技術面診斷助手。以下是一則剛觸發的股價告警，請用繁體中文寫一段 2-3 句的簡短診斷：說明發生了什麼、對照均線與 SEPA 模板狀態、接下來值得觀察什麼。不要給出買進或賣出建議，不要編造沒有提供的數字。\n\n帳戶：${alert.account_name}（${alert.ticker}）\n告警類型：${alert.alert_type}\n門檻價：${inputSnapshot.threshold}，觸發價：${inputSnapshot.price_at_trigger}，觸發日：${triggerDate}\n每股成本：${inputSnapshot.cost_price}，最新價：${inputSnapshot.last_price}\n50 日線：${inputSnapshot.ma50 ?? '—'}，150 日線：${inputSnapshot.ma150 ?? '—'}，200 日線：${inputSnapshot.ma200 ?? '—'}，10 週線：${inputSnapshot.wma10 ?? '—'}\nSEPA 模板分數：${score == null ? '—' : score + '/8'}`;

  let diagnosis;
  try {
    diagnosis = await ollama(prompt);
  } catch (err) {
    // Ollama 連不上：診斷直接缺件，不准用舊資料編一段（驗收 5）
    await db.query(`UPDATE fin_price_alerts SET diagnosis = NULL, diagnosis_status = 'missing' WHERE id = $1`, [alertId]);
    await writeAudit(db, {
      ...base, input_snapshot: inputSnapshot, result: 'error',
      output_summary: `診斷缺件：Ollama 連線失敗（${err.message}），未重試超過一次`,
    });
    return { ok: false, missing: true, error: err.message };
  }

  // 寫入前再檢查一次開關：執行中被關掉 → 直接中止，不留半成品診斷
  const settingsNow = await getSettings(db);
  if (!agentEnabled(settingsNow, 'agent_diagnosis')) {
    await db.query(`UPDATE fin_price_alerts SET diagnosis = NULL, diagnosis_status = 'cancelled' WHERE id = $1`, [alertId]);
    await writeAudit(db, {
      ...base, settings_snapshot: settingsNow, input_snapshot: inputSnapshot, result: 'cancelled',
      output_summary: '執行中開關被關閉，已中止，未寫入診斷',
    });
    return { ok: false, cancelled: true };
  }

  await db.query(
    `UPDATE fin_price_alerts SET diagnosis = $1, diagnosis_status = 'done' WHERE id = $2`,
    [diagnosis, alertId]
  );
  await writeAudit(db, {
    ...base, input_snapshot: inputSnapshot, result: 'ok',
    output_summary: String(diagnosis).slice(0, 200),
  });
  return { ok: true, diagnosis };
}

// 對外通知閘門：v1 只有站內告警，沒有對外通道；開關關著時一律不發送（驗收 3）
async function notifyExternal(event, deps = {}) {
  const db = deps.db || getDb();
  const settings = await getSettings(db);
  const base = {
    action_type: 'notification',
    account_id: event.account_id ?? null,
    ticker: event.ticker ?? null,
    alert_id: event.alert_id ?? null,
    settings_snapshot: settings,
    input_snapshot: { alert_type: event.alert_type ?? null },
    approved_by: 'auto',
  };
  if (!agentEnabled(settings, 'agent_notification')) {
    const reason = settings.agent_master !== true ? '總開關已關閉' : '對外通知開關已關閉';
    await writeAudit(db, { ...base, result: 'suppressed', output_summary: `未對外發送：${reason}` });
    return { sent: false, reason };
  }
  // 通知開關開著，但 v1 尚未接通任何對外通道（聊天室推播路徑待驗證）
  await writeAudit(db, { ...base, result: 'no_channel', output_summary: '通知開關已開，但 v1 無對外通道，未發送' });
  return { sent: false, reason: 'no_channel' };
}

// 每日健檢：資料庫、Ollama、SEPA 體檢新鮮度；正常只寫稽核不打擾
async function runHealthCheck(deps = {}) {
  const db = deps.db || getDb();
  const ollamaProbe = deps.checkOllama || checkOllama;
  const settings = await getSettings(db);
  const base = { action_type: 'health_check', settings_snapshot: settings, model: MODEL_NAME, approved_by: 'auto' };

  if (!agentEnabled(settings, 'agent_health_check')) {
    const reason = settings.agent_master !== true ? '總開關已關閉' : '每日健檢開關已關閉';
    await writeAudit(db, { ...base, result: 'skipped', output_summary: `健檢未執行：${reason}` });
    return { ok: false, skipped: true, reason };
  }

  const parts = [];
  let degraded = false;

  try {
    await db.query('SELECT 1');
    parts.push('資料庫正常');
  } catch (err) {
    degraded = true;
    parts.push(`資料庫異常（${err.message}）`);
  }

  const ollama = await ollamaProbe();
  if (ollama.ok) parts.push('Ollama 正常');
  else { degraded = true; parts.push(`Ollama 異常（${ollama.error || '連線失敗'}）`); }

  try {
    const { rows } = await db.query(`SELECT MAX(check_date::text) AS latest FROM fin_sepa_checks`);
    const latest = rows[0] && rows[0].latest;
    if (!latest) parts.push('SEPA 體檢：尚無紀錄');
    else {
      const ageDays = Math.round((new Date(phoenixDate()) - new Date(latest)) / 86400000);
      parts.push(ageDays <= 1 ? `SEPA 體檢最新（${latest}）` : `SEPA 體檢過期（最新 ${latest}）`);
      if (ageDays > 1) degraded = true;
    }
  } catch (err) {
    degraded = true;
    parts.push(`SEPA 體檢檢查失敗（${err.message}）`);
  }

  const result = degraded ? 'degraded' : 'ok';
  await writeAudit(db, { ...base, result, output_summary: parts.join('；') });
  return { ok: !degraded, result, summary: parts.join('；') };
}

// 產生一次 advisor 報告（與 POST /api/financials/advisor 共用同一實作）
async function generateAdvisorReport(deps = {}) {
  const db = deps.db || getDb();
  const analyze = deps.analyzeFinancialPortfolio || require('./gemini').analyzeFinancialPortfolio;
  const { rows: accounts } = await db.query('SELECT * FROM fin_accounts');
  const { rows: demands } = await db.query('SELECT * FROM fin_cash_demands');
  const { rows: marketContexts } = await db.query(`
    SELECT r.crawled_at, r.llm_response, p.name, p.url
    FROM results r JOIN pages p ON r.page_id = p.id
    ORDER BY r.crawled_at DESC LIMIT 10
  `);
  const advice = await analyze({ accounts, demands }, marketContexts);
  await db.query('INSERT INTO fin_ai_reports (analysis) VALUES ($1)', [advice]);
  return advice;
}

// 單檔重抓 Yahoo 股價（只更新該檔現價／市值／歷史，不觸發邊緣告警；
// 邊緣告警由每小時整點排程統一檢查，避免手動重抓重複洗版）
async function refetchOneStockPrice(accountId, deps = {}) {
  const db = deps.db || getDb();
  const { fetchYahooQuote, fetchFxRate } = deps.stock || require('./stock');
  const { rows } = await db.query('SELECT * FROM fin_accounts WHERE id = $1', [accountId]);
  if (rows.length === 0) throw new Error('Account not found');
  const acc = rows[0];
  if (!acc.ticker) throw new Error('Account has no ticker');
  const quote = await fetchYahooQuote(acc.ticker);
  if (!quote) throw new Error(`Yahoo 無法取得 ${acc.ticker} 現價`);
  let balance = quote.price * Number(acc.shares);
  if (quote.currency && quote.currency !== String(acc.currency).toUpperCase()) {
    const fx = await fetchFxRate(quote.currency, acc.currency);
    if (fx == null) throw new Error(`匯率無法取得 ${quote.currency}->${acc.currency}`);
    balance = balance * fx;
  }
  balance = Math.round(balance * 100) / 100;
  await db.query(
    'UPDATE fin_accounts SET balance = $1, last_price = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
    [balance, quote.price, acc.id]
  );
  await db.recordHistoryIfChanged(acc.id, balance);
  return { ticker: acc.ticker, price: quote.price, balance };
}

// 白名單動作執行入口（server 端強制把關）：
// - C 級或未知動作 → 直接擋下，只寫稽核，不執行（驗收 4）
// - 執行開關關著 → 拒絕，不排隊（驗收 2）
// - 只有五個 B 動作會真的執行，且一律寫稽核
async function executeAgentAction(type, params = {}, source = 'user', deps = {}) {
  const db = deps.db || getDb();
  const settings = await getSettings(db);
  const base = {
    action_type: type,
    account_id: params.account_id ?? null,
    ticker: params.ticker ?? null,
    page_id: params.page_id ?? null,
    alert_id: params.alert_id ?? null,
    settings_snapshot: settings,
    input_snapshot: params,
    approved_by: source === 'user' ? 'user' : 'auto',
  };

  // C 級禁止動作（或未知動作）：預設拒絕
  if (!WHITELIST_ACTIONS.includes(type)) {
    const known = BLOCKED_ACTIONS.includes(type);
    await writeAudit(db, {
      ...base, result: 'blocked',
      output_summary: known
        ? `C 級禁止動作（${type}），已擋下，未執行`
        : `未知動作（${type}）不在白名單，已擋下，未執行`,
    });
    return { ok: false, blocked: true, error: `動作 ${type} 不在白名單，禁止執行` };
  }

  // 執行開關把關
  const reason = actionDisabledReason(settings);
  if (reason) {
    await writeAudit(db, { ...base, result: 'disabled', output_summary: `未執行：${reason}` });
    return { ok: false, disabled: true, reason };
  }

  try {
    let summary = '';
    let data = null;
    switch (type) {
      case 'acknowledge_alert': {
        const { rowCount } = await db.query(
          'UPDATE fin_price_alerts SET acknowledged = TRUE WHERE id = $1', [params.alert_id]
        );
        if (rowCount === 0) throw new Error('Alert not found');
        summary = `已確認告警 #${params.alert_id}`;
        data = { alert_id: params.alert_id, acknowledged: true };
        break;
      }
      case 'rerun_sepa_check': {
        const runSepaCheck = deps.runSepaCheck || require('./sepa').runSepaCheck;
        const checked = await runSepaCheck();
        summary = `SEPA 體檢已重跑，${checked} 檔已檢查`;
        data = { checked };
        break;
      }
      case 'refetch_yahoo_price': {
        const r = await refetchOneStockPrice(params.account_id, { db, stock: deps.stock });
        summary = `${r.ticker} 現價已重抓：${r.price}`;
        data = r;
        break;
      }
      case 'rerun_page_crawl': {
        const { rows } = await db.query('SELECT * FROM pages WHERE id = $1', [params.page_id]);
        if (rows.length === 0) throw new Error('Page not found');
        const performCrawl = deps.performCrawl || require('./scheduler').performCrawl;
        const res = await performCrawl(rows[0].id, rows[0].url, rows[0].prompt);
        if (!res.success) throw new Error(res.error || 'Crawl failed');
        summary = `已重跑爬取：${rows[0].name || rows[0].url}`;
        data = { page_id: rows[0].id };
        break;
      }
      case 'generate_advisor_report': {
        const advice = await generateAdvisorReport({ db, analyzeFinancialPortfolio: deps.analyzeFinancialPortfolio });
        summary = 'AI 理財報告已產生';
        data = { analysis: advice };
        break;
      }
      default:
        throw new Error(`未實作的白名單動作：${type}`);
    }
    await writeAudit(db, { ...base, result: 'ok', output_summary: summary });
    return { ok: true, ...data };
  } catch (err) {
    await writeAudit(db, { ...base, result: 'error', output_summary: `執行失敗：${err.message}` });
    return { ok: false, error: err.message };
  }
}

module.exports = {
  SETTING_KEYS, SETTING_DEFAULTS, SETTING_LABELS,
  CAP_KEYS, CAP_DEFAULTS, CAP_LABELS,
  WHITELIST_ACTIONS, BLOCKED_ACTIONS,
  HIGH_PRIVILEGE_ACTIONS, MONEY_ACTIONS, HIGH_PRIVILEGE_SETTINGS,
  getSettings, updateSettings, agentEnabled, actionDisabledReason,
  highPrivilegeDisabledReason, getTodayMoneySpent,
  writeAudit, checkOllama, callOllama,
  diagnoseAlert, notifyExternal, runHealthCheck,
  generateAdvisorReport, refetchOneStockPrice, executeAgentAction,
  executeHighPrivilegeAction,
  phoenixDate, phoenixMidnightISO, MODEL_NAME,
};
