import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// S3：CSP 縱深防禦。只在「打包」時注入（dev 的 HMR 需要 eval/ws，故不套用），
// 內嵌 script/style 需 'unsafe-inline'；ffmpeg.wasm（web 版）需 'wasm-unsafe-eval'
// 與 jsdelivr/unpkg CDN（script/connect/worker）；桌面/串流媒體需 file:、blob:、127.0.0.1。
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: file:",
  "font-src 'self' data:",
  "media-src 'self' blob: data: file: http://127.0.0.1:* http://localhost:*",
  "connect-src 'self' blob: data: https://cdn.jsdelivr.net https://unpkg.com http://127.0.0.1:* http://localhost:*",
  "worker-src 'self' blob:",
].join('; ');
function injectCSP() {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const tag = `<meta http-equiv="Content-Security-Policy" content="${CSP}">`;
      return html.replace('</title>', `</title>\n${tag}`);
    },
  };
}

// 開發：vite（HMR）；打包：輸出單一可雙擊的 dist/index.html（含內嵌 JS/CSS）
export default defineConfig({
  base: './',
  plugins: [injectCSP(), viteSingleFile()],
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
