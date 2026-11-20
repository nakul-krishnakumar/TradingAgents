import { Suspense, lazy, useEffect, useState } from 'react';
import {
  Activity, Check, CircleAlert, ClipboardList, Database, Download, FileText, FlaskConical, Globe2, LoaderCircle, Play, SearchX, Terminal, TextAlignStart,
} from 'lucide-react';
import { Tabs } from 'radix-ui';
import { AnalystOptions } from './Workspace';
import ModelLog from './ModelLog';
import { api, dateLabel, openJob, signed, tone } from './api';
import { Help, HelpDetails, HelpField, HelpTitle, WithHelp } from './Help';

const Markdown = lazy(() => import('./Markdown'));

const statusLabels = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted' };
const ratingLabels = {
  Buy: 'Buy', Overweight: 'Own more (Overweight)', Hold: 'Hold what you own',
  Underweight: 'Own less (Underweight)', Sell: 'Sell', REVIEW: 'Review needed',
};

export function Status({ job }) {
  return <span className={`status status-${job.status}`}><span />{statusLabels[job.status] || job.status}</span>;
}

export function RunList({ jobs, library, onOpen, onImport, compact = false }) {
  const entries = compact ? jobs.slice(0, 3) : jobs;
  const saved = compact ? library.slice(0, Math.max(3 - entries.length, 0)) : library;
  return <section className="panel run-list">
    <div className="run-list-title"><div className="panel-heading"><div className="section-icon"><ClipboardList size={17} /></div>
      <HelpTitle as="h3" label={compact ? 'Recent work' : 'Research and test history'}
        text="Shows research requests and historical tests, along with dates and status. Choose a row to follow it or read the result. Imported reports were saved outside this browser workspace." /></div></div>
    {!entries.length && !saved.length && <div className="empty-list"><FileText size={22} /><p>Research reports and historical tests will appear here.</p></div>}
    {entries.map((job) => <button className="run-row" key={job.id} onClick={() => onOpen(job.id)}>
      <div className="run-icon">{job.type === 'research' ? <FileText size={18} /> : <FlaskConical size={18} />}</div>
      <div className="run-row-text"><strong>{job.params.symbol || job.params.symbols.join(', ')}</strong><span>{job.params.question || (job.type === 'research' ? 'Research report' : 'Test on past prices')}</span></div>
      <span className="run-date">{dateLabel(job.params.date || job.params.start)}</span><Status job={job} />
    </button>)}
    {saved.map((report) => <button className="run-row" key={report.id} onClick={() => onImport(report.id)}>
      <div className="run-icon"><FileText size={18} /></div>
      <div className="run-row-text"><strong>{report.symbol}</strong><span>Saved report</span></div>
      <span className="run-date">{dateLabel(report.date)}</span><span className="status status-imported">Imported</span>
    </button>)}
  </section>;
}

function ResearchSummary({ prefix }) {
  const [summary, setSummary] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api(`${prefix}/summary`, { signal: controller.signal })
      .then((result) => setSummary(result.summary))
      .catch(() => {});
    return () => controller.abort();
  }, [prefix]);

  if (!summary) return null;
  return <section className="panel research-tldr" aria-label="Research summary">
    <div className="panel-heading"><div className="section-icon"><TextAlignStart size={17} /></div><HelpTitle as="h3" label="Quick summary (TL;DR)"
      text="Start here for the report’s main finding, the strongest counterpoint, and the final view. Open the full research report for the evidence, sources, and risks behind it." /></div>
    <Suspense fallback={null}><Markdown content={summary} /></Suspense>
  </section>;
}

function ReportViewer({ prefix }) {
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setMarkdown('');
    setError('');
    fetch(`${prefix}/md`, { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error('Could not load this report.'); return response.text(); })
      .then(setMarkdown)
      .catch((requestError) => { if (requestError.name !== 'AbortError') setError(requestError.message); });
    return () => controller.abort();
  }, [prefix]);
  const parts = markdown.split(/(?=^## [IVX]+\. )/m).filter(Boolean);
  const groups = [{ id: 'all', title: 'Full report', content: markdown }, ...parts.slice(1).map((part, index) => ({
    id: String(index), title: part.split('\n')[0].replace(/^## [IVX]+\. /, '')
      .replace(' Team', '').replace(' Decision', '').replace(' Reports', '').replace(' Plan', ''),
    content: part,
  }))];

  return <section className="panel report-panel">
    <div className="report-heading">
      <div className="panel-heading"><div className="section-icon"><FileText size={17} /></div><HelpTitle as="h3" label="Research report"
        text="Read the evidence, arguments, risk review, and final research view. Choose a section to focus on one part of the report. Open the full page in another tab or download a text copy." /></div>
      <div className="report-actions">
        <a className="button button-small button-outline" href={`${prefix}/html`} target="_blank" rel="noreferrer"><Globe2 size={15} />Open full page</a>
        <a className="button button-small button-outline" href={`${prefix}/md`} download="research-report.md"><Download size={15} />Download report</a>
      </div>
    </div>
    {error && <p className="form-error">{error}</p>}
    {!markdown && !error && <div className="empty-list"><LoaderCircle className="spin" size={22} /><p>Loading report…</p></div>}
    {markdown && <Tabs.Root defaultValue="all" key={prefix}>
      <div className="report-tabs-help">
        <Tabs.List className="report-tabs" aria-label="Report sections">{groups.map(({ id, title }) =>
          <Tabs.Trigger value={id} key={id}>{title}</Tabs.Trigger>)}</Tabs.List>
        <Help label="Report sections" text="Full report shows everything together. Click a named section to read just that part, such as the analysts’ evidence or the final decision." />
      </div>
      {groups.map(({ id, content }) => <Tabs.Content key={id} value={id}><Suspense fallback={<p className="inline-note">Rendering report…</p>}><Markdown content={content} /></Suspense></Tabs.Content>)}
    </Tabs.Root>}
  </section>;
}

function AgentProgress({ job }) {
  const steps = job.steps || [];
  const names = { get_stock_data: 'Price history', get_verified_market_snapshot: 'Verified market snapshot', get_indicators: 'Technical indicators',
    get_news: 'Company news', get_global_news: 'Macro headlines', get_fundamentals: 'Company snapshot' };

  return <section className="panel progress-panel">
    <div className="panel-heading"><div className="section-icon"><Activity size={17} /></div>
      <HelpTitle as="h3" label="Research progress" text="Follow the research as the team collects evidence, compares views, reviews risks, and prepares the report. Waiting means a stage is queued. Done means its work is available to the next stage." /><Status job={job} /></div>
    {job.providers && <p className="inline-note">{job.providers.quick?.provider} gathers and compares the evidence · {job.providers.deep?.provider} does the final review</p>}
    {!steps.length && <p className="inline-note">{job.status === 'queued' ? 'Waiting for the current job to finish.' : 'Preparing the research team.'}</p>}
    <div className="step-grid">{steps.map(({ id, name, status }) => {
      const Icon = status === 'complete' ? Check : status === 'running' && openJob(job) ? LoaderCircle : Activity;
      return <div key={id} className={`step step-${status}`}>
        <Icon size={15} className={status === 'running' && openJob(job) ? 'spin' : ''} />
        <span>{name}</span>
        <small>{status === 'complete' ? 'Done' : status === 'running' && openJob(job) ? 'Running' : 'Waiting'}</small>
      </div>;
    })}</div>
    {job.tools && Object.keys(job.tools).length > 0 && <HelpDetails className="tools-list" wrapperClassName="tools-help" label="Data and tools used"
      text="Lists the functions the research team used to fetch or calculate evidence, with the number of results from each. Open the AI output and logs for individual calls.">
      <div>{Object.entries(job.tools).map(([tool, count]) => <span key={tool}>{names[tool] || tool.replaceAll('_', ' ')} <b>{count}</b></span>)}</div>
    </HelpDetails>}
  </section>;
}

function BacktestResult({ job }) {
  const summary = job.summary;
  const stats = summary && [
    ['Decisions scored', summary.resolved, 'Calls with a usable rating and enough later price data for a comparison.'],
    ['Waiting for prices', summary.pending, 'Calls whose result cannot be scored yet because the later price information needed for the comparison is missing.'],
    ['No score to assign', summary.unscored, 'Decisions marked for review instead of receiving a clear rating. They are counted here and excluded from the score table.'],
    ['Tests with errors', job.failed_cells ?? 0, 'Stock-and-date tests that stopped with an error. Open Run logs for details.'],
  ];
  return <section className="panel test-result">
    <div className="panel-heading"><div className="section-icon"><FlaskConical size={17} /></div>
      <HelpTitle as="h3" label="How past decisions did" text="See how the investments moved after each historical research call compared with their market index. The table groups those outcomes by the ratings the team gave." /><Status job={job} /></div>
    {!summary && !job.error && <p className="inline-note">{job.progress ? `Testing ${job.progress.symbol} on ${dateLabel(job.progress.date)} · ${job.progress.cell} of ${job.progress.total}` : 'Waiting to test the selected dates.'}</p>}
    {summary && <>
      <p className="inline-note">Each test makes a research call for one investment on one date, then compares its later price change with the market index used for that investment.</p>
      <div className="metrics">{stats.map(([label, value, text]) => <div className="metric" key={label}><WithHelp label={label} text={text} /><strong>{value}</strong></div>)}</div>
      {summary.resolved > 0 ? <div className="table-scroll"><table>
        <thead><tr>{[
          ['What research said', 'Buy or Own more expects the investment to beat the market comparison. Sell or Own less expects it to lag. Hold has no directional score.'],
          ['Decisions', 'The number of scored stock-and-date calls with this research rating.'],
          ['Right about beating or lagging the market', 'Counts how often the predicted direction against the market was right. For example, 2 of 2 means both calls were correct.'],
          ['Average difference vs market', 'Average investment return minus market return over the same period, in percentage points. A 3% gain versus a 1% market gain is +2 percentage points.'],
        ].map(([label, text]) => <th scope="col" aria-label={label} key={label}><WithHelp label={label} text={text} /></th>)}</tr></thead>
        <tbody>{Object.entries(summary.by_rating).map(([rating, score]) => <tr key={rating}><th scope="row">{ratingLabels[rating] || rating}</th><td>{score.count}</td>
          <td>{score.hit_rate == null ? 'Hold makes no prediction of direction' : `${Math.round(score.hit_rate * score.count)} of ${score.count} correct (${Math.round(score.hit_rate * 100)}%)`}</td>
          <td className={tone(score.mean_alpha)}>{signed(score.mean_alpha * 100, ' percentage points')}</td></tr>)}</tbody></table></div>
        : <p className="inline-note">There are no scored decisions for this test yet.</p>}
      <p className="inline-note">Measured over {summary.holding} starting with the first closing price after each research date. A negative difference means the investment lagged its market index.</p>
      {job.failed_cells > 0 && <p className="inline-note">{job.failed_cells} stock-and-date {job.failed_cells === 1 ? 'test hit an error and has' : 'tests hit errors and have'} no result in the table.</p>}
      {job.settlement_failures > 0 && <p className="inline-note">The app had trouble loading later prices for {job.settlement_failures} {job.settlement_failures === 1 ? 'investment' : 'investments'}.</p>}
    </>}
  </section>;
}

export function RunDetail({ job, imported, onDiagnostics }) {
  if (imported) {
    const prefix = `/api/library/${encodeURIComponent(imported)}`;
    return <div className="run-detail" key={imported}>
      <ResearchSummary prefix={prefix} />
      <ReportViewer prefix={prefix} />
    </div>;
  }
  if (!job) return <section className="panel empty-list no-run"><SearchX size={24} /><p>Choose a report or test to see its details.</p></section>;
  const p = job.params;
  const reportPrefix = `/api/jobs/${job.id}/report`;
  return <div className="run-detail">
    <section className="panel run-summary">
      <div><span className="instrument-label">{job.type === 'research' ? dateLabel(p.date) : `${dateLabel(p.start)} – ${dateLabel(p.end)}`}</span>
        <HelpTitle label={job.type === 'research' ? 'Selected research run' : 'Selected historical test'}
          text="Shows the investment, date, and original question or test for the item selected in history. The matching report, progress, or test results appear below.">
          {p.symbol || p.symbols.join(', ')}
        </HelpTitle><p>{p.question || (job.type === 'research' ? 'Research report' : 'Test on past prices')}</p></div>
      {job.rating && <div className="research-rating"><small><WithHelp label="Research view" text="The rating reflects the team’s reading of the evidence. Own more or Own less describes a larger or smaller holding. Hold means maintain the current position. Read the report for the reasoning and risks." /></small>
        {['Buy', 'Sell'].includes(job.rating) ? <span className={`trade-side trade-side-${job.rating.toLowerCase()}`}>{job.rating.toUpperCase()}</span>
          : <span className="rating">{ratingLabels[job.rating] || job.rating}</span>}</div>}
      <WithHelp label="Run logs" text="Open system events linked to this run to see requests, research stages, tool or provider errors, and timings.">
        <button type="button" className="button button-small button-outline" data-log="research.open-diagnostics"
          onClick={() => onDiagnostics(job.id)}><Terminal size={15} /> Run logs</button>
      </WithHelp>
      {job.error && <p className="form-error"><CircleAlert size={16} />{job.error}</p>}
    </section>
    {job.report && <ResearchSummary prefix={reportPrefix} key={job.id} />}
    {job.type === 'backtest' ? <BacktestResult job={job} /> : <AgentProgress job={job} />}
    <ModelLog job={job} key={`model-log:${job.id}`} onDiagnostics={onDiagnostics} />
    {job.report && <ReportViewer prefix={reportPrefix} key={`report:${job.id}`} />}
  </div>;
}

export function DecisionMemory() {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  function load(event) {
    if (!event.currentTarget.open || entries) return;
    api('/api/memory').then(setEntries).catch((err) => setError(err.message));
  }

  return <HelpDetails className="panel memory-panel" wrapperClassName="memory-help" onToggle={load} label="Lessons from past research"
    text="Review earlier research ratings and the price changes that followed. See how each investment did against the market comparison, and open a lesson when an explanation was saved."
    summary={<>
      <div className="section-icon"><Database size={17} /></div>
      <div><strong>Lessons from past research</strong><span>Read past calls and see what happened afterward</span></div>
    </>}>
    {error && <p className="form-error">{error}</p>}
    {!entries && !error && <p className="inline-note">Loading past decisions…</p>}
    {entries?.length === 0 && <p className="inline-note">Past decisions will appear after a research run.</p>}
    {entries?.map((entry) => <div key={`${entry.ticker}:${entry.date}`} className="memory-entry">
      <div><strong>{entry.ticker}</strong><span>{dateLabel(entry.date)} · {ratingLabels[entry.rating] || entry.rating}</span></div>
      {entry.pending ? <span className="status status-queued">Waiting for later prices</span>
        : <span>{entry.raw || '—'} price change · {entry.alpha || '—'} vs market · {entry.holding?.replace(/^(\d+)d$/, '$1 trading days') || '—'}</span>}
      {entry.reflection && <HelpDetails wrapperClassName="memory-lesson" label="Read lesson" text="Open the saved explanation of what happened after this research call and what the team could learn from the result.">
        <Suspense fallback={<p className="inline-note">Loading lesson…</p>}><Markdown content={entry.reflection} /></Suspense>
      </HelpDetails>}
    </div>)}
  </HelpDetails>;
}

export function BacktestForm({ asset, today, onJob }) {
  const previous = (days) => {
    const date = new Date(`${today}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - days);
    return date.toISOString().slice(0, 10);
  };
  const [symbols, setSymbols] = useState(asset.symbol.startsWith('AMFI-') ? 'RELIANCE.NS' : asset.symbol);
  const [start, setStart] = useState(() => previous(21));
  const [end, setEnd] = useState(() => previous(14));
  const [every, setEvery] = useState(7);
  const [selected, setSelected] = useState(['market']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const tickers = [...new Set(symbols.split(',').map((symbol) => symbol.trim()).filter(Boolean))];
  const dayDiff = (Date.parse(end) - Date.parse(start)) / 86400000;
  const count = dayDiff >= 0 && every >= 1 ? (Math.floor(dayDiff / every) + 1) * tickers.length : 0;

  async function submit(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      onJob(await api('/api/jobs/backtest', {
        method: 'POST', body: JSON.stringify({ symbols: tickers, start, end, every, analysts: selected }),
      }));
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return <section className="panel backtest-form">
    <div className="research-heading"><div className="section-icon green-icon"><FlaskConical size={21} /></div>
      <div><HelpTitle label="Test a research decision" text="Choose stock symbols, a range of past dates, and the research topics. Market Desk runs a historical research call for each combination and checks the later move against its market index." /><p>Choose investments and past dates. The test checks what happened after each research call.</p></div></div>
    <form onSubmit={submit} data-log="backtest.start">
      <HelpField label="Stock symbols, separated by commas" text="Enter the symbols to test, such as RELIANCE.NS and TCS.NS. Put a comma between them. Each stock is tested for every selected date."><input value={symbols} onChange={(event) => setSymbols(event.target.value)} placeholder="RELIANCE.NS, TCS.NS" required /></HelpField>
      <div className="form-columns">
        <HelpField label="Start date" text="The first historical date for the research calls. Choose a past date to see how the available evidence at that point would have held up."><input type="date" value={start} max={today} onChange={(event) => setStart(event.target.value)} required /></HelpField>
        <HelpField label="End date" text="The latest date allowed in the test. Dates used depend on the gap you select. Leaving time after the end date gives the outcomes a chance to have enough later trading prices."><input type="date" value={end} min={start} max={today} onChange={(event) => setEnd(event.target.value)} required /></HelpField>
      </div>
      <HelpField label="Days between test dates" text="The number of calendar days from one research date to the next. Seven tests roughly weekly. A larger gap runs fewer tests over the same range."><input type="number" min={1} value={every} onChange={(event) => setEvery(Number(event.target.value))} required /></HelpField>
      <div className="details-label"><WithHelp label="Research topics" text="Choose which types of evidence the team should use in each historical research call. The same selected topics apply across the test." /></div>
      <AnalystOptions selected={selected} setSelected={setSelected} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="backtest-submit"><WithHelp label="Number of tests" text="One test is one stock on one date. For example, two stocks tested on three dates create six historical calls."><span>{count} stock-and-date {count === 1 ? 'test' : 'tests'}</span></WithHelp><button className="button button-primary" disabled={busy || !count || !selected.length} type="submit">
        {busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}Run test</button></div>
    </form>
  </section>;
}
