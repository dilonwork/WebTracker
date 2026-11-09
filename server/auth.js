// 登入認證（單一使用者密碼登入，不接 OAuth／第三方）。
// 設計原則：
// - 密碼絕不進 repo：只認環境變數 WEBTRACKER_PASSWORD_HASH，格式為
//   `scrypt:<salt hex>:<hash hex>`，用 scripts/gen-password-hash.js 產生。
// - Session 不存 server 端狀態：cookie 是 HMAC-SHA256 簽名的 token
//  （payload 只有到期時間），重啟服務不掉登入；簽名密鑰來自環境變數
//   WEBTRACKER_AUTH_SECRET（至少 32 字元），外洩等於偽造登入，請只放 .env。
// - 預設 fail closed：兩個環境變數缺一就拒絕啟動（除非明確設
//   WEBTRACKER_AUTH_DISABLED=true，本機開發專用，絕對不要在對外的 VM 上開）。
// - 登入有速率限制：同一 IP 15 分鐘內 5 次失敗就鎖 15 分鐘（回 429）。
// - VM 目前是 plain HTTP，Secure cookie 不能開（開了瀏覽器不送）；
//   密碼與 session 在傳輸中是明文，公開 Wi-Fi 下有被竊聽的風險，
//   建議下一步在 OCI 安全清單限縮來源 IP，或上 HTTPS。
// 依賴只有 Node 內建 crypto，不新增套件。
const crypto = require('crypto');

const COOKIE_NAME = 'wt_session';
const SESSION_TTL_SECONDS = 7 * 24 * 3600; // 7 天
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 分鐘

// ---- 密碼雜湊（scrypt）----
// 格式：scrypt:<salt hex>:<hash hex>；salt 16 bytes、key 64 bytes。
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (!salt.length || expected.length !== 64) return false;
    const actual = crypto.scryptSync(String(password || ''), salt, 64);
    return crypto.timingSafeEqual(actual, expected);
  } catch (err) {
    return false;
  }
}

// ---- Session token（HMAC 簽名，無狀態）----
// token = base64url(JSON {exp}).base64url(HMAC-SHA256(secret, payload))
function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function createSessionToken(secret, ttlSeconds = SESSION_TTL_SECONDS, nowSeconds = Math.floor(Date.now() / 1000)) {
  const payload = base64url(JSON.stringify({ exp: nowSeconds + ttlSeconds }));
  const sig = base64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

function verifySessionToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return false;
    const [payload, sig] = parts;
    const expected = base64url(crypto.createHmac('sha256', secret).update(payload).digest());
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return Number.isFinite(data.exp) && data.exp > nowSeconds;
  } catch (err) {
    return false;
  }
}

// ---- Cookie ----
function parseCookies(req) {
  const out = {};
  const header = (req && req.headers && req.headers.cookie) || '';
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function sessionCookieHeader(token, maxAgeSeconds = SESSION_TTL_SECONDS) {
  // Secure 不開：VM 是 plain HTTP，開了瀏覽器不會送 cookie（見檔頭說明）。
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookieHeader() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function isAuthenticated(req, secret) {
  if (!secret) return false;
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME], secret);
}

// ---- Express middleware：擋下未登入的 API 請求（回 401 JSON，不導頁）----
function requireAuth(secret) {
  return (req, res, next) => {
    if (isAuthenticated(req, secret)) return next();
    return res.status(401).json({ error: '未登入，請先登入' });
  };
}

// ---- 登入速率限制（in-memory，依 IP 計數；成功登入後清零）----
function createLoginRateLimiter({ maxFails = LOGIN_MAX_FAILS, windowMs = LOGIN_WINDOW_MS } = {}) {
  const attempts = new Map(); // ip -> { fails, resetAt }
  return {
    // 回傳 null 表示放行；回傳物件表示被鎖（帶剩餘秒數）
    check(ip) {
      const now = Date.now();
      const rec = attempts.get(ip);
      if (rec && rec.fails >= maxFails) {
        if (now < rec.resetAt) return { retryAfterSeconds: Math.ceil((rec.resetAt - now) / 1000) };
        attempts.delete(ip); // 鎖定期過了，清零重算
      }
      return null;
    },
    recordFailure(ip) {
      const now = Date.now();
      const rec = attempts.get(ip) || { fails: 0, resetAt: now + windowMs };
      if (now >= rec.resetAt) { rec.fails = 0; rec.resetAt = now + windowMs; }
      rec.fails += 1;
      attempts.set(ip, rec);
    },
    recordSuccess(ip) {
      attempts.delete(ip);
    },
    _size() { return attempts.size; },
  };
}

function clientIp(req) {
  // 直接對外（無反向代理）時 req.ip 就是來源 IP；有代理時以 X-Forwarded-For 第一筆為準。
  const fwd = req && req.headers && req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req && req.ip) || 'unknown';
}

// ---- Auth 路由處理器（factory，方便單元測試注入設定）----
function createAuthHandlers({ passwordHash, secret, rateLimiter = createLoginRateLimiter() }) {
  const login = (req, res) => {
    const ip = clientIp(req);
    const locked = rateLimiter.check(ip);
    if (locked) {
      res.setHeader('Retry-After', String(locked.retryAfterSeconds));
      return res.status(429).json({ error: `登入失敗次數過多，請 ${locked.retryAfterSeconds} 秒後再試` });
    }
    const password = req && req.body && req.body.password;
    if (!passwordHash || !verifyPassword(password, passwordHash)) {
      rateLimiter.recordFailure(ip);
      return res.status(401).json({ error: '密碼錯誤' });
    }
    rateLimiter.recordSuccess(ip);
    const token = createSessionToken(secret);
    res.setHeader('Set-Cookie', sessionCookieHeader(token));
    return res.json({ ok: true });
  };

  const logout = (req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookieHeader());
    return res.json({ ok: true });
  };

  const status = (req, res) => {
    return res.json({ authenticated: isAuthenticated(req, secret) });
  };

  return { login, logout, status };
}

// ---- 啟動檢查：fail closed ----
function authConfigFromEnv(env = process.env) {
  const disabled = String(env.WEBTRACKER_AUTH_DISABLED || '').toLowerCase() === 'true';
  const passwordHash = env.WEBTRACKER_PASSWORD_HASH || '';
  const secret = env.WEBTRACKER_AUTH_SECRET || '';
  if (disabled) return { enabled: false, reason: 'WEBTRACKER_AUTH_DISABLED=true（本機開發專用，絕對不要在對外 VM 上開）' };
  if (!passwordHash) return { enabled: false, reason: '缺少 WEBTRACKER_PASSWORD_HASH' };
  if (!secret || secret.length < 32) return { enabled: false, reason: '缺少 WEBTRACKER_AUTH_SECRET（至少 32 字元）' };
  return { enabled: true, passwordHash, secret };
}

module.exports = {
  COOKIE_NAME, SESSION_TTL_SECONDS, LOGIN_MAX_FAILS, LOGIN_WINDOW_MS,
  hashPassword, verifyPassword,
  createSessionToken, verifySessionToken,
  parseCookies, sessionCookieHeader, clearSessionCookieHeader,
  isAuthenticated, requireAuth,
  createLoginRateLimiter, clientIp, createAuthHandlers,
  authConfigFromEnv,
};
