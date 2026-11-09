// Vite 插件：開發伺服器（vite dev）與預覽伺服器（vite preview）的登入保護。
// 後端 Express 只擋 /api；前端頁面（SPA、靜態資源）由這裡擋：
// 未登入一律導向 /login.html；/login.html 與 /api/* 直接放行（/api 由後端再驗一次）。
// Session 驗證與後端共用同一份 server/auth.js、同一把 WEBTRACKER_AUTH_SECRET，
// 所以前端與後端不需要共享狀態，重啟也不掉登入。
// 注意：secret 由 vite.config.ts 經 loadEnv 傳進來；沒設 secret 時插件不啟用
//（後端啟動檢查會先擋下，所以正式環境不會出現無保護的狀態）。
const auth = require('./server/auth');

function createAuthMiddleware(secret) {
  return (req, res, next) => {
    const url = String(req.url || '').split('?')[0];
    if (url === '/login.html' || url.startsWith('/api/')) return next();
    if (auth.isAuthenticated(req, secret)) return next();
    res.writeHead(302, { Location: '/login.html' });
    res.end();
  };
}

function webTrackerAuthPlugin(secret) {
  if (!secret) return { name: 'webtracker-auth-disabled' };
  const middleware = createAuthMiddleware(secret);
  return {
    name: 'webtracker-auth',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

module.exports = { webTrackerAuthPlugin, createAuthMiddleware };
