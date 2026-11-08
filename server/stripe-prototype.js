// Stripe Treasury MCP 原型（第 2 階段，server/stripe-prototype.js）
// 獨立模組：不接 D 級正式入口、不寫資料庫、不動 agent.js 的開關與白名單邏輯、
// 不加使用者面向的按鈕。原型只留 server 端＋單元測試。
//
// 背景（2026-11-08 上網查 Stripe 官方文件核對，見 README 原型一節）：
// - Stripe MCP server 由 Stripe 託管，網址 https://mcp.stripe.com/mcp（Remote，Streamable HTTP，JSON-RPC）。
// - Treasury for agents（2026-10-21 公告，公開預覽）：5 個 Treasury 專用工具，
//   get_balance_summary（唯讀）＋ convert_currency、send_money、setup_recipient、
//   transfer_money（動錢），各有具名權限；預設動真錢都要人工審核批准。
//   注意：付發票沒有 Treasury 專用工具，付發票走一般 MCP 工具 pay_invoice。
// - 認證只剩兩種：OAuth（互動式）與 Agent API key（自主式，Dashboard 上的 restricted key
//   勾選 Agent 用途，帶 Agent 標籤）。2026-11-30 前要遷移；12 月起 MCP 不再接受
//   full-access secret key 與未帶 Agent 標籤的 restricted key，違者回 401。
// - Agent 卡片發放與 agent 支出上限當時尚未上線（Stripe 說「即將推出」）。
//
// 本原型的 transport 設計：
// - 沒金鑰 → mock transport：不對外發任何請求，所有結果標示 mock／測試模式。
// - 有金鑰（環境變數 STRIPE_AGENT_API_KEY）→ live transport：走 MCP JSON-RPC
//   tools/call 打 mcp.stripe.com，Bearer 帶 Agent key。金鑰只從環境變數讀，
//   絕不寫進 repo、前端、稽核、log 或回傳結果；錯誤訊息裡也不出現金鑰。
// - 動錢類操作一律要求 confirmed === true（人工確認），沒確認就拒絕，
//   這是 Stripe 預設要求＋我們 D 級三道閘門的第二層，兩層都不能少。
// - 金鑰命名用 STRIPE_AGENT_API_KEY（Agent 標籤 key），不用 STRIPE_SECRET_KEY：
//   full secret key 12 月起會被 MCP 拒絕。
const axios = require('axios');

const MCP_URL = 'https://mcp.stripe.com/mcp';
const ENV_KEY_NAME = 'STRIPE_AGENT_API_KEY';

// Treasury 專用工具（公開預覽）＋付發票走的一般 MCP 工具
const TREASURY_TOOLS = [
  'get_balance_summary', // 唯讀
  'convert_currency',
  'send_money',
  'setup_recipient',
  'transfer_money',
];
const GENERAL_TOOLS = ['pay_invoice']; // 非 Treasury 專用，走一般 MCP 工具

function isLiveMode() {
  return Boolean(process.env[ENV_KEY_NAME]);
}

function getStatus() {
  return {
    mode: isLiveMode() ? 'live' : 'mock',
    hasKey: isLiveMode(),
    mcpUrl: MCP_URL,
    auth: isLiveMode() ? 'agent-api-key' : 'none',
    treasuryTools: [...TREASURY_TOOLS],
    generalTools: [...GENERAL_TOOLS],
    // 金鑰狀態只報有無，絕不回傳金鑰值
    note: isLiveMode()
      ? '已讀到 Agent 金鑰（環境變數），live transport 可用；仍只走測試模式帳戶，動錢每筆都要人工確認'
      : '未讀到 STRIPE_AGENT_API_KEY，走 mock transport，不對外發請求',
  };
}

// ---- 驗證（擋下前先驗，驗不過就不發請求）----
function validAmount(amount) {
  return typeof amount === 'number' && Number.isFinite(amount) && amount > 0;
}
function validCurrency(currency) {
  return typeof currency === 'string' && /^[A-Za-z]{3}$/.test(currency);
}
function checkMoneyArgs(args) {
  if (!args || typeof args !== 'object') return '缺少參數';
  if (!validAmount(args.amount)) return '金額必須是正數';
  if (args.currency !== undefined && !validCurrency(args.currency)) return '幣別必須是三碼代碼（例如 USD）';
  return null;
}

// ---- mock transport（沒金鑰時的預設）----
function mockResult(tool, args) {
  const base = {
    ok: true,
    mock: true,
    mode: 'mock',
    tool,
    note: '模擬結果，未真的動錢、未連 Stripe（測試模式）',
  };
  if (tool === 'get_balance_summary') {
    return {
      ...base,
      data: {
        currency: 'USD',
        stripe_balance_available: 12500,
        treasury_accounts: [{ name: 'Treasury 主帳戶（模擬）', balance: 8000, currency: 'USD' }],
      },
    };
  }
  return { ...base, data: { ...args, status: 'simulated', executed: false } };
}

// ---- live transport（MCP JSON-RPC tools/call；httpPost 可注入，測試用假的）----
async function defaultHttpPost(url, body, headers) {
  const res = await axios.post(url, body, { headers, timeout: 15000 });
  return { status: res.status, data: res.data };
}

async function callMcpTool(tool, args, deps = {}) {
  const httpPost = deps.httpPost || defaultHttpPost;
  const key = process.env[ENV_KEY_NAME];
  if (!key) return { ok: false, error: '未設定 STRIPE_AGENT_API_KEY，無法連 Stripe MCP' };
  const body = {
    jsonrpc: '2.0',
    id: `webtracker-${Date.now()}`,
    method: 'tools/call',
    params: { name: tool, arguments: args || {} },
  };
  let res;
  try {
    res = await httpPost(MCP_URL, body, {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${key}`,
    });
  } catch (err) {
    // 金鑰絕不出現在錯誤訊息裡
    const status = err.response && err.response.status;
    if (status === 401) {
      return { ok: false, error: 'Stripe MCP 認證失敗（401）：請改用 Agent 標籤金鑰或 OAuth（12 月起 full secret key 與未帶 Agent 標籤的 key 不再接受）' };
    }
    return { ok: false, error: `連線 Stripe MCP 失敗：${err.message}` };
  }
  if (res.status === 401) {
    return { ok: false, error: 'Stripe MCP 認證失敗（401）：請改用 Agent 標籤金鑰或 OAuth（12 月起 full secret key 與未帶 Agent 標籤的 key 不再接受）' };
  }
  const payload = res.data;
  if (payload && payload.error) {
    return { ok: false, error: `Stripe MCP 回傳錯誤：${payload.error.message || JSON.stringify(payload.error)}` };
  }
  const result = payload && payload.result;
  return { ok: true, mock: false, mode: 'live', tool, data: result };
}

// ---- 對外入口：先驗證 → 沒金鑰走 mock → 有金鑰走 live ----
async function runTool(tool, args = {}, deps = {}) {
  const allTools = [...TREASURY_TOOLS, ...GENERAL_TOOLS];
  if (!allTools.includes(tool)) return { ok: false, error: `未知工具（${tool}）不在原型清單` };
  if (tool !== 'get_balance_summary') {
    const argErr = checkMoneyArgs(args);
    if (argErr) return { ok: false, error: argErr };
  }
  if (tool === 'pay_invoice' && (args.invoiceId === undefined || args.invoiceId === '')) {
    return { ok: false, error: '付發票需要 invoiceId' };
  }
  if (!isLiveMode()) return mockResult(tool, args);
  return callMcpTool(tool, args, deps);
}

// 唯讀：查帳、查餘額（對應 MCP get_balance_summary；不用人工確認）
async function getBalanceSummary(deps = {}) {
  return runTool('get_balance_summary', {}, deps);
}

// 動錢：每筆都要 confirmed === true（人工確認），否則拒絕、不發請求
async function transferMoney(args, deps = {}) {
  if (!args || args.confirmed !== true) return { ok: false, error: '動錢需要人工確認（confirmed 必須為 true）' };
  return runTool('transfer_money', args, deps);
}
async function sendMoney(args, deps = {}) {
  if (!args || args.confirmed !== true) return { ok: false, error: '動錢需要人工確認（confirmed 必須為 true）' };
  return runTool('send_money', args, deps);
}
async function convertCurrency(args, deps = {}) {
  if (!args || args.confirmed !== true) return { ok: false, error: '動錢需要人工確認（confirmed 必須為 true）' };
  if (!args.fromCurrency || !args.toCurrency) return { ok: false, error: '換匯需要 fromCurrency 與 toCurrency' };
  return runTool('convert_currency', args, deps);
}
async function setupRecipient(args, deps = {}) {
  if (!args || args.confirmed !== true) return { ok: false, error: '動錢需要人工確認（confirmed 必須為 true）' };
  if (!args.name) return { ok: false, error: '設定收款人需要 name' };
  return runTool('setup_recipient', args, deps);
}
async function payInvoice(args, deps = {}) {
  if (!args || args.confirmed !== true) return { ok: false, error: '動錢需要人工確認（confirmed 必須為 true）' };
  return runTool('pay_invoice', args, deps);
}

module.exports = {
  MCP_URL,
  ENV_KEY_NAME,
  TREASURY_TOOLS,
  GENERAL_TOOLS,
  isLiveMode,
  getStatus,
  getBalanceSummary,
  transferMoney,
  sendMoney,
  convertCurrency,
  setupRecipient,
  payInvoice,
  runTool,
  mockResult,
  callMcpTool,
};
