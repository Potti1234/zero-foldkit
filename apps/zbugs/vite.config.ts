import '@dotenvx/dotenvx/config'
import { defineConfig } from 'vite'
import { foldkit } from '@foldkit/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { apiServerPlugin } from './server/vite-plugin.ts'

export default defineConfig({
  plugins: [tailwindcss(), apiServerPlugin(), foldkit()],
  server: {
    fs: {
      allow: ['../..'],
    },
  },
})
