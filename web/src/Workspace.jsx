import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownRight, ArrowUpRight, Bookmark, CandlestickChart, ChartNoAxesCombined,
  ChevronDown, CircleHelp, FlaskConical, Info, Layers3, LoaderCircle, Plus, Settings2,
  Sparkles, Star, X,
} from 'lucide-react';
import { Popover } from 'radix-ui';
import { analysts, api, dateLabel, makeUrl, money, number, openJob, signed, tone, typeLabel } from './api';

const PriceChart = lazy(() => import('./PriceChart'));
const ranges = ['1M', '3M', '6M', '1Y', '5Y'];

const EMPTY_PORTFOLIO = { cash: '', currency: 'INR', positions: [] };
const initialIndicators = { sma20: false, sma50: false, volume: false };
const focusPrompts = {
  stock: ['What is driving the trend?', 'What are the main downside risks?'],
  fund: ['How has the NAV trend changed?', 'What should I check in the factsheet?'],
  etf: ['How has the ETF performed?', 'What could affect tracking?'],
};

const symbolNames = { '^NSEI': 'Nifty 50', '^BSESN': 'Sensex', '^NSEBANK': 'Nifty Bank', SPY: 'S&P 500 ETF' };

export function AssetMark({ asset, size = '' }) {
  const symbols = { 'RELIANCE.NS': 'R', 'TCS.NS': 'T', 'HDFCBANK.NS': 'H', 'INFY.NS': 'I', 'NIFTYBEES.NS': 'N', '^NSEI': 'N' };
  const text = asset.kind === 'fund' ? 'MF' : symbols[asset.symbol] || asset.symbol.replace(/^[^A-Z\d]+/i, '').slice(0, 2);
  return <span aria-hidden="true" className={`asset-mark ${size} asset-${asset.kind}`}>{text}</span>;
}

function Metric({ label, value, className }) {
  return <div className="metric"><span>{label}</span><strong className={className}>{value}</strong></div>;
}

export function MarketPanel({ asset, chart, marketError, loading, pinned, onPin, onSave, onRetry }) {
  const [range, setRange] = useState('6M');
  const [style, setStyle] = useState('line');
  const [indicators, setIndicators] = useState(initialIndicators);
  const [compare, setCompare] = useState(false);
  const [comparison, setComparison] = useState(null);
  const [comparisonError, setComparisonError] = useState('');
  const [hovered, setHovered] = useState(null);
  const last = chart?.last;
  const bar = hovered || last;
  const nav = asset.kind === 'fund' || chart?.pricing === 'Published NAV';
  const hasCandles = !nav && chart?.bars?.some((point) => Number.isFinite(point.open));
  const benchmarkLabel = symbolNames[chart?.benchmark] || chart?.benchmark;
  const chartStyle = hasCandles ? style : 'line';
  const holder = chart?.name && chart.name !== asset.symbol ? chart.name : asset.name;

  useEffect(() => {
    setHovered(null);
    setCompare(false);
    setComparison(null);
    setComparisonError('');
  }, [asset.symbol]);

  useEffect(() => {
    setComparison(null);
    setComparisonError('');
    if (!compare || !chart?.benchmark) return undefined;
    const controller = new AbortController();
    api(makeUrl('/api/chart', { symbol: chart.benchmark, date: chart.as_of }), { signal: controller.signal })
      .then(setComparison)
      .catch((error) => { if (error.name !== 'AbortError') setComparisonError(error.message); });
    return () => controller.abort();
  }, [compare, chart?.as_of, chart?.benchmark]);

  return <div className="market-column">
    <section className="panel market-panel">
      <div className="market-heading">
        <div className="identity">
          <AssetMark asset={asset} size="large" />
          <div>
            <div className="instrument-label"><span>{asset.symbol}</span><span className="bullet" /><span>{typeLabel[asset.kind]}</span><span className="bullet" /><span>{asset.exchange}</span></div>
            <h2>{holder}</h2>
          </div>
        </div>
        <div className="form-actions instrument-actions">
          {onSave && <button className="icon-button" aria-label="Save to wishlist" title="Save to wishlist" onClick={onSave}><Bookmark size={17} /></button>}
        <button className={`icon-button pin-button ${pinned ? 'starred' : ''}`} aria-label={pinned ? 'Remove from watchlist' : 'Add to watchlist'} title={pinned ? 'Remove from watchlist' : 'Add to watchlist'} onClick={onPin}><Star size={19} /></button>
        </div>
      </div>

      <div className="price-summary">
        <div className="quote">
          <strong>{money(last?.close, chart?.currency)}</strong>
          {Number.isFinite(chart?.change_pct) && <span className={`change-pill ${tone(chart.change_pct)}`}>
            {chart.change_pct >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}
            {signed(chart.change, '')} ({signed(chart.change_pct)})
          </span>}
        </div>
        <div className="muted">{last ? `${nav ? 'NAV' : 'Daily bar'} · ${dateLabel(last.time)}` : 'Daily market data'}</div>
      </div>

      <div className="chart-toolbar">
        <div className="segmented range-controls" aria-label="Chart range">
          {ranges.map((option) => <button key={option} type="button" onClick={() => { setRange(option); setHovered(null); }} aria-pressed={range === option}>{option}</button>)}
        </div>
        <div className="chart-actions">
          <div className="segmented chart-types" aria-label="Chart type">
            <button type="button" title="Line chart" aria-label="Line chart" aria-pressed={chartStyle === 'line'} onClick={() => setStyle('line')}><Activity size={16} /></button>
            <button type="button" title="Candlesticks" aria-label="Candlesticks" aria-pressed={chartStyle === 'candle'} disabled={!hasCandles || Boolean(comparison)} onClick={() => setStyle('candle')}><CandlestickChart size={16} /></button>
          </div>
          <Popover.Root>
            <Popover.Trigger className="button button-small button-outline" title="Chart indicators"><Settings2 size={16} /><span>Indicators</span></Popover.Trigger>
            <Popover.Portal>
              <Popover.Content className="popover" align="end" sideOffset={8}>
                <strong>Chart overlays</strong>
                {Object.entries({ sma20: '20-session moving average', sma50: '50-session moving average', volume: 'Daily volume' }).map(([id, label]) => <label key={id} className="check-line">
                  <input type="checkbox" checked={indicators[id]} disabled={Boolean(comparison) || (id === 'volume' && nav)} onChange={(event) => setIndicators({ ...indicators, [id]: event.target.checked })} />{label}
                </label>)}
                {chart?.benchmark && <label className="check-line"><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} />Compare {benchmarkLabel}</label>}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>

      {chart ? <>
        <div className="chart-note">
          {comparison ? <><span><i className="legend-dot" />{asset.symbol}</span><span><i className="legend-dot benchmark" />{benchmarkLabel}</span><span>Return from first shared session</span></>
            : bar ? <><span>{dateLabel(bar.time, false)}</span>{nav ? <span>NAV <b>{number(bar.close, 4)}</b></span> :
              ['open', 'high', 'low', 'close'].map((key) => <span key={key}>{key[0].toUpperCase()} <b>{number(bar[key])}</b></span>)}</> : null}
        </div>
        <Suspense fallback={<div className="price-chart" />}><PriceChart bars={chart.bars} range={range} style={chartStyle} indicators={indicators} benchmark={comparison} onHover={setHovered} /></Suspense>
        {compare && !comparison && !comparisonError && <p className="inline-note">Loading {benchmarkLabel}…</p>}
        {comparisonError && <p className="inline-note negative">{comparisonError}</p>}
        <div className="chart-source">
          <span><Info size={14} />{chart.source} <span className="bullet" /> {chart.pricing}</span>
          <span><a href="/chart-notice.txt" target="_blank" rel="noreferrer">Attribution</a><span className="bullet" /><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a></span>
        </div>
        {chart.coverage_days < 20 && <p className="data-notice">Limited history from this source. Longer-term trends need more observations.</p>}
      </> : <div className="empty-chart">
        {loading ? <><LoaderCircle className="spin" size={25} /><p>Loading price history</p></>
          : <><ChartNoAxesCombined size={27} /><p>{marketError || 'Choose an instrument to view its chart.'}</p>{marketError && <button className="button button-small button-outline" onClick={onRetry}>Retry data</button>}</>}
      </div>}
    </section>

    <section className="panel trends-panel">
      <div className="panel-heading"><div className="section-icon"><Activity size={17} /></div><h3>{nav ? 'NAV trends' : 'Price trends'}</h3></div>
      <div className="metrics">
        {['1M', '3M', '1Y'].map((key) => <Metric key={key} label={{ '1M': '1 month', '3M': '3 months', '1Y': '1 year' }[key]} value={signed(chart?.performance?.[key])} className={tone(chart?.performance?.[key])} />)}
        <Metric label="1Y max drawdown" value={signed(chart?.performance?.drawdown)} className={tone(chart?.performance?.drawdown)} />
      </div>
      {nav && <div className="nav-metadata">
        {chart?.metadata?.fund_house && <span>{chart.metadata.fund_house}</span>}
        {chart?.metadata?.scheme_category && <span>{chart.metadata.scheme_category}</span>}
        <span>NAV changes exclude payouts.</span>
      </div>}
    </section>
  </div>;
}

export function AnalystOptions({ selected, setSelected, allowed = Object.keys(analysts) }) {
  return <div className="analyst-options">
    {Object.entries(analysts).map(([id, info]) => <label key={id} className={`analyst-option ${allowed.includes(id) ? '' : 'unavailable'}`}>
      <input type="checkbox" checked={selected.includes(id)} disabled={!allowed.includes(id)}
        onChange={(event) => setSelected(event.target.checked ? [...selected, id] : selected.filter((item) => item !== id))} />
      <span><strong>{info.name}</strong><small>{info.description}</small></span>
    </label>)}
  </div>;
}

function PortfolioFields({ value, onChange }) {
  function setPosition(index, key, update) {
    onChange({ ...value, positions: value.positions.map((position, i) => i === index ? { ...position, [key]: update } : position) });
  }
  return <div className="portfolio-fields">
    <div className="form-columns">
      <label>Cash available<input inputMode="decimal" type="number" step="any" value={value.cash} onChange={(event) => onChange({ ...value, cash: event.target.value })} placeholder="Optional" /></label>
      <label>Currency<input maxLength={8} value={value.currency} onChange={(event) => onChange({ ...value, currency: event.target.value })} placeholder="INR" /></label>
    </div>
    {value.positions.map((position, index) => <div className="position-row" key={index}>
      <input aria-label={`Position ${index + 1} ticker`} value={position.ticker} onChange={(e) => setPosition(index, 'ticker', e.target.value)} placeholder="Ticker" required />
      <input aria-label={`Position ${index + 1} quantity`} type="number" step="any" value={position.quantity} onChange={(e) => setPosition(index, 'quantity', e.target.value)} placeholder="Units" required />
      <input aria-label={`Position ${index + 1} cost per unit`} type="number" step="any" value={position.average_price} onChange={(e) => setPosition(index, 'average_price', e.target.value)} placeholder="Avg cost" />
      <button type="button" className="icon-button" aria-label={`Remove position ${index + 1}`} onClick={() => onChange({ ...value, positions: value.positions.filter((_, i) => i !== index) })}><X size={16} /></button>
    </div>)}
    <button type="button" className="button button-small button-outline" onClick={() => onChange({ ...value, positions: [...value.positions, { ticker: '', quantity: '', average_price: '' }] })}><Plus size={15} />Add holding</button>
  </div>;
}

export function ResearchPanel({ asset, today, date, setDate, providers, job, onJob, onOpen }) {
  const [question, setQuestion] = useState('');
  const [rounds, setRounds] = useState(1);
  const [language, setLanguage] = useState('English');
  const [checkpoint, setCheckpoint] = useState(true);
  const [usePortfolio, setUsePortfolio] = useState(false);
  const [portfolio, setPortfolio] = useState(EMPTY_PORTFOLIO);
  const [selected, setSelected] = useState(['market', 'news', 'fundamentals']);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const mutualFund = asset.symbol.startsWith('AMFI-');
  const allowed = useMemo(() => mutualFund ? ['market'] : Object.keys(analysts).filter((id) => id !== 'fundamentals' || asset.kind === 'stock'), [mutualFund, asset.kind]);
  const enabledAnalysts = mutualFund ? ['market'] : selected.filter((id) => allowed.includes(id));
  const missing = Object.values(providers || {}).filter(({ ready }) => !ready).map(({ provider }) => provider);

  async function start(event) {
    event.preventDefault();
    setStarting(true);
    setError('');
    const numberOrNull = (value) => value.trim() ? Number(value) : null;
    const book = usePortfolio ? {
      cash: numberOrNull(portfolio.cash), currency: portfolio.currency.trim() || null,
      positions: portfolio.positions.map((position) => ({
        ticker: position.ticker.trim().toUpperCase(), quantity: Number(position.quantity), average_price: numberOrNull(position.average_price),
      })),
    } : null;
    try {
      const next = await api('/api/jobs/research', { method: 'POST', body: JSON.stringify({
        symbol: asset.symbol, kind: asset.kind, date, question, analysts: enabledAnalysts, rounds, language,
        checkpoint, portfolio: book,
      }) });
      onJob(next);
    } catch (err) {
      setError(err.message);
    } finally {
      setStarting(false);
    }
  }

  return <div className="research-column">
    <section className="panel research-panel">
      <div className="research-heading">
        <div className="section-icon green-icon"><Sparkles size={21} /></div>
        <div><h2>Research this asset</h2><p>{asset.symbol} <span className="bullet" /> {typeLabel[asset.kind]}</p></div>
      </div>
      <form onSubmit={start}>
        <label className="question-label" htmlFor="research-question">What would you like to investigate?</label>
        <textarea id="research-question" rows={4} maxLength={2500} value={question} onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask a question or leave blank for a full brief." />
        <div className="prompts">{(focusPrompts[asset.kind] || focusPrompts.stock).map((prompt) => <button type="button" key={prompt} onClick={() => setQuestion(prompt)}>{prompt}</button>)}</div>
        <div className="form-date">
          <label htmlFor="analysis-date">Analysis date</label>
          <input id="analysis-date" type="date" value={date} max={today} onChange={(event) => { if (event.target.value && event.target.value <= today) setDate(event.target.value); }} required />
        </div>
        <details className="research-options">
          <summary><Settings2 size={17} /><span>Research settings</span><ChevronDown size={16} /></summary>
          <div className="details-body">
            <div className="details-label">Analysts</div>
            <AnalystOptions selected={enabledAnalysts} setSelected={setSelected} allowed={mutualFund ? [] : allowed} />
            {mutualFund && <p className="inline-note">The market analyst reads scheme NAV evidence. Company financials and exchange volume do not apply.</p>}
            <div className="form-columns">
              <label>Debate rounds<select value={rounds} onChange={(event) => setRounds(Number(event.target.value))}>
                <option value={1}>1 · Standard</option><option value={2}>2 · Detailed</option><option value={3}>3 · Extended</option>
              </select></label>
              <label>Report language<select value={language} onChange={(event) => setLanguage(event.target.value)}>
                {['English', 'Hindi', 'Marathi', 'Tamil', 'Telugu', 'Bengali', 'Kannada', 'Malayalam', 'Gujarati'].map((item) => <option key={item}>{item}</option>)}
              </select></label>
            </div>
            <label className="check-line"><input type="checkbox" checked={checkpoint} onChange={(event) => setCheckpoint(event.target.checked)} />Resume saved progress for matching runs</label>
            <label className="check-line"><input type="checkbox" checked={usePortfolio} onChange={(event) => setUsePortfolio(event.target.checked)} />Include holdings and cash</label>
            {usePortfolio && <PortfolioFields value={portfolio} onChange={setPortfolio} />}
          </div>
        </details>
        {missing.length > 0 && <p className="form-error">{missing.join(', ')} needs a key in .env.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button-primary run-button" type="submit" disabled={starting || !enabledAnalysts.length || missing.length > 0}>
          {starting ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}
          {starting ? 'Starting research…' : 'Run research'}
        </button>
      </form>

      <div className="research-footer">
        <div className="section-icon"><Layers3 size={17} /></div>
        <div><strong>Multi-agent research</strong><span>Analysts, bull and bear cases, risk review</span></div>
        <span title="Agents produce a research report and portfolio view."><CircleHelp size={16} /></span>
      </div>
    </section>
    {job && <section className="panel active-panel">
      <div className="panel-heading"><div className="section-icon"><FlaskConical size={17} /></div><h3>{openJob(job) ? 'Research in progress' : 'Latest research'}</h3></div>
      <div className="active-body">
        <div><strong>{job.params.symbol}</strong><p>{job.error || (openJob(job) ? `${job.steps?.filter(({ status }) => status === 'complete').length || 0} of ${job.steps?.length || '—'} stages complete` : dateLabel(job.params.date))}</p></div>
        <button className="button button-small button-outline" onClick={() => onOpen(job.id)}>{openJob(job) ? 'View progress' : 'View run'}</button>
      </div>
    </section>}
  </div>;
}
