import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: {
    strictPort: true,
    port: 1420,
    watch: { ignored: ['**/src-tauri/**'] }
  },
  build: { target: 'es2022' }
});
