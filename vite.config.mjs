import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'fs';

// B2：版本單一來源 — 從 package.json 注入 __APP_VERSION__，web 與桌面皆同源，發版只改 package.json
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

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

function crossOriginIsolation() {
  return {
    name: 'cross-origin-isolation',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    }
  };
}

// 開發：vite（HMR）；打包：輸出單一可雙擊的 dist/index.html（含內嵌 JS/CSS）
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [injectCSP(), viteSingleFile(), crossOriginIsolation()],
  server: { 
    port: 8777, 
    host: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  preview: { 
    port: 8777, 
    host: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp'
    }
  },
  build: {
    outDir: 'dist',
    target: 'esnext',
    cssCodeSplit: false,
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      /* AGENTS.md §7 說「npm run build 抓『import 了某模組未 export 的名稱』」——
         但 rollup 對這件事預設【只警告不失敗】，build 照樣 exit 0，於是那道防線
         其實是空的。

         真實事故：移除 subio.js 的 exportSub 之後，app.js 仍留著它的 import。
         lint 過（no-undef 認得 import 進來的名稱）、build 也過（只印了一行 warning
         就被 tail 吃掉），三關全綠但那是一個在原生 ESM 下會直接 SyntaxError 的錯誤。

         這裡把它升級成硬失敗。清單只收「一定是錯」的那幾種，不做風格檢查。 */
      onwarn(warning, defaultHandler) {
        /* 只收「一定是錯」的兩種，不做風格檢查。
           CIRCULAR_DEPENDENCY 刻意【不】列入：目前已知有一組 ui.js ↔ media.js
           的既有循環（ui.js 只為了讀 Media.mpvMode 決定開 modal 時要不要讓開 mpv），
           把它升級成致命會讓 build 卡在一個與本次改動無關的舊問題上。
           要解的話是把它改成事件（emit('mpv:sync')），那是另一件事。 */
        const FATAL = new Set([
          'MISSING_EXPORT',        // import 了對方沒有 export 的名稱
          'UNRESOLVED_IMPORT',     // import 的模組根本不存在
        ]);
        if (FATAL.has(warning.code)) {
          throw new Error(`[build 阻擋] ${warning.code}：${warning.message}`);
        }
        defaultHandler(warning);
      },
    },
  },
});




