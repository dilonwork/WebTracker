import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      host: true,
      port: 8080,
      proxy: {
        '/api': {
          target: `http://localhost:${env.BACKEND_PORT || 8081}`,
          changeOrigin: true
        }
      }
    }
  };
})
