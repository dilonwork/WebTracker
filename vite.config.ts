import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { webTrackerAuthPlugin } from './vite-plugin-auth.js'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = Number(env.FRONTEND_PORT);
  return {
    // 登入保護：未登入的頁面請求一律導向 /login.html（/api 由後端再驗一次）；
    // 沒設 WEBTRACKER_AUTH_SECRET 時插件不啟用（後端啟動檢查會先擋下）。
    plugins: [react(), webTrackerAuthPlugin(env.WEBTRACKER_AUTH_SECRET)],
    server: {
      host: true,
      port,
      proxy: {
        '/api': {
          target: `http://localhost:${env.BACKEND_PORT}`,
          changeOrigin: true
        }
      }
    }
  };
})
