import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';
import { JSDOM } from 'jsdom';

function visit(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (node.type) fn(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => visit(child, fn));
    else if (value && typeof value === 'object') visit(value, fn);
  }
}

describe('桌面驗收的設定隔離契約', () => {
  it('每支啟動獨立 profile 的 Electron 驗收都使用既有隔離旗標', () => {
    const launches = [];
    const mainTestLaunches = [];
    for (const directory of ['../scripts/acceptance/', './']) {
      const dir = new URL(directory, import.meta.url);
      for (const file of readdirSync(dir).filter(file => file.endsWith('.js'))) {
        const source = readFileSync(new URL(file, dir), 'utf8');
        visit(parse(source, { ecmaVersion: 'latest', sourceType: directory === './' ? 'module' : 'script' }), node => {
          if (node.type !== 'CallExpression' || node.callee.name !== 'spawn') return;
          const args = node.arguments[1];
          if (args?.type !== 'ArrayExpression') return;
          const texts = args.elements.filter(Boolean).map(arg => source.slice(arg.start, arg.end));
          if (!texts.some(text => text.includes('--user-data-dir='))) return;
          // 獨立 BrowserWindow fixture 不載入 main.js，也不使用正式 config owner。
          if (directory === './' && !texts.includes("'.'")) return;
          launches.push(file);
          if (directory === './') mainTestLaunches.push(file);
          expect(texts, file).toContain("'--subtool-transport-acceptance'");
        });
      }
    }
    expect(launches.length).toBeGreaterThanOrEqual(17);
    expect(mainTestLaunches.sort()).toEqual([
      'electronQueueLifecycle.test.js', 'electronQueueLifecycle.test.js', 'localResourceSecurity.test.js',
    ]);
  });

  it.each([
    [false, false, path.join('repo', '.config')],
    [false, true, path.join('profile', 'config')],
    [true, false, path.join('profile', 'config')],
  ])('實際主程序的 config owner：packaged=%s acceptance=%s', (packaged, acceptance, expected) => {
    const source = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
    const definition = parse(source, { ecmaVersion: 'latest' }).body
      .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'getConfigDir');
    const context = {
      app: { isPackaged: packaged, getPath: () => 'profile', getAppPath: () => 'repo' },
      IS_TRANSPORT_ACCEPTANCE: acceptance, path,
    };
    expect(vm.runInNewContext(`${source.slice(definition.start, definition.end)}; getConfigDir()`, context)).toBe(expected);
  });
});

describe('鎖定驗收的 fixture 與畫面觀察契約', () => {
  it('影片選取準備使用未鎖定片段，三個鎖定驗收目標仍保持鎖定', () => {
    const source = readFileSync(new URL('../scripts/acceptance/verify-locked-media-selection.js', import.meta.url), 'utf8');
    const ast = parse(source, { ecmaVersion: 'latest' });
    let fixtureSource;
    let selectionCases;
    let targets;
    visit(ast, node => {
      if (node.type === 'TemplateLiteral' && node.expressions.length === 0
          && node.quasis[0].value.cooked.includes('Object.assign(S.State')) {
        fixtureSource = node.quasis[0].value.cooked;
      }
      if (node.type === 'VariableDeclarator' && node.id.name === 'selectionCases') selectionCases = node.init;
      if (node.type === 'VariableDeclarator' && node.id.name === 'cases') targets = node.init;
    });
    expect(fixtureSource).toBeTypeOf('string');
    let fixtureNode;
    let lockedExternal;
    visit(parse(fixtureSource, { ecmaVersion: 'latest' }), node => {
      if (node.type !== 'CallExpression') return;
      if (node.callee.object?.name === 'Object' && node.callee.property?.name === 'assign') {
        fixtureNode = node.arguments[1];
      }
      if (node.callee.property?.name === 'add'
          && node.callee.object?.property?.name === 'externalAudio') {
        const asset = node.arguments[0];
        if (asset.properties.some(property => property.key.name === 'locked' && property.value.value === true)) {
          lockedExternal = vm.runInNewContext('(' + fixtureSource.slice(asset.start, asset.end) + ')');
        }
      }
    });
    const fixture = vm.runInNewContext('(' + fixtureSource.slice(fixtureNode.start, fixtureNode.end) + ')');
    const videoCase = selectionCases.elements.find(node => node.properties
      .some(property => property.key.name === 'name' && property.value.value === '影片選取'));
    const expectedNode = videoCase.properties.find(property => property.key.name === 'expected').value;
    const expected = vm.runInNewContext('(' + source.slice(expectedNode.start, expectedNode.end) + ')');
    let preparedSelector;
    visit(videoCase, node => {
      if (node.type === 'CallExpression' && node.callee.name === 'elementRect') preparedSelector = node.arguments[1].value;
    });
    const preparedClip = fixture.clips.find(clip => clip.id === expected.selectedClipId);
    expect(preparedClip).toBeDefined();
    expect(preparedClip.locked).toBe(false);
    expect(fixture.videoTracks[preparedClip.vtrack].locked).toBe(false);
    expect(preparedSelector).toBe('.clip-block[data-clip-id="' + preparedClip.id + '"]');
    expect(targets.elements).toHaveLength(3);
    expect(targets.elements.slice(0, 2).map(node => node.elements[1].value)).toEqual([
      '.clip-block[data-clip-id="locked-video"]',
      '.audio-clip-block[data-clip-id="locked-linked-audio"]',
    ]);
    const lockedVideo = fixture.clips.find(clip => clip.id === 'locked-video');
    expect(fixture.videoTracks[lockedVideo.vtrack].locked).toBe(true);
    expect(fixture.clips.find(clip => clip.id === 'locked-linked-audio').locked).toBe(true);
    expect(lockedExternal?.locked).toBe(true);
  });

  it('字幕觀察讀取重繪後仍連接的 live DOM 原文與唯讀狀態', async () => {
    const source = readFileSync(new URL('../scripts/acceptance/verify-locked-subtitle-editing.js', import.meta.url), 'utf8');
    const definition = parse(source, { ecmaVersion: 'latest' }).body
      .find(node => node.type === 'FunctionDeclaration' && node.id.name === 'lockedSubtitleViewSnapshot');
    const dom = new JSDOM('<div class="sub-row" data-id="locked-subtitle"><div class="txt" style="display:block;visibility:visible">舊節點</div></div><input id="tsSize" disabled>');
    try {
      const oldText = dom.window.document.querySelector('.txt');
      const liveText = oldText.cloneNode(true);
      liveText.textContent = '原始內容';
      liveText.contentEditable = 'false';
      liveText.getBoundingClientRect = () => ({ width: 200, height: 30 });
      oldText.scrollIntoView = () => {};
      Object.defineProperty(liveText, 'innerText', { get: () => '' });
      let frames = 0;
      const page = {
        document: dom.window.document,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: callback => {
          if (++frames === 1) oldText.replaceWith(liveText);
          callback();
        },
      };
      const snapshot = await vm.runInNewContext(source.slice(definition.start, definition.end)
        + '; lockedSubtitleViewSnapshot(page)', { page });
      expect(oldText.isConnected).toBe(false);
      expect(snapshot).toEqual({
        displayedText: '原始內容', textConnected: true,
        textReadonly: true, textVisible: true, styleDisabled: true,
      });
    } finally {
      dom.window.close();
    }
  });
});
