'use strict';

const crypto = require('node:crypto');

// A renderer request owns both the pending hash and its completed receipt.
// Invalidation is sender-scoped and also revokes a later receipt, even when a
// filesystem adapter does not observe AbortSignal until its current read ends.
function createDeliveryPreparation(consent, { maxActive = 2, maxQueued = 32, maxPerSender = 4 } = {}) {
  if (![maxActive, maxQueued, maxPerSender].every(value => Number.isSafeInteger(value) && value > 0))
    throw new TypeError('交付確認排程限制無效');
  const senders = new WeakMap();
  const waiting = [];
  let active = 0;
  let ticketSequence = 0n;
  const validId = id => typeof id === 'string' && /^delivery-[A-Za-z0-9_-]{1,100}$/.test(id);
  const unavailable = () => Object.assign(new Error('交付確認已取消或失效，請重新送出'), { code: 'DELIVERY_REQUEST_CANCELLED' });
  const busy = () => Object.assign(new Error('交付確認工作過多，請稍後重試'), { code: 'DELIVERY_PREPARATION_BUSY' });

  // The slot belongs to the underlying read until it actually settles, even
  // when the sender already cancelled or closed its window. Otherwise stalled
  // filesystem callbacks would allow unlimited concurrent reads after retries.
  function pump() {
    while (active < maxActive && waiting.length) {
      const entry = waiting.shift();
      entry.signal.removeEventListener('abort', entry.cancelQueued);
      if (entry.signal.aborted) { entry.reject(unavailable()); continue; }
      active++;
      let work;
      try { work = entry.work(); } catch (error) { work = Promise.reject(error); }
      Promise.resolve(work).then(entry.resolve, entry.reject).finally(() => { active--; pump(); });
    }
  }

  function schedule(signal, work) {
    if (signal.aborted) return Promise.reject(unavailable());
    if (active >= maxActive && waiting.length >= maxQueued) return Promise.reject(busy());
    return new Promise((resolve, reject) => {
      const entry = { signal, work, resolve, reject, cancelQueued: null };
      entry.cancelQueued = () => {
        const index = waiting.indexOf(entry);
        if (index < 0) return;
        waiting.splice(index, 1);
        signal.removeEventListener('abort', entry.cancelQueued);
        reject(unavailable());
        pump();
      };
      waiting.push(entry);
      signal.addEventListener('abort', entry.cancelQueued, { once: true });
      pump();
    });
  }

  function dispose(sender, state) {
    for (const request of state.requests.values()) {
      request.controller.abort(unavailable());
      if (request.receipt) consent.release(sender, request.receipt);
    }
    state.requests.clear();
    sender.removeListener?.('destroyed', state.destroyed);
    sender.removeListener?.('did-start-navigation', state.navigation);
    if (senders.get(sender) === state) senders.delete(sender);
  }

  function stateFor(sender) {
    if (!sender || sender.isDestroyed?.()) throw unavailable();
    let state = senders.get(sender);
    if (state) return state;
    state = { requests: new Map() };
    state.destroyed = () => dispose(sender, state);
    state.navigation = (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) dispose(sender, state);
    };
    sender.on?.('destroyed', state.destroyed);
    sender.on?.('did-start-navigation', state.navigation);
    senders.set(sender, state);
    return state;
  }

  function cleanupIdle(sender, state) {
    if (!state.requests.size) dispose(sender, state);
  }

  function begin(sender, id) {
    if (!validId(id)) throw new TypeError('缺少有效交付確認請求識別');
    const state = stateFor(sender);
    if (state.requests.has(id)) throw new Error('交付確認請求識別重複');
    if (state.requests.size >= maxPerSender) throw busy();
    const ticket = `${crypto.randomBytes(24).toString('hex')}-${(++ticketSequence).toString(36)}`;
    const request = { ticket, controller: new AbortController(), receipt: null, prepared: false };
    state.requests.set(id, request);
    return ticket;
  }

  function lookup(sender, id, ticket) {
    if (!validId(id) || typeof ticket !== 'string' || sender?.isDestroyed?.()) return null;
    const state = senders.get(sender), request = state?.requests.get(id);
    return request && request.ticket === ticket ? { state, request } : null;
  }

  async function prepare(sender, paths, id, ticket) {
    const matched = lookup(sender, id, ticket);
    if (!matched || matched.request.controller.signal.aborted || matched.request.prepared) throw unavailable();
    const { state, request } = matched;
    request.prepared = true;
    try {
      const result = await schedule(request.controller.signal, () => consent.prepare(sender, paths, { signal: request.controller.signal }));
      if (request.controller.signal.aborted || sender.isDestroyed?.() || senders.get(sender) !== state
        || state.requests.get(id) !== request) {
        if (result?.id) consent.release(sender, result.id);
        throw unavailable();
      }
      request.receipt = result.id;
      return result;
    } catch (error) {
      if (state.requests.get(id) === request) state.requests.delete(id);
      cleanupIdle(sender, state);
      throw error;
    }
  }

  function cancel(sender, id, ticket) {
    const matched = lookup(sender, id, ticket);
    if (!matched) return false;
    const { request } = matched;
    request.controller.abort(unavailable());
    if (request.receipt) { consent.release(sender, request.receipt); request.receipt = null; }
    return true;
  }

  function finish(sender, id, ticket) {
    const matched = lookup(sender, id, ticket);
    if (!matched) return false;
    const { state, request } = matched;
    request.controller.abort(unavailable());
    if (request.receipt) consent.release(sender, request.receipt);
    state.requests.delete(id);
    cleanupIdle(sender, state);
    return true;
  }

  function signal(sender, id, ticket, receipt = null) {
    if (id == null && receipt == null) return null;
    const request = lookup(sender, id, ticket)?.request;
    if (!request?.receipt || request.controller.signal.aborted || (receipt != null && receipt !== request.receipt)) throw unavailable();
    return request.controller.signal;
  }

  function senderScope(sender) {
    const controller = new AbortController();
    const destroyed = () => controller.abort(unavailable());
    const navigation = (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) destroyed(); };
    if (!sender || sender.isDestroyed?.()) destroyed();
    else {
      sender.on?.('destroyed', destroyed);
      sender.on?.('did-start-navigation', navigation);
    }
    return { signal: controller.signal, dispose() {
      sender?.removeListener?.('destroyed', destroyed);
      sender?.removeListener?.('did-start-navigation', navigation);
    } };
  }

  return { begin, prepare, cancel, finish, signal, senderScope };
}

module.exports = { createDeliveryPreparation };
