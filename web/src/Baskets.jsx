import { useEffect, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, Boxes, ExternalLink, LoaderCircle, Plus, RefreshCw, X } from 'lucide-react';
import { AssetIdentity, post } from './Discovery';
import { api, dateLabel, money, number, signedMoney, tone, typeLabel } from './api';
import { HelpDetails, HelpField, HelpTitle, WithHelp } from './Help';

function PopularSmallcases({ catalogue }) {
  if (!catalogue) return null;
  return <section className="panel popular-cases">
    <div className="collection-heading">
      <div><HelpTitle label="Popular smallcases" text="Browse themed investment baskets published by smallcase. Open one to see the publisher’s details and use it for ideas when building your own practice basket." /><p>Published in smallcase’s trending collection</p></div>
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
  const value = allMarked ? holdings.reduce((sum, row) => sum + Number(row.units) * marks.quotes[row.asset.symbol].price, 0) : holdings.length ? null : 0;
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
      setMessage('Saved how you want to split your money.');
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
      setMessage(order.side === 'buy' ? 'Paper BUY complete.' : 'Paper SELL complete.');
    });
  }

  function allocate(event) {
    event.preventDefault();
    attempt('allocate', async () => {
      const previous = item.orders.length;
      const next = await post(`${endpoint}/allocate`, { request_id: crypto.randomUUID(), budget, fee: fee || '0' });
      updateItem(next);
      setMarks(null);
      const count = next.orders.length - previous;
      setMessage(`${count} paper ${count === 1 ? 'buy' : 'buys'} completed.`);
    });
  }

  const setTicket = (field, update) => setOrder((previous) => ({ ...previous, [field]: update }));
  return <div className="basket-content">
    <section className="panel collection-content">
      <div className="collection-heading">
        <div><HelpTitle label="Practice account" text="See your basket’s virtual cash, completed trading results, and current holdings. Use Check latest prices to estimate what the holdings and whole account are worth today.">{item.name}</HelpTitle><p>Practice account · Started with {money(Number(item.capital), 'INR')} in virtual money</p></div>
        <WithHelp label="Check latest prices" text="Look up the latest available reference price for each holding. The estimate shows how the position and overall account have changed. Check the displayed dates for delayed prices.">
          <button className="button button-small button-outline" disabled={Boolean(busy) || !holdings.length} onClick={() => attempt('marks', async () => {
            setMarks(await post(`${endpoint}/marks`, {}));
          })}><RefreshCw size={15} className={busy === 'marks' ? 'spin' : ''} />Check latest prices</button>
        </WithHelp>
      </div>
      <div className="metrics paper-metrics">
        <div className="metric"><WithHelp label="Cash available" text="Virtual money left to buy investments after your practice buys, sells, and recorded fees." /><strong>{money(Number(item.cash), 'INR')}</strong></div>
        <div className="metric"><WithHelp label="Profit / loss from sells" text="The gain or loss on investments already sold, after purchase costs and recorded trade fees." /><strong className={tone(Number(item.realized))}>{signedMoney(Number(item.realized), 'INR')}</strong></div>
        <div className="metric"><WithHelp label="Estimated on investments held" text="What your holdings are worth at the latest prices minus what they cost to acquire. Check latest prices to calculate this figure." /><strong className={tone(value === null ? null : value - basis)}>{signedMoney(value === null ? null : value - basis, 'INR')}</strong></div>
        <div className="metric"><WithHelp label="Total account value" text="Adds the virtual cash left to the estimated market value of everything you still hold. It needs a price for each holding." /><strong>{money(value === null ? null : value + Number(item.cash), 'INR')}</strong></div>
      </div>
      {value === null && !marks && <p className="inline-note discovery-message">Check latest prices to estimate the return on investments you still hold.</p>}
      {marks && Object.keys(marks.unavailable).length > 0 && <p className="inline-note discovery-message">Quotes unavailable for {Object.keys(marks.unavailable).join(', ')}.</p>}
      {!!holdings.length && <div className="table-scroll">
        <table><thead><tr>{[
          ['Investment', 'An investment that this basket still holds. Click it to choose it in the paper trade form.'],
          ['Quantity', 'How many shares, units, or bonds the portfolio currently holds.'],
          ['Average price paid', 'The average cost per share or unit for the quantity you still hold.'],
          ['Latest price found', 'The most recent reference price Market Desk could find. Its source and date appear below it.'],
          ['Estimated profit / loss', 'Latest estimated value minus the cost of the shares or units still held.'],
        ].map(([label, text]) => <th scope="col" aria-label={label} key={label}><WithHelp label={label} text={text} /></th>)}</tr></thead>
          <tbody>{holdings.map((row) => {
            const mark = marks?.quotes[row.asset.symbol];
            return <tr key={row.asset.symbol}>
              <td><button className="asset-table-button" onClick={() => chooseTrade(row.asset)}><AssetIdentity asset={row.asset} /></button></td>
              <td>{number(Number(row.units), row.asset.kind === 'fund' ? 4 : 2)}</td>
              <td>{money(Number(row.entry), 'INR')}</td>
              <td>{mark ? <>{money(mark.price, 'INR')}<small className="under-cell">{dateLabel(mark.date, false)} · {mark.source}</small></> : '—'}</td>
              <td className={mark ? tone(mark.price * Number(row.units) - Number(row.cost)) : ''}>
                {mark ? signedMoney(mark.price * Number(row.units) - Number(row.cost), 'INR') : '—'}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
      {!holdings.length && <p className="inline-note discovery-message">Investments you buy appear here.</p>}
    </section>
    <div className="paper-editor-grid">
      <section className="panel collection-content">
        <div className="collection-heading">
          <div><HelpTitle label="How to split your money" text="Set the planned share of your basket for each investment. For example, 60% and 40% divide a ₹10,000 budget into ₹6,000 and ₹4,000 before trading costs and rounding. Save the percentages to use them for a basket buy." /><p>{number(totalWeight)}% assigned to investments</p></div>
          <button className="button button-small button-outline" onClick={() => onFind(addTarget)}><Plus size={15} />Add investment</button>
        </div>
        {!targets.length && <p className="inline-note">Add investments and set the share of your money for each one.</p>}
        {targets.map(({ asset, weight }) => <div className="target-row" key={asset.symbol}>
          <button className="asset-table-button" type="button" onClick={() => chooseTrade(asset)}><AssetIdentity asset={asset} /></button>
          <label className="target-weight">
            <input type="number" step=".01" min="0" max="100" aria-label={`Percent for ${asset.symbol}`} value={weight} onChange={(e) => setTargets(targets.map((row) =>
              row.asset.symbol === asset.symbol ? { ...row, weight: e.target.value } : row))} />%
          </label>
          <button className="icon-button" type="button" aria-label={`Remove ${asset.symbol} from targets`} onClick={() => setTargets(targets.filter((row) => row.asset.symbol !== asset.symbol))}><X size={16} /></button>
        </div>)}
        <WithHelp label="Save percentages" text="Keep these planned weights for the next basket purchase. Saving the plan does not create orders.">
          <button className="button button-small button-primary" type="button" disabled={Boolean(busy) || totalWeight > 100} onClick={saveTargets}>Save percentages</button>
        </WithHelp>
        {initialWeight > 0 && <HelpDetails className="allocation-panel" wrapperClassName="allocation-help" label="Buy the basket with paper money"
          text="Makes a group of paper buys using your saved percentages. The simulator uses reference prices and tradeable quantities, so amounts can round down and leave some virtual cash unspent.">
          <form className="paper-form" onSubmit={allocate}>
            <div className="form-columns">
              <HelpField label="Budget (₹)" text="How much virtual cash to divide among the investments using the saved percentages. It must fit within the basket’s available cash."><input type="number" step=".01" min=".01" value={budget} onChange={(e) => setBudget(e.target.value)} required /></HelpField>
              <HelpField label="Fee per buy (₹)" text="An optional virtual trading charge in rupees added to each purchase in the basket."><input type="number" step=".01" min="0" value={fee} onChange={(e) => setFee(e.target.value)} /></HelpField>
            </div>
            <p className="inline-note">Uses your saved percentages and the latest available rupee prices. Some investments can only be bought in set quantities.</p>
            <button className="button button-outline" disabled={Boolean(busy) || !budget} type="submit">Paper BUY basket</button>
          </form>
        </HelpDetails>}
      </section>

      <section className="panel collection-content">
        <div className="collection-heading"><div><HelpTitle label="Buy or sell" text="Choose an investment and a quantity to simulate a trade. BUY uses virtual cash and adds to your holdings. SELL reduces a holding and adds virtual cash back. Check BUY & SELL history for the completed trade." /><p>Practice a trade with virtual money.</p></div>
          <button className="button button-small button-outline" onClick={() => onFind((asset) => {
            if (asset.kind === 'index') { setError('Choose a traded instrument for a paper order.'); return; }
            chooseTrade(asset);
          })}><Plus size={15} />Find investment</button>
        </div>
        <form className="paper-form" onSubmit={simulate}>
          <WithHelp label="Trade action" text="Pick BUY to add to a holding, or SELL to reduce what you already hold. This chooses the action. Use the Paper BUY or Paper SELL button below to record it.">
            <span className="paper-side-picker" role="group" aria-label="Buy or sell">
              <button type="button" className="trade-side trade-side-buy" aria-pressed={order.side === 'buy'} onClick={() => setTicket('side', 'buy')}><ArrowDownLeft size={16} />BUY</button>
              <button type="button" className="trade-side trade-side-sell" aria-pressed={order.side === 'sell'} onClick={() => setTicket('side', 'sell')}><ArrowUpRight size={16} />SELL</button>
            </span>
          </WithHelp>
          <HelpField label="Investment" text="Choose which investment to trade from this basket. Use Find investment to look up another stock, fund, or bond."><select value={tradeAsset?.symbol || ''} onChange={(e) => chooseTrade(tradeChoices.find((asset) => asset.symbol === e.target.value) || null)}>
            <option value="">Choose an investment</option>
            {tradeChoices.map((asset) => <option value={asset.symbol} key={asset.symbol}>{asset.symbol} · {typeLabel[asset.kind]}</option>)}
          </select></HelpField>
          <HelpField label="Quantity" text="How many shares, fund units, or bonds to trade. Funds can allow fractional units. A paper sell must fit the quantity this basket holds."><input type="number" step="any" min=".000001" value={order.units} onChange={(e) => setTicket('units', e.target.value)} required /></HelpField>
          <div className="form-columns">
            <HelpField label="Price per share or unit (₹)" text="Enter a price to practice at that price, or leave it blank to ask for the latest available rupee reference price. For bonds, use the price per bond under its terms."><input type="number" step="any" min=".000001" value={order.price} onChange={(e) => setTicket('price', e.target.value)} placeholder="Use latest available price" /></HelpField>
            <HelpField label="Trade fee (₹)" text="Optional single trading charge in virtual rupees for this order. It increases the cost of a buy or reduces the amount received from a sell."><input type="number" step=".01" min="0" value={order.fee} onChange={(e) => setTicket('fee', e.target.value)} /></HelpField>
          </div>
          {quote && <p className="inline-note">{money(quote.price, 'INR')} · {dateLabel(quote.date, false)} · {quote.source}</p>}
          {tradeAsset?.kind === 'bond' && <p className="inline-note">For a manual bond fill enter the full rupee price per unit, including accrued interest where applicable.</p>}
          <div className="form-actions">
            <button className="button button-small button-outline" disabled={Boolean(busy) || !tradeAsset} type="button" onClick={() => attempt('quote', async () => {
              setQuote(await post('/api/paper/quote', tradeAsset));
            })}>Check latest price</button>
            <button className={`button ${order.side === 'buy' ? 'button-primary' : 'button-sell'}`} disabled={Boolean(busy) || !tradeAsset || !order.units} type="submit">
              {order.side === 'buy' ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}Paper {order.side.toUpperCase()}</button>
          </div>
        </form>
      </section>
    </div>
    {busy && <p className="inline-note discovery-message" role="status"><LoaderCircle size={16} className="spin" />Updating paper account…</p>}
    {message && <p className="inline-note discovery-message" role="status">{message}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}

    <section className="panel collection-content">
      <div className="collection-heading"><div><HelpTitle label="BUY & SELL history" text="Each row is one completed paper trade. You can see whether it was a buy or sell, how much traded, its price and fee, and whether the price came from a data source or was entered by you." /><p>{item.orders.length} completed paper trades</p></div></div>
      {!item.orders.length && <p className="inline-note">Completed buys and sells appear here.</p>}
      {!!item.orders.length && <div className="table-scroll">
        <table><thead><tr>{[
          ['Investment', 'The investment that was paper-traded. Click a supported symbol to research it.'],
          ['Action', 'BUY added to your holdings. SELL removed the displayed quantity and returned the proceeds to virtual cash.'],
          ['Quantity', 'The number of shares, units, or bonds in this trade.'],
          ['Price', 'The rupee amount per share, unit, or bond used to complete the trade.'],
          ['Fee', 'The virtual fee recorded for the entire trade.'],
          ['Price source', 'The source and date of the reference price, or an indication that a price was entered manually.'],
        ].map(([label, text]) => <th scope="col" aria-label={label} key={label}><WithHelp label={label} text={text} /></th>)}</tr></thead>
          <tbody>{[...item.orders].reverse().map((fill) => <tr key={fill.request_id}>
            <td>{fill.asset.kind === 'bond' ? fill.asset.symbol : <button className="sort-heading" onClick={() => onResearch(fill.asset)}>{fill.asset.symbol}</button>}</td>
            <td><span className={`trade-side trade-side-${fill.side}`}>{fill.side.toUpperCase()}</span></td>
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
        <HelpTitle label="Your baskets" text="Create named practice portfolios for different ideas, then click one to open it. The number next to a basket counts its completed practice trades." />
        <form className="new-basket" onSubmit={create}>
          <HelpField label="Basket name" text="Choose a name that describes what you want to practice, such as First ETF basket."><input placeholder="Name your basket" value={newName} onChange={(e) => setNewName(e.target.value)} required maxLength={70} /></HelpField>
          <HelpField label="Starting paper money (₹)" text="The virtual rupee balance your practice basket starts with. Paper buys spend it and paper sells return virtual proceeds."><input type="number" min=".01" step=".01" value={capital} onChange={(e) => setCapital(e.target.value)} required /></HelpField>
          <button className="button button-primary" type="submit" disabled={busy || !newName.trim()}><Plus size={16} />Create basket</button>
        </form>
        {entries.map((entry) => <button className={`collection-choice ${selected === entry.id ? 'collection-selected' : ''}`} key={entry.id} onClick={() => setSelected(entry.id)}>
          <Boxes size={16} /><span>{entry.name}</span><small>{entry.fills} trades</small>
        </button>)}
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>
      {basket?.id === selected && basket ? <Details key={selected} initial={basket} onFind={onFind} save={save} onResearch={onResearch} /> :
        <section className="panel empty-list"><Boxes size={24} /><p>{selected ? 'Loading basket…' : 'Create a basket to group investments and practice trading them.'}</p></section>}
    </div>
    <PopularSmallcases catalogue={popular} />
  </div>;
}
