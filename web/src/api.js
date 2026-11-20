import { browserEvent, requestTraceHeaders } from './telemetry';

export async function api(path, options = {}) {
  const { background, ...request } = options;
  const headers = new Headers(request.headers);
  for (const [name, value] of Object.entries(requestTraceHeaders({ interactive: !background }))) headers.set(name, value);
  if (request.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const track = !path.startsWith('/api/diagnostics');
  const route = path.split('?')[0].replace(/[a-f0-9]{32}/gi, '{id}');
  let response;
  try {
    response = await fetch(path, { ...request, headers });
  } catch (err) {
    if (track && err.name !== 'AbortError') browserEvent('api_error', { control: 'network', detail: `${request.method || 'GET'} ${route}` });
    throw err;
  }
  const requestId = response.headers.get('X-Request-ID');
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const detail = result.detail;
    const message = typeof detail === 'string' ? detail
      : Array.isArray(detail) ? detail.map((item) => item.msg).join('. ')
        : `Request failed (${response.status})`;
    if (track) browserEvent('api_error', { control: 'api-response', detail: `${request.method || 'GET'} ${route}`, request_id: requestId, status: response.status });
    const error = new Error(response.status >= 500 && requestId ? `${message} Request ID ${requestId}.` : message);
    error.requestId = requestId;
    error.status = response.status;
    throw error;
  }
  try {
    return await response.json();
  } catch (err) {
    if (track && err.name !== 'AbortError') browserEvent('api_error', { control: 'invalid-json', detail: route, request_id: requestId });
    throw err;
  }
}

export function makeUrl(path, parameters) {
  return `${path}?${new URLSearchParams(parameters)}`;
}

export const todayIST = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });

export function dateLabel(date, withYear = true) {
  if (!date) return '—';
  const normalized = /^\d{8}$/.test(date) ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : date;
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', ...(withYear && { year: 'numeric' }),
  }).format(new Date(normalized));
}

export function number(value, digits = 2) {
  return Number.isFinite(value) ? value.toLocaleString('en-IN', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  }) : '—';
}

export function money(value, currency, digits = 2) {
  if (!Number.isFinite(value)) return '—';
  const prefix = { INR: '₹', USD: '$', GBP: '£', EUR: '€' }[currency] || '';
  return `${prefix}${number(value, digits)}`;
}

export function signed(value, suffix = '%') {
  return Number.isFinite(value) ? `${value >= 0 ? '+' : '−'}${number(Math.abs(value))}${suffix}` : '—';
}

export function signedMoney(value, currency) {
  return Number.isFinite(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${money(Math.abs(value), currency)}` : '—';
}

export const tone = (value) => !Number.isFinite(value) || value === 0 ? '' : value > 0 ? 'positive' : 'negative';
export const typeLabel = { stock: 'Stock', etf: 'ETF', fund: 'Mutual fund', bond: 'Bond', index: 'Index', crypto: 'Crypto', other: 'Asset' };
export const analysts = {
  market: { name: 'Price and trading', description: 'How the price and trading activity have changed' },
  news: { name: 'News', description: 'Company news and the wider market' },
  fundamentals: { name: 'Company finances', description: 'Sales, profits, debt, and what investors are paying' },
  social: { name: 'Public opinion', description: 'What investors are saying in public discussions' },
};
export const openJob = (job) => job.status === 'queued' || job.status === 'running';
