// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';

let UI, consume, openPath;
const source = fs.readFileSync(path.resolve('src/app.js'), 'utf8');
function findProgressRegistration(node) {
  if (node?.type === 'CallExpression' && node.callee?.object?.name === 'DESK' && node.callee.property?.name === 'onProgress') return node;
  if (!node || typeof node !== 'object') return null;
  for (const value of Object.values(node)) for (const child of Array.isArray(value) ? value : [value]) {
    const found = findProgressRegistration(child); if (found) return found;
  }
  return null;
}
const registration = findProgressRegistration(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));

beforeAll(async () => {
  vi.useFakeTimers();
  const parsed = new DOMParser().parseFromString(fs.readFileSync(path.resolve('index.html'), 'utf8'), 'text/html');
  document.body.innerHTML = parsed.body.innerHTML;
  UI = await import('../src/ui.js');
});
beforeEach(() => {
  UI.closeModal(); openPath = vi.fn().mockResolvedValue('');
  // Actual registered consumer and real modal/DOM; only the desktop IPC adapter is fake.
  vm.runInNewContext(source.slice(registration.start, registration.end), {
    DESK: { onProgress: callback => { consume = callback; }, openPath },
    _taskStarts: {}, _visibleExportJobId: null, _updateQueueStatusUI: vi.fn(),
    setStatus: UI.setStatus, showToast: UI.showToast, openModal: UI.openModal, closeModal: UI.closeModal,
    setTimeout, document, window, CustomEvent: window.CustomEvent,
    $: id => document.getElementById(id),
  });
});
afterAll(() => { UI.closeModal(); vi.clearAllTimers(); vi.useRealTimers(); });

function reportFailure(logPath) {
  consume({ jobId: 'export-quoted-path', error: true,
    errorMsg: `${logPath ? `[LOG_PATH]${logPath}[/LOG_PATH]` : ''}ffmpeg failed <literal> & details` });
  return [...document.querySelectorAll('#modalBody button')].find(button => button.textContent === '開啟完整記錄');
}

it.each([
  "C:\\Users\\O'Brien\\AppData\\Roaming\\SUB Tool\\export-queue\\evidence.log",
  'C:\\素材 & 記錄\\匯出.log',
])('actual export failure modal click opens literal log path %s', logPath => {
  const button = reportFailure(logPath);
  expect(document.getElementById('modalBg').classList.contains('show')).toBe(true);
  expect(document.getElementById('modalBody').textContent).toContain('ffmpeg failed <literal> & details');
  expect(button.getAttribute('onclick')).toBe(null);
  button.click(); expect(openPath).toHaveBeenCalledExactlyOnceWith(logPath);
});

it.each(['replaced', 'closed'])('a saved log button cannot open an obsolete %s modal', state => {
  const button = reportFailure("C:\\Users\\O'Brien\\evidence.log");
  if (state === 'replaced') UI.openModal('new modal', '<div>new content</div>');
  else document.querySelector('#modalFoot button.primary').click();
  button.click(); expect(openPath).not.toHaveBeenCalled();
});

it('a failure without a log path remains readable and closes through the real modal', () => {
  expect(reportFailure(null)).toBeUndefined();
  expect(document.getElementById('modalBody').textContent).toBe('ffmpeg failed <literal> & details');
  document.querySelector('#modalFoot button.primary').click();
  expect(document.getElementById('modalBg').classList.contains('show')).toBe(false);
  expect(openPath).not.toHaveBeenCalled();
});
