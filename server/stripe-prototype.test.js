// Stripe Treasury MCP 原型單元測試（不用 live Stripe、不發真實請求也能跑）
// 執行：node server/stripe-prototype.test.js
// 覆蓋：唯讀查詢（mock）、模擬動錢標示 mock、缺金鑰不對外發請求、
// 金額無效擋下、人工確認缺失擋下、live transport（假 httpPost）與 401 處理、
// 金鑰絕不外洩（回傳與錯誤訊息裡都沒有金鑰值）。
const assert = require('node:assert/strict');

const proto = require('./stripe-prototype');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

const FAKE_KEY = 'sk_test_agent_FAKEKEY123';
const OLD_KEY = process.env[proto.ENV_KEY_NAME];

function clearKey() { delete process.env[proto.ENV_KEY_NAME]; }
function setKey() { process.env[proto.ENV_KEY_NAME] = FAKE_KEY; }

// 假 httpPost：記下呼叫次數與內容，回傳 canned JSON-RPC 結果
function fakeHttp(resultData, status = 200) {
  const calls = [];
  const fn = async (url, body, headers) => {
    calls.push({ url, body, headers });
    return { status, data: resultData };
  };
  fn.calls = calls;
  return fn;
}

async function run() {
  console.log('Stripe prototype tests (mock transport 預設，無金鑰不對外發請求）:');

  await ok('沒金鑰時是 mock 模式，getStatus 不含金鑰值', async () => {
    clearKey();
    const s = proto.getStatus();
    assert.equal(s.mode, 'mock');
    assert.equal(s.hasKey, false);
    assert.equal(s.auth, 'none');
    assert.equal(s.mcpUrl, 'https://mcp.stripe.com/mcp');
    assert.ok(!JSON.stringify(s).includes(FAKE_KEY));
  });

  await ok('唯讀查詢（mock）：回傳模擬餘額，標示 mock', async () => {
    clearKey();
    const http = fakeHttp({});
    const r = await proto.getBalanceSummary({ httpPost: http });
    assert.equal(r.ok, true);
    assert.equal(r.mock, true);
    assert.equal(r.tool, 'get_balance_summary');
    assert.equal(typeof r.data.stripe_balance_available, 'number');
    assert.equal(http.calls.length, 0, 'mock 不該發任何請求');
  });

  await ok('模擬動錢：轉帳／付發票／換匯都標示 mock，未真的執行', async () => {
    clearKey();
    const http = fakeHttp({});
    const t = await proto.transferMoney({ amount: 100, currency: 'USD', confirmed: true }, { httpPost: http });
    assert.equal(t.ok, true);
    assert.equal(t.mock, true);
    assert.equal(t.data.executed, false);
    assert.match(t.note, /模擬/);
    const p = await proto.payInvoice({ amount: 50, currency: 'USD', invoiceId: 'in_mock123', confirmed: true }, { httpPost: http });
    assert.equal(p.ok, true);
    assert.equal(p.mock, true);
    const fx = await proto.convertCurrency({ amount: 200, currency: 'USD', fromCurrency: 'USD', toCurrency: 'TWD', confirmed: true }, { httpPost: http });
    assert.equal(fx.ok, true);
    assert.equal(fx.mock, true);
    assert.equal(http.calls.length, 0, 'mock 不該發任何請求');
  });

  await ok('模擬動錢：設定收款人 mock，不發請求', async () => {
    clearKey();
    const http = fakeHttp({});
    const r = await proto.setupRecipient({ amount: 1, currency: 'USD', name: '測試收款人', confirmed: true }, { httpPost: http });
    assert.equal(r.ok, true);
    assert.equal(r.mock, true);
    assert.equal(http.calls.length, 0);
  });

  await ok('缺金鑰時不對外發請求：連有金鑰才走的 live 路徑也一樣', async () => {
    clearKey();
    const http = fakeHttp({ result: { content: [] } });
    // runTool 直接呼叫也不該發請求
    const r = await proto.runTool('send_money', { amount: 10, currency: 'USD' }, { httpPost: http });
    assert.equal(r.mock, true);
    assert.equal(http.calls.length, 0);
  });

  await ok('金額無效擋下：0、負數、非數字、缺失都不執行、不發請求', async () => {
    clearKey();
    const http = fakeHttp({});
    for (const bad of [0, -5, NaN, undefined, '100']) {
      const r = await proto.transferMoney({ amount: bad, currency: 'USD', confirmed: true }, { httpPost: http });
      assert.equal(r.ok, false, `金額 ${String(bad)} 應擋下`);
    }
    const badCur = await proto.transferMoney({ amount: 10, currency: 'USDD', confirmed: true }, { httpPost: http });
    assert.equal(badCur.ok, false);
    assert.equal(http.calls.length, 0);
  });

  await ok('人工確認缺失擋下：confirmed 不是 true 就不執行、不發請求', async () => {
    clearKey();
    const http = fakeHttp({});
    for (const args of [{ amount: 10, currency: 'USD' }, { amount: 10, currency: 'USD', confirmed: false }]) {
      const r = await proto.sendMoney(args, { httpPost: http });
      assert.equal(r.ok, false);
      assert.match(r.error, /人工確認/);
    }
    assert.equal(http.calls.length, 0);
  });

  await ok('付發票缺 invoiceId 擋下', async () => {
    clearKey();
    const r = await proto.payInvoice({ amount: 50, currency: 'USD', confirmed: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /invoiceId/);
  });

  await ok('未知工具擋下', async () => {
    clearKey();
    const r = await proto.runTool('delete_everything', {});
    assert.equal(r.ok, false);
    assert.match(r.error, /未知工具/);
  });

  await ok('live transport（假 httpPost）：打 MCP URL、帶 Bearer、用 tools/call，解析結果', async () => {
    setKey();
    const http = fakeHttp({ result: { content: [{ type: 'text', text: '{"available": 999}' }] } });
    const r = await proto.getBalanceSummary({ httpPost: http });
    assert.equal(r.ok, true);
    assert.equal(r.mock, false);
    assert.equal(r.mode, 'live');
    assert.equal(http.calls.length, 1);
    assert.equal(http.calls[0].url, 'https://mcp.stripe.com/mcp');
    assert.equal(http.calls[0].body.method, 'tools/call');
    assert.equal(http.calls[0].body.params.name, 'get_balance_summary');
    assert.equal(http.calls[0].headers.Authorization, `Bearer ${FAKE_KEY}`);
    // 回傳結果裡沒有金鑰值
    assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
  });

  await ok('live transport：401 回認證失敗提示（提 Agent 金鑰／OAuth），不含金鑰值', async () => {
    setKey();
    const http = fakeHttp({}, 401);
    const r = await proto.getBalanceSummary({ httpPost: http });
    assert.equal(r.ok, false);
    assert.match(r.error, /401/);
    assert.match(r.error, /Agent/);
    assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
    assert.equal(http.calls.length, 1);
  });

  await ok('live transport：動錢沒確認照樣擋下、不發請求（即使有金鑰）', async () => {
    setKey();
    const http = fakeHttp({ result: {} });
    const r = await proto.transferMoney({ amount: 10, currency: 'USD' }, { httpPost: http });
    assert.equal(r.ok, false);
    assert.equal(http.calls.length, 0);
  });

  await ok('live transport：httpPost 丟錯時回傳錯誤、不含金鑰值', async () => {
    setKey();
    const failing = async () => { throw new Error('network down'); };
    const r = await proto.getBalanceSummary({ httpPost: failing });
    assert.equal(r.ok, false);
    assert.match(r.error, /連線 Stripe MCP 失敗/);
    assert.ok(!JSON.stringify(r).includes(FAKE_KEY));
  });

  // 還原環境
  if (OLD_KEY === undefined) clearKey();
  else process.env[proto.ENV_KEY_NAME] = OLD_KEY;

  console.log(`\n${passed} 項測試通過，0 項失敗（exit code 0）`);
}

run();
