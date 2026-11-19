import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries, HistogramSeries, LineSeries, LineStyle, createChart, createSeriesMarkers,
} from 'lightweight-charts';
import { money } from './api';

const clock = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const formatTime = (time) => clock.format(time * 1000);
const levels = [
  ['trigger', 'Trigger', '#166c57'], ['entry_cap', 'Entry cap', '#607c72'],
  ['stop', 'Stop', '#ac4649'], ['target', 'Target', '#5d51a3'],
];

function markerTime(bars, value, includesEnd) {
  if (!value) return null;
  const stamp = typeof value === 'number' ? value : Date.parse(value) / 1000;
  if (!Number.isFinite(stamp)) return null;
  const bar = bars.findLast(({ time }) => includesEnd ? time < stamp : time <= stamp);
  return bar?.time ?? bars.find(({ time }) => time === stamp)?.time ?? null;
}

export function DailyChart({ bars, idea, symbol, day }) {
  const container = useRef(null);
  const instances = useRef(null);
  const [hover, setHover] = useState(null);
  const selected = bars.find(({ time }) => time === hover) || bars.at(-1);

  useEffect(() => {
    const chart = createChart(container.current, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#596e64', fontFamily: 'Inter Variable, sans-serif', fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: '#f2f5f3' }, horzLines: { color: '#edf1ee' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: .12, bottom: .21 } },
      timeScale: { timeVisible: true, secondsVisible: false, borderVisible: false, rightOffset: 3, tickMarkFormatter: formatTime },
      localization: { locale: 'en-IN', timeFormatter: formatTime },
      crosshair: { vertLine: { labelBackgroundColor: '#1b4538' }, horzLine: { labelBackgroundColor: '#1b4538' } },
    });
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#08765e', downColor: '#c2565b', wickUpColor: '#08765e', wickDownColor: '#c2565b',
      borderVisible: false, lastValueVisible: false, priceLineVisible: false,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: '', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: .82, bottom: 0 } });
    const vwap = chart.addSeries(LineSeries, { color: '#a76e23', lineWidth: 2, priceLineVisible: false, lastValueVisible: false });
    const markers = createSeriesMarkers(candles);
    const onMove = ({ time }) => setHover(time ?? null);
    chart.subscribeCrosshairMove(onMove);
    instances.current = { chart, candles, volume, vwap, markers, initial: true, lines: [] };
    return () => {
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      instances.current = null;
    };
  }, [symbol, day]);

  useEffect(() => {
    const view = instances.current;
    if (!view || !bars.length) return;
    view.candles.setData(bars);
    view.volume.setData(bars.filter(({ volume }) => Number.isFinite(volume)).map(({ time, open, close, volume }) => ({
      time, value: volume, color: close >= open ? '#a9d6c9' : '#edc0be',
    })));
    view.vwap.setData(bars.filter(({ vwap }) => Number.isFinite(vwap)).map(({ time, vwap }) => ({ time, value: vwap })));
    if (view.initial) {
      view.chart.timeScale().fitContent();
      view.initial = false;
    }
  }, [bars, symbol, day]);

  useEffect(() => {
    const view = instances.current;
    if (!view) return;
    for (const line of view.lines) view.candles.removePriceLine(line);
    view.lines = levels.flatMap(([key, title, color]) => Number.isFinite(idea?.[key]) ? [view.candles.createPriceLine({
      title, color, price: idea[key], lineWidth: 1, lineStyle: LineStyle.Dashed,
      axisLabelVisible: true, axisLabelColor: color, axisLabelTextColor: '#fff',
    })] : []);
    const entry = Number.isFinite(idea?.entry) ? markerTime(bars, idea.entry_at, false) : null;
    const exit = Number.isFinite(idea?.exit_price) ? markerTime(bars, idea.exit_at, idea.status !== 'time-exit') : null;
    view.markers.setMarkers([
      ...(entry ? [{ time: entry, position: 'belowBar', color: '#08765e', shape: 'arrowUp', text: 'Entry' }] : []),
      ...(exit ? [{ time: exit, position: 'aboveBar', color: '#ac4649', shape: 'arrowDown', text: 'Exit' }] : []),
    ].sort((a, b) => a.time - b.time));
  }, [bars, idea, symbol, day]);

  return <>
    {selected && <div className="daily-ohlc" aria-label="Selected candle data">
      <time dateTime={new Date(selected.time * 1000).toISOString()}>{formatTime(selected.time)} IST</time>
      {[['open', 'O'], ['high', 'H'], ['low', 'L'], ['close', 'C']].map(([field, label]) => <span key={field}>{label} <strong>{money(selected[field], 'INR')}</strong></span>)}
    </div>}
    <div className="daily-chart-canvas" ref={container} role="img" aria-label={`${symbol} intraday candlesticks, volume, session VWAP and trade plan levels`} />
  </>;
}
