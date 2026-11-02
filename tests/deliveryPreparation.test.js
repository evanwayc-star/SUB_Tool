import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';

const require = createRequire(import.meta.url);
const { createDeliveryPreparation } = require('../electron/delivery-preparation');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function ipcHandlers(deliveryPreparation, deliveryConsent) {
  const source = fs.readFileSync('electron/main.js', 'utf8');
  const tree = parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const handlers = {};
  for (const channel of ['delivery:beginTargetRequest','delivery:prepareTargets','delivery:cancelTargetRequest','delivery:finishTargetRequest','delivery:releaseTargets']) {
    const expression = tree.body.map(node => node.expression).find(node => node?.callee?.object?.name === 'ipcMain'
      && node.callee.property?.name === 'handle' && node.arguments?.[0]?.value === channel);
    vm.runInNewContext(source.slice(expression.start, expression.end), {
      deliveryPreparation, deliveryConsent, ipcMain: { handle: (name, callback) => { handlers[name] = callback; } },
    });
  }
  return handlers;
}

describe('交付確認請求與 sender 生命週期', () => {
  it('收據只屬於相同 sender、ID 與 ticket，不能借用其他工作的取消資格',async()=>{
    const sender=new EventEmitter();let next=0;
    const consent={prepare:vi.fn(async()=>({id:`receipt-${++next}`,existing:[]})),release:vi.fn()};
    const manager=createDeliveryPreparation(consent),a=manager.begin(sender,'delivery-a'),b=manager.begin(sender,'delivery-b');
    await manager.prepare(sender,['A'],'delivery-a',a);await manager.prepare(sender,['B'],'delivery-b',b);
    expect(()=>manager.signal(sender,'delivery-b',b,'receipt-1')).toThrow();
    expect(()=>manager.signal(sender,null,null,'receipt-1')).toThrow();
    expect(manager.signal(sender,'delivery-a',a,'receipt-1').aborted).toBe(false);
    manager.cancel(sender,'delivery-a',a);
    expect(()=>manager.signal(sender,'delivery-a',a,'receipt-1')).toThrow();
    expect(manager.signal(sender,'delivery-b',b,'receipt-2').aborted).toBe(false);
    manager.finish(sender,'delivery-a',a);manager.finish(sender,'delivery-b',b);
  });

  it('完成或取消在 prepare 前到達後，同 ID 重用不接受舊 ticket 的遲到訊息',async()=>{
    const sender=new EventEmitter(),consent={prepare:vi.fn(async()=>({id:'new-receipt',existing:[]})),release:vi.fn()};
    const manager=createDeliveryPreparation(consent),id='delivery-reused';
    const oldTicket=manager.begin(sender,id);
    expect(manager.cancel(sender,id,oldTicket)).toBe(true);
    expect(manager.finish(sender,id,oldTicket)).toBe(true);
    const currentTicket=manager.begin(sender,id);
    expect(currentTicket).not.toBe(oldTicket);
    expect(manager.cancel(sender,id,oldTicket)).toBe(false);
    expect(manager.finish(sender,id,oldTicket)).toBe(false);
    await expect(manager.prepare(sender,['old'],id,oldTicket)).rejects.toMatchObject({code:'DELIVERY_REQUEST_CANCELLED'});
    await expect(manager.prepare(sender,['new'],id,currentTicket)).resolves.toEqual({id:'new-receipt',existing:[]});
    expect(manager.signal(sender,id,currentTicket).aborted).toBe(false);
    expect(consent.prepare).toHaveBeenCalledOnce();
    expect(manager.finish(sender,id,currentTicket)).toBe(true);
    await expect(manager.prepare(sender,['late'],id,currentTicket)).rejects.toMatchObject({code:'DELIVERY_REQUEST_CANCELLED'});
  });

  it('舊工作仍在收尾時重用同 ID，遲到的舊收據及完成不得撤銷新工作',async()=>{
    const sender=new EventEmitter(),gate=deferred();
    const consent={prepare:vi.fn((_sender,paths)=>paths[0]==='old'?gate.promise:Promise.resolve({id:'new-receipt',existing:[]})),release:vi.fn()};
    const manager=createDeliveryPreparation(consent,{maxActive:2,maxQueued:2,maxPerSender:2}),id='delivery-reuse-live';
    const oldTicket=manager.begin(sender,id),old=manager.prepare(sender,['old'],id,oldTicket);
    expect(manager.cancel(sender,id,oldTicket)).toBe(true);expect(manager.finish(sender,id,oldTicket)).toBe(true);
    const newTicket=manager.begin(sender,id);
    await expect(manager.prepare(sender,['new'],id,newTicket)).resolves.toEqual({id:'new-receipt',existing:[]});
    gate.resolve({id:'late-old-receipt',existing:[]});
    await expect(old).rejects.toMatchObject({code:'DELIVERY_REQUEST_CANCELLED'});
    expect(consent.release).toHaveBeenCalledWith(sender,'late-old-receipt');
    expect(consent.release).not.toHaveBeenCalledWith(sender,'new-receipt');
    expect(manager.finish(sender,id,oldTicket)).toBe(false);
    expect(manager.signal(sender,id,newTicket,'new-receipt').aborted).toBe(false);
    expect(manager.finish(sender,id,newTicket)).toBe(true);
  });

  it('大量失敗後收到遲到的取消與完成，不累積取消紀錄或讓後續取消失效',async()=>{
    const sender=new EventEmitter(),consent={prepare:vi.fn(async()=>{throw new Error('read failed');}),release:vi.fn()};
    const manager=createDeliveryPreparation(consent);
    for(let i=0;i<600;i++){
      const id=`delivery-failed-${i}`,ticket=manager.begin(sender,id);
      await expect(manager.prepare(sender,['A'],id,ticket)).rejects.toThrow('read failed');
      expect(manager.cancel(sender,id,ticket)).toBe(false);
      expect(manager.finish(sender,id,ticket)).toBe(false);
    }
    const ticket=manager.begin(sender,'delivery-last');
    expect(manager.cancel(sender,'delivery-last',ticket)).toBe(true);
    await expect(manager.prepare(sender,['A'],'delivery-last',ticket)).rejects.toMatchObject({code:'DELIVERY_REQUEST_CANCELLED'});
    expect(manager.finish(sender,'delivery-last',ticket)).toBe(true);
    expect(consent.prepare).toHaveBeenCalledTimes(600);
    expect(sender.listenerCount('destroyed')).toBe(0);
  });

  it.each(['cancel','navigation','destroyed'])('%s 執行中讀取不提前釋放名額，後續 sender 等實際收尾才啟動', async action => {
    const first=deferred(), second=deferred(), senderA=new EventEmitter(),senderB=new EventEmitter();
    const consent={prepare:vi.fn((sender)=>sender===senderA?first.promise:second.promise),release:vi.fn()};
    const manager=createDeliveryPreparation(consent,{maxActive:1,maxQueued:2,maxPerSender:2});
    const ticketA=manager.begin(senderA,'delivery-a'),ticketB=manager.begin(senderB,'delivery-b');
    const a=manager.prepare(senderA,['A'],'delivery-a',ticketA);
    const b=manager.prepare(senderB,['B'],'delivery-b',ticketB);
    expect(consent.prepare).toHaveBeenCalledTimes(1);
    if(action==='cancel') expect(manager.cancel(senderA,'delivery-a',ticketA)).toBe(true);
    else if(action==='navigation') senderA.emit('did-start-navigation',{},'url',false,true);
    else senderA.emit('destroyed');
    await Promise.resolve();
    expect(consent.prepare).toHaveBeenCalledTimes(1);
    first.resolve({id:'late-a',existing:[]});
    await expect(a).rejects.toMatchObject({code:'DELIVERY_REQUEST_CANCELLED'});
    await vi.waitFor(()=>expect(consent.prepare).toHaveBeenCalledTimes(2));
    expect(consent.release).toHaveBeenCalledWith(senderA,'late-a');
    second.resolve({id:'receipt-b',existing:[]});
    await expect(b).resolves.toEqual({id:'receipt-b',existing:[]});
    expect(manager.signal(senderB,'delivery-b',ticketB).aborted).toBe(false);
    expect(manager.finish(senderB,'delivery-b',ticketB)).toBe(true);
  });

  it.each(['cancel','navigation'])('排隊中 %s 可即時撤銷，不佔槽位或影響先前收據', async action => {
    const held=deferred(),sender=new EventEmitter(),other=new EventEmitter();
    const consent={prepare:vi.fn((_sender,paths)=>paths[0]==='held'?held.promise:Promise.resolve({id:'queued',existing:[]})),release:vi.fn()};
    const manager=createDeliveryPreparation(consent,{maxActive:1,maxQueued:2,maxPerSender:3});
    const ticket=manager.begin(sender,'delivery-held'),otherTicket=manager.begin(other,'delivery-queued');
    const first=manager.prepare(sender,['held'],'delivery-held',ticket);
    const queued=manager.prepare(other,['queued'],'delivery-queued',otherTicket);
    if(action==='cancel')expect(manager.cancel(other,'delivery-queued',otherTicket)).toBe(true);
    else other.emit('did-start-navigation',{},'url',false,true);
    await expect(queued).rejects.toMatchObject({code:'DELIVERY_REQUEST_CANCELLED'});
    expect(consent.prepare).toHaveBeenCalledTimes(1);
    held.resolve({id:'held-receipt',existing:[]});
    await expect(first).resolves.toEqual({id:'held-receipt',existing:[]});
    expect(manager.signal(sender,'delivery-held',ticket).aborted).toBe(false);
    expect(consent.release).not.toHaveBeenCalledWith(sender,'held-receipt');
    manager.finish(sender,'delivery-held',ticket);
  });

  it('全域佇列與單一 sender 均有上限；拒絕新增請求不撤銷已發放收據', async () => {
    const gate=deferred(),sender=new EventEmitter(),other=new EventEmitter(),third=new EventEmitter();
    const consent={prepare:vi.fn((_sender,paths)=>paths[0]==='ready'?Promise.resolve({id:'ready-receipt',existing:[]}):gate.promise),release:vi.fn()};
    const manager=createDeliveryPreparation(consent,{maxActive:1,maxQueued:1,maxPerSender:2});
    const readyTicket=manager.begin(sender,'delivery-ready');await manager.prepare(sender,['ready'],'delivery-ready',readyTicket);
    const activeTicket=manager.begin(other,'delivery-active'),queuedTicket=manager.begin(sender,'delivery-queued');
    const active=manager.prepare(other,['active'],'delivery-active',activeTicket);
    const queued=manager.prepare(sender,['queued'],'delivery-queued',queuedTicket);
    expect(()=>manager.begin(sender,'delivery-excess')).toThrow(expect.objectContaining({code:'DELIVERY_PREPARATION_BUSY'}));
    const overflowTicket=manager.begin(third,'delivery-overflow');
    await expect(manager.prepare(third,['overflow'],'delivery-overflow',overflowTicket)).rejects.toMatchObject({code:'DELIVERY_PREPARATION_BUSY'});
    expect(manager.signal(sender,'delivery-ready',readyTicket).aborted).toBe(false);
    expect(consent.release).not.toHaveBeenCalledWith(sender,'ready-receipt');
    expect(manager.cancel(sender,'delivery-queued',queuedTicket)).toBe(true);
    await expect(queued).rejects.toMatchObject({code:'DELIVERY_REQUEST_CANCELLED'});
    manager.cancel(other,'delivery-active',activeTicket);gate.resolve({id:'late-active',existing:[]});
    await expect(active).rejects.toMatchObject({code:'DELIVERY_REQUEST_CANCELLED'});
    expect(manager.signal(sender,'delivery-ready',readyTicket).aborted).toBe(false);
    manager.finish(sender,'delivery-ready',readyTicket);
  });

  it('真實 IPC 等待確認時取消，同 sender 即時中止，遲到收據被撤銷', async () => {
    const gate = deferred(), sender = new EventEmitter(), other = new EventEmitter();
    let signal;
    const consent = { prepare: vi.fn((_sender, _paths, options) => { signal = options.signal; return gate.promise; }), release: vi.fn() };
    const manager = createDeliveryPreparation(consent), ipc = ipcHandlers(manager, consent), id = 'delivery-1';
    const ticket=ipc['delivery:beginTargetRequest']({sender},id);
    const pending = ipc['delivery:prepareTargets']({ sender }, { paths: ['A'], requestId: id, ticket });
    expect(signal.aborted).toBe(false);
    expect(ipc['delivery:cancelTargetRequest']({ sender: other }, {requestId:id,ticket})).toBe(false);
    expect(signal.aborted).toBe(false);
    expect(ipc['delivery:cancelTargetRequest']({ sender }, {requestId:id,ticket})).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(() => manager.signal(sender, id, ticket)).toThrow();
    gate.resolve({ id: 'receipt', existing: [] });
    await expect(pending).rejects.toMatchObject({ code: 'DELIVERY_REQUEST_CANCELLED' });
    expect(consent.release).toHaveBeenCalledWith(sender, 'receipt');
  });

  it('取消訊息先於 prepare 到達時不得啟動工作', async () => {
    const sender = new EventEmitter(), consent = { prepare: vi.fn(), release: vi.fn() };
    const manager = createDeliveryPreparation(consent), ipc = ipcHandlers(manager, consent), id = 'delivery-before';
    const ticket=ipc['delivery:beginTargetRequest']({sender},id);
    expect(ipc['delivery:cancelTargetRequest']({ sender }, {requestId:id,ticket})).toBe(true);
    await expect(ipc['delivery:prepareTargets']({ sender }, { paths: ['A'], requestId: id, ticket }))
      .rejects.toMatchObject({ code: 'DELIVERY_REQUEST_CANCELLED' });
    expect(consent.prepare).not.toHaveBeenCalled();
    ipc['delivery:finishTargetRequest']({sender},{requestId:id,ticket});
    expect(sender.listenerCount('destroyed')).toBe(0);
  });

  it.each(['navigation','destroyed'])('%s 撤銷準備完成後的收據與後續入列資格', async event => {
    const sender = new EventEmitter(), consent = { prepare: vi.fn(async () => ({ id: 'receipt', existing: [] })), release: vi.fn() };
    const manager = createDeliveryPreparation(consent), ipc = ipcHandlers(manager, consent), id = 'delivery-ready';
    const ticket=ipc['delivery:beginTargetRequest']({sender},id);
    await ipc['delivery:prepareTargets']({ sender }, { paths: ['A'], requestId: id, ticket });
    const signal = manager.signal(sender, id, ticket);
    expect(manager.signal(sender, undefined)).toBeNull();
    if (event === 'navigation') {
      sender.emit('did-start-navigation', {}, 'url', true, true);
      sender.emit('did-start-navigation', {}, 'url', false, false);
      expect(signal.aborted).toBe(false);
      sender.emit('did-start-navigation', {}, 'url', false, true);
    } else sender.emit('destroyed');
    expect(signal.aborted).toBe(true);
    expect(consent.release).toHaveBeenCalledWith(sender, 'receipt');
    expect(() => manager.signal(sender, id, ticket)).toThrow();
    expect(sender.listenerCount('did-start-navigation')).toBe(0);
  });

  it.each(['navigation','destroyed'])('直接匯出 scope 在 %s 後失效，結束時移除監聽', event => {
    const sender = new EventEmitter(), manager = createDeliveryPreparation({ prepare: vi.fn(), release: vi.fn() });
    const scope = manager.senderScope(sender);
    expect(scope.signal.aborted).toBe(false);
    if (event === 'navigation') sender.emit('did-start-navigation', {}, 'url', false, true);
    else sender.emit('destroyed');
    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
    expect(sender.listenerCount('did-start-navigation')).toBe(0);
    expect(sender.listenerCount('destroyed')).toBe(0);
  });

  it('完成送出會撤銷剩餘收據並移除 sender 監聽', async () => {
    const sender = new EventEmitter(), consent = { prepare: vi.fn(async () => ({ id: 'receipt', existing: [] })), release: vi.fn() };
    const manager = createDeliveryPreparation(consent), id = 'delivery-completed';
    const ticket=manager.begin(sender,id);
    await manager.prepare(sender, ['A'], id, ticket);
    const signal = manager.signal(sender, id, ticket);
    expect(manager.finish(sender, id, ticket)).toBe(true);
    expect(signal.aborted).toBe(true);
    expect(consent.release).toHaveBeenCalledWith(sender, 'receipt');
    expect(sender.listenerCount('destroyed')).toBe(0);
    expect(sender.listenerCount('did-start-navigation')).toBe(0);
  });
});
