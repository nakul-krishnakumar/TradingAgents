import { useEffect, useState } from 'react';
import { Activity, ExternalLink, LoaderCircle, MessageCircle, Vote } from 'lucide-react';
import { AssetIdentity, post } from './Discovery';
import { api, dateLabel, money, number, signed, tone, typeLabel } from './api';

const none = { bullish: 0, neutral: 0, bearish: 0, total: 0 };

function Source({ children, href }) {
  return <a className="source-link" href={href} target="_blank" rel="noreferrer">{children}<ExternalLink size={12} /></a>;
}

function SignalTable({ rows, onResearch, showTurnover = false, funds = false }) {
  if (!rows?.length) return <p className="inline-note discovery-message">No comparable observations from this feed.</p>;
  return <div className="table-scroll trend-table">
    <table><thead><tr><th>Instrument</th><th>{funds ? 'Published NAV' : 'Final close'}</th><th>{funds ? 'NAV change' : 'Session change'}</th>
      {showTurnover && <th>Turnover (₹ cr)</th>}{funds && <th>Category</th>}</tr></thead>
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
    <div className="collection-heading"><div><h2>Market movers</h2><p>{data?.session ? `Final NSE session · ${dateLabel(data.session)}` : 'Final NSE trading data'}</p></div>
      {data?.links && <Source href={data.links.bhavcopy}>NSE daily report</Source>}
    </div>
    <div className="trends-switches">
      <div className="segmented" aria-label="Mover asset class">
        <button type="button" aria-pressed={category === 'stocks'} onClick={() => setCategory('stocks')}>Stocks</button>
        <button type="button" aria-pressed={category === 'etfs'} onClick={() => setCategory('etfs')}>ETFs</button>
      </div>
      <div className="segmented" aria-label="Rank market movers">
        {[['active', 'Most traded'], ['gainers', 'Gainers'], ['losers', 'Losers']].map(([id, label]) =>
          <button type="button" key={id} aria-pressed={rank === id} onClick={() => setRank(id)}>{label}</button>)}
      </div>
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
      <div><h2>User sentiment</h2><p>Workspace votes and available self-labeled social posts</p></div>
      <button className="button button-small button-outline" onClick={() => onFind(setSubject)}>Choose an instrument</button>
    </div>
    <div className="sentiment-content">
      <div className="sentiment-topic">
        <span><Vote size={16} />{subject ? `${subject.name} · ${typeLabel[subject.kind]}` : 'Broad market'}</span>
        {subject && <button className="button button-small button-outline" onClick={() => setSubject(null)}>Broad market</button>}
      </div>
      <div className="metrics sentiment-metrics">
        {['bullish', 'neutral', 'bearish'].map((stance) => <div className="metric" key={stance}><span>{stance}</span><strong>{counts[stance]}</strong></div>)}
        <div className="metric"><span>Responses</span><strong>{counts.total}</strong></div>
      </div>
      <div className="form-actions vote-actions">{['bullish', 'neutral', 'bearish'].map((stance) => <button key={stance} className="button button-small button-outline" disabled={Boolean(busy)}
        onClick={() => vote(stance)}>Vote {stance}</button>)}</div>
      <p className="inline-note">One response per browser and instrument per day. Counts are from this workspace.</p>
      {ranked.length > 0 && <div className="local-polls">{ranked.map(([symbol, tally]) => <span key={symbol}>{symbol} · {tally.total} vote{tally.total !== 1 ? 's' : ''}</span>)}</div>}
      <div className="social-samples">
        <div className="collection-heading">
          <div><h3><MessageCircle size={16} />Public discussion</h3><p>Stocktwits labels from the last seven days for the chosen asset or the five most traded stocks.</p></div>
          <button className="button button-small button-outline" disabled={Boolean(busy) || !market && !subject} onClick={sample}>
            {busy === 'sample' && <LoaderCircle size={15} className="spin" />}Check coverage
          </button>
        </div>
        {discussion?.samples?.map(({ asset, counts: sample }) => <div className="discussion-row" key={asset.symbol}>
          <strong>{asset.symbol}</strong><span>{sample ? `${sample.bullish} bullish · ${sample.bearish} bearish · ${sample.unlabeled} unlabeled (${sample.total} posts)` : 'No usable sample'}</span>
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
    {market?.unavailable?.length > 0 && <p className="inline-note">Feed gaps · {market.unavailable.join(', ')}</p>}
    <section className="panel trends-discovery market-snapshot">
      <div className="collection-heading">
        <div><h2>Market pulse</h2><p>{market?.timestamp || 'Latest published NSE observations'}</p></div>
        {market?.links && <Source href={market.links.indices}>NSE markets</Source>}
      </div>
      {market?.benchmarks?.length > 0 ? <div className="metrics market-index-metrics">{market.benchmarks.map((item) =>
        <div className="metric" key={item.name}><span>{item.name}</span><strong>{number(item.value)}</strong><small className={tone(item.change)}>{signed(item.change)}</small></div>)}</div>
        : <p className="inline-note discovery-message">{market ? 'Index data was unavailable.' : 'Loading market pulse…'}</p>}
      {breadth > 0 && <div className="market-breadth">
        <div className="breadth-label"><strong>Nifty Total Market breadth</strong><span>{broad.advances} up · {broad.unchanged} flat · {broad.declines} down</span></div>
        <div className="breadth-bar" role="img" aria-label={`${broad.advances} advancing, ${broad.unchanged} unchanged, ${broad.declines} declining`}>
          <span style={{ width: `${broad.advances / breadth * 100}%` }} /><span style={{ width: `${broad.unchanged / breadth * 100}%` }} /><span style={{ width: `${broad.declines / breadth * 100}%` }} />
        </div>
        <p className="inline-note"><Source href={market.links.vix}>India VIX</Source> measures expected 30-day volatility.</p>
      </div>}
    </section>

    <div className="trends-content-grid">
      <StockTrends data={market} onResearch={onResearch} />
      <section className="panel trends-discovery sector-discovery">
        <div className="collection-heading"><div><h2>Sector rotation</h2><p>NSE sectoral indices</p></div><Activity size={18} /></div>
        {market?.sectors?.length ? <div className="sector-list">
          {market.sectors.map((item) => <div className="sector-row" key={item.name}><span>{item.name}</span><strong className={tone(item.change)}>{signed(item.change)}</strong></div>)}
        </div> : <p className="inline-note discovery-message">Waiting for index data.</p>}
      </section>
    </div>

    <section className="panel trends-discovery">
      <div className="collection-heading">
        <div><h2>Mutual fund NAV movers</h2><p>{funds?.session ? `Direct growth schemes · ${number(funds.matched, 0)} matched · ${dateLabel(funds.session)}` : 'Direct growth schemes'}</p></div>
        <Source href={funds?.flows_source || feeLink}>AMFI monthly flows</Source>
      </div>
      {funds ? <SignalTable rows={funds.rows} onResearch={onResearch} funds /> : <p className="inline-note discovery-message">Matching published NAVs…</p>}
      <p className="inline-note discovery-message">Ranked by absolute NAV move. Fund flows are reported separately by AMFI.</p>
    </section>

    <Sentiment onFind={onFind} market={market} />

    <div className="trends-content-grid">
      <section className="panel trends-discovery">
        <div className="collection-heading"><div><h2>Recent disclosures</h2><p>Company announcements reported to NSE</p></div>
          {market?.links && <Source href={market.links.filings}>NSE filings</Source>}
        </div>
        {(market?.filings || []).slice(0, 10).map((row, index) => <a className="filing-row" key={`${index}:${row.symbol}`} href={row.link} target="_blank" rel="noreferrer">
          <small>{row.symbol} · {row.timestamp}</small><strong>{row.title}</strong>
        </a>)}
        {market && !market.filings?.length && <p className="inline-note discovery-message">No disclosures returned by the feed.</p>}
      </section>
      <section className="panel trends-discovery">
        <div className="collection-heading"><div><h2>Institutional flows</h2><p>Provisional NSE figures in ₹ crore</p></div>
          {market?.links && <Source href={market.links.institutional}>NSE flows</Source>}
        </div>
        {(market?.flows || []).map((item) => <div className="sector-row" key={item.name}><span>{item.name}<small className="under-cell">{dateLabel(item.date)}</small></span><strong className={tone(item.net_crore)}>{signed(item.net_crore, '')}</strong></div>)}
        {market && !market.flows?.length && <p className="inline-note discovery-message">No current flow data.</p>}
      </section>
    </div>
  </div>;
}
