import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createLocalResourceServer } = require('../electron/local-resource.js');

function makeServer(pathModule) {
  let sequence = 0;
  return createLocalResourceServer({
    fileAuthority: { canExposeFileURL: () => true },
    protocolModule: { handle() {} },
    sessionModule: { defaultSession: { webRequest: { onBeforeRequest() {} } } },
    pathModule,
    randomBytes: size => Buffer.alloc(size, ++sequence),
  });
}

describe('本機資源 URL identity', () => {
  it('production entry 缺失時顯示可操作錯誤，不回退到無法解析的 Vite source index', async () => {
    const loads = [];
    const server = createLocalResourceServer({
      fileAuthority: { canExposeFileURL: () => true },
      protocolModule: { handle() {} },
      sessionModule: { defaultSession: { webRequest: { onBeforeRequest() {} } } },
      fsModule: { existsSync: () => false },
    });

    await server.loadApplicationDocument({
      loadFile: file => loads.push(['file', file]),
      loadURL: value => loads.push(['url', value]),
    }, 'C:\\SUB_Tool\\dist\\index.html');

    expect(loads).toHaveLength(1);
    expect(loads[0][0]).toBe('url');
    expect(decodeURIComponent(loads[0][1])).toContain('npm run build');
  });

  it('Windows 大小寫路徑共用 identity，但 macOS/POSIX 大小寫路徑保持不同', () => {
    const windows = makeServer(path.win32);
    expect(windows.urlFor('C:\\Media\\MASTER.MOV'))
      .toBe(windows.urlFor('c:\\media\\master.mov'));

    const posix = makeServer(path.posix);
    expect(posix.urlFor('/Volumes/Media/MASTER.MOV'))
      .not.toBe(posix.urlFor('/Volumes/Media/master.mov'));
  });

  it('token 核發後若 capability 不再成立，下一次 protocol 讀取立即拒絕', async () => {
    let allowed = true;
    let handler;
    const server = createLocalResourceServer({
      fileAuthority: { canExposeFileURL: () => allowed },
      protocolModule: { handle: (scheme, next) => { handler = next; } },
      sessionModule: { defaultSession: { webRequest: { onBeforeRequest() {} } } },
      pathModule: path.win32,
      randomBytes: size => Buffer.alloc(size, 7),
    });
    server.install();
    const resourceURL = server.urlFor('C:\\Media\\MASTER.MOV');

    allowed = false;

    const response = await handler(new Request(resourceURL));
    expect(response.status).toBe(404);
  });
});
