import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 云端版：网页只是界面，登录、AI 转发、实时推送、操作、截图都由云端 Homi 服务处理。
 * 本机开发时 npm run dev 会同时启动一个本机的 Homi 服务（localhost:8787），这里把请求转过去。
 */
const HOMI = 'http://localhost:8787'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5181,
    // 只监听本机
    host: 'localhost',
    proxy: {
      '/auth': HOMI,
      '/ai-api': HOMI,
      '/api': HOMI,
      '/openapi-api': HOMI,
    },
  },
})
