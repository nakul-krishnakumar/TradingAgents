import { Suspense, lazy, useEffect, useState } from 'react';
import {
  Activity, Check, CircleAlert, ClipboardList, Database, Download, FileText, FlaskConical, Globe2, LoaderCircle, Play, SearchX, TextAlignStart,
} from 'lucide-react';
import { Tabs } from 'radix-ui';
import { AnalystOptions } from './Workspace';
import ModelLog from './ModelLog';
import { api, dateLabel, openJob, signed } from './api';

const Markdown = lazy(() => import('./Markdown'));

const statusLabels = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted' };

export function Status({ job }) {
  return <span className={`status status-${job.status}`}><span />{statusLabels[job.status] || job.status}</span>;
}

export function RunList({ jobs, library, onOpen, onImport, compact = false }) {
  const entries = compact ? jobs.slice(0, 3) : jobs;
  const saved = compact ? library.slice(0, Math.max(3 - entries.length, 0)) : library;
  return <section className="panel run-list">
    <div className="run-list-title"><div className="panel-heading"><div className="section-icon"><ClipboardList size={17} /></div><h3>{compact ? 'Recent runs' : 'Run history'}</h3></div></div>
    {!entries.length && !saved.length && <div className="empty-list"><FileText size={22} /><p>Research reports and backtests will appear here.</p></div>}
    {entries.map((job) => <button className="run-row" key={job.id} onClick={() => onOpen(job.id)}>
      <div className="run-icon">{job.type === 'research' ? <FileText size={18} /> : <FlaskConical size={18} />}</div>
      <div className="run-row-text"><strong>{job.params.symbol || job.params.symbols.join(', ')}</strong><span>{job.params.question || (job.type === 'research' ? 'Research brief' : 'Decision backtest')}</span></div>
      <span className="run-date">{dateLabel(job.params.date || job.params.start)}</span><Status job={job} />
    </button>)}
    {saved.map((report) => <button className="run-row" key={report.id} onClick={() => onImport(report.id)}>
      <div className="run-icon"><FileText size={18} /></div>
      <div className="run-row-text"><strong>{report.symbol}</strong><span>Saved CLI report</span></div>
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
    <div className="panel-heading"><div className="section-icon"><TextAlignStart size={17} /></div><h3>TL;DR</h3></div>
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
      <div className="panel-heading"><div className="section-icon"><FileText size={17} /></div><h3>Research report</h3></div>
      <div className="report-actions">
        <a className="button button-small button-outline" href={`${prefix}/html`} target="_blank" rel="noreferrer"><Globe2 size={15} />Open HTML</a>
        <a className="button button-small button-outline" href={`${prefix}/md`} download="research-report.md"><Download size={15} />Markdown</a>
      </div>
    </div>
    {error && <p className="form-error">{error}</p>}
    {!markdown && !error && <div className="empty-list"><LoaderCircle className="spin" size={22} /><p>Loading report…</p></div>}
    {markdown && <Tabs.Root defaultValue="all" key={prefix}>
      <Tabs.List className="report-tabs" aria-label="Report sections">{groups.map(({ id, title }) =>
        <Tabs.Trigger value={id} key={id}>{title}</Tabs.Trigger>)}</Tabs.List>
      {groups.map(({ id, content }) => <Tabs.Content key={id} value={id}><Suspense fallback={<p className="inline-note">Rendering report…</p>}><Markdown content={content} /></Suspense></Tabs.Content>)}
    </Tabs.Root>}
  </section>;
}

function AgentProgress({ job }) {
  const steps = job.steps || [];
  const names = { get_stock_data: 'Price history', get_verified_market_snapshot: 'Verified market snapshot', get_indicators: 'Technical indicators',
    get_news: 'Company news', get_global_news: 'Macro headlines', get_fundamentals: 'Company snapshot' };

  return <section className="panel progress-panel">
    <div className="panel-heading"><div className="section-icon"><Activity size={17} /></div><h3>Agent progress</h3><Status job={job} /></div>
    <p className="inline-note">{job.providers?.quick?.provider} for analysts and debate · {job.providers?.deep?.provider} for managers</p>
    {!steps.length && <p className="inline-note">{job.status === 'queued' ? 'Waiting for the current job to finish.' : 'Preparing the research team.'}</p>}
    <div className="step-grid">{steps.map(({ id, name, status }) => {
      const Icon = status === 'complete' ? Check : status === 'running' && openJob(job) ? LoaderCircle : Activity;
      return <div key={id} className={`step step-${status}`}>
        <Icon size={15} className={status === 'running' && openJob(job) ? 'spin' : ''} />
        <span>{name}</span>
        <small>{status === 'complete' ? 'Done' : status === 'running' && openJob(job) ? 'Running' : 'Waiting'}</small>
      </div>;
    })}</div>
    {job.tools && Object.keys(job.tools).length > 0 && <details className="tools-list">
      <summary>Tool activity</summary>
      <div>{Object.entries(job.tools).map(([tool, count]) => <span key={tool}>{names[tool] || tool.replaceAll('_', ' ')} <b>{count}</b></span>)}</div>
    </details>}
  </section>;
}

function BacktestResult({ job }) {
  const summary = job.summary;
  const stats = summary && [
    ['Resolved', summary.resolved], ['Pending', summary.pending], ['Unscored', summary.unscored],
    ['Failed cells', job.failed_cells],
  ];
  return <section className="panel test-result">
    <div className="panel-heading"><div className="section-icon"><FlaskConical size={17} /></div><h3>Decision backtest</h3><Status job={job} /></div>
    {!summary && !job.error && <p className="inline-note">{job.progress ? `Evaluating ${job.progress.symbol} on ${dateLabel(job.progress.date)} · ${job.progress.cell} of ${job.progress.total}` : 'Waiting to evaluate the selected dates.'}</p>}
    {summary && <>
      <div className="metrics">{stats.map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="table-scroll"><table><thead><tr><th>Rating</th><th>Decisions</th><th>Directional hit rate</th><th>Mean excess return</th></tr></thead>
        <tbody>{Object.entries(summary.by_rating).map(([rating, result]) => <tr key={rating}><td>{rating}</td><td>{result.count}</td>
          <td>{result.hit_rate === null ? '—' : `${(result.hit_rate * 100).toFixed(0)}%`}</td><td>{signed(result.mean_alpha * 100)}</td></tr>)}</tbody></table></div>
      <p className="inline-note">Scored over {summary.holding} from the first close after the analysis date, against the configured benchmark.{job.settlement_failures > 0 && ` Settlement failures: ${job.settlement_failures}.`}</p>
    </>}
  </section>;
}

export function RunDetail({ job, imported }) {
  if (imported) {
    const prefix = `/api/library/${encodeURIComponent(imported)}`;
    return <div className="run-detail" key={imported}>
      <ResearchSummary prefix={prefix} />
      <ReportViewer prefix={prefix} />
    </div>;
  }
  if (!job) return <section className="panel empty-list no-run"><SearchX size={24} /><p>Select a run to see its progress and report.</p></section>;
  const p = job.params;
  const reportPrefix = `/api/jobs/${job.id}/report`;
  return <div className="run-detail">
    <section className="panel run-summary">
      <div><span className="instrument-label">{job.type === 'research' ? dateLabel(p.date) : `${dateLabel(p.start)} – ${dateLabel(p.end)}`}</span>
        <h2>{p.symbol || p.symbols.join(', ')}</h2><p>{p.question || (job.type === 'research' ? 'Research brief' : 'Historical decision evaluation')}</p></div>
      {job.rating && <span className="rating">{job.rating}</span>}
      {job.error && <p className="form-error"><CircleAlert size={16} />{job.error}</p>}
    </section>
    {job.report && <ResearchSummary prefix={reportPrefix} key={job.id} />}
    {job.type === 'backtest' ? <BacktestResult job={job} /> : <AgentProgress job={job} />}
    <ModelLog job={job} key={`model-log:${job.id}`} />
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

  return <details className="panel memory-panel" onToggle={load}>
    <summary>
      <div className="section-icon"><Database size={17} /></div>
      <div><strong>Decision memory</strong><span>Past decisions, outcomes, and lessons</span></div>
    </summary>
    {error && <p className="form-error">{error}</p>}
    {!entries && !error && <p className="inline-note">Loading past decisions…</p>}
    {entries?.length === 0 && <p className="inline-note">Past decisions will appear after a research run.</p>}
    {entries?.map((entry) => <div key={`${entry.ticker}:${entry.date}`} className="memory-entry">
      <div><strong>{entry.ticker}</strong><span>{dateLabel(entry.date)} · {entry.rating}</span></div>
      {entry.pending ? <span className="status status-queued">Pending</span>
        : <span>{entry.raw || '—'} return · {entry.alpha || '—'} alpha · {entry.holding || '—'}</span>}
      {entry.reflection && <details><summary>Read lesson</summary>
        <Suspense fallback={<p className="inline-note">Loading lesson…</p>}><Markdown content={entry.reflection} /></Suspense>
      </details>}
    </div>)}
  </details>;
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
      <div><h2>New backtest</h2><p>Run the agents across a date grid and score their decisions against the benchmark.</p></div></div>
    <form onSubmit={submit}>
      <label>Tickers<input value={symbols} onChange={(event) => setSymbols(event.target.value)} placeholder="RELIANCE.NS, TCS.NS" required /></label>
      <div className="form-columns">
        <label>Start date<input type="date" value={start} max={today} onChange={(event) => setStart(event.target.value)} required /></label>
        <label>End date<input type="date" value={end} min={start} max={today} onChange={(event) => setEnd(event.target.value)} required /></label>
      </div>
      <label>Evaluate every N calendar days<input type="number" min={1} value={every} onChange={(event) => setEvery(Number(event.target.value))} required /></label>
      <div className="details-label">Analysts</div>
      <AnalystOptions selected={selected} setSelected={setSelected} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="backtest-submit"><span>{count} evaluation{count !== 1 ? 's' : ''}</span><button className="button button-primary" disabled={busy || !count || !selected.length} type="submit">
        {busy ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}Run backtest</button></div>
    </form>
  </section>;
}
