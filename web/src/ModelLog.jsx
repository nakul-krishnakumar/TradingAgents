import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Download, Terminal } from 'lucide-react';
import { api, makeUrl, number, openJob } from './api';

const clock = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function addEvents(previous, events) {
  const calls = new Map(previous.calls);
  let toolResults = previous.toolResults;
  for (const event of events) {
    const current = calls.get(event.call);
    if (event.type === 'start') {
      calls.set(event.call, { ...event, status: 'Running', text: '', summary: '', reasoning: '' });
    } else if (event.type === 'tool') {
      toolResults += 1;
    } else if (current && event.type === 'delta') {
      calls.set(event.call, { ...current, [event.channel]: current[event.channel] + event.text });
    } else if (current && event.type === 'finish') {
      calls.set(event.call, { ...current, status: 'Completed', usage: event.usage, tools: event.tools, reason: event.reason });
    } else if (current && event.type === 'error') {
      const error = event.http_status ? `${event.error} · HTTP ${event.http_status}` : event.error;
      calls.set(event.call, { ...current, status: 'Failed', error });
    }
  }
  return { calls, toolResults };
}

function LiveText({ label, text }) {
  const view = useRef(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    if (follow.current) view.current.scrollTop = view.current.scrollHeight;
  }, [text]);
  return <div className="model-output">
    <strong>{label}</strong>
    <pre ref={view} aria-label={label} tabIndex={0} onScroll={(event) => {
      const el = event.currentTarget;
      follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    }}>{text}</pre>
  </div>;
}

function ModelCall({ call, latest, running }) {
  const status = call.status === 'Running' && !running ? 'Interrupted' : call.status;
  const stats = call.usage && [
    ['Input', call.usage.input], ['Output', call.usage.output], ['Thinking', call.usage.thinking],
  ];
  return <details className="model-call" open={latest || undefined}>
    <summary>
      <div className="model-call-name">
        <strong>{call.agent}</strong><span>{[call.provider, call.model].filter(Boolean).join(' · ')}</span>
      </div>
      <span className="model-time">{clock.format(new Date(call.at))}</span>
      <span className={`status status-${status.toLowerCase()}`}><span />{status}</span>
      <ChevronDown className="model-chevron" size={16} aria-hidden="true" />
    </summary>
    <div className="model-call-body">
      {stats && <div className="model-token-row" aria-label="Token usage">
        {stats.map(([label, value]) => <span key={label}>{label} <b>{number(value, 0)}</b></span>)}
      </div>}
      {call.cell && <p className="inline-note">{call.cell.symbol} · {call.cell.date}</p>}
      {call.summary && <LiveText label="Provider thought summary" text={call.summary} />}
      {call.reasoning && <LiveText label="Provider reasoning" text={call.reasoning} />}
      {call.text && <LiveText label="Generated chat" text={call.text} />}
      {call.tools?.length > 0 && <div className="model-output">
        <strong>Tool calls</strong>
        <pre tabIndex={0} aria-label="Tool calls">{call.tools.map((tool) => `${tool.name}\n${JSON.stringify(tool.arguments, null, 2)}`).join('\n\n')}</pre>
      </div>}
      {call.error && <p className="form-error">{call.error}</p>}
      {!call.text && !call.summary && !call.reasoning && !call.tools?.length && !call.error && (
        <p className="inline-note">{status === 'Running' ? 'Waiting for the provider to return output…' : 'This call returned no chat text.'}</p>
      )}
    </div>
  </details>;
}

export default function ModelLog({ job, endpoint, parameters }) {
  const [log, setLog] = useState(() => ({ calls: new Map(), toolResults: 0 }));
  const [error, setError] = useState('');
  const [agent, setAgent] = useState('');
  const cursor = useRef(0);
  const base = endpoint || `/api/jobs/${job.id}/model-log`;
  const query = new URLSearchParams(parameters).toString();
  const download = query ? `${base}/download?${query}` : `${base}/download`;
  const active = openJob(job);

  useEffect(() => {
    if (!job.model_log) return undefined;
    const controller = new AbortController();
    let timer;
    async function poll() {
      try {
        const selection = new URLSearchParams(query);
        selection.set('offset', cursor.current);
        const result = await api(makeUrl(base, selection), { signal: controller.signal });
        if (controller.signal.aborted) return;
        cursor.current = result.offset;
        if (result.events.length) setLog((previous) => addEvents(previous, result.events));
        setError('');
        if (result.more || active) timer = window.setTimeout(poll, result.more ? 0 : 550);
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err.message);
        if (active) timer = window.setTimeout(poll, 1800);
      }
    }
    poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [active, base, job.model_log, query]);

  const calls = [...log.calls.values()].reverse();
  const agents = [...new Set(calls.map((call) => call.agent))].sort();
  const visible = calls.filter((call) => !agent || call.agent === agent);
  const totals = ['input', 'output', 'thinking'].map((key) => {
    const counts = visible.map((call) => call.usage?.[key]).filter(Number.isFinite);
    return [key, counts.length ? counts.reduce((sum, count) => sum + count, 0) : null];
  });
  return <section className="panel model-log-panel">
    <div className="model-log-heading">
      <div className="panel-heading"><div className="section-icon"><Terminal size={17} /></div><h3>Model log</h3>{active && job.model_log && <span className="status status-running"><span />Live</span>}</div>
      {calls.length > 0 && <div className="model-log-controls">
        <select aria-label="Filter model log by agent" value={agent} onChange={(event) => setAgent(event.target.value)}>
          <option value="">All agents</option>
          {agents.map((label) => <option key={label}>{label}</option>)}
        </select>
        <a className="button button-small button-outline" href={download} download><Download size={15} />JSONL</a>
      </div>}
    </div>
    {error && <p className="form-error">{error}</p>}
    {calls.length === 0 && !error && <p className="inline-note">{
      !job.model_log ? 'This run predates model logging.' : active ? 'Waiting for the first model call…' : 'No model calls were recorded.'
    }</p>}
    {calls.length > 0 && <>
      <div className="model-token-row model-token-total" aria-label="Reported token totals">
        {totals.map(([label, value]) => <span key={label}>{label} <b>{number(value, 0)}</b></span>)}
      </div>
      <p className="inline-note">Thinking counts arrive with provider usage. Output totals include thinking when billed as output.</p>
      <div className="model-calls">
        {visible.map((call, index) => <ModelCall key={call.call} call={call} latest={index === 0} running={active} />)}
      </div>
      {log.toolResults > 0 && <p className="inline-note">{log.toolResults} tool result{log.toolResults === 1 ? '' : 's'} recorded.</p>}
    </>}
  </section>;
}
