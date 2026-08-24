import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'fs';

// B2：版本單一來源 — 從 package.json 注入 __APP_VERSION__，web 與桌面皆同源，發版只改 package.json
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// S3：CSP 縱深防禦。只在「打包」時注入（dev 的 HMR 需要 eval/ws，故不套用），
// 內嵌 script/style 需 'unsafe-inline'；ffmpeg.wasm（web 版）需 'wasm-unsafe-eval'
// 與 jsdelivr/unpkg/esm.sh CDN（script/connect/worker）；桌面本機資源只走主程序核發的
// subtool-local: capability URL，不再開放 renderer 直接讀 literal file:。
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://*.jsdelivr.net https://unpkg.com https://esm.sh",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: subtool-local: https://huggingface.co https://*.huggingface.co https://*.hf.co",
  "font-src 'self' data: subtool-local:",
  "media-src 'self' blob: data: subtool-local: http://127.0.0.1:* http://localhost:*",
  "connect-src 'self' blob: data: subtool-local: https://cdn.jsdelivr.net https://*.jsdelivr.net https://unpkg.com https://esm.sh https://huggingface.co https://*.huggingface.co https://*.hf.co https://cdn-lfs.huggingface.co https://cdn-lfs.hf.co https://api.groq.com https://api.openai.com https://generativelanguage.googleapis.com https://*.api.cognitive.microsoft.com https://dashscope.aliyuncs.com http://127.0.0.1:* http://localhost:*",
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
      onwarn(warning, defaultHandler) {
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
