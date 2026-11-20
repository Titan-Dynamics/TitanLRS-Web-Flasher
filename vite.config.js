import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'
import { VitePWA } from 'vite-plugin-pwa'
import babel from 'vite-plugin-babel'

// Custom-element tags defined by the ported firmware panels in src/dashboard/. Vue must leave
// them alone. Matched by exact name (never a blanket "contains a dash" rule, which would eat
// Vuetify's own components).
const DASHBOARD_ELEMENTS = new Set([
  'info-panel', 'binding-panel', 'tx-options-panel', 'rx-options-panel',
  'buttons-panel', 'models-panel', 'connections-panel', 'serial-panel',
  'file-drop',
])

// https://vitejs.dev/config/
export default defineConfig({
  appType: 'mpa',
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => DASHBOARD_ELEMENTS.has(tag),
        },
      },
    }),
    vuetify(),
    // The ported Lit panels use 2023-05 decorators (`@customElement`, `@state() accessor`),
    // matching the firmware web UI's own build (TitanLRS/src/html/vite.config.js).
    babel({
      filter: /src[\\/]dashboard[\\/].*\.js$/,
      babelConfig: {
        babelrc: false,
        configFile: false,
        plugins: [['@babel/plugin-proposal-decorators', { version: '2023-05' }]],
      },
    }),
    VitePWA({
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        runtimeCaching: [
          {
            // Cache firmware files for a device once they are requested the first time
            // This allows building again when being offline
            urlPattern: /\/assets\/backpack\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'firmwares',
              expiration: {
                maxEntries: 50,
              },
            },
          },
          {
            // Firmware files from the TitanLRS R2 bucket (src/js/firmwareSource.js). Each lives
            // under a release version or master commit folder, so never changes: cache on first use
            // for offline builds, as above.
            urlPattern: /^https:\/\/pub-6e0300ebcda2424ebd2f0d524bdb7d0f\.r2\.dev\/.*\.bin$/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'firmwares-r2',
              expiration: {
                maxEntries: 50,
              },
            },
          },
          {
            // The R2 version lists (releases/index.json, master/latest.json) change with every
            // publish: always ask the network, fall back to the last copy offline.
            urlPattern: /^https:\/\/pub-6e0300ebcda2424ebd2f0d524bdb7d0f\.r2\.dev\/.*\.json$/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'firmware-index-r2',
            },
          },
          {
            // Cache fonts
            urlPattern: /\/assets\/.*\.(ttf|eot|woff|woff2)/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'fonts',
              expiration: {
                maxEntries: 50,
              },
            },
          },
        ],
      },
      // These files will always be available offline
      includeAssets: [
        'favicon.webp',
        'apple-touch-icon.png',
        'mask-icon.svg',
        'assets/backpack/index.json',
        'assets/backpack/**/targets.json',
      ],
      manifest: {
        name: 'TitanLRS Web Flasher',
        short_name: 'TitanLRS Flasher',
        description: 'Web-hosted flasher for TitanLRS firmware',
        theme_color: '#4a88ab',
        display_override: ['window-controls-overlay', 'standalone', 'browser'],
        icons: [
          {
            src: 'pwa-64x64.png',
            sizes: '64x64',
            type: 'image/png'
          },
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ],
      },
    })
  ],
  base: './'
})
