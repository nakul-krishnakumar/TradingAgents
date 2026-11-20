import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, Bookmark, Boxes, CalendarDays, ChartCandlestick, ChartNoAxesCombined, ChevronDown, CircleHelp, Database, FlaskConical, History,
  LayoutDashboard, ListFilter, LoaderCircle, Plus, Search, Terminal, X,
} from 'lucide-react';
import { Dialog } from 'radix-ui';
import { AssetMark, MarketPanel, ResearchPanel } from './Workspace';
import { Help, HelpDetails, HelpTitle, WithHelp } from './Help';
import { Screener, WishlistDialog, Wishlists, post } from './Discovery';
import { BacktestForm, DecisionMemory, RunDetail, RunList } from './Runs';
import { api, dateLabel, makeUrl, openJob, todayIST, typeLabel } from './api';
import { startDiagnostics } from './telemetry';
import '@fontsource-variable/inter';
import './styles.css';

const Baskets = lazy(() => import('./Baskets').then((module) => ({ default: module.Baskets })));
const MarketTrends = lazy(() => import('./MarketTrends').then((module) => ({ default: module.MarketTrends })));
const DailyTrading = lazy(() => import('./DailyTrading').then((module) => ({ default: module.DailyTrading })));
const Diagnostics = lazy(() => import('./Diagnostics').then((module) => ({ default: module.Diagnostics })));

const first = { symbol: 'RELIANCE.NS', name: 'Reliance Industries', kind: 'stock', exchange: 'NSE' };
const VIEWS = {
  workspace: {
    label: 'Research', icon: LayoutDashboard, title: 'Research an investment',
    description: 'Pick a stock or fund, explore its prices, and ask a question.',
    help: 'Find an investment using the search bar. Review its chart, then ask a question such as “Why did this stock fall?” Start research to get a summary, evidence, and a detailed report.',
  },
  daily: {
    label: 'Daily Trading', icon: ChartCandlestick,
    description: 'See what Auto Trade checked, bought, sold, and earned with virtual money.',
    help: 'Watch the Indian trading day as it unfolds. Set a paper money limit and start Auto Trade to practice automatically. Open Market checks for decisions, BUY & SELL history for actual practice trades, or Past days to compare results.',
  },
  screener: {
    label: 'Find investments', icon: ListFilter,
    description: 'Filter stocks, ETFs, mutual funds, and bonds by the things you care about.',
    help: 'Choose an investment type and narrow the list by industry, price, profit, or other figures. For example, pick Stocks and then Profitable. Click an investment to see more information, research it, or save it.',
  },
  trends: {
    label: 'Market trends', icon: Activity,
    description: 'See which prices are moving, what people are trading, and what they’re saying.',
    help: 'Get a market-wide view before looking at individual investments. Compare rising and falling prices, activity across industries, mutual fund moves, company filings, and public opinions.',
  },
  wishlists: {
    label: 'Saved lists', icon: Bookmark,
    description: 'Keep stocks, funds, and bonds you want to revisit in your own lists.',
    help: 'Organise investments into lists such as “Funds to compare” or “Stocks to research”. You can add an investment from search or save it from Research or Find investments.',
  },
  baskets: {
    label: 'Practice portfolios', icon: Boxes,
    description: 'Build your own group of investments and practice buying and selling with virtual money.',
    help: 'Give a basket a name and a virtual starting balance. Decide how much you want in each investment, make paper buys or sells, and check how the portfolio is doing.',
  },
  runs: {
    label: 'Research history', icon: History,
    description: 'Follow research as it happens and read completed reports.',
    help: 'Click a research run or historical test to see its status and results. For research you can read the short summary, full report, and any available model activity.',
  },
  backtests: {
    label: 'Test past decisions', icon: FlaskConical,
    description: 'See whether research from earlier dates would have called the market direction correctly.',
    help: 'Choose investments and past dates. Market Desk makes a research call for each selected date and then compares the later price move with its market index. The results help you check how often the calls got that direction right.',
  },
  diagnostics: {
    label: 'Logs', icon: Terminal,
    description: 'See what happened and follow related events by ID.',
    help: 'Use this page when something seems slow, fails, or needs an explanation. Filter to warnings and errors or search by a stock or ID. Open an event to see its details and related requests, research runs, or checks.',
  },
};

function readLocal(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function currentView() {
  const hash = window.location.hash.slice(1);
  return Object.hasOwn(VIEWS, hash) ? hash : 'workspace';
}

function AssetSearch({ open, setOpen, onSelect, watchlist }) {
  const searchField = useRef(null);
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
      <Dialog.Content className="search-dialog" onOpenAutoFocus={(event) => {
        event.preventDefault();
        searchField.current?.focus({ preventScroll: true });
        searchField.current?.select();
      }}>
        <HelpTitle as={Dialog.Title} label="Find an investment" text="Type a company, fund name, or symbol such as RELIANCE.NS. Select a match to open it, or to add it to the list or basket you came from." />
        <Dialog.Description>Enter a company or fund name, stock symbol, fund code, or bond ID (ISIN).</Dialog.Description>
        <div className="search-input"><Search size={20} />
          <input ref={searchField} type="search" aria-label="Company, stock symbol, fund, or bond" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Reliance, NIFTYBEES, Parag Parikh…" maxLength={100}
            onKeyDown={(event) => { if (event.key === 'Enter' && choices.length) choose(choices[0]); }} />
          {loading && <LoaderCircle className="spin" size={17} />}
        </div>
        <Dialog.Close className="icon-button dialog-close" aria-label="Close search"><X size={19} /></Dialog.Close>
        <WithHelp label="Search categories" text="Use All to search across investment types. Exchange listed looks for investments traded on an exchange, such as stocks and ETFs. Mutual funds searches by scheme, and Bonds searches debt investments.">
          <span className="segmented search-modes" role="group" aria-label="Instrument category">
            {[['all', 'All'], ['listed', 'Exchange listed'], ['funds', 'Mutual funds'], ['bonds', 'Bonds']].map(([key, label]) => <button type="button" key={key} aria-pressed={mode === key} onClick={() => setMode(key)}>{label}</button>)}
          </span>
        </WithHelp>
        <div className="search-results">
          {choices.map((asset) => <button className="search-result" key={asset.symbol} onClick={() => choose(asset)}>
            <AssetMark asset={asset} />
            <span className="search-result-name"><strong>{asset.name}</strong><small>{asset.symbol} · {asset.exchange}</small></span>
            <span className="asset-type">{typeLabel[asset.kind]}</span>
          </button>)}
          {!choices.length && !loading && <p className="inline-note">{error || (query.trim() ? 'No matches. Try the full company or fund name.' : 'Type a name or symbol to search.')}</p>}
          {result?.unavailable?.length > 0 && <p className="inline-note">Temporarily unavailable: {result.unavailable.join(', ')}.</p>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function QuickGuide() {
  const title = useRef(null);
  return <Dialog.Root>
    <Dialog.Trigger className="button button-outline topbar-guide"><CircleHelp size={17} /><span>Quick guide</span></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="search-dialog quick-guide" onOpenAutoFocus={(event) => {
        event.preventDefault();
        title.current?.focus();
      }}>
        <HelpTitle as={Dialog.Title} ref={title} tabIndex={-1} label="Quick guide to Market Desk" text="Read short explanations of the terms that appear often in Market Desk. The circled question marks beside individual features give more information for that screen." />
        <Dialog.Description>Words you’ll see when researching and practicing trades.</Dialog.Description>
        <Dialog.Close className="icon-button dialog-close" aria-label="Close quick guide"><X size={19} /></Dialog.Close>
        <dl>
          <div><dt>Paper trading</dt><dd>A practice account with virtual money. A <strong>BUY</strong> adds shares to the account. A <strong>SELL</strong> removes shares and adds the proceeds to the account.</dd></div>
          <div><dt>Open and closed trades</dt><dd>An open trade still holds shares. Its gain or loss is an estimate using the last price available. A closed trade has sold those shares and recorded the result.</dd></div>
          <div><dt>Sell to limit loss or take profit</dt><dd>These are the planned prices for selling. If the price falls suddenly, the sale can happen at a worse price than planned.</dd></div>
          <div><dt>Market comparison (benchmark)</dt><dd>An index such as the Nifty 50 tracks a group of stocks. Comparing with an index shows how an investment did relative to that part of the market.</dd></div>
          <div><dt>Fund unit value (NAV)</dt><dd>The value of one unit of a fund, based on what it holds after expenses and liabilities.</dd></div>
        </dl>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function Sidebar({ view, watchlist, asset, settings, onNavigate, onSearch, onSelect }) {
  return <aside className="sidebar">
    <div className="sidebar-brand">
      <div className="brand-icon"><ChartNoAxesCombined size={23} strokeWidth={2.4} /></div>
      <div><WithHelp label="Market Desk" text="A workspace for researching Indian investments, watching the market, and practicing trades. Choose a page below or use Search to find an investment."><strong>Market Desk</strong></WithHelp><span>Indian markets</span></div>
    </div>
    <nav className="navigation" aria-label="Main navigation">
      {Object.entries(VIEWS).map(([id, { label, help, icon: Icon }]) => <div className="nav-row" key={id}>
        <button data-log={`navigate.${id}`} className={`nav-link${view === id ? ' nav-active' : ''}`} aria-current={view === id ? 'page' : undefined}
          onClick={() => onNavigate(id)}><Icon size={18} />{label}</button>
        <Help label={label} text={help} side="right" />
      </div>)}
      <div className="mobile-nav">
        <label className="mobile-page-picker">
          <span>Page</span>
          <select aria-label="Go to page" data-log="navigate.mobile" value={view} onChange={(event) => onNavigate(event.target.value)}>
            {Object.entries(VIEWS).map(([id, { label }]) => <option value={id} key={id}>{label}</option>)}
          </select>
          <ChevronDown size={16} aria-hidden="true" />
        </label>
        <Help label="Page menu" text="Tap the current page name to switch between Research, Daily Trading, and the other tools. Each page title has help specific to that page." />
      </div>
    </nav>
    <div className="watchlist">
      <div className="watchlist-title"><HelpTitle label="Pinned investments" text="Keep shortcuts to investments you check often. Use the star on an investment’s research chart to pin or unpin it. Click a pinned investment to open its chart." />
        <button className="icon-button" title="Find an investment" aria-label="Find an investment" onClick={onSearch}><Plus size={17} /></button></div>
      {watchlist.map((item) => <button key={item.symbol} className={`watch-item ${item.symbol === asset.symbol ? 'watch-active' : ''}`}
        title={item.name} onClick={() => onSelect(item)}>
        <AssetMark asset={item} />
        <span><strong>{item.symbol}</strong><small>{item.name}</small></span>
        <span className="watch-kind">{item.kind === 'fund' ? 'MF' : item.kind === 'etf' ? 'ETF' : item.exchange}</span>
      </button>)}
      {!watchlist.length && <p className="watch-empty">Use the star on a price chart to pin it here.</p>}
    </div>
    <HelpDetails className="sidebar-footer" wrapperClassName="sidebar-models" label="Research models"
      text="Shows which AI providers gather and compare evidence and which provider does the final review. The indicator turns green when Market Desk sees the required configuration."
      summaryProps={{ className: 'provider-title' }} summary={<><Database size={15} /><span>Research models</span></>}>
      <div className="provider-slots">
        {['quick', 'deep'].map((tier) => {
          const provider = settings?.providers?.[tier];
          return <div className="provider-row" key={tier} title={provider?.model || ''}>
            <span className={`provider-dot ${provider?.ready ? 'ready' : ''}`} />
            <span>{tier === 'quick' ? 'Gather and compare' : 'Final review'}<strong>{provider?.provider || 'Loading…'}</strong></span>
          </div>;
        })}
      </div>
    </HelpDetails>
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
  const [selectedTrace, setSelectedTrace] = useState('');
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
    const refreshJobs = () => api('/api/jobs', { background: true }).then(setJobs).catch(() => {});
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

  function openDiagnostics(id) {
    setSelectedTrace(id);
    navigate('diagnostics');
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
      onSelect={selectAsset} onNavigate={(value) => { setSelectedTrace(''); navigate(value); }} />
    <div className="app-content">
      <header className="topbar">
        <WithHelp className="topbar-search" label="Search investments" text="Open search to find a stock, ETF, mutual fund, bond, or index by its name or code. On a keyboard, Ctrl or Command + K opens search from any page.">
          <button className="global-search" data-log="search.open" onClick={() => findAsset()} aria-label="Search investments">
            <Search size={19} /><span>Search stocks, ETFs, mutual funds…</span><kbd>Ctrl K</kbd>
          </button>
        </WithHelp>
        <div className="topbar-meta">
          <span className="topbar-date"><CalendarDays size={16} />{dateLabel(today)}</span>
          {active > 0 && <span className="topbar-status" title={settingsError || 'Research jobs in progress'}><i className={providersReady ? 'ready' : ''} />{active} in progress</span>}
          <QuickGuide />
        </div>
      </header>
      <main data-log-region={view}>
        <div className="page-heading">
          <div><HelpTitle as="h1" label={viewInfo.title || viewInfo.label} text={viewInfo.help} /><p>{viewInfo.description}</p></div>
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
          {view === 'daily' && <DailyTrading onResearch={selectAsset} onDiagnostics={openDiagnostics} />}
          {view === 'diagnostics' && <Diagnostics key={selectedTrace} selectedTrace={selectedTrace} onRun={openRun} />}
        </Suspense>
        {view === 'runs' && <>
          <RunList jobs={jobs} library={library} onOpen={openRun} onImport={openImport} />
          <RunDetail job={job} imported={imported} onDiagnostics={openDiagnostics} />
          <DecisionMemory />
        </>}
        {view === 'backtests' && <div className="backtest-grid">
          <BacktestForm asset={asset} today={today} onJob={startJob} />
          <RunList jobs={jobs.filter(({ type }) => type === 'backtest')} library={[]} onOpen={openRun} />
        </div>}
        <footer className="workspace-footer">India Standard Time (IST)</footer>
      </main>
    </div>
    <AssetSearch open={searchOpen} setOpen={(open) => { if (!open) searchAction.current = null; setSearchOpen(open); }}
      onSelect={pickAsset} watchlist={watched} />
    <WishlistDialog asset={wishlistAsset} close={() => setWishlistAsset(null)} wishlists={wishlists}
      onCreate={createWishlist} onModify={updateWishlist} />
  </div>;
}

startDiagnostics();
createRoot(document.getElementById('root')).render(<App />);
