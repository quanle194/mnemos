import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { configDefaults } from 'vitest/config'

// The dashboard talks to the API under `/api` (prefix stripped by the reverse proxy in production).
// In development the Vite dev server emulates that proxy; override the target with MNEMOS_DEV_API_TARGET.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.MNEMOS_DEV_API_TARGET || 'http://localhost:8000'
  const live = Boolean(process.env.MNEMOS_LIVE_API_URL)
  const proxy = {
    '/api': {
      target: apiTarget,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/api/, ''),
    },
  }
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { port: 5173, strictPort: false, proxy },
    preview: { port: 4173, proxy },
    build: {
      outDir: 'dist',
      // Source maps are opt-in for production images (MNEMOS_WEB_SOURCEMAP=true) to avoid shipping full sources.
      sourcemap: env.MNEMOS_WEB_SOURCEMAP === 'true',
      rollupOptions: {
        output: {
          // Long-lived vendor chunks: app deploys do not invalidate the framework cache.
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return undefined
            if (/node_modules\/(react|react-dom|scheduler|react-router)\//.test(id)) return 'vendor-react'
            if (/node_modules\/(@tanstack|zod|react-hook-form|@hookform)\//.test(id)) return 'vendor-data'
            if (/node_modules\/(@radix-ui|lucide-react|sonner)\//.test(id)) return 'vendor-ui'
            return 'vendor'
          },
        },
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      restoreMocks: true,
      // `*.live.test.tsx` drive the real app against a running API (npm run test:live); excluded otherwise.
      include: live ? ['src/**/*.live.test.{ts,tsx}'] : ['src/**/*.test.{ts,tsx}'],
      exclude: live ? configDefaults.exclude : [...configDefaults.exclude, 'src/**/*.live.test.{ts,tsx}'],
      testTimeout: live ? 90_000 : 5_000,
      fileParallelism: !live,
    },
  }
})
