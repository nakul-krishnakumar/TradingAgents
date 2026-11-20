import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import {
  Activity, ArrowDownRight, ArrowUpRight, Bookmark, CandlestickChart, ChartNoAxesCombined,
  ChevronDown, FlaskConical, Info, Layers3, LoaderCircle, Plus, Settings2,
  Sparkles, Star, X,
} from 'lucide-react';
import { Popover } from 'radix-ui';
import { analysts, api, dateLabel, makeUrl, money, number, openJob, signed, tone, typeLabel } from './api';
import { Help, HelpDetails, HelpField, HelpTitle, WithHelp } from './Help';

const PriceChart = lazy(() => import('./PriceChart'));
const ranges = ['1M', '3M', '6M', '1Y', '5Y'];

const EMPTY_PORTFOLIO = { cash: '', currency: 'INR', positions: [] };
const initialIndicators = { sma20: false, sma50: false, volume: false };
const focusPrompts = {
  stock: ['Why is the price changing?', 'What could make the price fall?'],
  fund: ['How has the fund’s value changed?', 'What should I check in the fund’s factsheet?'],
  etf: ['How has the ETF performed?', 'What could affect tracking?'],
};

const symbolNames = { '^NSEI': 'Nifty 50', '^BSESN': 'Sensex', '^NSEBANK': 'Nifty Bank', SPY: 'S&P 500 ETF' };
const analystHelp = {
  market: 'Checks price history and trading activity to explain the trend. For mutual funds it reads the published fund unit values.',
  news: 'Looks for relevant announcements and news through the selected date. It explains which events might affect the investment.',
  fundamentals: 'Reads a company’s sales, profits, debt, and what investors pay for its shares. This topic is available for stocks.',
  social: 'Looks for available public discussion and identifies common views and disagreements. Coverage varies by investment and data source.',
};

export function AssetMark({ asset, size = '' }) {
  const symbols = { 'RELIANCE.NS': 'R', 'TCS.NS': 'T', 'HDFCBANK.NS': 'H', 'INFY.NS': 'I', 'NIFTYBEES.NS': 'N', '^NSEI': 'N' };
  const text = asset.kind === 'fund' ? 'MF' : symbols[asset.symbol] || asset.symbol.replace(/^[^A-Z\d]+/i, '').slice(0, 2);
  return <span aria-hidden="true" className={`asset-mark ${size} asset-${asset.kind}`}>{text}</span>;
}

function Metric({ label, text, value, className }) {
  return <div className="metric"><WithHelp label={label} text={text} /><strong className={className}>{value}</strong></div>;
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
            <HelpTitle label="Investment chart" text="This chart shows the selected investment’s past prices or fund unit values. Change the date range, choose a chart style, or add a market comparison. Move over the chart to read a specific date.">{holder}</HelpTitle>
          </div>
        </div>
        <div className="form-actions instrument-actions">
          {onSave && <button className="icon-button" aria-label="Save to wishlist" title="Save to wishlist" onClick={onSave}><Bookmark size={17} /></button>}
        <button className={`icon-button pin-button ${pinned ? 'starred' : ''}`} aria-label={pinned ? 'Remove from watchlist' : 'Add to watchlist'} title={pinned ? 'Remove from watchlist' : 'Add to watchlist'} onClick={onPin}><Star size={19} /></button>
          <Help label="Save or pin an investment" text="Use the bookmark to put this investment in a saved list. Use the star to add or remove a quick link in the sidebar." />
        </div>
      </div>

      <div className="price-summary">
        <div className="quote">
          <strong>{money(last?.close, chart?.currency)}</strong>
          {Number.isFinite(chart?.change_pct) && <WithHelp label="Latest price change"
            text="The change from the previous available close or fund value. The first number is the price difference and the number in brackets is the percentage change.">
            <span className={`change-pill ${tone(chart.change_pct)}`}>
              {chart.change_pct >= 0 ? <ArrowUpRight size={15} /> : <ArrowDownRight size={15} />}
              {signed(chart.change, '')} ({signed(chart.change_pct)})
            </span>
          </WithHelp>}
        </div>
        <div className="muted"><WithHelp label={nav ? 'Fund unit value (NAV)' : 'Closing price'}
          text={nav ? 'The published net asset value per unit of the fund. It is the value of its investments minus liabilities, divided across the fund’s units. The date shows when the value was reported.'
            : 'The last closing price available within the selected research date. Check the date beside it to see which trading day the price came from.'}>
          <span>{last ? `${nav ? 'Fund unit value (NAV)' : 'Closing price'} · ${dateLabel(last.time)}` : 'Daily market data'}</span>
        </WithHelp></div>
      </div>

      <div className="chart-toolbar">
        <WithHelp label="Chart range" text="Choose how much price history the chart displays. M means months and Y means years. The chart uses the data available for that period.">
          <span className="segmented range-controls" aria-label="Chart range">
            {ranges.map((option) => <button key={option} type="button" onClick={() => { setRange(option); setHovered(null); }} aria-pressed={range === option}>{option}</button>)}
          </span>
        </WithHelp>
        <div className="chart-actions">
          <WithHelp label="Chart type" text="The line shows closing prices or fund unit values. Candlesticks show each day’s opening, highest, lowest, and closing prices when that detail is available.">
            <span className="segmented chart-types" aria-label="Chart type">
              <button type="button" title="Line chart" aria-label="Line chart" aria-pressed={chartStyle === 'line'} onClick={() => setStyle('line')}><Activity size={16} /></button>
              <button type="button" title="Candlesticks" aria-label="Candlesticks" aria-pressed={chartStyle === 'candle'} disabled={!hasCandles || Boolean(comparison)} onClick={() => setStyle('candle')}><CandlestickChart size={16} /></button>
            </span>
          </WithHelp>
          <Popover.Root>
            <WithHelp label="Chart options" text="Add average prices or daily trading activity to the chart. You can also compare percentage moves with a market index when one is available.">
              <Popover.Trigger className="button button-small button-outline" title="Chart options"><Settings2 size={16} /><span>Chart options</span></Popover.Trigger>
            </WithHelp>
            <Popover.Portal>
              <Popover.Content className="popover" align="end" sideOffset={8}>
                <WithHelp label="Show on the chart" text="Choose which extra lines or bars to display. Market comparisons switch the chart to percentage moves on dates shared by both investments."><strong>Show on the chart</strong></WithHelp>
                {[
                  ['sma20', 'Average price over 20 trading days', 'A rolling average of the last 20 closing prices. It smooths daily moves so you can see the shorter-term direction.'],
                  ['sma50', 'Average price over 50 trading days', 'A rolling average of the last 50 closing prices. It changes more slowly than the 20-day average and helps you see the longer trend.'],
                  ['volume', 'Amount traded each day', 'Shows the count of shares or units traded each day. Taller bars mean more activity.'],
                ].map(([id, label, text]) => <WithHelp key={id} label={label} text={text}><label className="check-line">
                  <input type="checkbox" checked={indicators[id]} disabled={Boolean(comparison) || (id === 'volume' && nav)} onChange={(event) => setIndicators({ ...indicators, [id]: event.target.checked })} />{label}
                </label></WithHelp>)}
                {chart?.benchmark && <WithHelp label={`Compare ${benchmarkLabel}`} text="Puts the investment and its market comparison on the same percentage scale starting from their first shared date. See whether they rose or fell by different amounts.">
                  <label className="check-line"><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} />Compare {benchmarkLabel}</label>
                </WithHelp>}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
      </div>

      {chart ? <>
        <div className="chart-note">
          {comparison ? <><span><i className="legend-dot" />{asset.symbol}</span><span><i className="legend-dot benchmark" />{benchmarkLabel}</span><span>Change since the first day with prices for both</span></>
            : bar ? <><span>{dateLabel(bar.time, false)}</span>{nav ? <span>Value per unit <b>{number(bar.close, 4)}</b></span> :
              ['open', 'high', 'low', 'close'].map((key) => <span key={key}>{key[0].toUpperCase() + key.slice(1)} <b>{number(bar[key])}</b></span>)}</> : null}
        </div>
        <Suspense fallback={<div className="price-chart" />}><PriceChart bars={chart.bars} range={range} style={chartStyle} indicators={indicators} benchmark={comparison} onHover={setHovered} /></Suspense>
        {compare && !comparison && !comparisonError && <p className="inline-note">Loading {benchmarkLabel}…</p>}
        {comparisonError && <p className="inline-note negative">{comparisonError}</p>}
        <div className="chart-source">
          <WithHelp label="Chart data source" text="Shows the service that supplied the prices and the kind of data displayed, such as closing prices or a fund’s published value per unit."><span><Info size={14} />{chart.source} <span className="bullet" /> {chart.pricing}</span></WithHelp>
          <span><a href="/chart-notice.txt" target="_blank" rel="noreferrer">Attribution</a><span className="bullet" /><a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a></span>
        </div>
        {chart.coverage_days < 20 && <p className="data-notice">Limited history from this source. Longer-term trends need more observations.</p>}
      </> : <div className="empty-chart">
        {loading ? <><LoaderCircle className="spin" size={25} /><p>Loading price history</p></>
          : <><ChartNoAxesCombined size={27} /><p>{marketError || 'Choose an instrument to view its chart.'}</p>{marketError && <button className="button button-small button-outline" onClick={onRetry}>Retry data</button>}</>}
      </div>}
    </section>

    <section className="panel trends-panel">
      <div className="panel-heading"><div className="section-icon"><Activity size={17} /></div><HelpTitle as="h3" label={nav ? 'Changes in fund value per unit' : 'Price changes over time'}
        text="Compare changes over one month, three months, and one year. Positive numbers show a rise and negative numbers show a fall. A dash means the available data cannot show that figure." /></div>
      <div className="metrics">
        {Object.entries({ '1M': '1 month', '3M': '3 months', '1Y': '1 year' }).map(([key, label]) => <Metric key={key} label={label}
          text={`Percentage change from ${label} earlier to the most recent price or fund value in view. Compare periods to see how the direction changed over time.`}
          value={signed(chart?.performance?.[key])} className={tone(chart?.performance?.[key])} />)}
        <Metric label="Biggest drop in 1 year" text="The largest fall from an earlier high to a later low during the past year of available prices. A drop of 20% means a high of ₹100 fell as low as ₹80 before a new high." value={signed(chart?.performance?.drawdown)} className={tone(chart?.performance?.drawdown)} />
      </div>
      {nav && <div className="nav-metadata">
        {chart?.metadata?.fund_house && <span>{chart.metadata.fund_house}</span>}
        {chart?.metadata?.scheme_category && <span>{chart.metadata.scheme_category}</span>}
        <span>Changes are based on unit value and exclude cash paid out to investors.</span>
      </div>}
    </section>
  </div>;
}

export function AnalystOptions({ selected, setSelected, allowed = Object.keys(analysts) }) {
  return <div className="analyst-options">
    {Object.entries(analysts).map(([id, info]) => <WithHelp key={id} className="analyst-option" label={info.name} text={analystHelp[id]}>
      <label className={`analyst-choice${allowed.includes(id) ? '' : ' unavailable'}`}>
        <input type="checkbox" checked={selected.includes(id)} disabled={!allowed.includes(id)}
          onChange={(event) => setSelected(event.target.checked ? [...selected, id] : selected.filter((item) => item !== id))} />
        <span><strong>{info.name}</strong><small>{info.description}</small></span>
      </label>
    </WithHelp>)}
  </div>;
}

function PortfolioFields({ value, onChange }) {
  function setPosition(index, key, update) {
    onChange({ ...value, positions: value.positions.map((position, i) => i === index ? { ...position, [key]: update } : position) });
  }
  return <div className="portfolio-fields">
    <div className="form-columns">
      <HelpField label="Cash available" text="Optionally tell the research team how much cash you have available for investing. This amount is used as context in the report."><input inputMode="decimal" type="number" step="any" value={value.cash} onChange={(event) => onChange({ ...value, cash: event.target.value })} placeholder="Optional" /></HelpField>
      <HelpField label="Currency" text="Enter the currency for your cash and purchase prices. INR means Indian rupees."><input maxLength={8} value={value.currency} onChange={(event) => onChange({ ...value, currency: event.target.value })} placeholder="INR" /></HelpField>
    </div>
    {value.positions.map((position, index) => <div className="position-row" key={index}>
      <input aria-label={`Holding ${index + 1} symbol`} value={position.ticker} onChange={(e) => setPosition(index, 'ticker', e.target.value)} placeholder="Stock symbol" required />
      <input aria-label={`Position ${index + 1} quantity`} type="number" step="any" value={position.quantity} onChange={(e) => setPosition(index, 'quantity', e.target.value)} placeholder="Units" required />
      <input aria-label={`Position ${index + 1} cost per unit`} type="number" step="any" value={position.average_price} onChange={(e) => setPosition(index, 'average_price', e.target.value)} placeholder="Avg cost" />
      <button type="button" className="icon-button" aria-label={`Remove position ${index + 1}`} onClick={() => onChange({ ...value, positions: value.positions.filter((_, i) => i !== index) })}><X size={16} /></button>
    </div>)}
    <WithHelp label="Add holding" text="Add an investment you own by entering its symbol, how many shares or units you hold, and optionally the average price you paid. The report uses this as context.">
      <button type="button" className="button button-small button-outline" onClick={() => onChange({ ...value, positions: [...value.positions, { ticker: '', quantity: '', average_price: '' }] })}><Plus size={15} />Add holding</button>
    </WithHelp>
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
        <div><HelpTitle label="Research this investment" text="Ask about this investment or leave the question empty for a general report. The team reviews available evidence, reasons to buy or sell, and risks, then gives you a short summary and detailed report." /><p>{asset.symbol} <span className="bullet" /> {typeLabel[asset.kind]}</p></div>
      </div>
      <form onSubmit={start} data-log="research.start">
        <WithHelp className="question-help" label="What would you like to know?" text="Tell the team what to focus on, such as “What explains the price drop?” or choose a suggested question. Leave this blank for a general report.">
          <label htmlFor="research-question">What would you like to know?</label>
        </WithHelp>
        <textarea id="research-question" rows={4} maxLength={2500} value={question} onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask a question or leave this blank for a full report." />
        <div className="prompts">{(focusPrompts[asset.kind] || focusPrompts.stock).map((prompt) => <button type="button" key={prompt} onClick={() => setQuestion(prompt)}>{prompt}</button>)}</div>
        <div className="form-date">
          <WithHelp label="Use data through" text="The last date the research team should use. Pick today for a current report or choose a past date to ask what was known at that point.">
            <label htmlFor="analysis-date">Use data through</label>
          </WithHelp>
          <input id="analysis-date" type="date" value={date} max={today} onChange={(event) => { if (event.target.value && event.target.value <= today) setDate(event.target.value); }} required />
        </div>
        <HelpDetails className="research-options" wrapperClassName="research-options-help" label="More research options"
          text="Choose what the team investigates, the depth of its review, and the report language. You can also add portfolio context or resume saved research if available."
          summary={<><Settings2 size={17} /><span>More research options</span><ChevronDown size={16} /></>}>
          <div className="details-body">
            <div className="details-label"><WithHelp label="Topics to cover" text="Choose the areas the research team should investigate. The options available depend on the type of investment." /></div>
            <AnalystOptions selected={enabledAnalysts} setSelected={setSelected} allowed={mutualFund ? [] : allowed} />
            {mutualFund && <p className="inline-note">Mutual fund research uses the fund’s published value per unit.</p>}
            <div className="form-columns">
              <HelpField label="How much review" text="Select how many rounds the research and risk discussions should run. More rounds give the team extra chances to reconsider the evidence and generally take longer."><select value={rounds} onChange={(event) => setRounds(Number(event.target.value))}>
                <option value={1}>Standard · 1 round</option><option value={2}>Detailed · 2 rounds</option><option value={3}>Extended · 3 rounds</option>
              </select></HelpField>
              <HelpField label="Report language" text="Choose the language Market Desk asks for in the final research report."><select value={language} onChange={(event) => setLanguage(event.target.value)}>
                {['English', 'Hindi', 'Marathi', 'Tamil', 'Telugu', 'Bengali', 'Kannada', 'Malayalam', 'Gujarati'].map((item) => <option key={item}>{item}</option>)}
              </select></HelpField>
            </div>
            <WithHelp label="Resume previous research" text="When compatible saved progress exists for this research, continue from it. Turn this off to start a fresh run.">
              <label className="check-line"><input type="checkbox" checked={checkpoint} onChange={(event) => setCheckpoint(event.target.checked)} />Resume previous research when available</label></WithHelp>
            <WithHelp label="Include investments and cash" text="Give the team optional context about your current holdings and available cash. It can use this information when discussing the investment and its risks.">
              <label className="check-line"><input type="checkbox" checked={usePortfolio} onChange={(event) => setUsePortfolio(event.target.checked)} />Include investments I own and cash I have</label></WithHelp>
            {usePortfolio && <PortfolioFields value={portfolio} onChange={setPortfolio} />}
          </div>
        </HelpDetails>
        {missing.length > 0 && <p className="form-error">{missing.join(', ')} needs a key in .env.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <WithHelp className="research-start" label="Start research" text="Queue the research and open its progress page. The report and short summary appear there when the team finishes.">
          <button className="button button-primary run-button" type="submit" disabled={starting || !enabledAnalysts.length || missing.length > 0}>
            {starting ? <LoaderCircle size={18} className="spin" /> : <Sparkles size={18} />}
            {starting ? 'Starting research…' : 'Start research'}
          </button>
        </WithHelp>
      </form>

      <div className="research-footer">
        <div className="section-icon"><Layers3 size={17} /></div>
        <div><strong>How research works</strong><span>The team weighs reasons to buy, reasons to sell, and risks.</span></div>
        <Help label="How research works" text="Analysts gather evidence, the research team compares positive and negative cases, and a final review weighs risks before the report presents its view." />
      </div>
    </section>
    {job && <section className="panel active-panel">
      <div className="panel-heading"><div className="section-icon"><FlaskConical size={17} /></div><HelpTitle as="h3" label={openJob(job) ? 'Research in progress' : 'Latest research'} text="The most recent research run for this investment. Open it to follow progress or read its result and evidence." /></div>
      <div className="active-body">
        <div><strong>{job.params.symbol}</strong><p>{job.error || (openJob(job) ? `${job.steps?.filter(({ status }) => status === 'complete').length || 0} of ${job.steps?.length || '—'} stages complete` : dateLabel(job.params.date))}</p></div>
        <button className="button button-small button-outline" onClick={() => onOpen(job.id)}>{openJob(job) ? 'View progress' : 'Read report'}</button>
      </div>
    </section>}
  </div>;
}
