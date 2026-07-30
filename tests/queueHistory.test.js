/* 已完成匯出的紀錄（electron/queue-history.js）。

   使用者要的是「關掉軟體後，已完成的佇列紀錄還在，我要留著檢驗」。原本 done 工作
   在完成當下就被 removeArtifacts() 刪掉快照，loadJobs() 也會清掉殘留的 terminal
   tombstone，所以重啟後完成紀錄一律歸零。

   完成紀錄刻意【不】走 queue-store 的持久化：那邊把 done 當 terminal 並立即刪檔，
   是為了保證「已完成的工作不會在重啟後被誤當 queued 重跑」而覆寫掉已交付的成品
   （見 tests/queueStore.test.js）。history 記錄不含 payload.clips／audioPlan，
   本質上就不可執行，因此那條安全性質完全不受影響——下面有一條測試直接鎖住這件事。 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QueueHistory = require(path.join(ROOT, 'electron/queue-history.js'));

const dirs = new Set();
function makeDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'subtool-history-'));
  dirs.add(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.clear();
});

const doneJob = (over = {}) => ({
  id: 'job-1',
  status: 'done',
  createdAt: 1000,
  completedAt: 2000,
  elapsedMs: 1500,
  payload: { outPath: 'C:/out/a.mp4', duration: 12.5, format: 'h264' },
  ...over,
});

describe('寫入與讀回', () => {
  it('完成的工作寫進紀錄後讀得回來', () => {
    const dir = makeDir();
    QueueHistory.append(dir, doneJob());
    expect(QueueHistory.load(dir)).toEqual([{
      id: 'job-1',
      status: 'done',
      createdAt: 1000,
      completedAt: 2000,
      elapsedMs: 1500,
      payload: { outPath: 'C:/out/a.mp4', duration: 12.5, format: 'h264' },
    }]);
  });

  it('保持寫入順序（監控畫面依這個順序列出完成紀錄）', () => {
    const dir = makeDir();
    QueueHistory.append(dir, doneJob({ id: 'a' }));
    QueueHistory.append(dir, doneJob({ id: 'b' }));
    QueueHistory.append(dir, doneJob({ id: 'c' }));
    expect(QueueHistory.load(dir).map(e => e.id)).toEqual(['a', 'b', 'c']);
  });

  /* 重試後再度成功時，同一個 id 不該留下兩筆。 */
  it('同一個 id 重新完成會取代舊紀錄，且移到最後', () => {
    const dir = makeDir();
    QueueHistory.append(dir, doneJob({ id: 'a', completedAt: 100 }));
    QueueHistory.append(dir, doneJob({ id: 'b' }));
    QueueHistory.append(dir, doneJob({ id: 'a', completedAt: 999 }));
    const entries = QueueHistory.load(dir);
    expect(entries.map(e => e.id)).toEqual(['b', 'a']);
    expect(entries.find(e => e.id === 'a').completedAt).toBe(999);
  });
});

/* 這是這個模組存在的理由：紀錄必須【不可能】被排程重跑。 */
describe('紀錄不可執行（queue-store terminal tombstone 的安全性質不受影響）', () => {
  it('只留渲染完成卡片需要的欄位，不含 clips / audioPlan / assRef / sourcePaths', () => {
    const dir = makeDir();
    QueueHistory.append(dir, doneJob({
      assRef: 'burn_abc.ass',
      sourcePaths: ['C:/master/a.mxf'],
      senderId: 7,
      payload: {
        outPath: 'C:/out/a.mp4',
        duration: 3,
        format: 'h264',
        clips: [{ path: 'C:/master/a.mxf', in: 0, out: 3 }],
        audioPlan: { buses: [{ id: 'a1', inputs: [{ file: 'C:/master/a.mxf' }] }] },
        assText: 'Dialogue: ...',
      },
    }));
    const [entry] = QueueHistory.load(dir);
    expect(Object.keys(entry.payload).sort()).toEqual(['duration', 'format', 'outPath']);
    expect(entry.assRef).toBeUndefined();
    expect(entry.sourcePaths).toBeUndefined();
    expect(entry.senderId).toBeUndefined();
    // 整份序列化結果裡不該出現任何來源素材路徑
    expect(JSON.stringify(entry)).not.toContain('a.mxf');
  });

  it('狀態永遠是 done，不會存成 queued', () => {
    const dir = makeDir();
    QueueHistory.append(dir, doneJob({ status: 'queued' }));
    expect(QueueHistory.load(dir)[0].status).toBe('done');
  });
});

describe('移除與清空', () => {
  it('remove 只拿掉指定的一筆', () => {
    const dir = makeDir();
    QueueHistory.append(dir, doneJob({ id: 'a' }));
    QueueHistory.append(dir, doneJob({ id: 'b' }));
    QueueHistory.remove(dir, 'a');
    expect(QueueHistory.load(dir).map(e => e.id)).toEqual(['b']);
  });

  it('remove 不存在的 id 不會動到其他紀錄，也不丟例外', () => {
    const dir = makeDir();
    QueueHistory.append(dir, doneJob({ id: 'a' }));
    expect(() => QueueHistory.remove(dir, '不存在')).not.toThrow();
    expect(QueueHistory.load(dir).map(e => e.id)).toEqual(['a']);
  });

  it('clear 清空全部並刪掉檔案', () => {
    const dir = makeDir();
    QueueHistory.append(dir, doneJob());
    expect(existsSync(QueueHistory.historyPath(dir))).toBe(true);
    QueueHistory.clear(dir);
    expect(QueueHistory.load(dir)).toEqual([]);
    expect(existsSync(QueueHistory.historyPath(dir))).toBe(false);
  });

  it('clear 空目錄不丟例外', () => {
    expect(() => QueueHistory.clear(makeDir())).not.toThrow();
  });
});

/* 完成紀錄是稽核資料，壞掉時應該安靜地當作沒有，而不是讓整個程式起不來。 */
describe('壞資料一律回空，不擋啟動', () => {
  it('沒有檔案時回空陣列', () => {
    expect(QueueHistory.load(makeDir())).toEqual([]);
  });

  it('JSON 損毀時回空陣列', () => {
    const dir = makeDir();
    writeFileSync(QueueHistory.historyPath(dir), '{壞掉的 json', 'utf8');
    expect(QueueHistory.load(dir)).toEqual([]);
  });

  it('版本不符時回空陣列（不猜舊格式）', () => {
    const dir = makeDir();
    writeFileSync(QueueHistory.historyPath(dir),
      JSON.stringify({ version: 999, entries: [doneJob()] }), 'utf8');
    expect(QueueHistory.load(dir)).toEqual([]);
  });

  it('個別壞掉的項目被略過，其餘照常讀回', () => {
    const dir = makeDir();
    writeFileSync(QueueHistory.historyPath(dir), JSON.stringify({
      version: QueueHistory.HISTORY_VERSION,
      entries: [null, { id: '' }, { id: 'no-out' }, doneJob({ id: 'ok' })],
    }), 'utf8');
    expect(QueueHistory.load(dir).map(e => e.id)).toEqual(['ok']);
  });

  it('重複 id 只留第一筆', () => {
    const dir = makeDir();
    writeFileSync(QueueHistory.historyPath(dir), JSON.stringify({
      version: QueueHistory.HISTORY_VERSION,
      entries: [doneJob({ id: 'dup', completedAt: 1 }), doneJob({ id: 'dup', completedAt: 2 })],
    }), 'utf8');
    const entries = QueueHistory.load(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0].completedAt).toBe(1);
  });
});

describe('筆數上限', () => {
  it('超過上限時丟掉最舊的，保留最新的', () => {
    const dir = makeDir();
    const total = QueueHistory.MAX_ENTRIES + 5;
    const entries = Array.from({ length: total }, (_, i) => QueueHistory.toEntry(doneJob({ id: `job-${i}` })));
    QueueHistory.save(dir, entries);
    const loaded = QueueHistory.load(dir);
    expect(loaded).toHaveLength(QueueHistory.MAX_ENTRIES);
    expect(loaded[0].id).toBe('job-5');
    expect(loaded[loaded.length - 1].id).toBe(`job-${total - 1}`);
  });
});

describe('寫入是原子的', () => {
  it('寫完不留下 .tmp 殘檔', () => {
    const dir = makeDir();
    QueueHistory.append(dir, doneJob());
    const { readdirSync } = require('node:fs');
    expect(readdirSync(dir).filter(name => name.includes('.tmp-'))).toEqual([]);
  });

  it('產出的檔案是可讀的 JSON 且帶版本號', () => {
    const dir = makeDir();
    QueueHistory.append(dir, doneJob());
    const parsed = JSON.parse(readFileSync(QueueHistory.historyPath(dir), 'utf8'));
    expect(parsed.version).toBe(QueueHistory.HISTORY_VERSION);
    expect(parsed.entries).toHaveLength(1);
  });
});
