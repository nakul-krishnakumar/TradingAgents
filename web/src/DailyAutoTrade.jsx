import { useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Bot, ChartCandlestick, ChevronDown, CircleAlert, Clock3, LoaderCircle, Play, ScanLine, Square } from 'lucide-react';
import { dateLabel, money, signedMoney, tone } from './api';
import { Help, HelpDetails, HelpTitle, WithHelp } from './Help';

const rupees = (value) => money(value == null ? null : Number(value), 'INR');
const result = (value) => signedMoney(value == null ? null : Number(value), 'INR');
const resultTone = (value) => tone(Number(value));
const stock = (symbol) => symbol.replace(/\.NS$/, '');
const shareCount = (n) => `${n} ${n === 1 ? 'share' : 'shares'}`;
const counted = (n, word, plural = `${word}s`) => `${n} ${n === 1 ? word : plural}`;
const defaultRiskBps = 65;
const riskPercent = (bps) => `${(bps / 100).toFixed(2)}%`;

export function paperOrderLabel(order) {
  if (order.direction === 'short') return order.side === 'sell' ? 'SHORT' : 'COVER';
  return order.side === 'buy' ? 'BUY' : 'SELL';
}

const paperHelp = {
  closed: 'The combined result of closed positions after estimated charges and price adjustments on both orders.',
  open: 'An estimate based on the last available price for each open position and estimated closing costs.',
  budget: 'The most virtual money available to Auto Trade when that day began. It applies to the day shown and is shared by all strategies.',
  buys: 'Completed paper buy orders, including buys to cover shorts. An order for several shares counts once.',
  sells: 'Completed paper sell orders, including sells to open shorts. An order for several shares counts once.',
  profitable: 'Positions that closed with a gain after estimated trading costs.',
  risk: 'The estimated loss allowed per new paper position, as a percentage of the daily paper budget. It includes estimated costs. A price gap can cause a larger loss.',
  stop: 'If the price falls to this level, Auto Trade tries to sell to limit the loss. A price gap can result in a worse exit price.',
  target: 'If the price rises to this level, Auto Trade tries to sell to take profit.',
  shortStop: 'If the price rises to this level, Auto Trade tries to buy back the short. A price gap can result in a worse exit price.',
  shortTarget: 'If the price falls to this level, Auto Trade tries to buy back the short to take profit.',
};

export const paperStrategies = {
  'opening-range': {
    label: 'Break above the morning high',
    explanation: 'The price moved above its first 15-minute high and its average traded price, with more shares trading than usual.',
  },
  'vwap-reclaim': {
    label: 'Recovery above the average price',
    explanation: 'The price recovered above its average traded price, with more shares trading than usual.',
  },
  'gap-continuation': {
    label: 'Early price rise holds',
    explanation: 'The stock opened higher, held that rise, and then moved above its early high with more shares trading than usual.',
  },
  'opening-range-short': {
    label: 'Break below the morning low',
    explanation: 'The price moved below its first 15-minute low and its average traded price, with more shares trading than usual.',
  },
};

const exitReasons = {
  stop: 'The price reached the level set to limit the loss.',
  target: 'The price reached the profit target.',
  'time-exit': 'The trade reached the afternoon closing time set by Auto Trade.',
  'gap-exit': 'Some five-minute prices were missing. Auto Trade used the next available opening price.',
};

const skipReasons = {
  'Entry paused or session closed': 'New entries were paused or the market had closed.',
  'Entry candle arrived too late': 'The price data arrived too late to open the position.',
  'Opening price outside entry range': 'The next opening price was outside the planned entry range.',
  'Stock already held or queued': 'Auto Trade already had an open or waiting position in this stock.',
  'Stock details unavailable': 'The stock details were unavailable.',
  'Cash or risk limit': 'The remaining capital or loss allowance was too small for one share.',
  'Stopped before entry': 'Auto Trade was paused before the position opened.',
};

const checkReasons = {
  'market-closed': 'The market had closed. Auto Trade checked open positions for an exit.',
  'buys-paused': 'New entries were paused. Auto Trade continued to manage exits.',
  'market-unverified': 'Auto Trade could not confirm that the market was open for new entries.',
  'buy-window-ended': 'The entry window had ended for the day. Auto Trade continued to manage exits.',
};

function chartButton(asset, onChart) {
  return <button type="button" className="paper-chart-link" data-log="daily.open-paper-chart" onClick={() => onChart(asset)}
    aria-label={`View ${stock(asset.symbol)} price chart`}><ChartCandlestick size={16} /> Chart</button>;
}

function TradeList({ orders, timeLabel, onChart }) {
  return <ul className="paper-trades" aria-label="Completed paper orders">
    {orders.map((order) => {
      const buy = order.side === 'buy';
      const exit = order.net != null;
      const label = paperOrderLabel(order);
      const reason = exit
        ? exitReasons[order.reason] || order.reason
        : paperStrategies[order.strategy]?.explanation || order.signal_reason;
      const value = order.units * order.price;
      const entryTitle = buy ? 'Total spent' : 'Short sale value';
      return <li className="paper-trade" key={`${order.asset.symbol}:${order.strategy}:${order.at}:${order.side}`}>
        <span className={`trade-side trade-side-${order.side}`}>{buy ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}{label}</span>
        <div className="paper-stock"><strong>{stock(order.asset.symbol)}</strong><span>{order.asset.name}</span></div>
        <div className="paper-trade-price"><strong>{shareCount(order.units)} at {rupees(order.price)}</strong><small>{timeLabel(order.at)} · {rupees(order.fee)} estimated charges and price adjustment</small></div>
        <div className="paper-trade-money">
          <strong className={exit ? resultTone(order.net) : ''}>{exit ? result(order.net) : rupees(buy ? value + Number(order.fee) : value)}</strong>
          <small><WithHelp label={exit ? 'Profit / loss after costs' : entryTitle}
            text={exit ? paperHelp.closed : buy ? 'The purchase price times the number of shares, plus estimated buying costs.' : 'The entry price times the number of shares sold short. The simulator reserves capital for the position until it is closed.'} /></small>
        </div>
        {chartButton(order.asset, onChart)}
        <p className="paper-trade-reason"><strong>{exit ? 'Why it closed' : 'Why it opened'}</strong> {reason}
          {!exit && ' The opening price was within the planned entry range.'}</p>
      </li>;
    })}
  </ul>;
}

function WaitingList({ orders, timeLabel }) {
  return <ul className="paper-waiting">
    {orders.map((order) => {
      const label = order.direction === 'short' ? 'Waiting to SHORT' : 'Waiting to BUY';
      const lower = Math.min(order.trigger, order.entry_cap);
      const upper = Math.max(order.trigger, order.entry_cap);
      return <li key={order.asset.symbol}>
        <div><span className="trade-side trade-side-wait">{label}</span><strong>{stock(order.asset.symbol)}</strong>
          <Help label={label} text="Auto Trade reserved paper capital and opens the position only if the next eligible opening price is within this range." /></div>
        <p>{shareCount(order.quantity)} if the {timeLabel(order.enter_at)} opening price is between {rupees(lower)} and {rupees(upper)}.</p>
        {paperStrategies[order.strategy] && <small>{paperStrategies[order.strategy].explanation}</small>}
      </li>;
    })}
  </ul>;
}

function OpenTrades({ session, timeLabel, onChart }) {
  return <section className="paper-section" aria-label="Open and waiting paper trades">
    <div className="paper-section-title"><HelpTitle as="h3" label="Open and waiting positions"
      text="See each position’s entry, last observed price, exit levels, and estimated result. Open Chart to locate trades." />
      <span>{counted(session.open, 'open position')} · {session.pending} waiting</span></div>
    {session.unresolved > 0 && <p className="paper-alert">{counted(session.unresolved, 'position')} remained open at the end of this day because an exit price was unavailable. The estimate uses the last observed price.</p>}
    {session.holdings.length > 0 ? <ul className="paper-holdings">
      {session.holdings.map((position) => {
        const short = position.direction === 'short';
        const close = short ? 'Cover' : 'Sell';
        return <li key={position.asset.symbol}>
          <div className="paper-holding-heading"><div className="paper-stock"><strong>{stock(position.asset.symbol)}</strong><span>{position.asset.name}</span></div>{chartButton(position.asset, onChart)}</div>
          <p>{short ? 'Shorted' : 'Bought'} {shareCount(position.quantity)} at <strong>{rupees(position.entry)}</strong> · Last price {rupees(position.mark)} at {timeLabel(position.mark_at)}</p>
          <div className="paper-holding-result"><WithHelp label="Estimated profit / loss" text={paperHelp.open} /><strong className={resultTone(position.unrealized)}>{result(position.unrealized)}</strong></div>
          <div className="paper-sell-plan">
            <WithHelp label={`${close} to limit loss`} text={short ? paperHelp.shortStop : paperHelp.stop}><span>{close} to limit loss <strong>{rupees(position.stop)}</strong></span></WithHelp>
            <WithHelp label={`${close} to take profit`} text={short ? paperHelp.shortTarget : paperHelp.target}><span>{close} to take profit <strong>{rupees(position.target)}</strong></span></WithHelp>
          </div>
        </li>;
      })}
    </ul> : <p className="paper-note">No positions are open for this day.</p>}
    {session.queued.length > 0 && <WaitingList orders={session.queued} timeLabel={timeLabel} />}
  </section>;
}

function checkSummary(check) {
  const fills = {};
  for (const order of check.orders) {
    const label = paperOrderLabel(order);
    fills[label] = (fills[label] || 0) + 1;
  }
  const caption = [`Checked ${counted(check.checked.length, 'stock')}`];
  for (const [label, count] of Object.entries(fills)) caption.push(`${count} ${label}`);
  if (check.queued.length) caption.push(`${check.queued.length} waiting to enter`);
  if (!check.orders.length && !check.queued.length) caption.push('No orders filled');
  if (check.skipped.length) caption.push(counted(check.skipped.length, 'skipped entry', 'skipped entries'));
  return caption.join(' · ');
}

function checkExplanation(check) {
  if (checkReasons[check.mode]) return checkReasons[check.mode];
  if (!check.checked.length) return 'There were no stocks available to check.';
  if (check.checked.every((item) => !item.has_prices)) return 'No completed 5-minute prices were available for the stocks checked.';
  if (check.signals === 0 && !check.orders.length && !check.skipped.length) {
    return check.waiting ? 'An earlier order is still waiting for price data.' : 'No new entry or exit qualified.';
  }
  if (check.signals) return `${counted(check.signals, 'new entry signal')} met the strategy rules. Auto Trade checked the available capital and loss limit.`;
  return 'Auto Trade reviewed waiting orders and open positions using completed five-minute prices.';
}

function ScanActivity({ checks, earlierChecks, data, archive, timeLabel, onChart, onDiagnostics }) {
  const [expanded, setExpanded] = useState(false);
  const latest = checks[0];
  const marketCheck = data?.completed_at || data?.updated_at;
  const trace = data.active_scan_id || data.failed_scan_id || (!latest && data.scan_id);
  const running = !archive && (data?.operation === 'scan' || (!data?.operation && data?.running));
  let Icon = Clock3;
  let title = 'Waiting for a market check';
  let description = 'When trading opens, scheduled checks run about every five minutes.';
  if (running) {
    Icon = LoaderCircle;
    title = 'Checking the market now';
    description = 'Loading stock prices, then checking open positions and possible entries.';
  } else if (data?.check_issue) {
    Icon = CircleAlert;
    title = 'Market check message';
    description = data.check_issue;
  } else if (latest) {
    Icon = ScanLine;
    title = `Latest Auto Trade check · ${timeLabel(latest.at)}`;
    description = checkSummary(latest);
  } else if (marketCheck) {
    title = `Latest market check · ${timeLabel(marketCheck)}`;
    description = data.slot === 'premarket' ? 'The desk checked news and market activity before trading opened.'
      : 'The desk checked stock prices. This day has no saved Auto Trade check details.';
  }
  return <section className="paper-section" aria-labelledby="check-title">
    <div className="paper-section-title"><HelpTitle as="h3" id="check-title" label="Market checks"
      text="Auto Trade reviews the latest completed five-minute prices during a regular NSE session. Open a check to see stocks reviewed, missing prices, filled orders, and reasons it waited or skipped." />
      {checks.length > 0 && <span>{counted(checks.length, 'saved check')}</span>}</div>
    <div className="paper-check-status" role="status">
      <Icon className={running ? 'spin' : undefined} size={19} />
      <div><strong>{title}</strong><span>{description}</span></div>
      {trace && <WithHelp label="Check logs" text="Open the technical timeline for this market check to see data sources, timings, failures, and any trades it recorded.">
        <button type="button" className="button button-small button-outline" data-log="daily.open-check-log" onClick={() => onDiagnostics(trace)}>Check logs</button>
      </WithHelp>}
    </div>
    {checks.length > 0 && <>
      <div className="paper-checks">
        {(expanded ? checks : checks.slice(0, 4)).map((check, index) => <HelpDetails className="paper-check" wrapperClassName="paper-check-help"
          key={check.number} open={index === 0 ? true : undefined} label={`Check ${check.number}`}
          text="The time is when Auto Trade recorded this check. Expand it for decisions, the stock prices the check used, and the reason an order was completed or skipped."
          summaryProps={{ 'data-log': 'daily.inspect-check' }}
          summary={<><span><strong>Check {check.number} · {timeLabel(check.at)}</strong><small>{checkSummary(check)}</small></span><ChevronDown size={17} /></>}>
          <div className="paper-check-detail">
            <p>{checkExplanation(check)}</p>
            {check.orders.length > 0 && <TradeList orders={check.orders} timeLabel={timeLabel} onChart={onChart} />}
            {check.queued.length > 0 && <WaitingList orders={check.queued} timeLabel={timeLabel} />}
            {check.skipped.length > 0 && <div className="paper-skipped">
              <HelpTitle as="h4" label="Why entries were skipped" text="Shows why a planned position was skipped, such as insufficient paper capital or an opening price outside the entry range." />
              <ul>{check.skipped.map((item, index) => <li key={`${item.symbol}:${item.strategy}:${index}`}>
                <strong>{stock(item.symbol)}</strong><span>{skipReasons[item.reason] || item.reason}
                  {item.opening_price != null && ` Opened at ${rupees(item.opening_price)}. Entry range ${rupees(item.minimum_price)}–${rupees(item.maximum_price)}.`}
                </span>
              </li>)}</ul>
            </div>}
            {(check.open > 0 || check.waiting > 0) && <p>After this check, {counted(check.open, 'open position')} · {check.waiting} waiting.</p>}
            {check.checked.length > 0 && <HelpDetails className="paper-checked-stocks" label="Stocks checked"
              summary={`Stocks checked (${check.checked.length})`}
              text="See the last completed price and time available for each stock in this check. An old or missing price explains when the scanner had limited data for a stock.">
              <div className="table-scroll"><table>
                <thead><tr><th scope="col" aria-label="Stock"><WithHelp label="Stock" text="The symbol and company name of an investment with a price available during this check." /></th><th scope="col" aria-label="Last price seen on this check"><WithHelp label="Last price seen on this check" text="The closing price of the last completed five-minute interval available when this check ran. Compare its timestamp to the check time to see how recent it was." /></th></tr></thead>
                <tbody>{check.checked.map((item) => <tr key={item.symbol}>
                  <th scope="row">{stock(item.symbol)} <small>{item.name}</small></th>
                  <td>{item.has_prices ? <>{rupees(item.price)} <small>{timeLabel(item.price_at)}{item.price_at && check.at - item.price_at > 600 && ' · More than 10 minutes old'}</small></> : 'No prices received'}</td>
                </tr>)}</tbody>
              </table></div>
            </HelpDetails>}
            {check.scan_id && <button type="button" className="button button-small button-outline paper-more"
              data-log="daily.open-check-log" onClick={() => onDiagnostics(check.scan_id)}>Check logs</button>}
          </div>
        </HelpDetails>)}
      </div>
      {checks.length > 4 && <button type="button" className="button button-outline button-small paper-more" aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}>{expanded ? 'Show the latest four checks' : `Show all ${checks.length} checks`}</button>}
    </>}
    {earlierChecks > 0 && <p className="paper-note">Detailed records are available for checks made after this update. Earlier orders are in the trade history.</p>}
  </section>;
}

function PaperResults({ session, totals, data, archive, onTrades }) {
  const todayResult = session?.total_result ?? Number(session?.realized ?? 0) + Number(session?.unrealized ?? 0);
  const status = Number(todayResult) > 0 ? 'positive' : Number(todayResult) < 0 ? 'negative' : '';
  return <div className="paper-results">
    <div className="paper-result-main">
      <p><WithHelp label={archive ? 'Paper profit / loss' : 'Today’s paper profit / loss'}
        text="Adds the net result from closed positions to the estimated result from positions still open during this trading day.">
        <span>{archive ? `Paper profit / loss · ${dateLabel(data.day, false)}` : 'Today’s paper profit / loss'}</span>
      </WithHelp></p>
      <strong className={status}>{result(todayResult)}</strong>
      <dl><div><dt><WithHelp label="Closed positions, after costs" text={paperHelp.closed} /></dt><dd>{result(session?.realized ?? 0)}</dd></div>
        <div><dt><WithHelp label="Estimated on open positions" text={paperHelp.open} /></dt><dd>{result(session?.unrealized ?? 0)}</dd></div></dl>
    </div>
    <div className="paper-result-side">
      <div>
        <p><WithHelp label="All days · Closed-position profit / loss" text="Adds the net results of closed positions across all saved days." /></p>
        <strong className={resultTone(totals?.realized)}>{result(totals?.realized ?? 0)}</strong>
        <small>{counted(totals?.days ?? 0, 'saved day')} · {totals?.trades
          ? <WithHelp label="Profitable closed positions" text={paperHelp.profitable}><span>{totals.wins} of {counted(totals.trades, 'closed position')} profitable</span></WithHelp>
          : 'No closed positions yet'}</small>
      </div>
      <div className="paper-counts">
        <WithHelp label="Buys this day" text={paperHelp.buys}>
          <button type="button" aria-label={`Buys this day: ${session?.buys ?? 0}. View trade history`} onClick={onTrades}>
            <span className="trade-side trade-side-buy"><ArrowDownLeft size={16} /> BUY</span><strong>{session?.buys ?? 0}</strong></button>
        </WithHelp>
        <WithHelp label="Sells this day" text={paperHelp.sells}>
          <button type="button" aria-label={`Sells this day: ${session?.sells ?? session?.trades ?? 0}. View trade history`} onClick={onTrades}>
            <span className="trade-side trade-side-sell"><ArrowUpRight size={16} /> SELL</span><strong>{session?.sells ?? session?.trades ?? 0}</strong></button>
        </WithHelp>
      </div>
    </div>
  </div>;
}

function PastDays({ history, selected, onDay }) {
  return <section className="paper-section" aria-label="Saved paper trading days">
    <div className="paper-section-title"><HelpTitle as="h3" label="Past paper trading days"
      text="Compare completed buys, sells, and results across recorded days. Click a date to open its trade history, then use the trading date menu to go back to Today." /><span>{counted(history.length, 'saved day')}</span></div>
    {history.length ? <div className="table-scroll paper-table"><table>
      <thead><tr>{[
        ['Day', 'Select a trading date to open the saved day and see the trades that took place.'],
        ['Paper limit', paperHelp.budget], ['Buys', paperHelp.buys], ['Sells', paperHelp.sells],
        ['Profitable exits', paperHelp.profitable], ['Profit / loss from exits', paperHelp.closed],
      ].map(([label, text]) => <th scope="col" aria-label={label} key={label}><WithHelp label={label} text={text} /></th>)}</tr></thead>
      <tbody>{history.map((item) => <tr key={item.day}>
        <th scope="row"><button type="button" className="sort-heading" aria-current={selected === item.day ? 'date' : undefined}
          onClick={() => onDay(item.day)}>{dateLabel(item.day)}</button>
          {item.unresolved > 0 && <small>{counted(item.unresolved, 'position')} still open</small>}
          {!item.closed && <small>In progress</small>}</th>
        <td>{rupees(item.budget)}</td><td>{item.buys ?? item.fills - item.trades}</td><td>{item.sells ?? item.trades}</td><td>{item.wins}</td>
        <td className={resultTone(item.realized)}>{result(item.realized)}</td>
      </tr>)}</tbody>
    </table></div> : <p className="paper-note">Your first day will appear here when Auto Trade starts checking stocks during market hours.</p>}
  </section>;
}

export function DailyAutoTrade({ data, archive, busy, onChange, onDay, onChart, timeLabel, onDiagnostics }) {
  const [length, setLength] = useState(5);
  const [riskBps, setRiskBps] = useState(defaultRiskBps);
  const [allowShorts, setAllowShorts] = useState(false);
  const [tab, setTab] = useState('checks');
  const tradeTab = useRef(null);
  const { trial, session, totals, history = [] } = data?.auto_trade || {};
  const enabled = Boolean(trial?.enabled);
  const completed = history.filter((item) => item.closed && trial?.days.includes(item.day)).length;
  const status = archive ? 'Saved day' : enabled ? (!data?.scheduled ? 'Schedule paused' : session && !session.closed && data.phase === 'open' ? 'On' : 'Scheduled')
    : session && !session.closed && session.open > 0 ? 'Managing exits' : trial?.ended_by === 'completed' ? 'Trial complete' : 'Off';
  const checks = session?.activity || [];
  const settings = archive ? session : enabled ? trial : null;
  const canConfigure = !busy && Boolean(data?.scheduled);

  function showCompletedTrades() {
    setTab('trades');
    tradeTab.current?.focus();
  }

  return <section className="panel daily-auto" aria-labelledby="daily-auto-heading">
    <div className="daily-auto-head">
      <div className="daily-auto-title">
        <span className="daily-auto-icon"><Bot size={23} /></span>
        <div><HelpTitle id="daily-auto-heading" label="Auto Trade"
          text="Runs the paper trading rules automatically during regular NSE market hours. It checks stocks, practices buys and sells with virtual money, and records each decision so you can review how the rules behave.">
          Auto Trade <span className={`daily-auto-state${enabled && !archive ? ' active' : ''}`}>{status}</span>
        </HelpTitle>
          <p>Practice buying and selling Indian stocks with virtual money.</p></div>
      </div>
      {!archive && <div className="daily-auto-controls">
        <WithHelp label="Number of trading days" text="Choose 1, 3, or 5 NSE trading days for a paper trial. Weekends and market holidays do not count. The progress indicator counts days the trial has finished.">
          {enabled ? <span className="daily-auto-progress">{completed} of {trial.limit} trading days complete</span> :
            <select aria-label="Number of trading days" value={length} disabled={busy || !data?.scheduled}
              onChange={(event) => setLength(Number(event.target.value))}>
              {[1, 3, 5].map((days) => <option value={days} key={days}>{counted(days, 'trading day')}</option>)}
            </select>}
        </WithHelp>
        <WithHelp label={enabled ? 'Pause new entries' : 'Start Auto Trade'}
          text={enabled ? 'Pauses new entries and cancels waiting orders. Auto Trade continues to manage exits for any open position.'
            : 'Start the selected paper trial. Auto Trade watches for setups on its scheduled checks while Market Desk is running and uses the virtual limit for each trading day.'}>
          <button type="button" className={`button ${enabled ? 'button-outline' : 'button-primary'}`}
            data-log={enabled ? 'daily.pause-auto-trade' : 'daily.start-auto-trade'}
            disabled={busy || !data || (!enabled && !data.scheduled)}
            onClick={() => onChange({ enabled: !enabled, sessions: length, risk_bps: riskBps, allow_shorts: allowShorts })}>
            {busy ? <LoaderCircle className="spin" size={16} /> : enabled ? <Square size={15} /> : <Play size={16} />}
            {enabled ? 'Pause new entries' : 'Start Auto Trade'}
          </button>
        </WithHelp>
      </div>}
    </div>
    {data ? <>
      {!archive && !enabled && <div className="daily-auto-settings" role="group" aria-label="New paper trial settings">
        <div className="daily-auto-risk">
          <span className="daily-auto-risk-heading">
            <WithHelp label="Risk per new position" text={paperHelp.risk}><label htmlFor="paper-risk">Risk per new position</label></WithHelp>
            <output htmlFor="paper-risk">{riskPercent(riskBps)}</output>
          </span>
          <input id="paper-risk" type="range" min="10" max="65" step="1" value={riskBps} aria-valuetext={`${riskPercent(riskBps)} of the daily paper budget`}
            disabled={!canConfigure} onChange={(event) => setRiskBps(Number(event.target.value))} />
        </div>
        <WithHelp label="Allow paper shorts" text="Lets Auto Trade simulate selling first and buying the shares back during the same trading day. This setting applies to the new paper trial.">
          <label className="daily-auto-shorts"><input type="checkbox" checked={allowShorts} disabled={!canConfigure}
            onChange={(event) => setAllowShorts(event.target.checked)} /> Allow paper shorts</label>
        </WithHelp>
      </div>}
      {settings && <p className="daily-auto-progress">
        <WithHelp label="Risk per new position" text={paperHelp.risk}><span>Risk per new position {riskPercent(settings.risk_bps ?? defaultRiskBps)}</span></WithHelp>
        {' · '}{settings.allow_shorts ? 'Long and short' : 'Long only'}
      </p>}
      <PaperResults session={session} totals={totals} data={data} archive={archive} onTrades={showCompletedTrades} />
      {!session && <p className="paper-note">{archive ? 'Auto Trade has no trades or practice account saved for this day.' : enabled ?
        'Waiting for the next check during trading hours. A position opens only when a stock meets the rules and the price is within range.' :
        'Start Auto Trade to let it check prices roughly every five minutes during market hours. Each trading day uses its own paper money limit.'}</p>}
      <div className={`paper-journal-layout${session ? ' with-account' : ''}`}>
        <div className="paper-journal">
          <div className="paper-tabs-row">
            <div className="segmented paper-tabs" aria-label="Paper trade details">
              <button type="button" data-log="daily.market-checks" aria-pressed={tab === 'checks'} onClick={() => setTab('checks')}>Market checks</button>
              <button type="button" data-log="daily.trade-history" ref={tradeTab} aria-pressed={tab === 'trades'} onClick={() => setTab('trades')}>Order history{session?.fills > 0 && <span>{session.fills}</span>}</button>
              <button type="button" data-log="daily.past-days" aria-pressed={tab === 'days'} onClick={() => setTab('days')}>Past days</button>
            </div>
            <Help label="Paper trade details" text="Market checks explains each scan’s decisions. Order history lists completed paper orders. Past days compares results from saved days." />
          </div>
          {tab === 'checks' && <ScanActivity key={data.day} checks={checks} earlierChecks={(session?.scans ?? 0) - checks.length}
            data={data} archive={archive} timeLabel={timeLabel} onChart={onChart} onDiagnostics={onDiagnostics} />}
          {tab === 'trades' && <section className="paper-section" aria-label="Paper trades for this day">
            <div className="paper-section-title"><HelpTitle as="h3" label="Filled paper orders"
              text="See each fill’s size, price, time, and reason. Orders that close a position show the gain or loss after estimated costs." />
              <span>{counted(session?.fills || 0, 'fill')}</span></div>
            {session?.orders.length ? <TradeList orders={session.orders} timeLabel={timeLabel} onChart={onChart} /> :
              <p className="paper-note">No orders filled on this day.</p>}
          </section>}
          {tab === 'days' && <PastDays history={history} selected={data.day} onDay={(day) => { onDay(day); setTab('trades'); }} />}
        </div>
        {session && <div className="paper-account">
          <section className="paper-section" aria-label="Paper money for this day">
            <div className="paper-section-title"><HelpTitle as="h3" label="Paper money"
              text="See the daily budget, available capital, and the money committed or reserved for paper positions." /></div>
            <div className="paper-cash">
              <div><WithHelp label="Limit for this day" text={paperHelp.budget} /><strong>{rupees(session.budget)}</strong></div>
              <div><WithHelp label="Available for new positions" text="Paper capital available after accounting for open positions and waiting orders." /><strong>{rupees(session.available)}</strong></div>
              <div><WithHelp label="Committed to open positions" text="Paper capital tied up in open long and short positions, including estimated entry costs." /><strong>{rupees(session.invested)}</strong></div>
              <div><WithHelp label="Reserved for waiting orders" text="Paper capital set aside for orders awaiting the next eligible price. It is released when the order is skipped or cancelled." /><strong>{rupees(session.reserved)}</strong></div>
            </div>
          </section>
          <OpenTrades session={session} timeLabel={timeLabel} onChart={onChart} />
        </div>}
      </div>
      <HelpDetails className="paper-how" wrapperClassName="paper-help-details" label="How Auto Trade opens and closes positions"
        text="See the trading rules and the price patterns Auto Trade looks for.">
        <ol>
          <li>Auto Trade checks recent five-minute prices and volume for active NSE stocks, a rotating watchlist, and each open position.</li>
          <li>It reserves paper capital for qualifying setups, then waits for an eligible five-minute opening price within the entry range.</li>
          <li>It checks each open position’s stop and profit target, then looks for an exit near the afternoon cutoff. It buys to cover a short position.</li>
        </ol>
        <ul>{Object.values(paperStrategies).map((strategy) => <li key={strategy.label}><strong>{strategy.label}</strong> {strategy.explanation}</li>)}</ul>
        <p>The breakdown setup is available when paper shorts are enabled. The risk level and short setting are set at the start of each trial.</p>
        <p>Profits and losses include estimated charges and price adjustments. Open-trade figures use the last price available for each stock.</p>
      </HelpDetails>
      {session && <HelpDetails className="paper-how" wrapperClassName="paper-help-details" label="Results by strategy and trading costs"
        text="Compare net results by strategy, estimated costs, peak capital used, and reasons entries were skipped.">
        <dl className="paper-methods">
          {session.strategies.map((strategy) => <div key={strategy.key}><dt><WithHelp label={paperStrategies[strategy.key]?.label || strategy.label}
            text={paperStrategies[strategy.key]?.explanation || 'This row groups closed positions opened by this strategy.'} /> <small>{counted(strategy.trades, 'exit')}</small></dt>
            <dd className={resultTone(strategy.net)}>{result(strategy.net)}</dd></div>)}
          <div><dt><WithHelp label="Estimated charges and price adjustments" text="Adds estimated trading charges and the simulator’s allowance for differences between observed and completed prices on paper buys and sells." /></dt><dd>{rupees(session.costs)}</dd></div>
          <div><dt><WithHelp label="Peak capital committed" text="The most paper capital tied up in open positions at any point during the day." /></dt><dd>{rupees(session.peak_invested)}</dd></div>
          <div><dt><WithHelp label="Different stocks with prices this day" text="Counts each stock once if at least one of the day’s checks had price data for it." /></dt><dd>{session.candidates}</dd></div>
          <div><dt><WithHelp label="Total Auto Trade checks this day" text="Number of checks recorded for this paper trading day, including checks that produced zero buys or sells." /></dt><dd>{session.scans}</dd></div>
        </dl>
        {Object.keys(session.skipped).length > 0 && <div className="paper-skipped"><HelpTitle as="h4" label="Skipped entries for the day"
          text="Counts skipped entries across the selected day, grouped by reason." />
          <ul>{Object.entries(session.skipped).map(([reason, count]) => <li key={reason}>
            <span>{skipReasons[reason] || reason}</span><strong>{count}</strong>
          </li>)}</ul>
        </div>}
      </HelpDetails>}
    </> : <p className="paper-note" role="status">Loading paper trading results…</p>}
  </section>;
}
