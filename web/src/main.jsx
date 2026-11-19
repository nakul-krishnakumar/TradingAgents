import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, Bookmark, Boxes, CalendarDays, ChartCandlestick, ChartNoAxesCombined, CircleHelp, Database, FlaskConical, History,
  LayoutDashboard, ListFilter, LoaderCircle, Plus, Search, X,
} from 'lucide-react';
import { Dialog } from 'radix-ui';
import { AssetMark, MarketPanel, ResearchPanel } from './Workspace';
import { Screener, WishlistDialog, Wishlists, post } from './Discovery';
import { BacktestForm, DecisionMemory, RunDetail, RunList } from './Runs';
import { api, dateLabel, makeUrl, openJob, todayIST, typeLabel } from './api';
import '@fontsource-variable/inter';
import './styles.css';

const Baskets = lazy(() => import('./Baskets').then((module) => ({ default: module.Baskets })));
const MarketTrends = lazy(() => import('./MarketTrends').then((module) => ({ default: module.MarketTrends })));
const DailyTrading = lazy(() => import('./DailyTrading').then((module) => ({ default: module.DailyTrading })));

const first = { symbol: 'RELIANCE.NS', name: 'Reliance Industries', kind: 'stock', exchange: 'NSE' };
const VIEWS = {
  workspace: { label: 'Workspace', icon: LayoutDashboard, title: 'Research workspace', description: 'Explore market trends and put the agent team to work.' },
  daily: { label: 'Daily trading', icon: ChartCandlestick, description: 'Follow the session watchlist, intraday setups, and risk for your daily budget.' },
  screener: { label: 'Screener', icon: ListFilter, description: 'Find instruments by sector, category, financials, returns, and risk.' },
  trends: { label: 'Market trends', icon: Activity, description: 'See market breadth, the most traded listings, NAV movers, and sentiment.' },
  wishlists: { label: 'Wishlists', icon: Bookmark, description: 'Save stocks, funds, bonds, and other instruments into your own lists.' },
  baskets: { label: 'Paper baskets', icon: Boxes, description: 'Create a weighted basket and practice simulated trading.' },
  runs: { label: 'Research runs', icon: History, description: 'Follow the team’s progress and revisit completed research.' },
  backtests: { label: 'Backtests', icon: FlaskConical, description: 'Evaluate historical decisions across instruments and dates.' },
};

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function currentView() {
  const hash = window.location.hash.slice(1);
  return hash in VIEWS ? hash : 'workspace';
}

function AssetSearch({ open, setOpen, onSelect, watchlist }) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('all');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !query.trim()) { setResult(null); setError(''); setLoading(false); return undefined; }
    const controller = new AbortController();
    setResult(null);
    setLoading(true);
    setError('');
    const timer = window.setTimeout(() => {
      api(makeUrl('/api/search', { q: query.trim(), mode }), { signal: controller.signal })
        .then(setResult)
        .catch((err) => { if (err.name !== 'AbortError') setError(err.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 280);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query, mode, open]);

  const matchesMode = (asset) => mode === 'all'
    || mode === 'funds' && asset.kind === 'fund'
    || mode === 'bonds' && asset.kind === 'bond'
    || mode === 'listed' && asset.kind !== 'fund';
  const choices = query.trim() ? result?.results || [] : watchlist.filter(matchesMode);
  function choose(asset) {
    onSelect(asset);
    setOpen(false);
    setQuery('');
  }

  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="search-dialog">
        <Dialog.Title>Find an instrument</Dialog.Title>
        <Dialog.Description>Search by company, ticker, fund name, AMFI scheme code, or bond ISIN.</Dialog.Description>
        <div className="search-input"><Search size={20} />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Reliance, NIFTYBEES.NS, Parag Parikh…" maxLength={100}
            onKeyDown={(event) => { if (event.key === 'Enter' && choices.length) choose(choices[0]); }} />
          {loading && <LoaderCircle className="spin" size={17} />}
        </div>
        <Dialog.Close className="icon-button dialog-close" aria-label="Close search"><X size={19} /></Dialog.Close>
        <div className="segmented search-modes" aria-label="Instrument category">
          {[['all', 'All'], ['listed', 'Exchange listed'], ['funds', 'Mutual funds'], ['bonds', 'Bonds']].map(([key, label]) => <button key={key} aria-pressed={mode === key} onClick={() => setMode(key)}>{label}</button>)}
        </div>
        <div className="search-results">
          {choices.map((asset) => <button className="search-result" key={asset.symbol} onClick={() => choose(asset)}>
            <AssetMark asset={asset} />
            <span className="search-result-name"><strong>{asset.name}</strong><small>{asset.symbol} · {asset.exchange}</small></span>
            <span className="asset-type">{typeLabel[asset.kind]}</span>
          </button>)}
          {!choices.length && !loading && <p className="inline-note">{error || (query.trim() ? 'No matches. Try an exchange suffix such as .NS or a scheme code.' : 'Search for an instrument to add.')}</p>}
          {result?.unavailable?.length > 0 && <p className="inline-note">Temporarily unavailable: {result.unavailable.join(', ')}.</p>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function Sidebar({ view, watchlist, asset, settings, onNavigate, onSearch, onSelect }) {
  return <aside className="sidebar">
    <div className="sidebar-brand">
      <div className="brand-icon"><ChartNoAxesCombined size={23} strokeWidth={2.4} /></div>
      <div><strong>Market Desk</strong><span>TradingAgents</span></div>
    </div>
    <nav className="navigation" aria-label="Main navigation">
      {Object.entries(VIEWS).map(([id, { label, icon: Icon }]) =>
        <button key={id} className={view === id ? 'nav-active' : ''} aria-current={view === id ? 'page' : undefined}
          onClick={() => onNavigate(id)}><Icon size={18} />{label}</button>)}
    </nav>
    <div className="watchlist">
      <div className="watchlist-title"><h2>Watchlist</h2><button className="icon-button" title="Find an instrument" aria-label="Find an instrument" onClick={onSearch}><Plus size={17} /></button></div>
      {watchlist.map((item) => <button key={item.symbol} className={`watch-item ${item.symbol === asset.symbol ? 'watch-active' : ''}`}
        title={item.name} onClick={() => onSelect(item)}>
        <AssetMark asset={item} />
        <span><strong>{item.symbol}</strong><small>{item.name}</small></span>
        <span className="watch-kind">{item.kind === 'fund' ? 'MF' : item.kind === 'etf' ? 'ETF' : item.exchange}</span>
      </button>)}
      {!watchlist.length && <p className="watch-empty">Pin an instrument to add it here.</p>}
    </div>
    <div className="sidebar-footer">
      <div className="provider-title"><Database size={15} /><span>Model routing</span></div>
      <div className="provider-slots">
        {['quick', 'deep'].map((tier) => {
          const provider = settings?.providers?.[tier];
          return <div className="provider-row" key={tier} title={provider?.model || ''}>
            <span className={`provider-dot ${provider?.ready ? 'ready' : ''}`} />
            <span>{tier === 'quick' ? 'Analysts & debate' : 'Managers'}<strong>{provider?.provider || 'Connecting…'}</strong></span>
          </div>;
        })}
      </div>
    </div>
  </aside>;
}

function App() {
  const [view, setView] = useState(currentView);
  const [asset, setAsset] = useState(() => readLocal('market-desk:active', first));
  const [chart, setChart] = useState(null);
  const [marketError, setMarketError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [analysisDate, setAnalysisDate] = useState(todayIST);
  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState('');
  const [watchlist, setWatchlist] = useState(() => readLocal('market-desk:watchlist', null));
  const [jobs, setJobs] = useState([]);
  const [library, setLibrary] = useState([]);
  const [selectedJob, setSelectedJob] = useState(null);
  const [imported, setImported] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchAction = useRef(null);
  const [wishlists, setWishlists] = useState([]);
  const [wishlistAsset, setWishlistAsset] = useState(null);
  const [screenFocus, setScreenFocus] = useState('');
  const viewInfo = VIEWS[view];
  const today = settings?.today || todayIST();

  useEffect(() => {
    const changeView = () => setView(currentView());
    window.addEventListener('hashchange', changeView);
    return () => window.removeEventListener('hashchange', changeView);
  }, []);

  useEffect(() => {
    api('/api/settings').then(setSettings).catch((err) => setSettingsError(err.message));
    api('/api/library').then(setLibrary).catch(() => {});
    api('/api/wishlists').then(setWishlists).catch(() => {});
    const refreshJobs = () => api('/api/jobs').then(setJobs).catch(() => {});
    refreshJobs();
    const timer = window.setInterval(refreshJobs, 1800);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleKeyboard = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchAction.current = null;
        setSearchOpen((previous) => !previous);
      }
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, []);

  useEffect(() => {
    if (view !== 'workspace') return undefined;
    const controller = new AbortController();
    setChart(null);
    setMarketError('');
    api(makeUrl('/api/chart', { symbol: asset.symbol, kind: asset.kind, date: analysisDate }), { signal: controller.signal })
      .then(setChart).catch((err) => { if (err.name !== 'AbortError') setMarketError(err.message); });
    return () => controller.abort();
  }, [asset.symbol, asset.kind, analysisDate, refresh, view]);

  function navigate(next) {
    window.location.hash = next;
    setView(next);
    window.scrollTo(0, 0);
  }

  function selectAsset(next) {
    if (next.kind === 'bond') {
      setScreenFocus(next.symbol);
      navigate('screener');
      return;
    }
    setAsset(next);
    localStorage.setItem('market-desk:active', JSON.stringify(next));
    navigate('workspace');
  }

  function findAsset(action = null) {
    searchAction.current = action;
    setSearchOpen(true);
  }

  function pickAsset(next) {
    const action = searchAction.current;
    searchAction.current = null;
    if (action) action(next);
    else selectAsset(next);
  }

  async function createWishlist(name) {
    const list = await post('/api/wishlists', { name });
    setWishlists((previous) => [...previous, list].sort((a, b) => a.name.localeCompare(b.name)));
    return list;
  }

  async function updateWishlist(identifier, item, included) {
    const list = await post(`/api/wishlists/${identifier}/assets`, { asset: item, included });
    setWishlists((previous) => previous.map((old) => old.id === identifier ? list : old));
  }

  async function removeWishlist(identifier) {
    await api(`/api/wishlists/${identifier}`, { method: 'DELETE' });
    setWishlists((previous) => previous.filter((list) => list.id !== identifier));
  }

  const watched = watchlist || settings?.watchlist || [first];
  const pinned = watched.some(({ symbol }) => symbol === asset.symbol);

  function togglePin() {
    const next = pinned ? watched.filter(({ symbol }) => symbol !== asset.symbol) : [...watched, asset];
    setWatchlist(next);
    localStorage.setItem('market-desk:watchlist', JSON.stringify(next));
  }

  function openRun(id) {
    setSelectedJob(id);
    setImported(null);
    navigate('runs');
  }

  function openImport(id) {
    setImported(id);
    setSelectedJob(null);
    navigate('runs');
  }

  function startJob(job) {
    setJobs((previous) => [job, ...previous.filter(({ id }) => id !== job.id)]);
    openRun(job.id);
  }

  const recentResearch = jobs.find((job) => job.type === 'research' && job.params.symbol === asset.symbol);
  const job = jobs.find(({ id }) => id === selectedJob) || (!imported ? jobs[0] : null);
  const active = jobs.filter(openJob).length;
  const providersReady = settings && Object.values(settings.providers).every(({ ready }) => ready);

  return <div className="app-shell">
    <Sidebar view={view} settings={settings} asset={asset} watchlist={watched} onSearch={() => findAsset()}
      onSelect={selectAsset} onNavigate={navigate} />
    <div className="app-content">
      <header className="topbar">
        <button className="global-search" onClick={() => findAsset()} aria-label="Search instruments">
          <Search size={19} /><span>Search stocks, ETFs, mutual funds…</span><kbd>Ctrl K</kbd>
        </button>
        <div className="topbar-meta">
          <span className="topbar-date"><CalendarDays size={16} />{dateLabel(today)}</span>
          <span className="topbar-status" title={settingsError || 'Model provider configuration'}><i className={providersReady ? 'ready' : ''} />{active ? `${active} active` : providersReady ? 'Providers ready' : 'Local workspace'}</span>
        </div>
      </header>
      <main>
        <div className="page-heading">
          <div><h1>{viewInfo.title || viewInfo.label}</h1><p>{viewInfo.description}</p></div>
          <span className="workspace-market"><span />{view !== 'workspace' || ['NSE', 'BSE', 'AMFI'].includes(asset.exchange) ? 'India markets' : asset.exchange}</span>
        </div>
        {settingsError && <p className="form-error" role="alert">Could not load workspace settings. {settingsError}</p>}
        {view === 'workspace' && <>
          <div className="workspace-grid">
            <MarketPanel key={`chart:${asset.symbol}`} asset={asset} chart={chart?.symbol === asset.symbol && chart.as_of === analysisDate ? chart : null}
              marketError={marketError} loading={!chart && !marketError} pinned={pinned} onPin={togglePin} onSave={() => setWishlistAsset(asset)} onRetry={() => setRefresh(refresh + 1)} />
            <ResearchPanel key={`research:${asset.symbol}`} asset={asset} today={today} date={analysisDate} setDate={setAnalysisDate} providers={settings?.providers} job={recentResearch} onJob={startJob} onOpen={openRun} />
          </div>
          <RunList jobs={jobs} library={library} onOpen={openRun} onImport={openImport} compact />
        </>}
        {view === 'screener' && <Screener key={screenFocus} initialFocus={screenFocus} onResearch={selectAsset} onSave={setWishlistAsset} />}
        {view === 'wishlists' && <Wishlists wishlists={wishlists} onCreate={createWishlist} onModify={updateWishlist}
          onDelete={removeWishlist} onFind={findAsset} onResearch={selectAsset} />}
        <Suspense fallback={<p className="inline-note" role="status">Loading workspace…</p>}>
          {view === 'baskets' && <Baskets onFind={findAsset} onResearch={selectAsset} />}
          {view === 'trends' && <MarketTrends onFind={findAsset} onResearch={selectAsset} />}
          {view === 'daily' && <DailyTrading onResearch={selectAsset} />}
        </Suspense>
        {view === 'runs' && <>
          <RunList jobs={jobs} library={library} onOpen={openRun} onImport={openImport} />
          <RunDetail job={job} imported={imported} />
          <DecisionMemory />
        </>}
        {view === 'backtests' && <div className="backtest-grid">
          <BacktestForm asset={asset} today={today} onJob={startJob} />
          <RunList jobs={jobs.filter(({ type }) => type === 'backtest')} library={[]} onOpen={openRun} />
        </div>}
        <footer className="workspace-footer"><CircleHelp size={14} />Research workspace · India Standard Time</footer>
      </main>
    </div>
    <AssetSearch open={searchOpen} setOpen={(open) => { if (!open) searchAction.current = null; setSearchOpen(open); }}
      onSelect={pickAsset} watchlist={watched} />
    <WishlistDialog asset={wishlistAsset} close={() => setWishlistAsset(null)} wishlists={wishlists}
      onCreate={createWishlist} onModify={updateWishlist} />
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
