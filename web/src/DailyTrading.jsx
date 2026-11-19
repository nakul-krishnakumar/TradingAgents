import { useEffect, useMemo, useState } from 'react';
import {
  Activity, CalendarDays, ChartCandlestick, CircleHelp, Clock3,
  ExternalLink, FlaskConical, ListFilter, LoaderCircle, Radio, RefreshCw, Search,
} from 'lucide-react';
import { api, dateLabel, makeUrl, money, number, signed, todayIST, tone } from './api';
import { DailyChart } from './DailyChart';
import { DailyAutoTrade } from './DailyAutoTrade';
import ModelLog from './ModelLog';
import './daily.css';

const PHASE = { premarket: 'Premarket', open: 'Regular session', 'after-hours': 'After hours', closed: 'Market closed', unverified: 'Session unverified' };
const STATUS = {
  watch: 'Watching', confirmed: 'Trigger confirmed', open: 'Paper trade open', missed: 'Missed entry', expired: 'Expired',
  stop: 'Stop reached', target: 'Target reached', 'time-exit': 'Time exit', 'data-gap': 'Data gap',
};
const RISK = { low: 'Low', medium: 'Medium', high: 'High', 'very-high': 'Very high' };
const SORTS = { priority: 'Scanner order', reward: 'Highest reward / risk', risk: 'Lowest capital at risk', volume: 'Highest relative volume', name: 'Instrument name' };
const blankFilters = { query: '', strategy: '', risk: '', status: '', sort: 'priority' };
const clock = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

function timeLabel(stamp) {
  if (!stamp) return '—';
  if (/^\d\d:\d\d$/.test(stamp)) return `${stamp} IST`;
  const time = new Date(typeof stamp === 'number' ? stamp * 1000 : stamp);
  return Number.isNaN(time.valueOf()) ? String(stamp) : `${clock.format(time)} IST`;
}

const asNumber = (value) => value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : null;
const rupees = (value) => money(asNumber(value), 'INR');
const rate = (value) => asNumber(value) === null ? '—' : `${number(asNumber(value))}%`;
const ratio = (value) => asNumber(value) === null ? '—' : `${number(asNumber(value))}×`;
const ideaKey = (idea) => idea.id || `${idea.symbol}:${idea.strategy}`;
const riskKey = (idea) => String(idea.risk?.level || idea.risk?.label || idea.risk || '').toLowerCase().replace(/[ _]+/g, '-');
const statusLabel = (status) => STATUS[status] || String(status || 'watch').replace(/[-_]+/g, ' ');
const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

function ideaState(idea) {
  return idea.status === 'confirmed' && idea.live ? 'Entry condition met' : statusLabel(idea.status);
}

function useDashboard(day, refresh) {
  const [snapshot, setSnapshot] = useState(null);
  const [failure, setFailure] = useState(null);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const path = day ? makeUrl('/api/daily', { day }) : '/api/daily';
        const result = await api(path, { signal: controller.signal });
        if (!controller.signal.aborted) { setSnapshot({ day, data: result }); setFailure(null); }
      } catch (err) {
        if (!controller.signal.aborted) setFailure({ day, message: err.message });
      } finally { inFlight = false; }
    }
    load();
    const timer = window.setInterval(load, 15000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [day, refresh]);
  return [snapshot?.day === day ? snapshot.data : null, failure?.day === day ? failure.message : '',
    (result) => setSnapshot({ day, data: result })];
}

function useDailyChart(symbol, day, snapshot) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!symbol || !day) return undefined;
    const controller = new AbortController();
    api(makeUrl('/api/daily/chart', { symbol, day }), { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) { setResult(data); setError(null); } })
      .catch((err) => { if (!controller.signal.aborted) setError({ symbol, day, message: err.message }); });
    return () => controller.abort();
  }, [symbol, day, snapshot]);
  const matches = (entry) => entry && entry.symbol === symbol && entry.day === day;
  return [matches(result) ? result : null, matches(error) ? error.message : ''];
}

function SourceLink({ href, children }) {
  if (typeof href !== 'string' || !href.startsWith('https://')) return null;
  try {
    return <a className="daily-source-link" href={href} rel="noreferrer" target="_blank">{children || new URL(href).hostname}<ExternalLink size={12} /></a>;
  } catch { return null; }
}

function RiskTag({ idea }) {
  const key = riskKey(idea);
  return RISK[key] ? <span className={`daily-risk daily-risk-${key}`}>{RISK[key]} risk</span> : null;
}

function SessionControls({ data, day, setDay, today, run, runningAction, saveBudget }) {
  const [amount, setAmount] = useState(null);
  const archive = Boolean(day && day !== today);
  const days = [...new Set([today, day, ...(data?.history || [])].filter(Boolean))].sort().reverse();
  const next = data?.next_scan;
  const feed = data?.feed;
  const schedulerText = archive ? 'Saved snapshot' : !data ? 'Checking schedule' : data.running ? 'Desk working' : data.scheduled ? 'Schedule active' : 'Schedule paused';

  async function submit(event) {
    event.preventDefault();
    if (await saveBudget(Number(amount))) setAmount(null);
  }

  return <section className="daily-session panel" aria-label="Trading session and budget">
    <div className="daily-session-main">
      <div className="daily-session-badge"><i className={data?.phase === 'open' ? 'daily-dot-active' : ''} />{archive ? 'Past session' : PHASE[data?.phase] || 'Checking session'}</div>
      <div className="daily-session-title">NSE cash equities</div>
      <p className="daily-schedule-line"><Clock3 size={15} />{schedulerText}{!archive && next && ` · Next scan ${/^\d{4}-/.test(next) && String(next).slice(0, 10) !== today ? `${dateLabel(next, false)} · ` : ''}${timeLabel(next)}`}{data?.updated_at && ` · Updated ${timeLabel(data.updated_at)}`}</p>
      {['closed', 'unverified'].includes(data?.phase) && data?.session?.note && <p className="daily-schedule-line">{data.session.note}</p>}
    </div>
    <div className="daily-session-actions">
      <form className="daily-budget" onSubmit={submit} key={day || 'today'}>
        <label htmlFor="daily-budget">Daily capital limit <span>INR</span></label>
        <div className="daily-budget-input"><span aria-hidden="true">₹</span><input id="daily-budget" type="number" inputMode="decimal" min="0" max="1000000000" step=".01" required
          value={amount ?? data?.budget ?? 5000} disabled={archive || !data || runningAction === 'budget'} onChange={(event) => setAmount(event.target.value)} />
          <button type="submit" title="Save today's limit" disabled={archive || amount === null || runningAction === 'budget'}>Save</button></div>
      </form>
      <div className="daily-session-tools">
        <label className="daily-session-date"><CalendarDays size={15} /><select aria-label="Trading date" value={day || today} onChange={(event) => { setAmount(null); setDay(event.target.value === today ? '' : event.target.value); }}>
          {days.map((value) => <option key={value} value={value}>{value === today ? 'Today' : dateLabel(value, false)}</option>)}
        </select></label>
        <button type="button" className="button daily-scan" disabled={archive || !data || data.running || Boolean(runningAction)} onClick={run}>
          {data?.running || runningAction === 'scan' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
          {data?.running ? 'In progress' : 'Scan now'}
        </button>
      </div>
    </div>
    {feed && <div className="daily-feed-line"><Radio size={14} /><strong>{feed.name || 'Market data'}</strong>{feed.mode && <span className="daily-feed-mode">{String(feed.mode).replace(/[-_]+/g, ' ')}</span>}
      {feed.note && <span>{feed.note}</span>}</div>}
  </section>;
}

function IdeaList({ ideas, candidates, selection, setSelection, loading }) {
  const [chosenView, setView] = useState(null);
  const view = chosenView ?? (ideas.length ? 'setups' : 'watchlist');
  const [filters, setFilters] = useState(blankFilters);
  const update = (key, value) => setFilters((prior) => ({ ...prior, [key]: value }));
  const strategies = [...new Map(ideas.map((idea) => [idea.strategy, idea.label || idea.strategy])).entries()];
  const visible = useMemo(() => {
    const query = filters.query.toLowerCase().trim();
    const rows = (view === 'setups' ? ideas : candidates).filter((row) => {
      if (!`${row.symbol} ${row.name || ''}`.toLowerCase().includes(query)) return false;
      if (view === 'watchlist') return true;
      return (!filters.strategy || filters.strategy === row.strategy)
        && (!filters.risk || filters.risk === riskKey(row))
        && (!filters.status || filters.status === row.status);
    });
    if (view !== 'setups' || filters.sort === 'priority') return rows;
    const compares = {
      reward: (a, b) => (asNumber(b.size?.reward_risk) ?? -Infinity) - (asNumber(a.size?.reward_risk) ?? -Infinity),
      risk: (a, b) => (asNumber(a.size?.budget_risk_pct) ?? Infinity) - (asNumber(b.size?.budget_risk_pct) ?? Infinity),
      volume: (a, b) => (asNumber(b.relative_volume) ?? -Infinity) - (asNumber(a.relative_volume) ?? -Infinity),
      name: (a, b) => a.symbol.localeCompare(b.symbol),
    };
    return rows.sort(compares[filters.sort]);
  }, [candidates, filters, ideas, view]);

  return <section className="panel daily-idea-panel" aria-label="Figure out what to watch">
    <div className="daily-list-header"><div><h2>Trade desk</h2><p>Ranked stocks and strategy triggers</p></div><ListFilter size={17} /></div>
    <div className="daily-list-controls">
      <div className="segmented daily-list-tabs" aria-label="Trading list">
        <button type="button" aria-pressed={view === 'setups'} onClick={() => setView('setups')}>Setups <span>{ideas.length}</span></button>
        <button type="button" aria-pressed={view === 'watchlist'} onClick={() => setView('watchlist')}>Watchlist <span>{candidates.length}</span></button>
      </div>
      <label className="daily-search"><Search size={15} /><input type="search" aria-label="Search by ticker or company" placeholder="Ticker or company" value={filters.query} onChange={(event) => update('query', event.target.value)} /></label>
      {view === 'setups' && <div className="daily-filters">
        <select aria-label="Filter by strategy" value={filters.strategy} onChange={(event) => update('strategy', event.target.value)}>
          <option value="">All strategies</option>{strategies.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select aria-label="Filter by risk" value={filters.risk} onChange={(event) => update('risk', event.target.value)}>
          <option value="">All risk levels</option>{Object.entries(RISK).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select aria-label="Filter by status" value={filters.status} onChange={(event) => update('status', event.target.value)}>
          <option value="">All statuses</option>{Object.entries(STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select aria-label="Sort trade setups" value={filters.sort} onChange={(event) => update('sort', event.target.value)}>
          {Object.entries(SORTS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </div>}
    </div>
    <div className="daily-list-rows" tabIndex={visible.length > 8 ? 0 : undefined} aria-label={view === 'setups' ? 'Trade setup results' : 'Watchlist results'}>
      {visible.map((row) => {
        const setup = view === 'setups';
        const key = setup ? ideaKey(row) : `watch:${row.symbol}`;
        return <button type="button" className="daily-idea" key={key} aria-pressed={selection === key} onClick={() => setSelection(key)}>
          <span className="daily-idea-text"><strong>{row.symbol?.replace(/\.NS$/, '')}</strong><small>{setup ? row.label || row.strategy : row.name || 'NSE equity'}</small></span>
          <span className="daily-idea-value">{setup ? <><RiskTag idea={row} /><small>{ideaState(row)}</small></> : <>
            <strong>{rupees(row.last ?? row.preopen_price ?? row.prior_close)}</strong><small className={tone(asNumber(row.prior_change))}>
              {row.last == null && row.preopen_price != null ? 'Indicative auction price' : `Prior session ${signed(asNumber(row.prior_change))}`}
            </small>
          </>}</span>
        </button>;
      })}
      {!visible.length && <p className="daily-list-empty">{loading ? 'Loading the session…' : filters.query || filters.strategy || filters.risk || filters.status ? 'No results match these filters.' : view === 'setups' ? 'Setups appear when session data meets the strategy rules.' : 'The watchlist is awaiting a session scan.'}</p>}
    </div>
  </section>;
}

function ChartPanel({ chart, chartError, candidate, day, idea, symbol, onResearch }) {
  const recent = chart?.bars?.at(-1);
  const quote = candidate?.last ?? recent?.close ?? candidate?.preopen_price ?? candidate?.prior_close;
  const caption = candidate?.last != null ? 'Last observed quote' : recent ? 'Last candle close' : candidate?.preopen_price != null ? 'Indicative auction price' : 'Previous final close';
  const observed = candidate?.last != null ? candidate.as_of : chart?.as_of ?? candidate?.preopen_at;
  const name = candidate?.name || idea?.name;

  return <section className="panel daily-chart-panel" aria-label="Instrument chart and trade plan">
    <div className="daily-chart-heading">
      <div><h2>{symbol || 'Intraday chart'}</h2>{symbol && <p>{name || 'NSE equity'}{idea?.label && ` · ${idea.label}`}</p>}</div>
      {symbol && <div className="daily-quote"><strong>{rupees(quote)}</strong><small>{caption}{observed && ` · ${timeLabel(observed)}`}</small>
        {onResearch && <button className="button button-small button-outline" type="button" onClick={() => onResearch({ symbol, name: name || symbol, kind: 'stock', exchange: 'NSE' })}>Research stock</button>}
      </div>}
    </div>
    {chart?.bars?.length > 0 ? <DailyChart bars={chart.bars} symbol={symbol} day={day} idea={idea} /> : <div className="daily-chart-empty">
      <ChartCandlestick size={26} /><strong>{chartError || (chart ? 'No intraday candles for this session' : symbol ? 'Loading intraday candles…' : 'Select a stock or setup')}</strong>
    </div>}
    {symbol && <div className="daily-chart-note"><span>{chart?.source || candidate?.feed || 'NSE cash equities'}{chart?.as_of && ` · As of ${timeLabel(chart.as_of)}`}</span>
      {chart?.bars?.length > 0 && <div><span className="daily-chart-legend"><i />Session VWAP</span><span>Volume</span>{idea && <span>Trigger · Entry cap · Stop · Target</span>}</div>}
    </div>}
    {idea && <TradePlan idea={idea} />}
  </section>;
}

function TradePlan({ idea }) {
  const size = idea.size || {};
  const quote = idea.live ? idea.live_quote : null;
  const prices = [['Trigger', idea.trigger], ['Entry cap', idea.entry_cap], ['Stop', idea.stop], ['Target', idea.target]];
  const amount = asNumber(size.quantity);
  return <div className="daily-trade-plan">
    <div className="daily-plan-title"><h3>{ideaState(idea)}</h3><div>{idea.live && idea.status === 'confirmed' && <span className="daily-signal-label daily-signal-live">Fresh broker signal</span>}{!idea.live && <span className="daily-signal-label">Research only</span>}<RiskTag idea={idea} /></div></div>
    {asNumber(quote?.ask) !== null && <p className="daily-fill-line">Live ask {rupees(quote.ask)}{quote.at && ` · ${timeLabel(quote.at)}`}</p>}
    <dl className="daily-prices">{prices.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{rupees(value)}</dd></div>)}</dl>
    <dl className="daily-size-grid">
      <div><dt>Shares</dt><dd>{amount === null ? '—' : number(amount, 0)}</dd></div>
      <div><dt>Planned capital</dt><dd>{rupees(size.capital)}</dd></div>
      <div><dt>Estimated loss at stop</dt><dd>{rupees(size.estimated_loss)}</dd></div>
      <div><dt>Daily capital at risk</dt><dd>{rate(size.budget_risk_pct)}</dd></div>
      <div><dt>Stop distance</dt><dd>{rate(size.stop_distance_pct)}</dd></div>
      <div><dt>Reward / risk</dt><dd>{ratio(size.reward_risk)}</dd></div>
      <div><dt>Est. round-trip cost</dt><dd>{rupees(size.estimated_round_trip)}</dd></div>
      <div><dt>Relative volume</dt><dd>{ratio(idea.relative_volume)}</dd></div>
    </dl>
    {(idea.entry_at || idea.exit_at) && <p className="daily-fill-line">
      {idea.entry_at && asNumber(idea.entry) !== null && <span>Paper entry {rupees(idea.entry)} · {timeLabel(idea.entry_at)}</span>}
      {idea.exit_at && <span>{asNumber(idea.exit_price) !== null ? `Paper exit ${rupees(idea.exit_price)} · ` : ''}{timeLabel(idea.exit_at)}{idea.exit_reason && ` · ${idea.exit_reason}`}</span>}
    </p>}
    {idea.exit_reason && !idea.exit_at && <p className="daily-fill-line">{idea.exit_reason}</p>}
    {idea.reason && <p className="daily-plan-reason">{Array.isArray(idea.reason) ? idea.reason.join(' ') : idea.reason}</p>}
    <p className="daily-plan-note"><CircleHelp size={14} />Risk levels use stop distance. Capital at risk estimates the loss at the stop as a share of the daily limit. Gaps and slippage can increase losses. Sizes are per idea.</p>
  </div>;
}

const filingKey = (filing) => `${filing.symbol}|${filing.at || filing.timestamp}|${filing.link || filing.url}|${filing.title}`;

function DisclosureList({ title, filings }) {
  if (!filings.length) return null;
  return <div className="daily-filings"><h3>{title}</h3>{filings.map((item) => {
    const stamp = item.timestamp || item.at;
    return <div key={filingKey(item)}>
      {item.symbol && <strong>{item.symbol}</strong>}<SourceLink href={item.link || item.url}>{item.title || item.description || item.label}</SourceLink>
      {stamp && <small>{dateLabel(stamp, false)} · {timeLabel(stamp)}</small>}
      {item.summary && <p>{item.summary}</p>}
    </div>;
  })}</div>;
}

function PremarketBrief({ brief, latestFilings = [] }) {
  const { links = [], filings = [], title, summary, context, method } = brief || {};
  const sources = Array.isArray(links) ? links : Object.entries(links).map(([label, href]) => ({ label, href }));
  const seen = new Set(filings.map(filingKey));
  return <section className="panel daily-brief" aria-label="Premarket research">
    <div className="daily-list-header"><div><h2>{title || 'Premarket brief'}</h2><p>{method || 'NSE session research'}</p></div><Activity size={17} /></div>
    <div className="daily-brief-content">
      <p>{Array.isArray(summary) ? summary.join(' ') : summary || 'The brief appears after the premarket scan.'}</p>
      {typeof context === 'string' && <p>{context}</p>}
      {Array.isArray(context) && context.length > 0 && <ul>{context.map((item, index) => <li key={index}>{typeof item === 'string' ? item : item.text || item.title || item.label}</li>)}</ul>}
      {sources.length > 0 && <div className="daily-source-links">{sources.map((item, index) => typeof item === 'string' ? <SourceLink href={item} key={index} /> :
        <SourceLink href={item.href || item.url || item.link} key={index}>{item.label || item.title || item.name}</SourceLink>)}</div>}
      <DisclosureList title="Intraday disclosures" filings={latestFilings.filter((item) => !seen.has(filingKey(item)))} />
      <DisclosureList title="Brief disclosures" filings={filings} />
    </div>
  </section>;
}

function ReplayPanel({ replay, available, pending, onRun }) {
  const rows = replay?.strategies || [];
  const showUnresolved = rows.some((row) => asNumber(row.unresolved) !== null);
  return <section className="panel daily-replay" aria-labelledby="daily-replay-heading">
    <div className="daily-list-header">
      <div><h2 id="daily-replay-heading">Strategy replay</h2><p>Earlier candles with estimated trading costs</p></div>
      <button className="button button-small button-outline" type="button" disabled={!available || pending} onClick={onRun}>
        {pending ? <LoaderCircle size={15} className="spin" /> : <FlaskConical size={15} />}Run replay
      </button>
    </div>
    {replay ? <div className="daily-replay-content">
      <p>{number(asNumber(replay.sessions), 0)} symbol sessions through {dateLabel(replay.through)} · {rupees(replay.budget)} capital limit</p>
      {replay.symbols?.length > 0 && <p>{replay.symbols.join(' · ')}</p>}
      <div className="table-scroll"><table><thead><tr><th scope="col">Strategy</th><th scope="col">Closed trades</th><th scope="col">Profitable trades</th>{showUnresolved && <th scope="col">Unresolved</th>}<th scope="col">Net P&L</th><th scope="col">Average P&L</th></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.strategy}>
          <th scope="row">{row.label}</th><td>{number(asNumber(row.trades), 0)}</td><td>{number(asNumber(row.profitable), 0)}</td>
          {showUnresolved && <td>{number(asNumber(row.unresolved), 0)}</td>}
          <td className={tone(asNumber(row.net))}>{row.trades ? rupees(row.net) : '—'}</td><td className={tone(asNumber(row.average))}>{rupees(row.average)}</td>
        </tr>)}</tbody></table></div>
      {replay.note && <p>{replay.note}</p>}
    </div> : <p className="daily-replay-empty">{available ? 'Replay the watchlist against up to 15 earlier sessions per stock.' : 'Replay becomes available after the desk has a watchlist for today.'}</p>}
  </section>;
}

export function DailyTrading({ onResearch }) {
  const [day, setDay] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState(null);
  const [action, setAction] = useState('');
  const [feedback, setFeedback] = useState('');
  const [actionError, setActionError] = useState('');
  const [data, error, setData] = useDashboard(day, refresh);
  const today = (day ? null : data?.day) || todayIST();
  const ideas = data?.ideas || [];
  const candidates = data?.candidates || [];
  const idea = selection ? ideas.find((item) => ideaKey(item) === selection) : ideas[0];
  const candidate = (idea ? candidates.find((item) => item.symbol === idea.symbol) : candidates.find((item) => `watch:${item.symbol}` === selection)) || (!idea && candidates[0]);
  const symbol = idea?.symbol || candidate?.symbol;
  const selectedKey = idea ? ideaKey(idea) : candidate ? `watch:${candidate.symbol}` : null;
  const [chart, chartError] = useDailyChart(symbol, data?.day, data?.updated_at || data?.slot);

  function chooseDay(value) {
    setSelection(null);
    setDay(value === today ? '' : value);
  }

  async function perform(kind, path, body, message) {
    setAction(kind); setActionError(''); setFeedback('');
    try {
      const result = await post(path, body);
      if (result.day === today) setData(result);
      setRefresh((previous) => previous + 1);
      setFeedback(result.accepted === false ? 'The desk is busy. Check the session status and try again.' : message);
      return true;
    } catch (err) { setActionError(err.message); return false; }
    finally { setAction(''); }
  }

  return <div className="daily-workspace">
    <SessionControls data={data} day={day} today={today} setDay={chooseDay} runningAction={action}
      saveBudget={(budget) => perform('budget', '/api/daily/budget', { budget }, 'Daily limit saved.')}
      run={() => perform('scan', '/api/daily/scan', {}, 'Scan requested. This page updates automatically.')} />
    {(error || actionError) && <p className="form-error" role="alert">{actionError || error}</p>}
    {feedback && <p className="daily-feedback" role="status">{feedback}</p>}
    <DailyAutoTrade data={data} archive={Boolean(day)} busy={Boolean(action)} timeLabel={timeLabel} onDay={chooseDay}
      onChange={(enabled, sessions) => perform('auto', '/api/daily/auto-trade', { enabled, sessions },
        enabled ? 'Auto trade scheduled.' : 'Auto trade stopped for new entries.')} />
    {data?.warnings?.length > 0 && <ul className="daily-warnings" aria-label="Trading session messages">
      {data.warnings.map((warning, index) => <li key={index}>{typeof warning === 'string' ? warning : warning.message}</li>)}
    </ul>}
    <div className="daily-content-grid">
      <IdeaList ideas={ideas} candidates={candidates} selection={selectedKey} setSelection={setSelection} loading={!data && !error} />
      <ChartPanel chart={chart} chartError={chartError} symbol={symbol} candidate={candidate} idea={idea} day={data?.day} onResearch={onResearch} />
    </div>
    <PremarketBrief brief={data?.brief} latestFilings={data?.latest_filings} />
    <ReplayPanel replay={data?.research} available={candidates.length > 0 && !day} pending={data?.running || Boolean(action)}
      onRun={() => perform('replay', '/api/daily/replay', {}, 'Strategy replay requested.')} />
    {data?.model_log && <ModelLog key={data.day} job={{ id: data.day, status: data.running ? 'running' : 'completed', model_log: true }}
      endpoint="/api/daily/model-log" parameters={{ day: data.day }} />}
  </div>;
}
