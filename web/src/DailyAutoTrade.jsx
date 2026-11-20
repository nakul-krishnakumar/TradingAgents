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

const paperHelp = {
  sold: 'The net gain or loss from shares already sold. It subtracts the cost of buying plus estimated charges and price adjustments on both trades.',
  open: 'An estimate based on the last available price of shares still held, after estimated costs. It changes with the price and becomes a recorded result once the shares sell.',
  budget: 'The most virtual money available to Auto Trade when that day began. It applies to the day shown and is shared by all strategies.',
  buys: 'Number of simulated buy orders that completed. An order for several shares still counts as one buy. Waiting buys count when they finish.',
  sells: 'Number of simulated sell orders that completed. Each sell records the gain or loss on the shares sold after estimated trading costs.',
  profitable: 'Completed sells whose proceeds were above their purchase cost after the estimated trading costs.',
  stop: 'If the price falls to this level, Auto Trade tries to sell to limit the loss. A sudden drop can mean a lower sale price.',
  target: 'If the price rises to this level, Auto Trade tries to sell and record the gain.',
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
};

const sellReasons = {
  stop: 'The price reached the level set to limit the loss.',
  target: 'The price reached the planned selling price.',
  'time-exit': 'The trade reached the afternoon closing time set by Auto Trade.',
  'gap-exit': 'Some 5-minute prices were missing. Auto Trade sold using the next available opening price.',
};

const skipReasons = {
  'Entry paused or session closed': 'New buys were paused or the market had closed.',
  'Entry candle arrived too late': 'The price data arrived too late to place the buy.',
  'Opening price outside entry range': 'The next opening price was outside the planned buy range.',
  'Stock already held or queued': 'Auto Trade already held this stock or had a buy waiting.',
  'Stock details unavailable': 'The stock details were unavailable.',
  'Cash or risk limit': 'The remaining cash or the loss limit was too small to buy a share.',
  'Stopped before entry': 'Auto Trade was paused before the buy could happen.',
};

const checkReasons = {
  'market-closed': 'The market had closed. Auto Trade checked any open trades for a final sell.',
  'buys-paused': 'New buys were paused. Auto Trade still checked when to sell any shares it held.',
  'market-unverified': 'New buys were paused because the exchange reported the market was closed.',
  'buy-window-ended': 'Buying had ended for the day. Auto Trade checked when to sell any shares it held.',
};

function chartButton(asset, onChart) {
  return <button type="button" className="paper-chart-link" data-log="daily.open-paper-chart" onClick={() => onChart(asset)}
    aria-label={`View ${stock(asset.symbol)} price chart`}><ChartCandlestick size={16} /> Chart</button>;
}

function TradeList({ orders, timeLabel, onChart }) {
  return <ul className="paper-trades" aria-label="Completed paper buys and sells">
    {orders.map((order) => {
      const buy = order.side === 'buy';
      const reason = buy
        ? paperStrategies[order.strategy]?.explanation || order.signal_reason || 'The price was within the planned buy range.'
        : sellReasons[order.reason] || order.reason;
      return <li className="paper-trade" key={`${order.asset.symbol}:${order.strategy}:${order.at}:${order.side}`}>
        <span className={`trade-side trade-side-${order.side}`}>{buy ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}{buy ? 'BUY' : 'SELL'}</span>
        <div className="paper-stock"><strong>{stock(order.asset.symbol)}</strong><span>{order.asset.name}</span></div>
        <div className="paper-trade-price"><strong>{shareCount(order.units)} at {rupees(order.price)}</strong><small>{timeLabel(order.at)} · {rupees(order.fee)} estimated charges and price adjustment</small></div>
        <div className="paper-trade-money">
          <strong className={buy ? '' : resultTone(order.net)}>{buy ? rupees(order.units * order.price + Number(order.fee)) : result(order.net)}</strong>
          <small><WithHelp label={buy ? 'Total spent' : 'Profit / loss after costs'}
            text={buy ? 'The number of shares times their buy price, plus the estimated cost of buying. This is how much virtual money the trade used.' : paperHelp.sold} /></small>
        </div>
        {chartButton(order.asset, onChart)}
        <p className="paper-trade-reason"><strong>{buy ? 'Why it bought' : 'Why it sold'}</strong> {reason}
          {buy && paperStrategies[order.strategy] && ' The opening price was within the planned buy range.'}</p>
      </li>;
    })}
  </ul>;
}

function WaitingList({ orders, timeLabel }) {
  return <ul className="paper-waiting">
    {orders.map((order) => <li key={order.asset.symbol}>
      <div><span className="trade-side trade-side-wait">Waiting to BUY</span><strong>{stock(order.asset.symbol)}</strong>
        <Help label="Waiting to BUY" text="The strategy found a possible buy and set aside virtual cash. It checks the next eligible opening price and only buys if that price is within the displayed range." /></div>
      <p>{shareCount(order.quantity)} if the {timeLabel(order.enter_at)} opening price is between {rupees(order.trigger)} and {rupees(order.entry_cap)}.</p>
      {paperStrategies[order.strategy] && <small>{paperStrategies[order.strategy].explanation}</small>}
    </li>)}
  </ul>;
}

function OpenTrades({ session, timeLabel, onChart }) {
  return <section className="paper-section" aria-label="Open and waiting paper trades">
    <div className="paper-section-title"><HelpTitle as="h3" label="Shares held"
      text="Stocks Auto Trade has paper-bought and still holds, plus possible buys it is waiting to complete. See the buy price, last observed price, planned sell prices, and estimated result. Open Chart to locate trades." />
      <span>{counted(session.open, 'stock')} · {counted(session.pending, 'buy')} waiting</span></div>
    {session.unresolved > 0 && <p className="paper-alert">{counted(session.unresolved, 'stock')} remained open at the end of this day because an exit price was unavailable. The open value uses the last observed price.</p>}
    {session.holdings.length > 0 ? <ul className="paper-holdings">
      {session.holdings.map((position) => <li key={position.asset.symbol}>
        <div className="paper-holding-heading"><div className="paper-stock"><strong>{stock(position.asset.symbol)}</strong><span>{position.asset.name}</span></div>{chartButton(position.asset, onChart)}</div>
        <p>Bought {shareCount(position.quantity)} at <strong>{rupees(position.entry)}</strong> · Last price {rupees(position.mark)} at {timeLabel(position.mark_at)}</p>
        <div className="paper-holding-result"><WithHelp label="Estimated profit / loss" text={paperHelp.open} /><strong className={resultTone(position.unrealized)}>{result(position.unrealized)}</strong></div>
        <div className="paper-sell-plan">
          <WithHelp label="Sell to limit loss" text={paperHelp.stop}><span>Sell to limit loss <strong>{rupees(position.stop)}</strong></span></WithHelp>
          <WithHelp label="Sell to take profit" text={paperHelp.target}><span>Sell to take profit <strong>{rupees(position.target)}</strong></span></WithHelp>
        </div>
      </li>)}
    </ul> : <p className="paper-note">No shares are held for this day.</p>}
    {session.queued.length > 0 && <WaitingList orders={session.queued} timeLabel={timeLabel} />}
  </section>;
}

function checkSummary(check) {
  const buys = check.orders.filter((order) => order.side === 'buy').length;
  const sells = check.orders.length - buys;
  const seen = check.checked.length;
  const caption = [`Checked ${counted(seen, 'stock')}`];
  if (buys) caption.push(`${buys} BUY`);
  if (sells) caption.push(`${sells} SELL`);
  if (check.queued.length) caption.push(`${check.queued.length} waiting to buy`);
  if (!buys && !sells && !check.queued.length) caption.push('No buys or sells');
  if (check.skipped.length) caption.push(counted(check.skipped.length, 'skipped buy'));
  return caption.join(' · ');
}

function checkExplanation(check) {
  if (checkReasons[check.mode]) return checkReasons[check.mode];
  if (!check.checked.length) return 'There were no stocks available to check.';
  if (check.checked.every((item) => !item.has_prices)) return 'No completed 5-minute prices were available for the stocks checked.';
  if (check.signals === 0 && !check.orders.length && !check.skipped.length) {
    return check.waiting ? 'A previous buy is still waiting for price data.' : 'No new stock met the rules for buying, and no shares needed to be sold.';
  }
  if (check.signals) return `${counted(check.signals, 'new buy signal')} met the strategy rules. Each was checked against the available cash and loss limit.`;
  return 'Auto Trade checked any earlier buy plans and decided whether to sell open trades using completed 5-minute prices.';
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
    description = 'Loading stock prices, then checking shares held, sells, and possible buys.';
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
      text="Auto Trade reviews the latest completed five-minute prices during a regular NSE session. Open a check to see the stocks it reviewed, missing prices, buys and sells, and the reasons it waited or skipped." />
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
              <HelpTitle as="h4" label="Why buys were skipped" text="These stocks got far enough for Auto Trade to consider a buy. The reason beside each one explains why it was skipped, such as insufficient paper cash or a price outside the buy range." />
              <ul>{check.skipped.map((item, index) => <li key={`${item.symbol}:${item.strategy}:${index}`}>
                <strong>{stock(item.symbol)}</strong><span>{skipReasons[item.reason] || item.reason}</span>
              </li>)}</ul>
            </div>}
            {(check.open > 0 || check.waiting > 0) && <p>After this check, {counted(check.open, 'stock')} held · {counted(check.waiting, 'buy')} waiting.</p>}
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
    {earlierChecks > 0 && <p className="paper-note">Detailed records are available for checks made after this update. Earlier buys and sells are in the trade history.</p>}
  </section>;
}

function PaperResults({ session, totals, data, archive, onTrades }) {
  const todayResult = session?.total_result ?? Number(session?.realized ?? 0) + Number(session?.unrealized ?? 0);
  const status = Number(todayResult) > 0 ? 'positive' : Number(todayResult) < 0 ? 'negative' : '';
  return <div className="paper-results">
    <div className="paper-result-main">
      <p><WithHelp label={archive ? 'Paper profit / loss' : 'Today’s paper profit / loss'}
        text="The result for this trading day. It adds the gains or losses from completed sells to the estimated result on shares still held. A figure above zero is a paper gain.">
        <span>{archive ? `Paper profit / loss · ${dateLabel(data.day, false)}` : 'Today’s paper profit / loss'}</span>
      </WithHelp></p>
      <strong className={status}>{result(todayResult)}</strong>
      <dl><div><dt><WithHelp label="From shares sold, after costs" text={paperHelp.sold} /></dt><dd>{result(session?.realized ?? 0)}</dd></div>
        <div><dt><WithHelp label="Estimated on shares held" text={paperHelp.open} /></dt><dd>{result(session?.unrealized ?? 0)}</dd></div></dl>
    </div>
    <div className="paper-result-side">
      <div>
        <p><WithHelp label="All days · Profit / loss from sells" text="Adds the net results of completed paper sells across all saved days. The profitable count tells you how many individual sells finished above zero. Use Past days to compare daily results." /></p>
        <strong className={resultTone(totals?.realized)}>{result(totals?.realized ?? 0)}</strong>
        <small>{counted(totals?.days ?? 0, 'saved day')} · {totals?.trades
          ? <WithHelp label="Profitable sells" text={paperHelp.profitable}><span>{totals.wins} of {counted(totals.trades, 'sell')} profitable</span></WithHelp>
          : 'No sells yet'}</small>
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
        ['Profitable sells', paperHelp.profitable], ['Profit / loss from sells', paperHelp.sold],
      ].map(([label, text]) => <th scope="col" aria-label={label} key={label}><WithHelp label={label} text={text} /></th>)}</tr></thead>
      <tbody>{history.map((item) => <tr key={item.day}>
        <th scope="row"><button type="button" className="sort-heading" aria-current={selected === item.day ? 'date' : undefined}
          onClick={() => onDay(item.day)}>{dateLabel(item.day)}</button>
          {item.unresolved > 0 && <small>{counted(item.unresolved, 'stock')} still held</small>}
          {!item.closed && <small>In progress</small>}</th>
        <td>{rupees(item.budget)}</td><td>{item.buys ?? item.fills - item.trades}</td><td>{item.sells ?? item.trades}</td><td>{item.wins}</td>
        <td className={resultTone(item.realized)}>{result(item.realized)}</td>
      </tr>)}</tbody>
    </table></div> : <p className="paper-note">Your first day will appear here when Auto Trade starts checking stocks during market hours.</p>}
  </section>;
}

export function DailyAutoTrade({ data, archive, busy, onChange, onDay, onChart, timeLabel, onDiagnostics }) {
  const [length, setLength] = useState(5);
  const [tab, setTab] = useState('checks');
  const tradeTab = useRef(null);
  const { trial, session, totals, history = [] } = data?.auto_trade || {};
  const enabled = Boolean(trial?.enabled);
  const completed = history.filter((item) => item.closed && trial?.days.includes(item.day)).length;
  const status = archive ? 'Saved day' : enabled ? (!data?.scheduled ? 'Schedule paused' : session && !session.closed && data.phase === 'open' ? 'On' : 'Scheduled')
    : session && !session.closed && session.open > 0 ? 'Watching sells' : trial?.ended_by === 'completed' ? 'Trial complete' : 'Off';
  const checks = session?.activity || [];

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
        <WithHelp label={enabled ? 'Pause new buys' : 'Start Auto Trade'}
          text={enabled ? 'Stops new buys and cancels buys that were waiting. Auto Trade keeps tracking shares already held and follows their sell rules.'
            : 'Start the selected paper trial. Auto Trade watches for setups on its scheduled checks while Market Desk is running and uses the virtual limit for each trading day.'}>
          <button type="button" className={`button ${enabled ? 'button-outline' : 'button-primary'}`}
            data-log={enabled ? 'daily.pause-auto-trade' : 'daily.start-auto-trade'}
            disabled={busy || !data || (!enabled && !data.scheduled)}
            onClick={() => onChange(!enabled, length)}>
            {busy ? <LoaderCircle className="spin" size={16} /> : enabled ? <Square size={15} /> : <Play size={16} />}
            {enabled ? 'Pause new buys' : 'Start Auto Trade'}
          </button>
        </WithHelp>
      </div>}
    </div>
    {data ? <>
      <PaperResults session={session} totals={totals} data={data} archive={archive} onTrades={showCompletedTrades} />
      {!session && <p className="paper-note">{archive ? 'Auto Trade has no trades or practice account saved for this day.' : enabled ?
        'Waiting for the next check during trading hours. A buy happens only when a stock meets the rules and the price is within range.' :
        'Start Auto Trade to let it check prices roughly every five minutes during market hours. Each trading day uses its own paper money limit.'}</p>}
      <div className={`paper-journal-layout${session ? ' with-account' : ''}`}>
        <div className="paper-journal">
          <div className="paper-tabs-row">
            <div className="segmented paper-tabs" aria-label="Paper trade details">
              <button type="button" data-log="daily.market-checks" aria-pressed={tab === 'checks'} onClick={() => setTab('checks')}>Market checks</button>
              <button type="button" data-log="daily.trade-history" ref={tradeTab} aria-pressed={tab === 'trades'} onClick={() => setTab('trades')}>BUY &amp; SELL history{session?.fills > 0 && <span>{session.fills}</span>}</button>
              <button type="button" data-log="daily.past-days" aria-pressed={tab === 'days'} onClick={() => setTab('days')}>Past days</button>
            </div>
            <Help label="Paper trade details" text="Market checks explains each scan’s decisions. BUY & SELL history lists completed paper trades. Past days compares the results from saved days." />
          </div>
          {tab === 'checks' && <ScanActivity key={data.day} checks={checks} earlierChecks={(session?.scans ?? 0) - checks.length}
            data={data} archive={archive} timeLabel={timeLabel} onChart={onChart} onDiagnostics={onDiagnostics} />}
          {tab === 'trades' && <section className="paper-section" aria-label="Paper trades for this day">
            <div className="paper-section-title"><HelpTitle as="h3" label="Completed paper trades"
              text="See each finished buy or sell, the number of shares, price, time, and reason. Sells show the gain or loss after estimated costs. Tap Chart to find the buy and sell on the price chart." />
              <span>{counted(session?.fills || 0, 'buy or sell', 'buys and sells')}</span></div>
            {session?.orders.length ? <TradeList orders={session.orders} timeLabel={timeLabel} onChart={onChart} /> :
              <p className="paper-note">No buys or sells have happened for this day. A waiting buy appears here after the simulator completes it.</p>}
          </section>}
          {tab === 'days' && <PastDays history={history} selected={data.day} onDay={(day) => { onDay(day); setTab('trades'); }} />}
        </div>
        {session && <div className="paper-account">
          <section className="paper-section" aria-label="Paper money for this day">
            <div className="paper-section-title"><HelpTitle as="h3" label="Paper money"
              text="See how much virtual money was allowed for this day, what is still available, and what has already been spent or set aside. Auto Trade limits buys to the virtual cash and risk rules." /></div>
            <div className="paper-cash">
              <div><WithHelp label="Limit for this day" text={paperHelp.budget} /><strong>{rupees(session.budget)}</strong></div>
              <div><WithHelp label="Available to buy" text="The virtual cash that can be used for new buys under the day’s limit, after accounting for held stocks and money reserved for waiting buys." /><strong>{rupees(session.available)}</strong></div>
              <div><WithHelp label="Spent on shares held" text="The cost of buying the shares still owned, including estimated buying costs. Their latest market value may be higher or lower." /><strong>{rupees(session.invested)}</strong></div>
              <div><WithHelp label="Set aside for buys" text="Virtual cash temporarily reserved for buys waiting for their next eligible price. It is released if the buy is skipped or cancelled." /><strong>{rupees(session.reserved)}</strong></div>
            </div>
          </section>
          <OpenTrades session={session} timeLabel={timeLabel} onChart={onChart} />
        </div>}
      </div>
      <HelpDetails className="paper-how" wrapperClassName="paper-help-details" label="How Auto Trade decides when to buy and sell"
        text="Open this guide to see what happens in each check, the three price patterns Auto Trade looks for, and the conditions that cause a paper sell.">
        <ol>
          <li>Every check looks at recent five-minute prices and the number of shares traded. It follows active NSE stocks, checks a rotating list of other stocks, and keeps tracking anything it holds.</li>
          <li>It checks earlier buy plans at the next eligible opening price and looks for reasons to sell shares already held. It sells at a planned gain or loss level, or near its afternoon time limit.</li>
          <li>It considers new buys that meet one of three patterns. It sets aside paper money and waits for the next five-minute opening price. A share must fit the cash and loss limits.</li>
        </ol>
        <ul>{Object.values(paperStrategies).map((strategy) => <li key={strategy.label}><strong>{strategy.label}</strong> {strategy.explanation}</li>)}</ul>
        <p>Each day’s Auto Trade limit is set when that day starts. Pausing cancels waiting buys and keeps tracking the shares already held until they are sold.</p>
        <p>Profits and losses include estimated charges and price adjustments. Open-trade figures use the last price available for each stock.</p>
      </HelpDetails>
      {session && <HelpDetails className="paper-how" wrapperClassName="paper-help-details" label="Results by strategy and trading costs"
        text="Compare completed sells and their net results by buy strategy. This section also shows estimated trading costs, peak paper money used, how many stocks were checked, and the reasons buys were skipped.">
        <dl className="paper-methods">
          {session.strategies.map((strategy) => <div key={strategy.key}><dt><WithHelp label={paperStrategies[strategy.key]?.label || strategy.label}
            text={paperStrategies[strategy.key]?.explanation || 'This row groups the completed paper sells that started with this buy strategy.'} /> <small>{counted(strategy.trades, 'sale')}</small></dt>
            <dd className={resultTone(strategy.net)}>{result(strategy.net)}</dd></div>)}
          <div><dt><WithHelp label="Estimated charges and price adjustments" text="Adds estimated trading charges and the simulator’s allowance for differences between observed and completed prices on paper buys and sells." /></dt><dd>{rupees(session.costs)}</dd></div>
          <div><dt><WithHelp label="Most paper money used at once" text="The highest combined purchase cost of open paper trades at any point during the day. It measures how much virtual money was committed at the same time." /></dt><dd>{rupees(session.peak_invested)}</dd></div>
          <div><dt><WithHelp label="Different stocks with prices this day" text="Counts each stock once if at least one of the day’s checks had price data for it." /></dt><dd>{session.candidates}</dd></div>
          <div><dt><WithHelp label="Total Auto Trade checks this day" text="Number of checks recorded for this paper trading day, including checks that produced zero buys or sells." /></dt><dd>{session.scans}</dd></div>
        </dl>
        {Object.keys(session.skipped).length > 0 && <div className="paper-skipped"><HelpTitle as="h4" label="All skipped buys for the day"
          text="Counts skipped buys across the selected day, grouped by the reason each buy was skipped." />
          <ul>{Object.entries(session.skipped).map(([reason, count]) => <li key={reason}>
            <span>{skipReasons[reason] || reason}</span><strong>{count}</strong>
          </li>)}</ul>
        </div>}
      </HelpDetails>}
    </> : <p className="paper-note" role="status">Loading paper trading results…</p>}
  </section>;
}
