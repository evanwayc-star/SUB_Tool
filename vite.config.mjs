import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 開發：vite（HMR）；打包：輸出單一可雙擊的 dist/index.html（含內嵌 JS/CSS）
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  server: { port: 8777, host: true },
  preview: { port: 8777, host: true },
  build: {
    outDir: 'dist',
    target: 'esnext',
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 4000,
  },
});
