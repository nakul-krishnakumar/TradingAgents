import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Download, Terminal } from 'lucide-react';
import { api, makeUrl, number, openJob } from './api';
import { HelpDetails, HelpTitle, WithHelp } from './Help';

const clock = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

const tokenHelp = {
  Input: 'The number of pieces of text sent to the model, including the question, instructions, and any evidence already collected.',
  Output: 'The number of pieces of text the model generated. Depending on the provider, this count may include tokens used while thinking.',
  Thinking: 'The number of tokens the provider says the model used to reason before responding. A dash means the provider supplied no count.',
};

const outputHelp = {
  'Thinking summary from the model': 'A short account of the approach the model took, supplied by the provider when available. It can update while the call is running.',
  'Reasoning shared by the model': 'Reasoning text supplied by the provider for this call. What appears here depends on the model and provider.',
  'Model response': 'The text returned by this model call. During a live run it may arrive in pieces. Scroll up to read earlier text without following new output.',
};

function addEvents(previous, events) {
  const calls = new Map(previous.calls);
  let toolResults = previous.toolResults;
  let gaps = previous.gaps;
  for (const event of events) {
    const current = calls.get(event.call);
    if (event.type === 'gap') {
      gaps += event.dropped || 1;
    } else if (event.type === 'start') {
      calls.set(event.call, { ...event, status: 'Running', text: '', summary: '', reasoning: '' });
    } else if (event.type === 'tool') {
      toolResults += 1;
    } else if (current && event.type === 'delta') {
      calls.set(event.call, { ...current, [event.channel]: current[event.channel] + event.text });
    } else if (current && event.type === 'finish') {
      calls.set(event.call, { ...current, status: 'Completed', usage: event.usage, tools: event.tools, reason: event.reason, elapsed: event.elapsed_ms });
    } else if (current && event.type === 'error') {
      const error = event.http_status ? `${event.error} · HTTP ${event.http_status}` : event.error;
      calls.set(event.call, { ...current, status: 'Failed', error, detail: event.detail, elapsed: event.elapsed_ms });
    }
  }
  return { calls, toolResults, gaps };
}

function LiveText({ label, text }) {
  const view = useRef(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    if (follow.current) view.current.scrollTop = view.current.scrollHeight;
  }, [text]);
  return <div className="model-output">
    <WithHelp label={label} text={outputHelp[label]}><strong>{label}</strong></WithHelp>
    <pre ref={view} aria-label={label} tabIndex={0} onScroll={(event) => {
      const el = event.currentTarget;
      follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    }}>{text}</pre>
  </div>;
}

function ModelCall({ call, latest, running, onDiagnostics }) {
  const status = call.status === 'Running' && !running ? 'Interrupted' : call.status;
  const stats = call.usage && [
    ['Input', call.usage.input], ['Output', call.usage.output], ['Thinking', call.usage.thinking],
  ];
  return <HelpDetails className="model-call" wrapperClassName="model-call-help" open={latest || undefined}
    label={`${call.agent} model call`} text="Open this entry to see what the model returned, which tools it requested, and any error. The row shows the model, its start time in India, and its status."
    summary={<>
      <div className="model-call-name">
        <strong>{call.agent}</strong><span>{[call.provider, call.model].filter(Boolean).join(' · ')}</span>
      </div>
      <span className="model-time">{clock.format(new Date(call.at))}</span>
      <span className={`status status-${status.toLowerCase()}`}><span />{status}</span>
      <ChevronDown className="model-chevron" size={16} aria-hidden="true" />
    </>}>
    <div className="model-call-body">
      <div className="form-actions">
        {Number.isFinite(call.elapsed) && <span className="inline-note">{number(call.elapsed / 1000, 1)} seconds</span>}
        {onDiagnostics && <WithHelp label="Follow this call" text="Open the system log filtered to this model call. See related requests, warnings, and errors together.">
          <button type="button" className="button button-small button-outline" data-log="model.follow-call"
            onClick={() => onDiagnostics(call.call)}>Follow this call</button>
        </WithHelp>}
      </div>
      {stats && <div className="model-token-row" aria-label="Token usage">
        {stats.map(([label, value]) => <WithHelp key={label} label={label} text={tokenHelp[label]}><span>{label} <b>{number(value, 0)}</b></span></WithHelp>)}
      </div>}
      {call.cell && <p className="inline-note">{call.cell.symbol} · {call.cell.date}</p>}
      {call.summary && <LiveText label="Thinking summary from the model" text={call.summary} />}
      {call.reasoning && <LiveText label="Reasoning shared by the model" text={call.reasoning} />}
      {call.text && <LiveText label="Model response" text={call.text} />}
      {call.tools?.length > 0 && <div className="model-output">
        <WithHelp label="Tools the model requested" text="Lists the tools this model asked the app to run and the inputs it sent. For example, a price lookup may include a stock symbol and date.">
          <strong>Tools the model requested</strong>
        </WithHelp>
        <pre tabIndex={0} aria-label="Tools the model requested">{call.tools.map((tool) => `${tool.name}\n${JSON.stringify(tool.arguments, null, 2)}`).join('\n\n')}</pre>
      </div>}
      {call.error && <p className="form-error">{call.error}{call.detail && ` · ${call.detail}`}</p>}
      {!call.text && !call.summary && !call.reasoning && !call.tools?.length && !call.error && (
        <p className="inline-note">{status === 'Running' ? 'Waiting for the provider to return output…' : 'This call returned no chat text.'}</p>
      )}
    </div>
  </HelpDetails>;
}

export default function ModelLog({ job, endpoint, parameters, onDiagnostics }) {
  const [log, setLog] = useState(() => ({ calls: new Map(), toolResults: 0, gaps: 0 }));
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
        const result = await api(makeUrl(base, selection), { signal: controller.signal, background: true });
        if (controller.signal.aborted) return;
        cursor.current = result.offset;
        if (result.events.length) setLog((previous) => addEvents(previous, result.events));
        setError('');
        if (result.more || active) timer = window.setTimeout(poll, result.more ? 0 : 550);
      } catch (err) {
        if (controller.signal.aborted) return;
        if (err.status === 400 && cursor.current > 0) {
          cursor.current = 0;
          setLog({ calls: new Map(), toolResults: 0, gaps: 0 });
          timer = window.setTimeout(poll, 0);
          return;
        }
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
  const totals = Object.keys(tokenHelp).map((label) => {
    const counts = visible.map((call) => call.usage?.[label.toLowerCase()]).filter(Number.isFinite);
    return [label, counts.length ? counts.reduce((sum, count) => sum + count, 0) : null];
  });
  return <section className="panel model-log-panel">
    <div className="model-log-heading">
      <div className="panel-heading"><div className="section-icon"><Terminal size={17} /></div>
        <HelpTitle as="h3" label="AI output and logs" text="See each model call, the text it returned, tool requests, and any reported errors. Thinking summaries and counts appear when the provider shares them. A Live badge means the list updates during the run." />
        {active && job.model_log && <span className="status status-running"><span />Live</span>}</div>
      {calls.length > 0 && <div className="model-log-controls">
        <WithHelp label="Filter the log by team member" text="Pick a research team member to see only their calls and token totals. Whole research team shows the complete list.">
          <select aria-label="Filter the log by team member" value={agent} onChange={(event) => setAgent(event.target.value)}>
            <option value="">Whole research team</option>
            {agents.map((label) => <option key={label}>{label}</option>)}
          </select>
        </WithHelp>
        <WithHelp label="Download log" text="Save the recorded model output, errors, and usage for this run as a text file with one event per line.">
          <a className="button button-small button-outline" href={download} download><Download size={15} />Download log</a>
        </WithHelp>
      </div>}
    </div>
    {error && <p className="form-error">{error}</p>}
    {log.gaps > 0 && <p className="inline-note">The model log has {log.gaps} missing or damaged {log.gaps === 1 ? 'record' : 'records'}.</p>}
    {calls.length === 0 && !error && <p className="inline-note">{
      !job.model_log ? 'No model log was saved for this run.' : active ? 'Waiting for the research team’s first response…' : 'No model activity was recorded.'
    }</p>}
    {calls.length > 0 && <>
      <div className="model-token-row model-token-total" aria-label="Reported token totals">
        {totals.map(([label, value]) => <WithHelp key={label} label={`Total ${label.toLowerCase()} tokens`}
          text={`${tokenHelp[label]} This total adds up the reported counts for the calls shown below.`}>
          <span>{label} <b>{number(value, 0)}</b></span>
        </WithHelp>)}
      </div>
      <p className="inline-note">Models count text in tokens, which are pieces of words. Thinking counts appear when the provider reports them and may be included in the output count.</p>
      <div className="model-calls">
        {visible.map((call, index) => <ModelCall key={call.call} call={call} latest={index === 0} running={active} onDiagnostics={onDiagnostics} />)}
      </div>
      {log.toolResults > 0 && <p className="inline-note">{log.toolResults} tool result{log.toolResults === 1 ? '' : 's'} recorded.</p>}
    </>}
  </section>;
}
