import { useState } from 'react';
import { Bot, LoaderCircle, Play, Square } from 'lucide-react';
import { dateLabel, money, number, tone } from './api';

const rupees = (value) => value == null ? '—' : money(Number(value), 'INR');
const pnlTone = (value) => tone(Number(value));
const orderReasons = {
  'candle-open': 'Entry within range', stop: 'Stop loss', target: 'Target', 'time-exit': 'Time exit',
  'gap-exit': 'Exit at next observed open after missing candles',
};

function PaperSession({ session, timeLabel }) {
  const strategies = Object.fromEntries(session.strategies.map(({ key, label }) => [key, label]));
  return <>
    <dl className="daily-auto-metrics">
      <div><dt>Session capital</dt><dd>{rupees(session.budget)}</dd></div>
      <div><dt>Available to deploy</dt><dd>{rupees(session.available)}</dd></div>
      <div><dt>Net realized P&L</dt><dd className={pnlTone(session.realized)}>{rupees(session.realized)}</dd></div>
      <div><dt>Peak invested</dt><dd>{rupees(session.peak_invested)}</dd></div>
      <div><dt>Trades closed</dt><dd>{session.trades}</dd></div>
      <div><dt>Stocks scanned</dt><dd>{session.candidates}</dd></div>
    </dl>
    <p className="daily-auto-note">Estimated costs {rupees(session.costs)} · {session.scans} scans
      {session.last_scan && ` · Last scan ${timeLabel(session.last_scan)}`}</p>
    {session.unresolved > 0 && <p className="daily-auto-alert">{session.unresolved} {session.unresolved === 1 ? 'position has' : 'positions have'} no observed exit. The realized result excludes them.</p>}
    {(session.open > 0 || session.pending > 0) && <section className="daily-auto-positions" aria-label="Paper positions and queued entries">
      {session.holdings.map((position) => <div key={position.asset.symbol}>
        <strong>{position.asset.symbol.replace(/\.NS$/, '')}</strong>
        <span>{position.quantity} shares · Entry {rupees(position.entry)} · Last {rupees(position.mark)} at {timeLabel(position.mark_at)}</span>
        <span>Stop {rupees(position.stop)} · Target {rupees(position.target)}</span>
      </div>)}
      {session.queued.map((order) => <div key={order.asset.symbol}>
        <strong>{order.asset.symbol.replace(/\.NS$/, '')}</strong>
        <span>{order.quantity} shares queued for {timeLabel(order.enter_at)} · {rupees(order.reserved)} reserved</span>
        <span>{rupees(order.trigger)} to {rupees(order.entry_cap)}</span>
      </div>)}
    </section>}
    {session.open > 0 && <p className="daily-auto-note">Estimated open P&L at the last observed prices {rupees(session.unrealized)}.</p>}
    <div className="daily-auto-strategies" aria-label="Closed trades by strategy">
      {session.strategies.map((strategy) => <div key={strategy.key}>
        <span>{strategy.label}</span><small>{strategy.trades} closed</small>
        <strong className={pnlTone(strategy.net)}>{rupees(strategy.net)}</strong>
      </div>)}
    </div>
    {session.orders.length > 0
      ? <div className="table-scroll daily-auto-table"><table aria-label="Automatic paper fills">
        <thead><tr><th scope="col">IST</th><th scope="col">Stock</th><th scope="col">Side</th><th scope="col">Shares</th>
          <th scope="col">Price</th><th scope="col">Costs</th><th scope="col">Net P&L</th><th scope="col">Strategy and fill</th></tr></thead>
        <tbody>{session.orders.map((order) => <tr key={`${order.asset.symbol}:${order.strategy}:${order.at}:${order.side}`}>
          <td title={`Recorded at ${timeLabel(order.recorded_at)}`}>{timeLabel(order.at)}</td><th scope="row">{order.asset.symbol.replace(/\.NS$/, '')}</th>
          <td className={order.side === 'buy' ? 'positive' : ''}>{order.side === 'buy' ? 'Buy' : 'Sell'}</td>
          <td>{order.units}</td><td>{rupees(order.price)}</td><td>{rupees(order.fee)}</td>
          <td className={pnlTone(order.net)}>{rupees(order.net)}</td>
          <td>{strategies[order.strategy]}<small>{orderReasons[order.reason]}{order.source && ` · ${order.source}`}</small></td>
        </tr>)}</tbody>
      </table></div>
      : <p className="daily-auto-note">No paper fills this session.</p>}
    {Object.keys(session.skipped).length > 0 && <details className="daily-auto-skips">
      <summary>Skipped entries</summary>
      <ul>{Object.entries(session.skipped).map(([reason, count]) => <li key={reason}>{reason} <strong>{count}</strong></li>)}</ul>
    </details>}
  </>;
}

export function DailyAutoTrade({ data, archive, busy, onChange, onDay, timeLabel }) {
  const [length, setLength] = useState(5);
  const trial = data?.auto_trade?.trial;
  const session = data?.auto_trade?.session;
  const history = data?.auto_trade?.history || [];
  const enabled = Boolean(trial?.enabled);
  const started = trial?.days?.length || 0;
  const completed = history.filter((item) => item.closed && trial?.days.includes(item.day)).length;
  const status = archive ? 'Saved session' : enabled ? (!data?.scheduled ? 'Scheduler paused' : session && !session.closed ? 'Running' : 'Scheduled')
    : session && !session.closed && session.open > 0 ? 'Managing exits' : trial?.ended_by === 'completed' ? 'Trial complete' : 'Off';
  return <section className="panel daily-auto" aria-labelledby="daily-auto-heading">
    <div className="daily-auto-head">
      <div className="daily-auto-title">
        <span className="daily-auto-icon"><Bot size={21} /></span>
        <div><h2 id="daily-auto-heading">Auto trade <span className={`daily-auto-state${enabled && !archive ? ' active' : ''}`}>{status}</span></h2>
          <p>Paper trading · All three strategies · NSE cash equities</p></div>
      </div>
      {!archive && <div className="daily-auto-controls">
        {enabled ? <span className="daily-auto-progress">{completed} of {trial.limit} sessions complete</span> :
          <select aria-label="Auto trade trial length" value={length} disabled={busy || !data?.scheduled}
            onChange={(event) => setLength(Number(event.target.value))}>
            {[1, 3, 5].map((days) => <option value={days} key={days}>{days} trading {days === 1 ? 'day' : 'days'}</option>)}
          </select>}
        <button type="button" className={`button ${enabled ? 'button-outline' : 'button-primary'}`}
          disabled={busy || !data || (!enabled && !data.scheduled)}
          onClick={() => onChange(!enabled, length)}>
          {busy ? <LoaderCircle className="spin" size={15} /> : enabled ? <Square size={14} /> : <Play size={15} />}
          {enabled ? 'Stop auto trade' : 'Auto trade'}
        </button>
      </div>}
    </div>
    {!archive && <p className="daily-auto-note">
      {enabled
        ? `${started ? 'Entries use one shared cash limit per session.' : 'Waiting for the next eligible scan.'} ${data?.next_scan ? `Next scan ${dateLabel(data.next_scan, false)} at ${timeLabel(data.next_scan)}. ` : ''}Stopping cancels queued entries. Open positions still follow their exits.`
        : 'Runs on the server across regular trading sessions. Cash is used as setups qualify.'}
      {session && !session.closed && ' Today’s capital was fixed when the paper session started.'}
    </p>}
    {session ? <PaperSession session={session} timeLabel={timeLabel} /> : archive && <p className="daily-auto-note">No Auto trade account was recorded for this session.</p>}
    {history.length > 0 && <details className="daily-auto-history" open={!session}>
      <summary>Paper session history <span>{history.length}</span></summary>
      <div className="table-scroll daily-auto-table"><table aria-label="Paper session history">
        <thead><tr><th scope="col">Session</th><th scope="col">Status</th><th scope="col">Capital</th><th scope="col">Trades</th>
          <th scope="col">Winning trades</th><th scope="col">Net realized P&L</th><th scope="col">Peak invested</th></tr></thead>
        <tbody>{history.map((item) => <tr key={item.day}>
          <th scope="row"><button type="button" className="sort-heading" onClick={() => onDay(item.day)}>{dateLabel(item.day)}</button></th>
          <td>{item.unresolved ? `${item.unresolved} unresolved` : item.closed ? 'Closed' : 'In progress'}</td>
          <td>{rupees(item.budget)}</td><td>{item.trades}</td><td>{number(item.wins, 0)}</td>
          <td className={pnlTone(item.realized)}>{rupees(item.realized)}</td><td>{rupees(item.peak_invested)}</td>
        </tr>)}</tbody>
      </table></div>
    </details>}
  </section>;
}
