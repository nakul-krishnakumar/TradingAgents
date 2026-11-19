import { useEffect, useState } from 'react';
import { Bookmark, Info, ListFilter, LoaderCircle, Plus, Search, Settings2, Trash2, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { AssetMark } from './Workspace';
import { api, dateLabel, money, number, signed, tone, typeLabel } from './api';

export const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
const crore = 10000000;
const croreKeys = new Set([
  'turnover', 'market_cap', 'ev', 'net_income', 'revenue', 'gross_profit', 'ebitda',
  'total_debt', 'total_cash', 'free_cash', 'operating_cash', 'assets',
]);
const classes = [
  ['stock', 'Stocks'], ['etf', 'ETFs'], ['fund', 'Mutual funds'],
  ['bond', 'Bonds'], ['other', 'Other'], ['all', 'All assets'],
];
const defaults = {
  stock: ['price', 'change', 'turnover', 'pe', 'net_income'],
  etf: ['price', 'change', 'nav', 'turnover', 'return_1y'],
  fund: ['price', 'return_1m', 'return_1y', 'expense', 'assets'],
  bond: ['price', 'coupon', 'years_left', 'face_value', 'turnover'],
  other: ['price', 'change', 'turnover', 'return_1y'],
  all: ['price', 'change', 'turnover', 'return_1y'],
};
const presets = {
  stock: [
    ['Profitable', 'net_income', '0.0000001', ''], ['Loss-making', 'net_income', '', '-0.0000001'],
    ['Positive 1Y return', 'return_1y', '0.01', ''],
  ],
  fund: [['Low expenses', 'expense', '', '0.5'], ['Positive 1Y return', 'return_1y', '0.01', '']],
  etf: [['High turnover', 'turnover', '1', ''], ['Low expenses', 'expense', '', '0.5']],
  bond: [['Matures within 3 years', 'years_left', '0', '3'], ['Coupon 8% or more', 'coupon', '8', '']],
};

function emptyForm(kind = 'stock') {
  return { kind, query: '', sector: '', category: '', exchange: '', issuer: '', plan: '', option: '', rating: '', frequency: '',
    filters: [], sort: kind === 'fund' || kind === 'bond' ? 'name' : 'turnover', descending: kind !== 'fund' && kind !== 'bond', offset: 0 };
}

function screenParams(request) {
  return { ...request, filters: request.filters.filter((filter) => filter.min !== '' || filter.max !== '').map((filter) => {
    const scale = croreKeys.has(filter.key) ? crore : 1;
    return { key: filter.key, minimum: filter.min === '' ? null : Number(filter.min) * scale,
      maximum: filter.max === '' ? null : Number(filter.max) * scale };
  }) };
}

function formatted(axis, value) {
  if (!Number.isFinite(value)) return '—';
  if (croreKeys.has(axis.key)) return number(value / crore);
  if (axis.unit === '%') return axis.key === 'change' || axis.key.startsWith('return_') ? signed(value) : `${number(value)}%`;
  if (axis.unit === '₹') return money(value, 'INR');
  if (axis.unit === '×') return `${number(value)}×`;
  return number(value, ['volume', 'trades', 'lot'].includes(axis.key) ? 0 : 2);
}
const unit = (axis) => croreKeys.has(axis.key) ? '₹ cr' : axis.unit;

function rowDescription(row) {
  return [...new Set([row.exchange, row.category, row.sector || row.issuer].filter(Boolean))].join(' · ');
}

export function AssetIdentity({ asset }) {
  return <span className="discovery-asset"><AssetMark asset={asset} /><span>
    <strong>{asset.name}</strong><small>{asset.symbol}{asset.exchange ? ` · ${asset.exchange}` : ''}</small>
  </span></span>;
}

function Facet({ field, label, request, options, change }) {
  if (!options?.length) return null;
  return <label>{label}<select value={request[field]} onChange={(event) => change(field, event.target.value)}>
    <option value="">Any {label.toLowerCase()}</option>
    {options.map((value) => <option key={value}>{value}</option>)}
  </select></label>;
}

function MarketDetails({ asset, open, setOpen, axes, onResearch, onSave }) {
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="search-dialog instrument-dialog">
        {asset && <>
          <Dialog.Title>{asset.name}</Dialog.Title>
          <Dialog.Description>{asset.symbol} · {rowDescription(asset)}</Dialog.Description>
          <Dialog.Close className="icon-button dialog-close" aria-label="Close instrument details"><X size={19} /></Dialog.Close>
          <div className="instrument-detail-body">
            <dl className="source-grid">
              {asset.isin && <div><dt>ISIN</dt><dd>{asset.isin}</dd></div>}
              {asset.underlying && <div><dt>Underlying</dt><dd>{asset.underlying}</dd></div>}
              {asset.maturity && <div><dt>Maturity</dt><dd>{dateLabel(asset.maturity)}</dd></div>}
              {asset.rating_report && <div><dt>Reported rating</dt><dd><a href={asset.terms_link} target="_blank" rel="noreferrer">{asset.rating_report}</a></dd></div>}
              {asset.frequency && <div><dt>Interest frequency</dt><dd>{asset.frequency}</dd></div>}
              {asset.listed && <div><dt>Listed</dt><dd>{dateLabel(asset.listed)}</dd></div>}
              {asset.observed && <div><dt>Price date</dt><dd>{dateLabel(asset.observed)}</dd></div>}
              {asset.nav_date && <div><dt>ETF NAV date</dt><dd>{dateLabel(asset.nav_date)}</dd></div>}
              {asset.expense_date && <div><dt>Expense ratio date</dt><dd><a href={asset.expense_link} target="_blank" rel="noreferrer">{dateLabel(asset.expense_date)}</a></dd></div>}
              {asset.financial_period && <div><dt>Latest reported quarter</dt><dd>{dateLabel(asset.financial_period)}</dd></div>}
              {asset.plan && <div><dt>Plan</dt><dd>{asset.plan}</dd></div>}
              {asset.option && <div><dt>Option</dt><dd>{asset.option}</dd></div>}
            </dl>
            <dl className="source-grid snapshot-metrics">
              {axes.filter((axis) => Number.isFinite(asset.metrics[axis.key])).map((axis) => <div key={axis.key}>
                <dt>{axis.label}{unit(axis) === '₹ cr' && ' (₹ cr)'}</dt><dd>{formatted(axis, asset.metrics[axis.key])}</dd>
              </div>)}
            </dl>
            <p className="inline-note"><a href={asset.link} target="_blank" rel="noreferrer">{asset.source}</a>{asset.price_source && ` · ${asset.price_source}`}{asset.profile_sources?.length > 0 && ` · ${asset.profile_sources.join(' · ')}`}</p>
          </div>
          <div className="form-actions">
            <button type="button" className="button button-outline" onClick={() => { setOpen(false); onSave(asset); }}><Bookmark size={15} />Save to wishlist</button>
            {asset.kind !== 'bond' && <button type="button" className="button button-primary" onClick={() => { setOpen(false); onResearch(asset); }}>Research instrument</button>}
          </div>
        </>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function Screener({ initialFocus = '', onResearch, onSave }) {
  const initial = () => ({ ...emptyForm(initialFocus ? 'bond' : 'stock'), query: initialFocus });
  const [draft, setDraft] = useState(initial);
  const [active, setActive] = useState(initial);
  const [response, setResponse] = useState(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [fields, setFields] = useState(initialFocus ? defaults.bond : defaults.stock);
  const [busy, setBusy] = useState(false);
  const [enriching, setEnriching] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [newAxis, setNewAxis] = useState('');
  const [error, setError] = useState('');
  const [update, setUpdate] = useState('');
  const [details, setDetails] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const axes = (response?.axes || []).filter((axis) => draft.kind === 'all' || axis.kinds.includes(draft.kind));
  const columns = fields.map((key) => axes.find((axis) => axis.key === key)).filter(Boolean);
  const facets = response?.options || {};
  const set = (name, value) => setDraft((prev) => ({ ...prev, [name]: value }));

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    api('/api/screener', { method: 'POST', body: JSON.stringify(screenParams(active)), signal: controller.signal })
      .then(setResponse)
      .catch((err) => { if (!controller.signal.aborted) setError(err.message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [active, refresh]);

  function chooseKind(kind) {
    const form = emptyForm(kind);
    setDraft(form);
    setActive(form);
    setFields(defaults[kind]);
    setNewAxis('');
    setResponse(null);
    setUpdate('');
  }

  function apply(event) {
    event?.preventDefault();
    setUpdate('');
    setActive({ ...draft, offset: 0 });
  }

  function changeLimit(key, side, value) {
    set('filters', draft.filters.map((filter) => filter.key === key ? { ...filter, [side]: value } : filter));
  }

  function addFilter(key, min = '', max = '', useNow = false) {
    const filters = [...draft.filters.filter((filter) => filter.key !== key), { key, min, max }];
    const next = { ...draft, filters, offset: 0 };
    setDraft(next);
    setNewAxis('');
    setFilterOpen(true);
    if (useNow) setActive(next);
  }

  async function enrich(assets) {
    if (!assets?.length) return;
    setEnriching(true);
    setUpdate('');
    setError('');
    try {
      const result = await post('/api/screener/enrich', { assets: assets.slice(0, 15) });
      setUpdate(`Loaded ${result.loaded.length} profile${result.loaded.length === 1 ? '' : 's'}${result.unavailable.length ? ` · ${result.unavailable.length} unavailable` : ''}.`);
      setRefresh((old) => old + 1);
    } catch (err) { setError(err.message); }
    finally { setEnriching(false); }
  }

  const page = Math.floor(active.offset / 25) + 1;
  const pages = Math.max(1, Math.ceil((response?.total || 0) / 25));
  const activeFilters = active.filters.filter((filter) => filter.min !== '' || filter.max !== '');

  return <div className="discovery-wrap">
    <section className="panel discovery-filter">
      <div className="segmented screen-kinds" aria-label="Asset class">
        {classes.map(([key, label]) => <button type="button" key={key} aria-pressed={draft.kind === key} onClick={() => chooseKind(key)}>{label}</button>)}
      </div>
      <form onSubmit={apply} autoComplete="off">
        <div className="screen-query-row">
          <label className="screen-query"><Search size={17} /><input aria-label="Search screener" value={draft.query} onChange={(e) => set('query', e.target.value)} placeholder="Search instrument, ISIN, or issuer" /></label>
          <label className="screen-sort"><span>Sort by</span>
            <select aria-label="Sort by" value={draft.sort} onChange={(e) => set('sort', e.target.value)}>
              <option value="name">Instrument name</option>{axes.map((axis) => <option key={axis.key} value={axis.key}>{axis.label}</option>)}
            </select>
          </label>
          <select aria-label="Sort direction" value={draft.descending ? 'desc' : 'asc'} onChange={(e) => set('descending', e.target.value === 'desc')}>
            <option value="desc">Descending</option><option value="asc">Ascending</option>
          </select>
          <button className="button button-outline" type="button" aria-expanded={filterOpen} onClick={() => setFilterOpen(!filterOpen)}><ListFilter size={16} />Filters{activeFilters.length ? ` (${activeFilters.length})` : ''}</button>
          <button className="button button-primary" type="submit">Apply</button>
        </div>
        {presets[draft.kind] && <div className="screen-presets">
          {presets[draft.kind].map(([label, key, min, max]) => <button className="button button-small button-outline" type="button" key={label} onClick={() => addFilter(key, min, max, true)}>{label}</button>)}
        </div>}
        {filterOpen && <div className="screen-filter-body">
          <div className="screen-facets">
            {Object.entries({ sector: 'Sector', category: 'Category', issuer: 'Issuer', exchange: 'Exchange', plan: 'Plan', option: 'Option', rating: 'Reported credit rating', frequency: 'Interest frequency' }).map(([field, label]) =>
              <Facet key={field} field={field} label={label} request={draft} options={facets[field]} change={set} />)}
          </div>
          <div className="axis-filters">
            {draft.filters.map((filter) => {
              const axis = axes.find((item) => item.key === filter.key);
              if (!axis) return null;
              const covered = response?.coverage?.[filter.key];
              return <div className="axis-row" key={filter.key}>
              <div><strong>{axis.label}</strong> {unit(axis) && <small>{unit(axis)}</small>}
                  {Number.isFinite(covered) && <small className="axis-cover">{number(covered, 0)} amounts available</small>}
                </div>
                <input type="number" step="any" placeholder="Min" aria-label={`${axis.label} minimum`} value={filter.min} onChange={(e) => changeLimit(filter.key, 'min', e.target.value)} />
                <input type="number" step="any" placeholder="Max" aria-label={`${axis.label} maximum`} value={filter.max} onChange={(e) => changeLimit(filter.key, 'max', e.target.value)} />
                <button className="icon-button" type="button" aria-label={`Remove ${axis.label} filter`} onClick={() => set('filters', draft.filters.filter((item) => item.key !== filter.key))}><X size={16} /></button>
              </div>;
            })}
          </div>
          <div className="form-actions axis-add">
            <select aria-label="Choose metric filter" value={newAxis} onChange={(e) => setNewAxis(e.target.value)}>
              <option value="">Choose a metric</option>
              {[...new Set(axes.map((axis) => axis.group))].map((group) => <optgroup key={group} label={group}>
                {axes.filter((axis) => axis.group === group && !draft.filters.some((filter) => filter.key === axis.key)).map((axis) =>
                  <option key={axis.key} value={axis.key}>{axis.label}{unit(axis) ? ` (${unit(axis)})` : ''}</option>)}
              </optgroup>)}
            </select>
            <button className="button button-outline" type="button" disabled={!newAxis} onClick={() => addFilter(newAxis)}><Plus size={16} />Add filter</button>
            <button className="button button-outline" type="button" onClick={() => chooseKind(draft.kind)}>Clear filters</button>
          </div>
        </div>}
      </form>
    </section>

    <section className="panel discovery-results">
      <div className="discovery-toolbar">
        <div>
          <h2>{response ? `${number(response.total, 0)} instruments` : 'Results'}</h2>
          {response && <p>{number(response.scope_count, 0)} in scope{response.session ? ` · NSE final prices ${dateLabel(response.session, false)}` : ''}{response.enriched > 0 ? ` · ${response.enriched} enriched profiles` : ''}</p>}
        </div>
        <div className="form-actions">
          {axes.length > 0 && <details className="columns-menu">
            <summary className="button button-small button-outline"><Settings2 size={15} />Columns</summary>
            <div>{axes.map((axis) => <label className="check-line" key={axis.key}><input type="checkbox" checked={fields.includes(axis.key)}
              onChange={(e) => setFields(e.target.checked ? [...fields, axis.key] : fields.filter((key) => key !== axis.key))} />{axis.label}</label>)}</div>
          </details>}
          {response?.enrichment_candidates?.length > 0 && <button className="button button-small button-outline" type="button" disabled={enriching}
            onClick={() => enrich(response.enrichment_candidates)}>{enriching && <LoaderCircle size={15} className="spin" />}Load more metrics</button>}
        </div>
      </div>
      {error && <p className="form-error discovery-message" role="alert">{error}</p>}
      {update && <p className="inline-note discovery-message" role="status">{update}</p>}
      {response?.unavailable?.length > 0 && <p className="inline-note discovery-message">Feed gaps · {response.unavailable.join(', ')}</p>}
      {response?.profit_range_match_count > 0 && <p className="inline-note discovery-message"><a href="https://finance.yahoo.com/research-hub/screener/" target="_blank" rel="noreferrer">Yahoo Finance</a> matched {number(response.profit_range_match_count, 0)} additional stocks to your net-income range. Load company profiles to see their reported amounts.</p>}
      {busy && <p className="inline-note discovery-message" role="status">Loading instrument data…</p>}
      {response && !response.total && !busy && <p className="inline-note discovery-message">No instruments match. Numeric filters require a published or loaded value.</p>}
      {response?.rows?.length > 0 && <div className="table-scroll discovery-table">
        <table><thead><tr>
          <th>Instrument</th><th>Category</th>
          {columns.map((axis) => <th key={axis.key}><button className="sort-heading" type="button" onClick={() => {
            const next = { ...active, sort: axis.key, descending: active.sort === axis.key ? !active.descending : true, offset: 0 };
            setActive(next);
            setDraft((prev) => ({ ...prev, sort: next.sort, descending: next.descending }));
          }}>{axis.label}{unit(axis) && ` (${unit(axis)})`}</button></th>)}
          <th>Actions</th>
        </tr></thead>
        <tbody>{response.rows.map((row) => <tr key={row.symbol}>
          <td><button className="asset-table-button" onClick={() => { setDetails(row); setDetailsOpen(true); }}><AssetIdentity asset={row} /></button></td>
          <td className="category-cell">{row.category || row.sector || typeLabel[row.kind]}{row.plan && <small>{row.plan}{row.option && ` · ${row.option}`}</small>}{row.rating && <small>{row.rating} · NSDL</small>}</td>
          {columns.map((axis) => <td key={axis.key} className={`number-cell ${axis.key === 'change' || axis.key.startsWith('return_') ? tone(row.metrics[axis.key]) : ''}`}>
            {axis.key === 'net_income' && row.profit_range_match ? <span title="Yahoo Finance confirms this stock matches your range">In range</span> : formatted(axis, row.metrics[axis.key])}
          </td>)}
          <td><button className="icon-button" type="button" aria-label={`Save ${row.symbol} to wishlist`} title="Save to wishlist" onClick={() => onSave(row)}><Bookmark size={16} /></button></td>
        </tr>)}</tbody></table>
      </div>}
      {response && <div className="discovery-pagination">
        <p className="inline-note"><Info size={14} /> NSE price returns use unadjusted closes. Loaded profiles can provide adjusted returns and published NAV history. A dash marks a missing value.</p>
        {pages > 1 && <div className="form-actions">
          <button className="button button-small button-outline" disabled={busy || page <= 1} onClick={() => setActive({ ...active, offset: active.offset - 25 })}>Previous</button>
          <span>{page} / {pages}</span>
          <button className="button button-small button-outline" disabled={busy || page >= pages} onClick={() => setActive({ ...active, offset: active.offset + 25 })}>Next</button>
        </div>}
      </div>}
    </section>
    <MarketDetails asset={details} open={detailsOpen} setOpen={setDetailsOpen} axes={axes} onResearch={onResearch} onSave={onSave} />
  </div>;
}

export function WishlistDialog({ asset, close, wishlists, onCreate, onModify }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function modify(list, included) {
    setBusy(true);
    setError('');
    try { await onModify(list.id, asset, included); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const item = await onCreate(name);
      await onModify(item.id, asset, true);
      setName('');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <Dialog.Root open={Boolean(asset)} onOpenChange={(open) => { if (!open) close(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="search-dialog wishlist-dialog">
        <Dialog.Title>Save to wishlists</Dialog.Title>
        <Dialog.Description>{asset?.name}</Dialog.Description>
        <Dialog.Close className="icon-button dialog-close" aria-label="Close wishlist dialog"><X size={19} /></Dialog.Close>
        <div className="wishlist-choices">
          {wishlists.map((list) => <label className="check-line" key={list.id}>
            <input type="checkbox" disabled={busy} checked={list.assets.some((item) => item.symbol === asset?.symbol)}
              onChange={(e) => modify(list, e.target.checked)} />{list.name}
          </label>)}
        </div>
        <form className="form-actions" onSubmit={create}>
          <input aria-label="New wishlist name" placeholder="New wishlist name" required maxLength={70} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="button button-primary" disabled={busy || !name.trim()} type="submit"><Plus size={15} />Create and save</button>
        </form>
        {error && <p className="form-error" role="alert">{error}</p>}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function Wishlists({ wishlists, onCreate, onModify, onDelete, onFind, onResearch }) {
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const active = wishlists.find((item) => item.id === selected) || wishlists[0];
  async function create(event) {
    event.preventDefault();
    setError('');
    try {
      const item = await onCreate(name);
      setSelected(item.id);
      setName('');
    } catch (err) { setError(err.message); }
  }
  async function perform(action) {
    setError('');
    try { await action(); } catch (err) { setError(err.message); }
  }
  return <div className="collections-grid">
    <section className="panel collection-sidebar">
      <h2>Your wishlists</h2>
      <form className="form-actions" onSubmit={create}>
        <input aria-label="Wishlist name" placeholder="Name a wishlist" value={name}
          onChange={(e) => setName(e.target.value)} maxLength={70} required />
        <button className="button button-primary" type="submit" disabled={!name.trim()}>Create</button>
      </form>
      {wishlists.map((list) => <button key={list.id} className={`collection-choice ${active?.id === list.id ? 'collection-selected' : ''}`} onClick={() => setSelected(list.id)}>
        <Bookmark size={16} /><span>{list.name}</span><small>{list.assets.length}</small>
      </button>)}
    </section>
    <section className="panel collection-content">
      <div className="collection-heading">
        <div><h2>{active?.name || 'Instruments'}</h2>{active && <p>{active.assets.length} saved</p>}</div>
        {active && <div className="form-actions">
          <button className="button button-outline" onClick={() => onFind((asset) => perform(() => onModify(active.id, asset, true)))}><Plus size={16} />Add instrument</button>
          <button className="icon-button" title="Delete wishlist" aria-label="Delete wishlist" onClick={() => {
            if (window.confirm(`Delete wishlist “${active.name}”?`)) perform(() => onDelete(active.id));
          }}><Trash2 size={16} /></button>
        </div>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!active && <div className="empty-list"><Bookmark size={22} /><p>Create a wishlist to start saving instruments.</p></div>}
      {active && !active.assets.length && <div className="empty-list"><Bookmark size={22} /><p>This wishlist is empty.</p></div>}
      {active?.assets.map((asset) => <div className="collection-item" key={asset.symbol}>
        <AssetIdentity asset={asset} /><span className="asset-type">{typeLabel[asset.kind]}</span>
        {asset.kind !== 'bond' && <button className="button button-small button-outline" onClick={() => onResearch(asset)}>Research</button>}
        <button className="icon-button" aria-label={`Remove ${asset.symbol}`} onClick={() => perform(() => onModify(active.id, asset, false))}><X size={16} /></button>
      </div>)}
    </section>
  </div>;
}
