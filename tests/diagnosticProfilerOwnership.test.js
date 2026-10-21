import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { rendererLagProbe } = require('../scripts/diagnostics/renderer-lag-probe.js');
const source = readFileSync(new URL('../scripts/diagnostics/profile-renderer-stall.js', import.meta.url), 'utf8');
const ast = parse(source, { ecmaVersion: 'latest' });
// Execute the actual injected implementation, with only the native debugger
// adapter replaced. No source-pattern assertion stands in for ownership.
const definitions = ast.body.filter(node => node.type === 'FunctionDeclaration'
  || node.type === 'VariableDeclaration' && node.declarations.some(declaration =>
    ['PROFILE_TOKEN', 'START_PROFILE', 'STOP_PROFILE'].includes(declaration.id.name)))
  .map(node => source.slice(node.start, node.end)).join('\n');
const host = vm.createContext({ require, rendererLagProbe });
vm.runInContext(definitions, host);
const commands = vm.runInContext('({ start: START_PROFILE, stop: STOP_PROFILE })', host);
const other = vm.runInContext("({ start: profileCommand('start', 'second'), stop: profileCommand('stop', 'second') })", host);
function lagCommands(token) {
  return {
    start: vm.runInContext(`profileCommand('lag-start', ${JSON.stringify(token)}, rendererLagProbe({
      timerKey: '__lagTimer_p_' + ${JSON.stringify(token)}, totalKey: '__lagTotal_p_' + ${JSON.stringify(token)} }))`, host),
    read: vm.runInContext(`profileCommand('lag-read', ${JSON.stringify(token)})`, host),
    stop: vm.runInContext(`profileCommand('lag-stop', ${JSON.stringify(token)})`, host),
  };
}
const lag = lagCommands(vm.runInContext('PROFILE_TOKEN', host)), otherLag = lagCommands('second');
async function reached(native, command) {
  for (let index = 0; index < 20 && !native.calls.includes(command); index++) await Promise.resolve();
  expect(native.calls).toContain(command);
}

function fixture({ attached = false, fail = null, hold = null, detachFailures = 0, holdRenderer = false } = {}) {
  const calls = [];
  const debuggerAdapter = new EventEmitter();
  const timers = new Map(), listeners = new Set(); let next = 0, releaseRenderer;
  const page = vm.createContext({ window: {}, performance: { now: () => 0 }, Date,
    document: { visibilityState: 'visible', addEventListener: (_, handler) => listeners.add(handler),
      removeEventListener: (_, handler) => listeners.delete(handler) },
    setInterval: callback => { const id = ++next; timers.set(id, callback); return id; },
    clearInterval: id => timers.delete(id),
  });
  let release;
  Object.assign(debuggerAdapter, {
    isAttached: () => attached,
    attach() { calls.push('attach'); attached = true; },
    detach() {
      calls.push('detach');
      if (detachFailures-- > 0) throw new Error('native detach failed');
      attached = false; debuggerAdapter.emit('detach', {}, 'target closed');
    },
    async sendCommand(command) {
      calls.push(command);
      if (command === hold) await new Promise(resolve => { release = resolve; });
      if (command === fail) throw new Error('native command failed: ' + command);
      return command === 'Profiler.stop' ? { profile: {
        startTime: 0, endTime: 3000, samples: [1, 1], timeDeltas: [1000, 2000],
        nodes: [{ id: 1, callFrame: { functionName: 'render', url: 'file:///app.js', lineNumber: 4 } }],
      } } : {};
    },
  });
  let destroyed = false;
  const webContents = { debugger: debuggerAdapter, isDestroyed: () => destroyed,
    async executeJavaScript(code) {
      if (destroyed) throw new Error('renderer destroyed');
      const result = vm.runInContext(code, page);
      if (holdRenderer) { holdRenderer = false; await new Promise(resolve => { releaseRenderer = resolve; }); }
      return result;
    },
  };
  const window = { getParentWindow: () => null, webContents };
  const foreignCalls = [];
  const foreignWindow = { getParentWindow: () => null, webContents: {
    async executeJavaScript(code) { foreignCalls.push(code); return 999; },
  } };
  let windows = [window];
  const remote = vm.createContext({ require: () => ({ BrowserWindow: { getAllWindows: () => windows } }) });
  return {
    calls, debuggerAdapter, timers, listeners, foreignCalls,
    foreignWindowFirst: () => { windows = [foreignWindow, window]; },
    destroyRenderer() { destroyed = true; timers.clear(); listeners.clear(); debuggerAdapter.detach(); },
    attached: () => attached,
    run: code => vm.runInContext(code, remote),
    release: () => release?.(),
    releaseRenderer: () => releaseRenderer?.(),
  };
}

describe('CPU diagnostic owns only its debugger session', () => {
  it('rejects an existing attachment without starting or detaching another caller', async () => {
    const native = fixture({ attached: true });
    const result = await native.run(commands.start).catch(error => error);
    expect(result).not.toBe('ok');
    await native.run(commands.stop);
    expect(native.calls).toEqual([]);
    expect(native.attached()).toBe(true);
  });

  it('collects the real profile summary and releases an acquired session exactly once', async () => {
    const native = fixture();
    expect(await native.run(commands.start)).toBe('ok');
    const result = JSON.parse(await native.run(commands.stop));
    expect(result).toMatchObject({ 取樣總長ms: 3, 取樣數: 2, 前25名: [{ fn: 'render  @ app.js:5', ms: 3 }] });
    await native.run(commands.stop);
    expect(native.calls).toEqual(['attach', 'Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Profiler.stop', 'detach']);
    expect(native.attached()).toBe(false);
  });

  it.each(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start'])('cleans up its failed %s and permits a fresh owner', async command => {
    const native = fixture({ fail: command });
    await expect(native.run(commands.start)).rejects.toThrow('native command failed');
    expect(native.calls.filter(value => value === 'detach')).toHaveLength(1);
    expect(native.calls.filter(value => value === 'Profiler.stop')).toHaveLength(command === 'Profiler.start' ? 1 : 0);
    expect(native.attached()).toBe(false);
    // Failure must not leave a registry fence after releasing the native session.
    await expect(native.run(other.start)).rejects.toThrow('native command failed');
    expect(native.calls.filter(value => value === 'attach')).toHaveLength(2);
  });

  it('an old stop cannot terminate a later token owner', async () => {
    const native = fixture();
    await native.run(commands.start); await native.run(commands.stop);
    await native.run(other.start);
    const before = native.calls.slice();
    expect(JSON.parse(await native.run(commands.stop))).toHaveProperty('err');
    expect(native.calls).toEqual(before);
    expect(native.attached()).toBe(true);
    await native.run(other.stop);
  });

  it.each(['Profiler.enable', 'Profiler.start'])('cancellation waits for pending %s before releasing its native session', async command => {
    const native = fixture({ hold: command });
    const starting = native.run(commands.start).catch(error => error);
    await reached(native, command);
    let stopped = false;
    const stopping = native.run(commands.stop).then(value => { stopped = true; return value; });
    await Promise.resolve(); expect(stopped).toBe(false);
    expect(native.calls).not.toContain('detach');
    native.release();
    expect((await starting).message).toContain('已取消');
    expect(JSON.parse(await stopping)).toHaveProperty('err');
    expect(native.calls.filter(value => value === 'detach')).toHaveLength(1);
    expect(native.calls.filter(value => value === 'Profiler.stop')).toHaveLength(command === 'Profiler.start' ? 1 : 0);
  });

  it('native detach revokes ownership before another caller attaches, including a late start reply', async () => {
    const native = fixture({ hold: 'Profiler.start' });
    const starting = native.run(commands.start).catch(error => error);
    await reached(native, 'Profiler.start');
    native.debuggerAdapter.detach();
    native.debuggerAdapter.attach();
    const before = native.calls.slice();
    native.release(); await starting;
    await native.run(commands.stop);
    expect(native.calls).toEqual(before);
    expect(native.attached()).toBe(true);
  });

  it('a failed stop releases its own debugger and leaves the original error visible', async () => {
    const native = fixture({ fail: 'Profiler.stop' });
    await native.run(commands.start);
    await expect(native.run(commands.stop)).rejects.toThrow('native command failed: Profiler.stop');
    expect(native.attached()).toBe(false);
    expect(native.calls.filter(value => value === 'detach')).toHaveLength(1);
    expect(JSON.parse(await native.run(commands.stop))).toHaveProperty('err');
  });

  it('failed native detach retains ownership and retries release without stopping an already stopped profile', async () => {
    const native = fixture({ detachFailures: 1 });
    await native.run(commands.start);
    await expect(native.run(commands.stop)).rejects.toThrow('native detach failed');
    expect(native.attached()).toBe(true);
    await expect(native.run(other.start)).rejects.toThrow('已由其他工作持有');
    const recovered = JSON.parse(await native.run(commands.stop));
    expect(recovered).toMatchObject({ 取樣數: 2 });
    expect(native.attached()).toBe(false);
    expect(native.calls.filter(value => value === 'Profiler.stop')).toHaveLength(1);
    expect(native.calls.filter(value => value === 'detach')).toHaveLength(2);
  });

  it('external detach after failed release revokes the retained owner before a foreign reattachment', async () => {
    const native = fixture({ detachFailures: 1 });
    await native.run(commands.start);
    await expect(native.run(commands.stop)).rejects.toThrow('native detach failed');
    native.debuggerAdapter.detach(); native.debuggerAdapter.attach();
    const before = native.calls.slice();
    expect(JSON.parse(await native.run(commands.stop))).toHaveProperty('err');
    expect(native.calls).toEqual(before);
    expect(native.attached()).toBe(true);
  });

  it('failed startup retains a failed detach fence until its own stop retries cleanup', async () => {
    const native = fixture({ fail: 'Profiler.enable', detachFailures: 1 });
    await expect(native.run(commands.start)).rejects.toThrow('native command failed: Profiler.enable');
    expect(native.attached()).toBe(true);
    await expect(native.run(other.start)).rejects.toThrow('已由其他工作持有');
    expect(JSON.parse(await native.run(commands.stop))).toHaveProperty('err');
    expect(native.attached()).toBe(false);
    expect(native.calls).not.toContain('Profiler.stop');
    expect(native.calls.filter(value => value === 'detach')).toHaveLength(2);
  });

  it('a late stop reply cannot detach a foreign session attached while native stop was pending', async () => {
    const native = fixture({ hold: 'Profiler.stop' });
    await native.run(commands.start);
    const stopping = native.run(commands.stop).catch(error => error);
    await reached(native, 'Profiler.stop');
    native.debuggerAdapter.detach(); native.debuggerAdapter.attach();
    const before = native.calls.slice();
    native.release();
    expect((await stopping).message).toContain('已被取代');
    expect(native.calls).toEqual(before);
    expect(native.attached()).toBe(true);
  });

  it('concurrent stops share one native stop and release', async () => {
    const native = fixture({ hold: 'Profiler.stop' });
    await native.run(commands.start);
    const first = native.run(commands.stop), second = native.run(commands.stop);
    await reached(native, 'Profiler.stop'); native.release();
    expect(await first).toBe(await second);
    expect(native.calls.filter(value => value === 'Profiler.stop')).toHaveLength(1);
    expect(native.calls.filter(value => value === 'detach')).toHaveLength(1);
  });

  it('successful profiling installs and releases the real renderer probe timer and visibility listener', async () => {
    const native = fixture();
    await expect(native.run(lag.start)).rejects.toThrow('已取消或被取代');
    expect(native.timers.size).toBe(0);
    await native.run(commands.start); await native.run(lag.start);
    expect(native.timers.size).toBe(1); expect(native.listeners.size).toBe(1);
    expect(await native.run(lag.read)).toBe(0);
    await native.run(lag.stop); await native.run(commands.stop);
    expect(native.timers.size).toBe(0); expect(native.listeners.size).toBe(0);
  });

  it('an old probe cleanup leaves a later token timer and listener intact', async () => {
    const native = fixture();
    await native.run(commands.start); await native.run(lag.start); await native.run(commands.stop);
    await native.run(other.start); await native.run(otherLag.start);
    expect(native.timers.size).toBe(2);
    await native.run(lag.stop);
    expect(native.timers.size).toBe(1); expect(native.listeners.size).toBe(1);
    await expect(native.run(lag.read)).rejects.toThrow('已取消或被取代');
    expect(await native.run(otherLag.read)).toBe(0);
    await native.run(otherLag.stop); await native.run(other.stop);
    expect(native.timers.size).toBe(0); expect(native.listeners.size).toBe(0);
  });

  it('ownership lost while renderer arming is pending cleans only its probe after the late reply', async () => {
    const native = fixture({ holdRenderer: true });
    await native.run(commands.start);
    const arming = native.run(lag.start).catch(error => error);
    expect(native.timers.size).toBe(1);
    native.debuggerAdapter.detach(); native.debuggerAdapter.attach();
    const before = native.calls.slice(); native.releaseRenderer();
    expect((await arming).message).toContain('已取消或被取代');
    expect(native.timers.size).toBe(0); expect(native.listeners.size).toBe(0);
    expect(native.calls).toEqual(before); expect(native.attached()).toBe(true);
  });

  it('probe arming and reads stay on the profiled WebContents when another parentless window comes first', async () => {
    const native = fixture();
    await native.run(commands.start);
    native.foreignWindowFirst();
    await native.run(lag.start);
    expect(native.timers.size).toBe(1);
    expect(await native.run(lag.read)).toBe(0);
    expect(native.foreignCalls).toEqual([]);
    await native.run(lag.stop); await native.run(commands.stop);
    expect(native.timers.size).toBe(0);
  });

  it('probe cleanup remembers its original renderer after native detach removes the profile owner', async () => {
    const native = fixture();
    await native.run(commands.start); await native.run(lag.start);
    native.debuggerAdapter.detach(); native.foreignWindowFirst();
    expect(await native.run(lag.stop)).toBe(true);
    expect(native.timers.size).toBe(0); expect(native.listeners.size).toBe(0);
    expect(native.foreignCalls).toEqual([]);
  });

  it('a destroyed renderer is a completed probe cleanup and never redirects into a replacement window', async () => {
    const native = fixture();
    await native.run(commands.start); await native.run(lag.start);
    native.destroyRenderer(); native.foreignWindowFirst();
    expect(await native.run(lag.stop)).toBe(true);
    expect(await native.run(lag.stop)).toBe(true);
    expect(native.foreignCalls).toEqual([]);
  });

  it('the real CLI leaves no renderer timer or listener when another debugger owns the target', async () => {
    const timers = new Map(), listeners = new Set(); let next = 0;
    const page = vm.createContext({ window: {}, performance: { now: () => 0 }, Date,
      document: { visibilityState: 'visible', addEventListener: (_, handler) => listeners.add(handler),
        removeEventListener: (_, handler) => listeners.delete(handler) },
      setInterval: callback => { const id = ++next; timers.set(id, callback); return id; },
      clearInterval: id => timers.delete(id),
    });
    const remote = vm.createContext({ require: () => ({ BrowserWindow: { getAllWindows: () => [{
      getParentWindow: () => null, webContents: {
        debugger: { isAttached: () => true },
        executeJavaScript: code => vm.runInContext(code, page),
      },
    }] } }) });
    class CdpClient {
      async connect() {}
      evaluate(code) { return Promise.resolve().then(() => vm.runInContext(code, remote)); }
      close() {}
    }
    const processAdapter = { argv: ['node', 'fixture', '123'], _debugProcess() {}, exitCode: 0 };
    await vm.runInNewContext(source, {
      require: name => name === 'child_process' ? {} : name === 'node:crypto' ? require(name)
        : name.includes('cdp-electron-harness') ? { CdpClient, getJSON: async () => [{ webSocketDebuggerUrl: 'fixture' }] }
          : { rendererLagProbe },
      process: processAdapter, setTimeout: callback => { callback(); return 1; },
      console: { log() {}, error() {} },
    });
    expect(processAdapter.exitCode).toBe(1);
    expect(timers.size).toBe(0);
    expect(listeners.size).toBe(0);
  });
});
