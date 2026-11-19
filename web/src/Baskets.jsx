import { useEffect, useState } from 'react';
import { Boxes, CircleDollarSign, ExternalLink, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';
import { AssetIdentity, post } from './Discovery';
import { api, dateLabel, money, number, tone, typeLabel } from './api';

function PopularSmallcases({ catalogue }) {
  if (!catalogue) return null;
  return <section className="panel popular-cases">
    <div className="collection-heading">
      <div><h2>Popular smallcases</h2><p>Published in smallcase’s trending collection</p></div>
      <a className="button button-small button-outline" href={catalogue.collection} target="_blank" rel="noreferrer"><ExternalLink size={15} />Open collection</a>
    </div>
    <div className="popular-grid">{catalogue.featured.map((item) => <a className="case-link" key={item.name} href={item.url} target="_blank" rel="noreferrer">
      <div className="section-icon"><Boxes size={17} /></div><span><strong>{item.name}</strong><small>{item.theme}</small></span>
      <ExternalLink size={14} />
    </a>)}</div>
  </section>;
}

function Details({ initial, onFind, save, onResearch }) {
  const [item, setItem] = useState(initial);
  const [targets, setTargets] = useState(initial.targets);
  const [marks, setMarks] = useState(null);
  const [tradeAsset, setTradeAsset] = useState(initial.targets[0]?.asset || null);
  const [order, setOrder] = useState({ side: 'buy', units: '', price: '', fee: '0' });
  const [quote, setQuote] = useState(null);
  const [budget, setBudget] = useState('');
  const [fee, setFee] = useState('0');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const holdings = item.positions;
  const endpoint = `/api/baskets/${item.id}`;
  const initialWeight = item.targets.reduce((sum, row) => sum + Number(row.weight), 0);
  const totalWeight = targets.reduce((sum, row) => sum + Number(row.weight), 0);
  const allMarked = marks && holdings.every((row) => Boolean(marks.quotes[row.asset.symbol]));
  const value = allMarked ? holdings.reduce((sum, row) => sum + Number(row.units) * marks.quotes[row.asset.symbol].price, 0) : null;
  const basis = holdings.reduce((sum, row) => sum + Number(row.cost), 0);
  const tradeChoices = [...new Map([...targets.map((row) => row.asset), ...holdings.map((row) => row.asset),
    ...(tradeAsset ? [tradeAsset] : [])].map((asset) => [asset.symbol, asset])).values()];

  function chooseTrade(asset) {
    setTradeAsset(asset);
    setQuote(null);
    setOrder((previous) => ({ ...previous, price: '' }));
  }

  function updateItem(next) {
    setItem(next);
    save(next);
  }

  async function attempt(key, operation) {
    setBusy(key);
    setMessage('');
    setError('');
    try { await operation(); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  function saveTargets() {
    attempt('targets', async () => {
      const next = await post(`${endpoint}/targets`, { targets: targets.map(({ asset, weight }) => ({ asset, weight: weight || '0' })) });
      updateItem(next);
      setTargets(next.targets);
      setMessage('Saved target allocations.');
    });
  }

  function addTarget(asset) {
    if (asset.kind === 'index') { setError('Choose a traded fund or security for a basket.'); return; }
    if (targets.some((row) => row.asset.symbol === asset.symbol)) return;
    setError('');
    setTargets((previous) => [...previous, { asset, weight: '0' }]);
    if (!tradeAsset) chooseTrade(asset);
  }

  function simulate(event) {
    event.preventDefault();
    if (!tradeAsset) return;
    attempt('order', async () => {
      const next = await post(`${endpoint}/orders`, {
        asset: tradeAsset, request_id: crypto.randomUUID(), side: order.side,
        units: order.units, price: order.price || null, fee: order.fee || '0',
      });
      updateItem(next);
      setMarks(null);
      setOrder((previous) => ({ ...previous, units: '' }));
      setMessage('Paper fill recorded.');
    });
  }

  function allocate(event) {
    event.preventDefault();
    attempt('allocate', async () => {
      const previous = item.orders.length;
      const next = await post(`${endpoint}/allocate`, { request_id: crypto.randomUUID(), budget, fee: fee || '0' });
      updateItem(next);
      setMarks(null);
      setMessage(`${next.orders.length - previous} paper fills recorded.`);
    });
  }

  const setTicket = (field, update) => setOrder((previous) => ({ ...previous, [field]: update }));
  return <div className="basket-content">
    <section className="panel collection-content">
      <div className="collection-heading">
        <div><h2>{item.name}</h2><p>Paper account · Started with {money(Number(item.capital), 'INR')}</p></div>
        <button className="button button-small button-outline" disabled={Boolean(busy) || !holdings.length} onClick={() => attempt('marks', async () => {
          setMarks(await post(`${endpoint}/marks`, {}));
        })}><RefreshCw size={15} className={busy === 'marks' ? 'spin' : ''} />Refresh valuation</button>
      </div>
      <div className="metrics paper-metrics">
        {[['Paper cash', Number(item.cash)], ['Realized P&L', Number(item.realized)],
          ['Unrealized P&L', value === null ? null : value - basis], ['Marked equity', value === null ? null : value + Number(item.cash)]].map(([label, v]) =>
          <div className="metric" key={label}><span>{label}</span><strong className={label.endsWith('P&L') ? tone(v) : ''}>{money(v, 'INR')}</strong></div>)}
      </div>
      {marks && Object.keys(marks.unavailable).length > 0 && <p className="inline-note discovery-message">Quotes unavailable for {Object.keys(marks.unavailable).join(', ')}.</p>}
      {!!holdings.length && <div className="table-scroll">
        <table><thead><tr><th>Holding</th><th>Units</th><th>Average cost</th><th>Market reference</th><th>Open P&L</th></tr></thead>
          <tbody>{holdings.map((row) => {
            const mark = marks?.quotes[row.asset.symbol];
            return <tr key={row.asset.symbol}>
              <td><button className="asset-table-button" onClick={() => chooseTrade(row.asset)}><AssetIdentity asset={row.asset} /></button></td>
              <td>{number(Number(row.units), row.asset.kind === 'fund' ? 4 : 2)}</td>
              <td>{money(Number(row.entry), 'INR')}</td>
              <td>{mark ? <>{money(mark.price, 'INR')}<small className="under-cell">{dateLabel(mark.date, false)} · {mark.source}</small></> : '—'}</td>
              <td className={mark ? tone(mark.price * Number(row.units) - Number(row.cost)) : ''}>
                {mark ? money(mark.price * Number(row.units) - Number(row.cost), 'INR') : '—'}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
      {!holdings.length && <p className="inline-note discovery-message">Holdings appear after a paper buy.</p>}
    </section>
    <div className="paper-editor-grid">
      <section className="panel collection-content">
        <div className="collection-heading">
          <div><h2>Target allocation</h2><p>{number(totalWeight)}% allocated</p></div>
          <button className="button button-small button-outline" onClick={() => onFind(addTarget)}><Plus size={15} />Add asset</button>
        </div>
        {!targets.length && <p className="inline-note">Add instruments to define a basket.</p>}
        {targets.map(({ asset, weight }) => <div className="target-row" key={asset.symbol}>
          <button className="asset-table-button" type="button" onClick={() => chooseTrade(asset)}><AssetIdentity asset={asset} /></button>
          <label className="target-weight">
            <input type="number" step=".01" min="0" max="100" aria-label={`Weight for ${asset.symbol}`} value={weight} onChange={(e) => setTargets(targets.map((row) =>
              row.asset.symbol === asset.symbol ? { ...row, weight: e.target.value } : row))} />%
          </label>
          <button className="icon-button" type="button" aria-label={`Remove ${asset.symbol} from targets`} onClick={() => setTargets(targets.filter((row) => row.asset.symbol !== asset.symbol))}><X size={16} /></button>
        </div>)}
        <button className="button button-small button-primary" type="button" disabled={Boolean(busy) || totalWeight > 100} onClick={saveTargets}>Save weights</button>
        {initialWeight > 0 && <details className="allocation-panel">
          <summary>Simulate a basket buy</summary>
          <form className="paper-form" onSubmit={allocate}>
            <div className="form-columns">
              <label>Budget (₹)<input type="number" step=".01" min=".01" value={budget} onChange={(e) => setBudget(e.target.value)} required /></label>
              <label>Fee per fill (₹)<input type="number" step=".01" min="0" value={fee} onChange={(e) => setFee(e.target.value)} /></label>
            </div>
            <p className="inline-note">Uses saved weights and market lots at the latest available INR reference price.</p>
            <button className="button button-outline" disabled={Boolean(busy) || !budget} type="submit">Simulate basket buy</button>
          </form>
        </details>}
      </section>

      <section className="panel collection-content">
        <div className="collection-heading"><div><h2>Paper order</h2><p>Simulated buys and sells</p></div>
          <button className="button button-small button-outline" onClick={() => onFind((asset) => {
            if (asset.kind === 'index') { setError('Choose a traded instrument for a paper order.'); return; }
            chooseTrade(asset);
          })}><Plus size={15} />Find asset</button>
        </div>
        <form className="paper-form" onSubmit={simulate}>
          <label>Instrument<select value={tradeAsset?.symbol || ''} onChange={(e) => chooseTrade(tradeChoices.find((asset) => asset.symbol === e.target.value) || null)}>
            <option value="">Choose an instrument</option>
            {tradeChoices.map((asset) => <option value={asset.symbol} key={asset.symbol}>{asset.symbol} · {typeLabel[asset.kind]}</option>)}
          </select></label>
          <div className="form-columns">
            <label>Side<select value={order.side} onChange={(e) => setTicket('side', e.target.value)}><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
            <label>Units<input type="number" step="any" min=".000001" value={order.units} onChange={(e) => setTicket('units', e.target.value)} required /></label>
          </div>
          <div className="form-columns">
            <label>Manual price per unit (₹)<input type="number" step="any" min=".000001" value={order.price} onChange={(e) => setTicket('price', e.target.value)} placeholder="Use latest quote" /></label>
            <label>Fee / slippage (₹)<input type="number" step=".01" min="0" value={order.fee} onChange={(e) => setTicket('fee', e.target.value)} /></label>
          </div>
          {quote && <p className="inline-note">{money(quote.price, 'INR')} · {dateLabel(quote.date, false)} · {quote.source}</p>}
          {tradeAsset?.kind === 'bond' && <p className="inline-note">For a manual bond fill enter the full rupee price per unit, including accrued interest where applicable.</p>}
          <div className="form-actions">
            <button className="button button-small button-outline" disabled={Boolean(busy) || !tradeAsset} type="button" onClick={() => attempt('quote', async () => {
              setQuote(await post('/api/paper/quote', tradeAsset));
            })}>Check quote</button>
            <button className="button button-primary" disabled={Boolean(busy) || !tradeAsset || !order.units} type="submit"><CircleDollarSign size={16} />Simulate {order.side}</button>
          </div>
        </form>
      </section>
    </div>
    {busy && <p className="inline-note discovery-message" role="status"><LoaderCircle size={16} className="spin" />Updating paper account…</p>}
    {message && <p className="inline-note discovery-message" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}

    <section className="panel collection-content">
      <div className="collection-heading"><div><h2>Fill history</h2><p>{item.orders.length} simulated fills</p></div></div>
      {!item.orders.length && <p className="inline-note">Placed paper orders appear here.</p>}
      {!!item.orders.length && <div className="table-scroll">
        <table><thead><tr><th>Instrument</th><th>Side</th><th>Units</th><th>Fill price</th><th>Fee</th><th>Price source</th></tr></thead>
          <tbody>{[...item.orders].reverse().map((fill) => <tr key={fill.request_id}>
            <td>{fill.asset.kind === 'bond' ? fill.asset.symbol : <button className="sort-heading" onClick={() => onResearch(fill.asset)}>{fill.asset.symbol}</button>}</td>
            <td className={fill.side === 'buy' ? 'positive' : 'negative'}>{fill.side === 'buy' ? 'Buy' : 'Sell'}</td>
            <td>{number(Number(fill.units), fill.asset.kind === 'fund' ? 4 : 2)}</td>
            <td>{money(Number(fill.price), 'INR')}</td><td>{money(Number(fill.fee), 'INR')}</td>
            <td>{fill.source}<small className="under-cell">{dateLabel(fill.session || fill.filled_at)}</small></td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
  </div>;
}

export function Baskets({ onFind, onResearch }) {
  const [entries, setEntries] = useState([]);
  const [selected, setSelected] = useState('');
  const [basket, setBasket] = useState(null);
  const [popular, setPopular] = useState(null);
  const [newName, setNewName] = useState('');
  const [capital, setCapital] = useState('100000');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/baskets').then((items) => { setEntries(items); setSelected((value) => value || items[0]?.id || ''); })
      .catch((err) => setError(err.message)).finally(() => setBusy(false));
    api('/api/baskets/popular').then(setPopular).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selected) { setBasket(null); return undefined; }
    const controller = new AbortController();
    api(`/api/baskets/${selected}`, { signal: controller.signal }).then(setBasket)
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [selected]);

  function save(item) {
    const record = { ...item, targets: item.targets.length, fills: item.orders.length };
    setEntries((previous) => [...previous.filter(({ id }) => id !== item.id), record].sort((a, b) => a.name.localeCompare(b.name)));
    setBasket(item);
  }

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const item = await post('/api/baskets', { name: newName, capital });
      save(item);
      setSelected(item.id);
      setNewName('');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return <div className="discovery-wrap">
    <div className="collections-grid">
      <section className="panel collection-sidebar">
        <h2>Your baskets</h2>
        <form className="new-basket" onSubmit={create}>
          <label>Basket name<input placeholder="Name your basket" value={newName} onChange={(e) => setNewName(e.target.value)} required maxLength={70} /></label>
          <label>Starting cash (₹)<input type="number" min=".01" step=".01" value={capital} onChange={(e) => setCapital(e.target.value)} required /></label>
          <button className="button button-primary" type="submit" disabled={busy || !newName.trim()}><Plus size={16} />Create basket</button>
        </form>
        {entries.map((entry) => <button className={`collection-choice ${selected === entry.id ? 'collection-selected' : ''}`} key={entry.id} onClick={() => setSelected(entry.id)}>
          <Boxes size={16} /><span>{entry.name}</span><small>{entry.fills} fills</small>
        </button>)}
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
      {basket?.id === selected && basket ? <Details key={selected} initial={basket} onFind={onFind} save={save} onResearch={onResearch} /> :
        <section className="panel empty-list"><Boxes size={24} /><p>{selected ? 'Loading basket…' : 'Create a basket to set weights and simulate trades.'}</p></section>}
    </div>
    <PopularSmallcases catalogue={popular} />
  </div>;
}
