import { useEffect, useState } from 'react';
import { Activity, ExternalLink, LoaderCircle, MessageCircle, Vote } from 'lucide-react';
import { AssetIdentity, post } from './Discovery';
import { api, dateLabel, money, number, signed, tone, typeLabel } from './api';
import { Help, HelpTitle, WithHelp } from './Help';

const none = { bullish: 0, neutral: 0, bearish: 0, total: 0 };
const opinions = { bullish: 'Expect a rise', neutral: 'Neutral', bearish: 'Expect a fall' };
const opinionHelp = {
  bullish: 'Votes from people who expect the selected investment or market to rise.',
  neutral: 'Votes from people who do not have a clear expectation of a rise or fall.',
  bearish: 'Votes from people who expect the selected investment or market to fall.',
};
const indexHelp = {
  'NIFTY 50': 'Follows 50 large stocks listed on NSE. Use its percentage move as a reference for how large Indian companies did.',
  'NIFTY BANK': 'Follows a group of Indian bank stocks listed on NSE. Use its move to compare banking with the broader market.',
  'NIFTY TOTAL MARKET': 'Tracks a broad group of listed Indian companies across different sizes. The counts below show how many of its stocks rose or fell.',
  'INDIA VIX': 'Measures how much the market expects Indian stock prices to fluctuate over about 30 days. A higher reading means larger expected moves.',
};

function Source({ children, href }) {
  return <a className="source-link" href={href} target="_blank" rel="noreferrer">{children}<ExternalLink size={12} /></a>;
}

function SignalTable({ rows, onResearch, showTurnover = false, funds = false }) {
  if (!rows?.length) return <p className="inline-note discovery-message">Price comparisons are unavailable from this source.</p>;
  return <div className="table-scroll trend-table">
    <table><thead><tr>
      <th scope="col"><WithHelp label="Investment" text="The investment’s name and code. Select it to open its research and price history." /></th>
      <th scope="col"><WithHelp label={funds ? 'Value per unit' : 'Closing price'}
        text={funds ? 'The fund’s published net asset value for one unit on the date shown.' : 'The final available closing price for the NSE trading day shown.'} /></th>
      <th scope="col"><WithHelp label={funds ? 'Change in unit value' : 'Change on the day'}
        text={funds ? 'Percentage change from the previous comparable published fund value. Its date appears underneath.' : 'The percentage rise or fall from the previous trading day’s close.'} /></th>
      {showTurnover && <th scope="col"><WithHelp label="Value traded (₹ crore)" text="The total rupee value of the trades, expressed in crore rupees. A higher amount means more money changed hands for that investment." /></th>}
      {funds && <th scope="col"><WithHelp label="Category" text="The fund’s published category groups it with schemes that have a similar focus." /></th>}
    </tr></thead>
      <tbody>{rows.map((row) => <tr key={row.symbol}>
        <td><button className="asset-table-button" onClick={() => onResearch(row)}><AssetIdentity asset={row} /></button></td>
        <td className="number-cell">{money(row.price, 'INR')}</td>
        <td className={`number-cell ${tone(row.change)}`}>{signed(row.change)}{funds && <small className="under-cell">vs {dateLabel(row.previous, false)}</small>}</td>
        {showTurnover && <td className="number-cell">{number(row.turnover / 10000000)}</td>}
        {funds && <td>{row.category || '—'}</td>}
      </tr>)}</tbody></table>
  </div>;
}

function StockTrends({ data, onResearch }) {
  const [category, setCategory] = useState('stocks');
  const [rank, setRank] = useState('active');
  return <section className="panel trends-discovery">
    <div className="collection-heading"><div><HelpTitle label="Most traded and biggest price moves" text="Choose stocks or ETFs, then see the highest rupee trading activity or the largest percentage rises and falls from the previous close. Select any row to research it." /><p>{data?.session ? `NSE trading day · ${dateLabel(data.session)}` : 'Prices at the end of the NSE trading day'}</p></div>
      {data?.links && <Source href={data.links.bhavcopy}>NSE daily report</Source>}
    </div>
    <div className="trends-switches">
      <div className="segmented" aria-label="Mover asset class">
        <button type="button" aria-pressed={category === 'stocks'} onClick={() => setCategory('stocks')}>Stocks</button>
        <button type="button" aria-pressed={category === 'etfs'} onClick={() => setCategory('etfs')}>ETFs</button>
      </div>
      <div className="segmented" aria-label="Rank market movers">
        {[['active', 'Most traded'], ['gainers', 'Biggest rises'], ['losers', 'Biggest falls']].map(([id, label]) =>
          <button type="button" key={id} aria-pressed={rank === id} onClick={() => setRank(id)}>{label}</button>)}
      </div>
      <Help label="How market movers are ranked" text="Most traded ranks by the rupee value traded. Biggest rises and Biggest falls rank by the percentage price change on the trading day shown." />
    </div>
    {data ? <SignalTable rows={data[category]?.[rank]} onResearch={onResearch} showTurnover /> : <p className="inline-note discovery-message">Loading the market session…</p>}
  </section>;
}

function Sentiment({ onFind, market }) {
  const [votes, setVotes] = useState(null);
  const [subject, setSubject] = useState(null);
  const [discussion, setDiscussion] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    api('/api/market/sentiment').then(setVotes).catch((err) => setError(err.message));
  }, []);
  const topic = subject?.symbol || 'MARKET';
  const counts = votes?.votes?.[topic] || none;
  const ranked = Object.entries(votes?.votes || {}).filter(([key]) => key !== 'MARKET')
    .sort((a, b) => b[1].total - a[1].total).slice(0, 10);

  async function vote(stance) {
    setBusy('vote');
    setError('');
    try {
      let voter = localStorage.getItem('market-desk:voter');
      if (!voter) { voter = crypto.randomUUID(); localStorage.setItem('market-desk:voter', voter); }
      setVotes(await post('/api/market/sentiment', { symbol: topic, voter, stance }));
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  async function sample() {
    const isCandidate = subject && ['stock', 'etf', 'crypto'].includes(subject.kind);
    const assets = isCandidate ? [subject] : (market?.stocks?.active || []).slice(0, 5);
    if (!assets.length) return;
    setBusy('sample');
    setError('');
    try { setDiscussion(await post('/api/market/discussion', { assets })); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  return <section className="panel trends-discovery">
    <div className="collection-heading">
      <div><HelpTitle label="What people think" text="See how people in this Market Desk workspace voted on the market or a particular investment. The separate Public discussion section samples available social posts. Use both as views of opinion." /><p>Votes in Market Desk and public posts about investments.</p></div>
      <WithHelp label="Choose an investment to vote on" text="Pick a stock, fund, or another investment so this section shows votes for that subject. Choose Broad market to view votes about the market overall.">
        <button className="button button-small button-outline" onClick={() => onFind(setSubject)}>Choose an investment</button>
      </WithHelp>
    </div>
    <div className="sentiment-content">
      <div className="sentiment-topic">
        <span><Vote size={16} />{subject ? `${subject.name} · ${typeLabel[subject.kind]}` : 'Broad market'}</span>
        {subject && <button className="button button-small button-outline" onClick={() => setSubject(null)}>Broad market</button>}
      </div>
      <div className="metrics sentiment-metrics">
        {Object.entries(opinions).map(([stance, label]) => <div className="metric" key={stance}><WithHelp label={label} text={opinionHelp[stance]} /><strong>{counts[stance]}</strong></div>)}
        <div className="metric"><WithHelp label="Total votes" text="All votes submitted today for the market or investment selected here. Check the total alongside each category to see how many people contributed." /><strong>{counts.total}</strong></div>
      </div>
      <div className="form-actions vote-actions" role="group" aria-label="Cast your vote">{Object.entries(opinions).map(([stance, label]) => <button key={stance} className="button button-small button-outline" disabled={Boolean(busy)}
        onClick={() => vote(stance)} aria-label={`Vote: ${label}`}>{label}</button>)}</div>
      <p className="inline-note">Vote once per browser, per investment, per day.</p>
      {ranked.length > 0 && <div className="local-polls">{ranked.map(([symbol, tally]) => <span key={symbol}>{symbol} · {tally.total} vote{tally.total !== 1 ? 's' : ''}</span>)}</div>}
      <div className="social-samples">
        <div className="collection-heading">
          <div><HelpTitle as="h3" label="Public discussion" text="Check available Stocktwits posts for the selected supported investment or a sample of the most traded stocks. Positive and negative counts come from labels authors set. Unlabelled posts are counted separately."><MessageCircle size={16} />Public discussion</HelpTitle><p>Stocktwits posts from the last seven days. Authors can label their own posts as positive or negative.</p></div>
          <button className="button button-small button-outline" disabled={Boolean(busy) || !market && !subject} onClick={sample}>
            {busy === 'sample' && <LoaderCircle size={15} className="spin" />}Check posts
          </button>
        </div>
        {discussion?.samples?.map(({ asset, counts: sample }) => <div className="discussion-row" key={asset.symbol}>
          <strong>{asset.symbol}</strong><span>{sample ? `${sample.bullish} positive · ${sample.bearish} negative · ${sample.unlabeled} without a label (${sample.total} posts)` : 'No recent posts available'}</span>
        </div>)}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  </section>;
}

export function MarketTrends({ onResearch, onFind }) {
  const [market, setMarket] = useState(null);
  const [funds, setFunds] = useState(null);
  const [fault, setFault] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    api('/api/market/trends', { signal: controller.signal }).then(setMarket)
      .catch((err) => { if (!controller.signal.aborted) setFault(err.message); });
    api('/api/market/fund-movers', { signal: controller.signal }).then(setFunds)
      .catch(() => { if (!controller.signal.aborted) setFunds({ unavailable: true }); });
    return () => controller.abort();
  }, []);
  const broad = market?.benchmarks?.find((item) => item.name === 'NIFTY TOTAL MARKET');
  const breadth = broad && [broad.advances, broad.unchanged, broad.declines].every(Number.isFinite)
    ? broad.advances + broad.unchanged + broad.declines : 0;
  const feeLink = 'https://www.amfiindia.com/research-information/amfi-monthly';

  return <div className="discovery-wrap">
    {fault && <p className="form-error" role="alert">{fault}</p>}
    {market?.unavailable?.length > 0 && <p className="inline-note">Some sources are unavailable · {market.unavailable.join(', ')}</p>}
    <section className="panel trends-discovery market-snapshot">
      <div className="collection-heading">
        <div><HelpTitle label="How the market is doing" text="Read the latest NSE index levels and percentage moves. The breadth bar shows how many stocks rose, fell, or stayed unchanged in the broad market." /><p>{market?.timestamp || 'Latest published NSE figures'}</p></div>
        {market?.links && <Source href={market.links.indices}>NSE markets</Source>}
      </div>
      {market?.benchmarks?.length > 0 ? <div className="metrics market-index-metrics">{market.benchmarks.map((item) =>
        <div className="metric" key={item.name}><WithHelp label={item.name} text={indexHelp[item.name] || 'The latest published index level and its change from the previous close.'} /><strong>{number(item.value)}</strong><small className={tone(item.change)}>{signed(item.change)}</small></div>)}</div>
        : <p className="inline-note discovery-message">{market ? 'Index data was unavailable.' : 'Loading market figures…'}</p>}
      {breadth > 0 && <div className="market-breadth">
        <div className="breadth-label"><WithHelp label="Stocks in the Nifty Total Market" text="Counts how many stocks in the broad index are above, equal to, or below their previous close. The bar shows each group’s share so you can judge how widespread the move was."><strong>Stocks in the Nifty Total Market</strong></WithHelp><span>{broad.advances} up · {broad.unchanged} unchanged · {broad.declines} down</span></div>
        <div className="breadth-bar" role="img" aria-label={`${broad.advances} advancing, ${broad.unchanged} unchanged, ${broad.declines} declining`}>
          <span style={{ width: `${broad.advances / breadth * 100}%` }} /><span style={{ width: `${broad.unchanged / breadth * 100}%` }} /><span style={{ width: `${broad.declines / breadth * 100}%` }} />
        </div>
        <p className="inline-note">India VIX tracks how much investors expect prices to swing over the next 30 days. <Source href={market.links.vix}>NSE India VIX</Source></p>
      </div>}
    </section>

    <div className="trends-content-grid">
      <StockTrends data={market} onResearch={onResearch} />
      <section className="panel trends-discovery sector-discovery">
        <div className="collection-heading"><div><HelpTitle label="Which industries are up or down" text="Compare percentage price moves for NSE industry groups. Positive means the group index rose. Use the list to see whether a move is affecting one industry or much of the market." /><p>Price changes for NSE industry groups</p></div><Activity size={18} /></div>
        {market?.sectors?.length ? <div className="sector-list">
          {market.sectors.map((item) => <div className="sector-row" key={item.name}><span>{item.name}</span><strong className={tone(item.change)}>{signed(item.change)}</strong></div>)}
        </div> : <p className="inline-note discovery-message">Waiting for index data.</p>}
      </section>
    </div>

    <section className="panel trends-discovery">
      <div className="collection-heading">
        <div><HelpTitle label="Biggest changes in mutual fund values" text="Shows direct growth funds with the largest moves in their published value per unit in either direction. Read the earlier comparison date under each change. Select a fund to see its longer history." /><p>{funds?.session ? `Direct growth funds · ${number(funds.matched, 0)} compared · ${dateLabel(funds.session)}` : 'Direct growth funds'}</p></div>
        <Source href={funds?.flows_source || feeLink}>AMFI monthly money flows</Source>
      </div>
      {funds ? <SignalTable rows={funds.rows} onResearch={onResearch} funds /> : <p className="inline-note discovery-message">Loading published fund values…</p>}
      <p className="inline-note discovery-message">Ordered by the biggest moves in either direction. AMFI publishes money going into and out of funds separately.</p>
    </section>

    <Sentiment onFind={onFind} market={market} />

    <div className="trends-content-grid">
      <section className="panel trends-discovery">
        <div className="collection-heading"><div><HelpTitle label="Recent company announcements" text="See recent official company disclosures filed on NSE. Open an item to read the original announcement and check when it was published." /><p>Official announcements filed with NSE</p></div>
          {market?.links && <Source href={market.links.filings}>NSE filings</Source>}
        </div>
        {(market?.filings || []).slice(0, 10).map((row, index) => <a className="filing-row" key={`${index}:${row.symbol}`} href={row.link} target="_blank" rel="noreferrer">
          <small>{row.symbol} · {row.timestamp}</small><strong>{row.title}</strong>
        </a>)}
        {market && !market.filings?.length && <p className="inline-note discovery-message">No announcements were returned by NSE.</p>}
      </section>
      <section className="panel trends-discovery">
        <div className="collection-heading"><div><HelpTitle label="What large investors bought or sold" text="The reported value of buys minus sells by groups of large investors. A positive number means the group bought more than it sold. Amounts are in crore rupees for the displayed trading date." /><p>Buys minus sells, in ₹ crore. NSE figures can be revised.</p></div>
          {market?.links && <Source href={market.links.institutional}>NSE flows</Source>}
        </div>
        {(market?.flows || []).map((item) => <div className="sector-row" key={item.name}><span>{item.name}<small className="under-cell">{dateLabel(item.date)}</small></span><strong className={tone(item.net_crore)}>{signed(item.net_crore, '')}</strong></div>)}
        {market && !market.flows?.length && <p className="inline-note discovery-message">No recent buy and sell totals are available.</p>}
      </section>
    </div>
  </div>;
}
