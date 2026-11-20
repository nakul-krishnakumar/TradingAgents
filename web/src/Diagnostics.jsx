import { useEffect, useState } from 'react';
import { Activity, ChevronDown, Download, LoaderCircle, RefreshCw, Search, Terminal, X } from 'lucide-react';
import { api, makeUrl } from './api';
import { HelpTitle, WithHelp } from './Help';
import './diagnostics.css';

const services = { 'market-desk': 'Market Desk', 'codex-bridge': 'Codex bridge', launcher: 'Launcher' };
const clock = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const identifiers = {
  request_id: 'Request', parent_request_id: 'Parent request', related_request_id: 'Related request', run_id: 'Run',
  scan_id: 'Market check', call_id: 'Call', action_id: 'Action', session_id: 'Browser visit',
};

function EventRow({ entry, onTrace, onRun }) {
  const row = entry.fields || {};
  const summary = [row.method, row.route, row.status, row.symbol, row.provider || row.vendor, row.control]
    .filter((item) => typeof item === 'string' || Number.isFinite(item)).join(' · ');
  const links = Object.entries(identifiers).filter(([field]) => row[field]);
  return <details className="diagnostic-entry">
    <summary data-log="logs.expand-event">
      <span className={`diagnostic-level diagnostic-${entry.level.toLowerCase()}`}>{entry.level}</span>
      <span className="diagnostic-identity">
        <strong>{entry.message}</strong>
        <small>{entry.event}{summary && ` · ${summary}`}</small>
      </span>
      <span className="diagnostic-time"><time dateTime={entry.at}>{clock.format(new Date(entry.at))}</time><small>{services[entry.service] || entry.service}</small></span>
      <ChevronDown size={16} />
    </summary>
    <div className="diagnostic-details">
      <div className="diagnostic-context">
        {links.map(([field, label]) => <button className="button button-small button-outline" key={field} type="button"
          title={row[field]} data-log="logs.follow-id" onClick={() => onTrace(row[field])}>{label} {row[field].slice(0, 8)}</button>)}
        {row.run_id && <button type="button" className="button button-small button-outline" data-log="logs.open-run"
          onClick={() => onRun(row.run_id)}>Open research run</button>}
      </div>
      <small>{entry.logger} · Event {entry.id}{Number.isFinite(row.elapsed_ms) && ` · ${row.elapsed_ms} ms`}</small>
      <WithHelp label="Event details" text="Shows the technical details recorded for this event. Click a short ID above to follow the same request, research run, or market check across the log." />
      <pre tabIndex={0} aria-label="Event details">{JSON.stringify(row, null, 2)}</pre>
    </div>
  </details>;
}

export function Diagnostics({ selectedTrace = '', onRun }) {
  const [filter, setFilter] = useState({ q: '', service: '', issues: false, omit_reads: !selectedTrace, trace: selectedTrace });
  const [text, setText] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [revision, refresh] = useState(0);
  const args = Object.fromEntries(Object.entries(filter).filter(([, value]) => Boolean(value)));
  const query = new URLSearchParams(args).toString();

  useEffect(() => {
    const controller = new AbortController();
    let fetching = false;
    async function load() {
      if (fetching) return;
      fetching = true;
      try {
        const payload = await api(`/api/diagnostics?${query}`, { signal: controller.signal, background: true });
        if (!controller.signal.aborted) {
          setError('');
          setData({ ...payload, query });
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err.message);
      } finally {
        fetching = false;
      }
    }
    load();
    const timer = live ? window.setInterval(load, 3000) : undefined;
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [query, revision, live]);

  const visible = data?.query === query ? data : null;

  async function more() {
    setBusy(true);
    try {
      const next = await api(makeUrl('/api/diagnostics', { ...args, before: visible.next }), { background: true });
      setData((previous) => previous?.query === query ? { ...next, query, events: [...previous.events, ...next.events] } : previous);
      setError('');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  function follow(trace) {
    setText('');
    setFilter((prior) => ({ ...prior, trace, q: '', service: '', issues: false, omit_reads: false }));
    window.scrollTo(0, 0);
  }

  return <section className="panel diagnostics" aria-label="Event log" data-log-region="logs">
    <div className="collection-heading">
      <div><HelpTitle label="System events" text="Find out what happened in Market Desk, when, and in which part of the app. Open an event to read the details or follow its ID to see related activity. Timestamps use India time.">
        <Terminal size={20} /> System events
      </HelpTitle><p>Browse requests, research, market checks, and browser activity.</p></div>
      <div className="diagnostic-actions">
        <WithHelp label="Live updates" text="Turn this on to refresh the newest matching events every three seconds. Turn it off to browse older pages.">
          <button type="button" aria-pressed={live} className="button button-small button-outline" data-log="logs.live"
            onClick={() => setLive(!live)}><Activity size={15} /> {live ? 'Live updates on' : 'Live updates off'}</button>
        </WithHelp>
        <WithHelp label="Refresh events" text="Fetch the newest events that match your current filters.">
          <button type="button" className="button button-small button-outline" data-log="logs.refresh" onClick={() => refresh(revision + 1)}><RefreshCw size={15} /> Refresh</button>
        </WithHelp>
        <WithHelp label="Download JSONL" text="Save up to 5,000 of the most recent matching events. JSONL is a text format with one event per line and can be opened in a text editor.">
          <a className="button button-small button-outline" data-log="logs.download" href={`/api/diagnostics/download?${query}`} download>
            <Download size={15} /> Download JSONL</a>
        </WithHelp>
      </div>
    </div>
    <form className="diagnostic-filters" data-log="logs.search" onSubmit={(e) => { e.preventDefault(); setFilter({ ...filter, q: text.trim() }); }}>
      <WithHelp label="Search events" className="diagnostic-search-help" text="Type a word from the event, a symbol like RELIANCE.NS, or a request ID. Press Search to apply it with your other filters.">
        <label className="diagnostic-search"><Search size={16} /><input type="search" maxLength={200} data-log="logs.search-field"
          value={text} aria-label="Search log messages, stock symbols, or IDs" placeholder="Search events, stock symbols, or IDs" onChange={(e) => setText(e.target.value)} /></label>
      </WithHelp>
      <button className="button button-primary" type="submit">Search</button>
      <WithHelp label="Log source" text="Choose Market Desk for app events, Codex bridge for model requests handled by Codex, or Launcher for starting and stopping services.">
        <select aria-label="Log source" value={filter.service} data-log="logs.filter-source" onChange={(e) => setFilter({ ...filter, service: e.target.value })}>
          <option value="">All sources</option>{Object.entries(services).map(([key, value]) => <option value={key} key={key}>{value}</option>)}
        </select>
      </WithHelp>
      <WithHelp label="Warnings and errors" text="Show only events that recorded a possible problem, failure, or critical error. Clear the box to include routine activity too.">
        <label className="check-line"><input type="checkbox" data-log="logs.issues-only" checked={filter.issues}
          onChange={(e) => setFilter({ ...filter, issues: e.target.checked })} />Warnings and errors</label>
      </WithHelp>
      <WithHelp label="Hide successful reads" text="Hides routine requests that read data successfully, such as checks for updates. Clear this box when you need to trace every request.">
        <label className="check-line"><input type="checkbox" data-log="logs.routine-reads" checked={filter.omit_reads}
          onChange={(e) => setFilter({ ...filter, omit_reads: e.target.checked })} />Hide successful reads</label>
      </WithHelp>
    </form>
    {filter.trace && <div className="diagnostic-filter-tag">
      <WithHelp label="Following an ID" text="Shows events linked to this ID. It can track one request, research run, market check, or browser action. Use the X to remove the filter.">
        <span>Following <code>{filter.trace}</code></span>
      </WithHelp>
      <button className="icon-button" type="button" data-log="logs.clear-id" aria-label="Clear ID filter" onClick={() => setFilter({ ...filter, trace: '' })}><X size={15} /></button></div>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {!visible && !error && <p className="diagnostic-empty" role="status"><LoaderCircle className="spin" size={18} /> Loading events…</p>}
    {visible?.events.length === 0 && <p className="diagnostic-empty">No events match these filters yet.</p>}
    {visible?.events.length > 0 && <div className="diagnostic-list" aria-label="Recorded system events">
      {visible.events.map((entry) => <EventRow key={entry.id} entry={entry} onTrace={follow} onRun={onRun} />)}
    </div>}
    {!live && visible?.next && <WithHelp className="diagnostic-more" label="Load older events" text="Add the previous page of matching events below the ones already shown.">
      <button type="button" className="button button-outline" data-log="logs.older" disabled={busy} onClick={more}>Load older events</button>
    </WithHelp>}
  </section>;
}
