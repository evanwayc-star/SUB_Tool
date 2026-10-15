import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const callers = new Map();
for (const name of readdirSync(join(root, 'src'), { recursive: true }).filter(name => name.endsWith('.js'))) {
  const code = readFileSync(join(root, 'src', name), 'utf8');
  for (const match of code.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*['"]((?:\.\.\/)+shared\/[^'"]+\.cjs)['"]/gu)) {
    const shared = basename(match[2]);
    if (!callers.has(shared)) callers.set(shared, []);
    callers.get(shared).push({ name, exports: match[1].split(',').map(value => value.trim().split(/\s+as\s+/u)[0]).filter(Boolean) });
  }
}

let server, cacheDir, origin;
beforeAll(async () => {
  cacheDir = mkdtempSync(join(realpathSync(tmpdir()), 'subtool-vite-shared-'));
  server = await createServer({ root, configFile: join(root, 'vite.config.mjs'), cacheDir,
    server: { host: '127.0.0.1', port: 0, strictPort: false, preTransformRequests: false }, logLevel: 'silent' });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
});
afterAll(async () => {
  try { await server?.close(); }
  finally {
    if (cacheDir) {
      expect(dirname(cacheDir)).toBe(realpathSync(tmpdir()));
      expect(basename(cacheDir)).toMatch(/^subtool-vite-shared-/u);
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }
});

describe('真實 Vite 開發伺服器的共用 CJS 規則', () => {
  it.each([...callers])('%s 的 renderer caller 取得與 main 相同的規則', async (shared, imports) => {
    let optimizedUrl;
    for (const caller of imports) {
      const response = await fetch(`${origin}/src/${caller.name.replaceAll('\\', '/')}`);
      expect(response.ok).toBe(true);
      const code = await response.text();
      expect(code).not.toMatch(new RegExp(`from\\s*['"][^'"]*/shared/${shared.replaceAll('.', '\\.')}(?:\\?import)?['"]`, 'u'));
      optimizedUrl = [...code.matchAll(/from\s*["']([^"']+)["']/gu)]
        .map(match => match[1]).find(url => url.includes('subtool-shared') && url.includes(shared.slice(0, -4)));
      expect(optimizedUrl, caller.name).toBeTruthy();
    }
    // 讀取實際預打包輸出，確認 CJS interop 不只是改寫了 URL。
    const response = await fetch(origin + optimizedUrl);
    expect(response.ok).toBe(true);
    await response.text();
    const metadata = JSON.parse(readFileSync(join(cacheDir, 'deps', '_metadata.json'), 'utf8'));
    const optimized = metadata.optimized[`@subtool-shared/${shared}`];
    expect(optimized).toBeDefined();
    const actual = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      const output = await import(process.argv[1]);
      const rules = output.default ?? output;
      console.log(JSON.stringify({ types: Object.fromEntries(Object.entries(rules).map(([key,value]) => [key,typeof value])),
        clipLength: rules.clipLength?.({in:1,out:5,speed:2}), frameRate: rules.exactDeliveryFrameRate?.(29.97) }));
    `, pathToFileURL(resolve(cacheDir, 'deps', optimized.file)).href], { encoding: 'utf8', windowsHide: true, timeout: 10000 }));
    const main = require(join(root, 'shared', shared));
    expect(Object.keys(actual.types).sort()).toEqual(Object.keys(main).sort());
    for (const caller of imports) for (const name of caller.exports) {
      expect(main).toHaveProperty(name);
      expect(actual.types[name]).toBe(typeof main[name]);
    }
    if (shared === 'clip-fade.cjs') expect(actual.clipLength).toBe(main.clipLength({ in: 1, out: 5, speed: 2 }));
    if (shared === 'delivery-frame-rate.cjs') expect(actual.frameRate).toBe(main.exactDeliveryFrameRate(29.97));
  });
});
