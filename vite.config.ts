import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 相对路径产物：部署到任意子路径/域名都能直接跑
  base: './',
  server: {
    // 开发时前端 5173、接口 8787；生产由 Node 同源托管
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    chunkSizeWarningLimit: 1200,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // 沙箱环境下 threads 池会争抢临时目录导致个别测试文件被静默跳过，
    // 改用 forks 并串行，结果稳定。
    pool: 'forks',
    fileParallelism: false,
  },
})
