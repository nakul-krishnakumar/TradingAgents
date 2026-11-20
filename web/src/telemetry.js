/** Send interaction and browser-error metadata without reading form values. */

const key = 'market-desk:diagnostics';
const pages = new Set(['workspace', 'daily', 'screener', 'trends', 'wishlists', 'baskets', 'runs', 'backtests', 'diagnostics']);
const targetId = /^[a-zA-Z0-9_.:-]{1,100}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const capacity = 200;
const batchSize = 32;
let session;
let pending = [];
let dropped = 0;
let action;
let timer;
let sending = false;
let delay = 600;

function makeId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function pageName() {
  const value = window.location.hash.slice(1);
  return pages.has(value) ? value : 'workspace';
}

function keepQueue() {
  try {
    // Error messages are scrubbed by the server. Only metadata is saved here.
    sessionStorage.setItem(key, JSON.stringify({
      session, dropped, events: pending.map(({ detail, ...item }) => item),
    }));
  } catch { /* A private browser may disable storage. */ }
}

function schedule() {
  if (timer == null && pending.length) timer = window.setTimeout(send, delay);
}

async function send() {
  timer = undefined;
  if (sending || !pending.length) return;
  sending = true;
  const batch = pending.slice(0, batchSize);
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('/api/diagnostics/browser', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({ session, events: batch }), signal: controller.signal,
    });
    if (response.ok || [400, 413, 415, 422].includes(response.status)) {
      const finished = new Set(batch.map(({ id }) => id));
      pending = pending.filter(({ id }) => !finished.has(id));
      if (!response.ok) dropped += batch.length;
      delay = 600;
      if (response.ok && dropped) {
        const count = dropped;
        dropped = 0;
        browserEvent('dropped', { detail: `${count} events could not be delivered from this browser.` });
      }
      keepQueue();
    } else delay = Math.min(delay * 2, 30000);
  } catch {
    delay = Math.min(delay * 2, 30000);
  } finally {
    window.clearTimeout(timeout);
    sending = false;
    schedule();
  }
}

export function browserEvent(kind, fields = {}) {
  if (!session) return;
  const entry = { id: makeId(), kind, page: pageName(), at: new Date().toISOString(), ...fields };
  if (['view', 'click', 'submit', 'change'].includes(kind)) action = { id: entry.id, at: performance.now() };
  if (pending.length >= capacity) {
    pending.shift();
    dropped++;
  }
  pending.push(entry);
  keepQueue();
  schedule();
}

export function requestTraceHeaders({ interactive = true } = {}) {
  return session ? {
    'X-MarketDesk-Session': session,
    ...(interactive && action && performance.now() - action.at < 3000 ? { 'X-MarketDesk-Action': action.id } : {}),
  } : {};
}

function controlName(target) {
  const label = target.getAttribute('data-log') || target.id || target.getAttribute('name');
  if (label && targetId.test(label)) return label;
  const region = target.closest('[data-log-region]')?.dataset.logRegion;
  const type = target.tagName.toLowerCase();
  return region && targetId.test(region) ? `${region}.${type}` : type;
}

function basename(source) {
  if (!source) return 'browser';
  try {
    const url = new URL(source, window.location.href);
    const name = url.pathname.split('/').at(-1);
    return url.origin === window.location.origin && targetId.test(name || '') ? name : 'resource';
  } catch { return 'resource'; }
}

export function startDiagnostics() {
  if (session) return;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || '{}');
    if (typeof saved.session === 'string' && (uuid.test(saved.session) || /^[a-f0-9]{32}$/i.test(saved.session))) {
      session = saved.session;
      pending = Array.isArray(saved.events) ? saved.events.slice(-capacity) : [];
      dropped = Number.isSafeInteger(saved.dropped) ? saved.dropped : 0;
    }
  } catch { /* Continue with a new browser session. */ }
  session ||= makeId();

  window.addEventListener('hashchange', () => browserEvent('view'));
  document.addEventListener('click', (event) => {
    const element = event.target instanceof Element && event.target.closest('button, a, summary, [role="button"], [role="tab"]');
    if (element && !element.disabled) browserEvent('click', { control: controlName(element) });
  }, true);
  document.addEventListener('submit', (event) => browserEvent('submit', { control: controlName(event.target) }), true);
  document.addEventListener('change', (event) => {
    if (event.target instanceof Element) browserEvent('change', { control: controlName(event.target) });
  }, true);
  window.addEventListener('error', (event) => {
    const position = event.lineno ? ` (${event.lineno}:${event.colno || 0})` : '';
    const message = typeof event.message === 'string' ? event.message : 'A browser resource could not be loaded.';
    browserEvent('error', { control: basename(event.filename), detail: `${message}${position}`.slice(0, 1000) });
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    const message = event.reason instanceof Error ? event.reason.message : 'An unhandled browser task failed.';
    browserEvent('error', { control: 'unhandled-promise', detail: message.slice(0, 1000) });
  });
  window.addEventListener('online', () => {
    window.clearTimeout(timer);
    delay = 600;
    send();
  });
  window.addEventListener('pagehide', () => {
    if (pending.length && navigator.sendBeacon) {
      const body = JSON.stringify({ session, events: pending.slice(0, batchSize) });
      navigator.sendBeacon('/api/diagnostics/browser', new Blob([body], { type: 'application/json' }));
    }
  });
  browserEvent('view');
}
