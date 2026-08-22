import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    // The dev proxy runs on the single edge port; /api is the management plane.
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})
