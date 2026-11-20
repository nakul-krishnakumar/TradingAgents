import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, CalendarDays, ChartCandlestick, Clock3,
  ExternalLink, FlaskConical, ListFilter, LoaderCircle, Radio, RefreshCw, Search,
} from 'lucide-react';
import { api, dateLabel, makeUrl, money, number, signed, signedMoney, todayIST, tone } from './api';
import { DailyChart } from './DailyChart';
import { DailyAutoTrade, paperOrderLabel, paperStrategies } from './DailyAutoTrade';
import { Help, HelpDetails, HelpTitle, WithHelp } from './Help';
import ModelLog from './ModelLog';
import './daily.css';

const PHASE = { premarket: 'Before the market opens', open: 'Market open', 'after-hours': 'Market closed for today', closed: 'Market closed', unverified: 'Checking market hours' };
const STATUS = {
  watch: 'Watching the price', confirmed: 'Buy conditions reached', open: 'Test buy price reached', missed: 'Buy price missed', expired: 'Idea expired',
  stop: 'Loss limit reached', target: 'Profit price reached', 'time-exit': 'Day’s time limit reached', 'data-gap': 'Missing prices',
};
const RISK = { low: 'Low', medium: 'Medium', high: 'High', 'very-high': 'Very high' };
const SORTS = { priority: 'Default order', reward: 'Most gain per rupee risked', risk: 'Smallest estimated loss', volume: 'Most trading vs usual', name: 'Stock symbol' };
const blankFilters = { query: '', strategy: '', risk: '', status: '', sort: 'priority' };
const riskHelp = 'Risk levels measure how far the planned buy price is from the price set to limit the loss. A higher level means a larger price drop to that point. The actual outcome depends on how the stock moves.';
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
  return idea.status === 'confirmed' && idea.live ? 'Latest buy price is in range' : statusLabel(idea.status);
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
        const result = await api(path, { signal: controller.signal, background: true });
        if (!controller.signal.aborted) { setSnapshot({ day, data: result }); setFailure(null); }
      } catch (err) {
        if (!controller.signal.aborted) setFailure({ day, message: err.message });
      } finally { inFlight = false; }
    }
    load();
    const timer = day ? null : window.setInterval(load, 10000);
    return () => { controller.abort(); if (timer !== null) window.clearInterval(timer); };
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
  const working = data?.operation || data?.running || runningAction === 'scan';
  const schedulerText = archive ? 'Saved market data' : !data ? 'Checking schedule' : data.operation === 'replay' ? 'Testing strategies'
    : working ? 'Checking the market' : data.scheduled ? 'Automatic checks on' : 'Automatic checks off';
  const paperSession = data?.auto_trade?.session;
  const capital = data?.suggested_capital;

  async function submit(event) {
    event.preventDefault();
    if (await saveBudget(Number(amount))) setAmount(null);
  }

  return <section className="daily-session panel" aria-label="Trading session and budget">
    <div className="daily-session-main">
      <WithHelp label="Market status" text="Shows whether the NSE market is open, closed, awaiting confirmation, or showing a saved day. On a regular trading day the market opens at 09:15 and closes at 15:30 IST.">
        <span className="daily-session-badge"><i className={data?.phase === 'open' ? 'daily-dot-active' : ''} />{archive ? 'Past trading day' : PHASE[data?.phase] || 'Checking market hours'}</span>
      </WithHelp>
      <p className="daily-schedule-line"><Clock3 size={15} />{schedulerText}{!archive && next && ` · Next check ${String(next).slice(0, 10) !== today ? `${dateLabel(next, false)} · ` : ''}${timeLabel(next)}`}
        <Help label="Market check schedule" text="Shows whether automatic checks are on, what the desk is doing, and when it plans to check again. The desk prepares a morning report before the market opens and checks prices about every five minutes during the session." /></p>
      {['closed', 'unverified'].includes(data?.phase) && data?.session?.note && <p className="daily-schedule-line">{data.session.note}</p>}
    </div>
    <div className="daily-session-actions">
      <form className="daily-budget" data-log="daily.save-budget" onSubmit={submit} key={day || 'today'}>
        <WithHelp label="Paper money limit"
          text="Set the virtual rupee limit for today and press Save. The default is ₹5,000. Set it before Auto Trade opens its practice account for the day, because an account already started keeps its original limit.">
          <label htmlFor="daily-budget">Paper money limit</label>
        </WithHelp>
        <div className="daily-budget-input"><span aria-hidden="true">₹</span><input id="daily-budget" type="number" inputMode="decimal" min="0" max="1000000000" step=".01" required
          value={amount ?? data?.budget ?? 5000} disabled={archive || !data || runningAction === 'budget'} onChange={(event) => setAmount(event.target.value)} />
          <button type="submit" title="Save today's limit" disabled={archive || amount === null || runningAction === 'budget'}>Save</button></div>
      </form>
      <div className="daily-session-tools">
        <WithHelp label="Trading date" text="Choose Today for the current desk or select a recorded date to see that day’s charts, checks, and paper trades.">
          <label className="daily-session-date"><CalendarDays size={15} /><select aria-label="Trading date" value={day || today} onChange={(event) => { setAmount(null); setDay(event.target.value === today ? '' : event.target.value); }}>
            {days.map((value) => <option key={value} value={value}>{value === today ? 'Today' : dateLabel(value)}</option>)}
          </select></label>
        </WithHelp>
        <WithHelp label="Check now" text="Request a market check for today. Look in Market checks to see whether it’s running and what it found. The button is disabled while the desk is working.">
          <button type="button" className="button daily-scan" data-log="daily.check-now" disabled={archive || !data || working || Boolean(runningAction)} onClick={run}>
            {working && !archive ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
            {working && !archive ? 'In progress' : 'Check now'}
          </button>
        </WithHelp>
      </div>
    </div>
    {!archive && (capital || data?.phase === 'premarket') && <aside className="daily-capital" aria-labelledby="daily-capital-title">
      <div>
        <WithHelp label="Suggested paper capital"
          text="Estimates the paper capital needed for one share in at least half the sampled stocks, including modeled costs. It uses the active trial’s risk limit or the 0.65% default. The premarket estimate uses the prior NSE session’s high–low range as a planning proxy.">
          <h3 id="daily-capital-title">Suggested paper capital</h3>
        </WithHelp>
        {capital ? <p>{capital.basis === 'setups' ? 'Fresh long setup plans' : 'NSE prior-session ranges'} · Fits one share in {capital.affordable} of {capital.sample} stocks at {(capital.risk_bps / 100).toFixed(2)}% modeled risk</p>
          : <p>Waiting for usable NSE watchlist prices.</p>}
      </div>
      {capital && <strong>{rupees(capital.amount)}</strong>}
    </aside>}
    {paperSession && !archive && Number(paperSession.budget) !== data.budget && <p className="daily-session-note">Auto Trade is using {rupees(paperSession.budget)}, the limit when today’s practice account started.</p>}
    {feed && <HelpDetails className="daily-feed-line" wrapperClassName="daily-feed-help" label="Price data sources"
      summary={<><Radio size={14} /> Price data from {feed.name || 'market providers'}</>}
      text="Shows where the latest price data came from. Public quotes can arrive after the trades they describe. Open this line to see how the desk is getting prices on this date.">
      <p>{feed.mode === 'broker' ? 'The desk checks broker quotes when available.' : 'The desk uses public 5-minute prices, which can arrive after the trade time.'} {feed.note}</p>
    </HelpDetails>}
  </section>;
}

function IdeaList({ ideas, candidates, selection, setSelection, loading }) {
  const [chosenView, setView] = useState(null);
  const view = chosenView ?? (ideas.length ? 'setups' : 'watchlist');
  const [filters, setFilters] = useState(blankFilters);
  const update = (key, value) => setFilters((prior) => ({ ...prior, [key]: value }));
  const strategies = [...new Map(ideas.map((idea) => [idea.strategy, paperStrategies[idea.strategy]?.label || idea.label || idea.strategy])).entries()];
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
    <div className="daily-list-header"><div><HelpTitle label="Stocks to watch" text="Trade ideas are possible setups generated by the rules. Stocks checked includes the stocks the desk reviewed, even if no setup was found. Select a row to see its chart and any example buy and sell levels." /><p>Explore prices and possible trade plans.</p></div><ListFilter size={17} /></div>
    <div className="daily-list-controls">
      <div className="segmented daily-list-tabs" aria-label="Trading list">
        <button type="button" aria-pressed={view === 'setups'} onClick={() => setView('setups')}>Trade ideas <span>{ideas.length}</span></button>
        <button type="button" aria-pressed={view === 'watchlist'} onClick={() => setView('watchlist')}>Stocks checked <span>{candidates.length}</span></button>
      </div>
      <WithHelp label="Search stocks to watch" text="Type a symbol or part of a company name to filter the current tab. For example, type Reliance to find its row if it is in the current stock list.">
        <label className="daily-search"><Search size={15} /><input type="search" aria-label="Search by stock symbol or company" placeholder="Stock symbol or company" value={filters.query} onChange={(event) => update('query', event.target.value)} /></label>
      </WithHelp>
      {view === 'setups' && <div className="daily-filters">
        <WithHelp label="Filter by strategy" text="Show ideas from one price pattern, such as a break above the morning high. Choose All strategies to see every pattern.">
          <select aria-label="Filter by strategy" value={filters.strategy} onChange={(event) => update('strategy', event.target.value)}>
            <option value="">All strategies</option>{strategies.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </WithHelp>
        <WithHelp label="Filter by risk" text={riskHelp}>
          <select aria-label="Filter by risk" value={filters.risk} onChange={(event) => update('risk', event.target.value)}>
            <option value="">All risk levels</option>{Object.entries(RISK).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </WithHelp>
        <WithHelp label="Filter by status" text="Choose a stage of the example plan, such as watching the price, reaching the buy conditions, or reaching the planned sell level. Completed Auto Trade orders are listed under BUY & SELL history.">
          <select aria-label="Filter by status" value={filters.status} onChange={(event) => update('status', event.target.value)}>
            <option value="">All statuses</option>{Object.entries(STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </WithHelp>
        <WithHelp label="Sort trade setups" text="Reorder the trade ideas by planned gain per rupee risked, estimated loss relative to today’s limit, trading activity compared with usual, or stock symbol.">
          <select aria-label="Sort trade setups" value={filters.sort} onChange={(event) => update('sort', event.target.value)}>
            {Object.entries(SORTS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select>
        </WithHelp>
      </div>}
    </div>
    <div className="daily-list-rows" tabIndex={visible.length > 8 ? 0 : undefined} aria-label={view === 'setups' ? 'Trade setup results' : 'Watchlist results'}>
      {visible.map((row) => {
        const setup = view === 'setups';
        const key = setup ? ideaKey(row) : `watch:${row.symbol}`;
        return <button type="button" className="daily-idea" key={key} aria-pressed={selection === key} onClick={() => setSelection(key)}>
          <span className="daily-idea-text"><strong>{row.symbol?.replace(/\.NS$/, '')}</strong><small>{setup ? paperStrategies[row.strategy]?.label || row.label || row.strategy : row.name || 'NSE stock'}</small></span>
          <span className="daily-idea-value">{setup ? <><RiskTag idea={row} /><small>{ideaState(row)}</small></> : <>
            <strong>{rupees(row.last ?? row.preopen_price ?? row.prior_close)}</strong><small className={tone(asNumber(row.prior_change))}>
              {row.last == null && row.preopen_price != null ? 'Estimated opening price' : `Previous day ${signed(asNumber(row.prior_change))}`}
            </small>
          </>}</span>
        </button>;
      })}
      {!visible.length && <p className="daily-list-empty">{loading ? 'Loading the trading day…' : filters.query || (view === 'setups' && (filters.strategy || filters.risk || filters.status)) ? 'No results match these filters.' : view === 'setups' ? 'Trade ideas appear when a stock comes close to one of the strategy rules.' : 'Stocks will appear after a market check.'}</p>}
    </div>
  </section>;
}

function ChartPanel({ panelRef, chart, chartError, candidate, day, idea, symbol, onResearch, orders }) {
  const recent = chart?.bars?.at(-1);
  const candleAt = candidate?.last != null ? candidate.as_of : chart?.as_of;
  const broker = candidate?.live_quote;
  const useBroker = broker?.last != null && broker.last_trade_at >= (candleAt ?? 0);
  const quote = useBroker ? broker.last : candidate?.last ?? recent?.close ?? candidate?.preopen_price ?? candidate?.prior_close;
  const caption = useBroker ? 'Upstox last trade' : candidate?.last != null || recent ? 'Latest 5-minute close' : candidate?.preopen_price != null ? 'Estimated opening price' : 'Previous day’s closing price';
  const observed = useBroker ? broker.last_trade_at : candleAt ?? candidate?.preopen_at;
  const name = candidate?.name || idea?.name;

  return <section className="panel daily-chart-panel" ref={panelRef} tabIndex={-1} aria-label="Stock price chart and buy or sell plan">
    <div className="daily-chart-heading">
      <div><HelpTitle label="Stock price chart" text="See five-minute prices and paper order markers. SHORT opens a short position and COVER buys it back. Dashed lines show levels for an example trade plan.">
        {symbol?.replace(/\.NS$/, '') || 'Stock price chart'}
      </HelpTitle>{symbol && <p>{name || 'NSE stock'}{idea && ` · ${paperStrategies[idea.strategy]?.label || idea.label}`}</p>}</div>
      {symbol && <div className="daily-quote"><strong>{rupees(quote)}</strong><small>{caption}{observed && ` · ${timeLabel(observed)}`}</small>
        {onResearch && <button className="button button-small button-outline" type="button" onClick={() => onResearch({ symbol, name: name || symbol, kind: 'stock', exchange: 'NSE' })}>Research stock</button>}
      </div>}
    </div>
    {chart?.bars?.length > 0 ? <DailyChart bars={chart.bars} symbol={symbol} day={day} idea={idea} orders={orders} /> : <div className="daily-chart-empty">
      <ChartCandlestick size={26} /><strong>{chartError || (chart ? 'No five-minute prices were saved for this stock on this day' : symbol ? 'Loading prices…' : 'Choose a stock or trade idea')}</strong>
    </div>}
    {symbol && <div className="daily-chart-note"><span>{chart?.source || candidate?.feed || 'NSE stocks'}{chart?.as_of && ` · As of ${timeLabel(chart.as_of)}`}</span>
      {chart?.bars?.length > 0 && <div>
        <WithHelp label="Average traded price" text="The session’s running average price, weighted by how many shares traded in each interval. Periods with more trading count more. The chart shows this as a gold line."><span className="daily-chart-legend"><i />Average traded price</span></WithHelp>
        <WithHelp label="Shares traded" text="The bars along the bottom show how many shares changed hands during each five-minute interval. Taller bars mean heavier trading." />
      </div>}
    </div>}
    {orders.length > 0 && <div className="daily-chart-trades" aria-label="Paper trades on this chart">
      {orders.map((order) => <span key={`${order.at}:${order.side}`}><strong className={`trade-side trade-side-${order.side}`}>{paperOrderLabel(order)}</strong> {order.units} × {rupees(order.price)} · {timeLabel(order.at)}</span>)}
    </div>}
    {idea && <TradePlan idea={idea} />}
  </section>;
}

function TradePlan({ idea }) {
  const size = idea.size || {};
  const quote = idea.live ? idea.live_quote : null;
  const amount = asNumber(size.quantity);
  const prices = [
    ['Buy from', idea.trigger, 'The low end of the price range the strategy will accept for a buy. The pattern must qualify before a buy can be considered.'],
    ['Most to pay', idea.entry_cap, 'The high end of the buy range. If the price is above this level when the strategy checks the buy, it skips it.'],
    ['Sell to limit loss', idea.stop, 'The price that triggers a sell to cut losses. If the stock drops through this level, the simulated sell may happen at a lower price.'],
    ['Sell to take profit', idea.target, 'The planned price for selling if the stock rises. It shows where the strategy aims to close a winning trade.'],
  ];
  const amounts = [
    ['Shares', amount === null ? '—' : number(amount, 0), 'The example number of shares the trade can afford within the cash and loss limits.'],
    ['Money needed to buy', rupees(size.capital), 'The planned price multiplied by the number of shares. Estimated trading costs are shown separately under More about this idea.'],
    ['Estimated loss at sell limit', rupees(size.estimated_loss), 'How much virtual money the example would lose if it sold at the loss-limiting price, including estimated buy and sell costs.'],
    ['Loss as % of daily limit', rate(size.budget_risk_pct), 'The estimated rupee loss divided by today’s paper money limit. A 1% figure on a ₹5,000 limit means an estimated loss of ₹50.'],
  ];
  const extras = [
    ['Price fall to loss limit', rate(size.stop_distance_pct), 'The percentage price drop from the planned buy price to the loss-limiting price.'],
    ['Planned gain per ₹1 risked', ratio(size.reward_risk), 'Compares the estimated gain at the profit price with the estimated loss at the loss-limiting price. 2× means about ₹2 of planned gain per ₹1 of planned loss.'],
    ['Estimated cost to buy and sell', rupees(size.estimated_round_trip), 'The simulated charges and allowance for price differences across the planned buy and sell.'],
    ['Shares traded vs usual', ratio(idea.relative_volume), 'Compares shares traded in this five-minute interval with a typical count at the same time on recent trading days. 2× means twice the usual activity.'],
  ];
  return <div className="daily-trade-plan">
    <div className="daily-plan-title"><HelpTitle as="h3" label="Example trade plan"
      text="An example of how this strategy could trade the selected stock. It shows the buy range, planned sells, and the estimated trade size and loss. Completed trades are listed in BUY & SELL history." />
      <div><span className="daily-signal-label">{ideaState(idea)}</span><WithHelp label="Trade risk level" text={riskHelp}><RiskTag idea={idea} /></WithHelp></div></div>
    {asNumber(quote?.ask) !== null && <p className="daily-fill-line">Latest price offered by sellers {rupees(quote.ask)}{quote.at && ` · ${timeLabel(quote.at)}`}</p>}
    <dl className="daily-prices">{prices.map(([label, value, text]) => <div key={label}><dt><WithHelp label={label} text={text} /></dt><dd>{rupees(value)}</dd></div>)}</dl>
    <dl className="daily-size-grid">{amounts.map(([label, value, text]) => <div key={label}><dt><WithHelp label={label} text={text} /></dt><dd>{value}</dd></div>)}</dl>
    <HelpDetails className="paper-how" wrapperClassName="paper-help-details" label="More about this idea"
      text="Open to see why the strategy flagged this idea, how much trading was taking place, and how the planned gain compares with the estimated loss.">
      <dl className="daily-size-grid">{extras.map(([label, value, text]) => <div key={label}><dt><WithHelp label={label} text={text} /></dt><dd>{value}</dd></div>)}</dl>
      {(idea.entry_at || idea.exit_at) && <p className="daily-fill-line">
        {idea.entry_at && asNumber(idea.entry) !== null && <span>Example buy {rupees(idea.entry)} · {timeLabel(idea.entry_at)}</span>}
        {idea.exit_at && <span>{asNumber(idea.exit_price) !== null ? `Example sell ${rupees(idea.exit_price)} · ` : ''}{timeLabel(idea.exit_at)}</span>}
      </p>}
      {idea.exit_reason && <p>{idea.exit_reason}</p>}
      {idea.reason && <p>{Array.isArray(idea.reason) ? idea.reason.join(' ') : idea.reason}</p>}
      <p>The risk label is based on how far the buy price is from the loss limit. A sudden price drop can make the loss larger.</p>
    </HelpDetails>
  </div>;
}

const filingKey = (filing) => `${filing.symbol}|${filing.at || filing.timestamp}|${filing.link || filing.url}|${filing.title}`;

function DisclosureList({ title, filings }) {
  if (!filings.length) return null;
  return <div className="daily-filings"><HelpTitle as="h3" label={title}
    text="Company notices the desk found for stocks on the watchlist. Open a link to read the original announcement. Check the company and publication time before using it in your research." />{filings.map((item) => {
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
    <div className="daily-list-header"><div><HelpTitle label="Before the market opens"
      text="The morning report combines early market information, company announcements, and stocks to watch. On a regular NSE day the desk starts preparing it around 09:00 IST." /><p>{title || 'News and stocks to watch today'}</p></div><Activity size={17} /></div>
    <div className="daily-brief-content">
      <p>{Array.isArray(summary) ? summary.join(' ') : summary || 'The morning report appears after the check before the market opens.'}</p>
      {typeof context === 'string' && <p>{context}</p>}
      {Array.isArray(context) && context.length > 0 && <ul>{context.map((item, index) => <li key={index}>{typeof item === 'string' ? item : item.text || item.title || item.label}</li>)}</ul>}
      {sources.length > 0 && <div className="daily-source-links">{sources.map((item, index) => typeof item === 'string' ? <SourceLink href={item} key={index} /> :
        <SourceLink href={item.href || item.url || item.link} key={index}>{item.label || item.title || item.name}</SourceLink>)}</div>}
      <DisclosureList title="Latest company announcements" filings={latestFilings.filter((item) => !seen.has(filingKey(item)))} />
      <DisclosureList title="Announcements in the morning report" filings={filings} />
      {method && <HelpDetails className="paper-how" wrapperClassName="paper-help-details" label="How the report was prepared"
        text="Read how the desk produced the morning report and which information was available to it."><p>{method}</p></HelpDetails>}
    </div>
  </section>;
}

function ReplayPanel({ replay, available, pending, onRun }) {
  const rows = replay?.strategies || [];
  const showUnresolved = rows.some((row) => asNumber(row.unresolved) !== null);
  return <section className="panel daily-replay" aria-labelledby="daily-replay-heading">
    <div className="daily-list-header">
      <div><HelpTitle id="daily-replay-heading" label="Test strategies on past prices"
        text="Replays today’s selected stocks on up to 15 prior trading days per stock. Check completed sells, estimated results after costs, and trades that could not be closed from the available prices." /><p>See how the rules would have performed, including estimated trading costs.</p></div>
      <WithHelp label="Run strategy test" text="Start the historical simulation using the latest stock list. The button becomes available after today’s first market check and while the desk is free.">
        <button className="button button-small button-outline" type="button" disabled={!available || pending} onClick={onRun}>
          {pending ? <LoaderCircle size={15} className="spin" /> : <FlaskConical size={15} />}Run test
        </button>
      </WithHelp>
    </div>
    {replay ? <div className="daily-replay-content">
      <p>{number(asNumber(replay.sessions), 0)} stock-and-day tests through {dateLabel(replay.through)} · {rupees(replay.budget)} limit</p>
      {replay.incomplete_sessions > 0 && <p>{replay.incomplete_sessions} stock-and-day samples skipped due to incomplete candles or opening volume.</p>}
      {replay.symbols?.length > 0 && <p>{replay.symbols.join(' · ')}</p>}
      <div className="table-scroll"><table><thead><tr>{[
        ['Strategy', 'The price pattern that generated the example trades in this row.'],
        ['Sells', 'How many simulated trades finished with a recorded sell.'],
        ['Profitable sells', 'How many of those sells made a gain after the estimated costs.'],
        ...(showUnresolved ? [['Still held', 'Example trades whose exit could not be determined from the available prices.']] : []),
        ['Profit / loss', 'Adds the estimated gains and losses of completed trades after costs.'],
        ['Average per trade', 'The total estimated result divided by the number of completed trades.'],
      ].map(([label, text]) => <th scope="col" aria-label={label} key={label}><WithHelp label={label} text={text} /></th>)}</tr></thead>
        <tbody>{rows.map((row) => <tr key={row.strategy}>
          <th scope="row">{paperStrategies[row.strategy]?.label || row.label}</th><td>{number(asNumber(row.trades), 0)}</td><td>{number(asNumber(row.profitable), 0)}</td>
          {showUnresolved && <td>{number(asNumber(row.unresolved), 0)}</td>}
          <td className={tone(asNumber(row.net))}>{row.trades ? signedMoney(asNumber(row.net), 'INR') : '—'}</td><td className={tone(asNumber(row.average))}>{signedMoney(asNumber(row.average), 'INR')}</td>
        </tr>)}</tbody></table></div>
      {replay.note && <p>{replay.note}</p>}
    </div> : <p className="daily-replay-empty">{available ? 'Try the rules on up to 15 previous trading days per stock.' : 'Tests become available after the first market check for today.'}</p>}
  </section>;
}

export function DailyTrading({ onResearch, onDiagnostics }) {
  const [day, setDay] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [selection, setSelection] = useState(null);
  const [action, setAction] = useState('');
  const [feedback, setFeedback] = useState('');
  const [actionError, setActionError] = useState('');
  const chartPanel = useRef(null);
  const [data, error, setData] = useDashboard(day, refresh);
  const today = (day ? null : data?.day) || todayIST();
  const ideas = data?.ideas || [];
  const candidates = data?.candidates || [];
  const orders = data?.auto_trade?.session?.orders || [];
  const idea = selection ? ideas.find((item) => ideaKey(item) === selection) : ideas[0];
  const symbol = idea?.symbol || (selection?.startsWith('watch:') ? selection.slice(6) : selection?.split(':')[0]) || candidates[0]?.symbol;
  const candidate = candidates.find((item) => item.symbol === symbol) || orders.find((order) => order.asset.symbol === symbol)?.asset;
  const selectedKey = idea ? ideaKey(idea) : symbol ? `watch:${symbol}` : null;
  const [chart, chartError] = useDailyChart(symbol, data?.day, data?.updated_at || data?.slot);

  function chooseDay(value) {
    setSelection(null);
    setDay(value === today ? '' : value);
  }

  function showTradeChart(asset) {
    setSelection(`watch:${asset.symbol}`);
    chartPanel.current?.focus({ preventScroll: true });
    chartPanel.current?.scrollIntoView({ block: 'start' });
  }

  async function perform(kind, path, body, message) {
    setAction(kind); setActionError(''); setFeedback('');
    try {
      const result = await post(path, body);
      if (result.day === today) setData(result);
      setRefresh((previous) => previous + 1);
      setFeedback(result.accepted === false ? 'The desk is busy. Try again after the current check finishes.' : message);
      return result.accepted !== false;
    } catch (err) { setActionError(err.message); return false; }
    finally { setAction(''); }
  }

  return <div className="daily-workspace">
    <SessionControls data={data} day={day} today={today} setDay={chooseDay} runningAction={action}
      saveBudget={(budget) => perform('budget', '/api/daily/budget', { budget }, 'Paper money limit saved.')}
      run={() => perform('scan', '/api/daily/scan', {}, 'Market check requested. This page updates automatically.')} />
    {(error || actionError) && <p className="form-error" role="alert">{actionError || error}</p>}
    {feedback && <p className="daily-feedback" role="status">{feedback}</p>}
    <DailyAutoTrade data={data} archive={Boolean(day)} busy={Boolean(action)} timeLabel={timeLabel} onDay={chooseDay} onChart={showTradeChart}
      onDiagnostics={onDiagnostics}
      onChange={(settings) => perform('auto', '/api/daily/auto-trade', settings,
        settings.enabled ? 'Auto Trade is scheduled for the next market check.' : 'New entries are paused. Auto Trade will keep managing open positions.')} />
    {data?.warnings?.length > 0 && <HelpDetails className="daily-warnings" wrapperClassName="daily-warnings-help"
      label="Market data notices" summary={`Market data notices (${data.warnings.length})`}
      text="Open to see which prices or sources were delayed, missing, or could not be checked. This helps explain gaps in the watchlist, chart, or trade decisions.">
      <ul>{data.warnings.map((warning, index) => <li key={index}>{typeof warning === 'string' ? warning : warning.message}</li>)}</ul>
    </HelpDetails>}
    <div className="daily-content-grid">
      <IdeaList ideas={ideas} candidates={candidates} selection={selectedKey} setSelection={setSelection} loading={!data && !error} />
      <ChartPanel panelRef={chartPanel} chart={chart} chartError={chartError} symbol={symbol} candidate={candidate} idea={idea}
        day={data?.day} onResearch={onResearch} orders={orders.filter((order) => order.asset.symbol === symbol)} />
    </div>
    <PremarketBrief brief={data?.brief} latestFilings={data?.latest_filings} />
    <ReplayPanel replay={data?.research} available={candidates.length > 0 && !day} pending={Boolean(data?.operation || data?.running || action)}
      onRun={() => perform('replay', '/api/daily/replay', {}, 'Historical strategy test requested.')} />
    {data?.model_log && <ModelLog key={data.day} job={{ id: data.day, status: data.running ? 'running' : 'completed', model_log: true }} onDiagnostics={onDiagnostics}
      endpoint="/api/daily/model-log" parameters={{ day: data.day }} />}
  </div>;
}
