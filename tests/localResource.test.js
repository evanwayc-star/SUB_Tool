import { createRequire } from 'node:module';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

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
  it('正式視窗只准自己的應用頁，封鎖 dev origin、其他內部頁與外部重導向', () => {
    const server = makeServer(path);
    const contents = new EventEmitter();
    contents.setWindowOpenHandler = vi.fn();
    const document = path.resolve('electron/queue.html');
    server.protectApplicationWindow({ webContents: contents }, { document });

    const allowed = { preventDefault: vi.fn() };
    contents.emit('will-navigate', allowed, `${pathToFileURL(document).href}#completed`);
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    for (const target of [pathToFileURL(path.resolve('dist/index.html')).href,
      'http://localhost:8777/', 'https://example.test/', 'data:text/html,<h1>other</h1>']) {
      for (const eventName of ['will-navigate', 'will-redirect']) {
        const event = { preventDefault: vi.fn() };
        contents.emit(eventName, event, target);
        expect(event.preventDefault).toHaveBeenCalledOnce();
      }
    }
    expect(contents.setWindowOpenHandler.mock.calls[0][0]({ url: 'https://example.test/' }))
      .toEqual({ action: 'deny' });
  });

  it('dev 導航以解析後的 origin 與 pathname 比對，不能用帳號或較長 port 偽造', async () => {
    const server = makeServer(path);
    const contents = new EventEmitter();
    contents.setWindowOpenHandler = vi.fn();
    const openExternal = vi.fn().mockResolvedValue();
    server.protectApplicationWindow({ webContents: contents }, {
      document: path.resolve('dist/index.html'), developmentURL: 'http://localhost:8777/', openExternal,
    });
    const allowed = { preventDefault: vi.fn() };
    contents.emit('will-navigate', allowed, 'http://localhost:8777/?dev=1#timeline');
    expect(allowed.preventDefault).not.toHaveBeenCalled();
    for (const target of ['http://localhost:8777@remote.test/', 'http://localhost:87770/',
      'http://localhost:8777/other.html', 'http://localhost:8777.evil.test/']) {
      const event = { preventDefault: vi.fn() };
      contents.emit('will-navigate', event, target);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    const open = contents.setWindowOpenHandler.mock.calls[0][0];
    expect(open({ url: 'https://example.test/help' })).toEqual({ action: 'deny' });
    expect(open({ url: 'file:///private.html' })).toEqual({ action: 'deny' });
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://example.test/help');
  });

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
