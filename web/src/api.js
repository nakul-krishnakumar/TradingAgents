export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    const detail = result.detail;
    throw new Error(typeof detail === 'string' ? detail
      : Array.isArray(detail) ? detail.map((item) => item.msg).join('. ')
        : `Request failed (${response.status})`);
  }
  return response.json();
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

export const tone = (value) => !Number.isFinite(value) || value === 0 ? '' : value > 0 ? 'positive' : 'negative';
export const typeLabel = { stock: 'Equity', etf: 'ETF', fund: 'Mutual fund', bond: 'Bond', index: 'Index', crypto: 'Crypto', other: 'Instrument' };
export const analysts = {
  market: { name: 'Market', description: 'Price action and technicals' },
  news: { name: 'News', description: 'Headlines and macro context' },
  fundamentals: { name: 'Fundamentals', description: 'Financial statements and valuation' },
  social: { name: 'Sentiment', description: 'Public discussion and positioning' },
};
export const openJob = (job) => job.status === 'queued' || job.status === 'running';
