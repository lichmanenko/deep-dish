import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'));
const sha = process.env.GITHUB_SHA?.slice(0, 7) ?? 'local';

// base = путь GitHub Pages (репо deep-dish)
export default defineConfig({
  base: '/deep-dish/',
  define: {
    __APP_VER__: JSON.stringify(pkg.version),
    __APP_SHA__: JSON.stringify(sha),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      manifest: {
        id: '/',
        start_url: './',
        name: 'Deep Dish — дневник питания',
        short_name: 'Deep Dish',
        description: 'Домашний трекер питания и веса. Работает офлайн.',
        lang: 'ru',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#14171B',
        theme_color: '#14171B',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallback: 'index.html',
        // служебные страницы (витрины дизайна/лого) не перехватывать SPA-фолбэком — иначе iOS отдаёт онбординг
        navigateFallbackDenylist: [/^\/deep-dish\/design\//],
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,webmanifest}'],
        globIgnores: ['design/**'], // витрина палитр — не часть офлайн-приложения
      },
    }),
  ],
});
