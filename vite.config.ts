import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const port = Number(env.FRONTEND_PORT);
  return {
    plugins: [react()],
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
