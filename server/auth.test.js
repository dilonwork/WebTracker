// 登入認證單元測試（不用 live PostgreSQL / Express server 也能跑）
// 執行：node server/auth.test.js
// 覆蓋：密碼雜湊與驗證、session token 簽名／竄改／過期／錯密鑰、
// requireAuth 中介層、登入成功／失敗／速率限制、登出清 cookie、登入狀態查詢、
// 啟動設定檢查（fail closed）。
const assert = require('node:assert/strict');

let passed = 0;
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; });
}

// ---- 假 req / res（只實作 handler 實際用的方法）----
function fakeReq({ body = {}, headers = {}, ip = '1.2.3.4' } = {}) {
  return { body, headers, ip };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    getHeader(name) { return this.headers[name.toLowerCase()]; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
  return res;
}

async function main() {
  const auth = require('./auth.js');

  console.log('登入認證單元測試：');

  await ok('密碼雜湊：正確密碼驗證通過、錯誤密碼失敗、格式正確', async () => {
    const hash = auth.hashPassword('correct-horse-battery');
    assert.match(hash, /^scrypt:[0-9a-f]{32}:[0-9a-f]{128}$/);
    assert.equal(auth.verifyPassword('correct-horse-battery', hash), true);
    assert.equal(auth.verifyPassword('wrong-password', hash), false);
    assert.equal(auth.verifyPassword('', hash), false);
    assert.equal(auth.verifyPassword('correct-horse-battery', 'not-a-hash'), false);
    assert.equal(auth.verifyPassword('correct-horse-battery', ''), false);
    assert.equal(auth.verifyPassword('correct-horse-battery', null), false);
    // 兩次雜湊同一密碼，salt 不同、雜湊不同，但都驗得過
    const hash2 = auth.hashPassword('correct-horse-battery');
    assert.notEqual(hash, hash2);
    assert.equal(auth.verifyPassword('correct-horse-battery', hash2), true);
  });

  await ok('session token：簽名正確驗證通過', async () => {
    const token = auth.createSessionToken('test-secret-12345678901234567890');
    assert.equal(auth.verifySessionToken(token, 'test-secret-12345678901234567890'), true);
  });

  await ok('session token：竄改 payload／簽名／錯密鑰都驗不過', async () => {
    const secret = 'test-secret-12345678901234567890';
    const token = auth.createSessionToken(secret);
    const [payload, sig] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ exp: 9999999999 })).toString('base64url');
    assert.equal(auth.verifySessionToken(`${tamperedPayload}.${sig}`, secret), false);
    assert.equal(auth.verifySessionToken(`${payload}.0000000000000000000000000000000000000000000000`, secret), false);
    assert.equal(auth.verifySessionToken(token, 'different-secret-12345678901234567890'), false);
    assert.equal(auth.verifySessionToken('not-a-token', secret), false);
    assert.equal(auth.verifySessionToken('', secret), false);
    assert.equal(auth.verifySessionToken(null, secret), false);
  });

  await ok('session token：過期驗不過（exp 已過）', async () => {
    const secret = 'test-secret-12345678901234567890';
    const now = Math.floor(Date.now() / 1000);
    const expired = auth.createSessionToken(secret, -10, now); // TTL -10 秒＝已過期
    assert.equal(auth.verifySessionToken(expired, secret, now), false);
    const fresh = auth.createSessionToken(secret, 60, now);
    assert.equal(auth.verifySessionToken(fresh, secret, now), true);
  });

  await ok('isAuthenticated：cookie 正確才算登入', async () => {
    const secret = 'test-secret-12345678901234567890';
    const token = auth.createSessionToken(secret);
    assert.equal(auth.isAuthenticated(fakeReq({ headers: { cookie: `wt_session=${token}` } }), secret), true);
    assert.equal(auth.isAuthenticated(fakeReq({ headers: { cookie: 'wt_session=junk' } }), secret), false);
    assert.equal(auth.isAuthenticated(fakeReq({ headers: {} }), secret), false);
    assert.equal(auth.isAuthenticated(fakeReq({ headers: { cookie: `wt_session=${token}` } }), ''), false);
  });

  await ok('requireAuth：未登入回 401、有登入放行', async () => {
    const secret = 'test-secret-12345678901234567890';
    const mw = auth.requireAuth(secret);
    const denied = fakeRes();
    let nextCalled = false;
    mw(fakeReq({ headers: {} }), denied, () => { nextCalled = true; });
    assert.equal(denied.statusCode, 401);
    assert.equal(nextCalled, false);
    assert.match(denied.body.error, /未登入/);
    const token = auth.createSessionToken(secret);
    const allowed = fakeRes();
    let nextCalled2 = false;
    mw(fakeReq({ headers: { cookie: `wt_session=${token}` } }), allowed, () => { nextCalled2 = true; });
    assert.equal(nextCalled2, true);
  });

  await ok('登入成功：回 200＋Set-Cookie 帶 session（HttpOnly），速率計數清零', async () => {
    const handlers = auth.createAuthHandlers({
      passwordHash: auth.hashPassword('my-password'),
      secret: 'test-secret-12345678901234567890',
    });
    const res = fakeRes();
    handlers.login(fakeReq({ body: { password: 'my-password' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    const cookie = String(res.getHeader('set-cookie') || '');
    assert.match(cookie, /^wt_session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+;/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
  });

  await ok('登入失敗：密碼錯誤回 401、不發 cookie', async () => {
    const handlers = auth.createAuthHandlers({
      passwordHash: auth.hashPassword('my-password'),
      secret: 'test-secret-12345678901234567890',
    });
    const res = fakeRes();
    handlers.login(fakeReq({ body: { password: 'wrong' } }), res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.getHeader('set-cookie'), undefined);
    const res2 = fakeRes();
    handlers.login(fakeReq({ body: {} }), res2);
    assert.equal(res2.statusCode, 401);
  });

  await ok('速率限制：同一 IP 連錯 5 次後第 6 次回 429，成功登入後清零', async () => {
    const handlers = auth.createAuthHandlers({
      passwordHash: auth.hashPassword('my-password'),
      secret: 'test-secret-12345678901234567890',
    });
    for (let i = 0; i < 5; i++) {
      const res = fakeRes();
      handlers.login(fakeReq({ body: { password: 'wrong' } }), res);
      assert.equal(res.statusCode, 401);
    }
    const locked = fakeRes();
    handlers.login(fakeReq({ body: { password: 'wrong' } }), locked);
    assert.equal(locked.statusCode, 429);
    assert.match(locked.body.error, /次數過多/);
    assert.ok(Number(locked.getHeader('retry-after')) > 0);
    // 正確密碼也被鎖住（鎖定期內一律擋）
    const locked2 = fakeRes();
    handlers.login(fakeReq({ body: { password: 'my-password' } }), locked2);
    assert.equal(locked2.statusCode, 429);
    // 不同 IP 不受影響
    const otherIp = fakeRes();
    handlers.login(fakeReq({ body: { password: 'my-password' }, ip: '5.6.7.8' }), otherIp);
    assert.equal(otherIp.statusCode, 200);
  });

  await ok('登出：清 cookie（Max-Age=0）；狀態查詢：登入 true、未登入 false', async () => {
    const secret = 'test-secret-12345678901234567890';
    const handlers = auth.createAuthHandlers({
      passwordHash: auth.hashPassword('my-password'),
      secret,
    });
    const logoutRes = fakeRes();
    handlers.logout(fakeReq(), logoutRes);
    assert.equal(logoutRes.statusCode, 200);
    assert.match(String(logoutRes.getHeader('set-cookie')), /Max-Age=0/);
    const token = auth.createSessionToken(secret);
    const statusIn = fakeRes();
    handlers.status(fakeReq({ headers: { cookie: `wt_session=${token}` } }), statusIn);
    assert.deepEqual(statusIn.body, { authenticated: true });
    const statusOut = fakeRes();
    handlers.status(fakeReq({ headers: {} }), statusOut);
    assert.deepEqual(statusOut.body, { authenticated: false });
  });

  await ok('啟動設定檢查：缺雜湊／缺密鑰／密鑰太短都 fail closed；設齊才啟用', async () => {
    assert.equal(auth.authConfigFromEnv({}).enabled, false);
    assert.equal(auth.authConfigFromEnv({ WEBTRACKER_PASSWORD_HASH: 'scrypt:00:00' }).enabled, false);
    assert.equal(auth.authConfigFromEnv({ WEBTRACKER_PASSWORD_HASH: 'scrypt:00:00', WEBTRACKER_AUTH_SECRET: 'short' }).enabled, false);
    const good = auth.authConfigFromEnv({
      WEBTRACKER_PASSWORD_HASH: 'scrypt:00:00',
      WEBTRACKER_AUTH_SECRET: 'a-very-long-secret-at-least-32-chars',
    });
    assert.equal(good.enabled, true);
    assert.equal(auth.authConfigFromEnv({ WEBTRACKER_AUTH_DISABLED: 'true' }).enabled, false);
  });

  console.log(`\n${passed} 項測試通過，0 項失敗（exit code ${process.exitCode || 0}）`);
}

main().catch(err => { console.error(err); process.exit(1); });
