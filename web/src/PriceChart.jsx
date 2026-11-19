import { useEffect, useRef } from 'react';
import { AreaSeries, CandlestickSeries, HistogramSeries, LineSeries, createChart } from 'lightweight-charts';

const rangeMonths = { '1M': 1, '3M': 3, '6M': 6, '1Y': 12, '5Y': 60 };
const chartGreen = '#00826a';
const benchmarkColor = '#8766ca';

function cutoffFor(time, range) {
  const last = new Date(time);
  const day = last.getUTCDate();
  last.setUTCDate(1);
  last.setUTCMonth(last.getUTCMonth() - rangeMonths[range]);
  const monthEnd = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 0)).getUTCDate();
  last.setUTCDate(Math.min(day, monthEnd));
  return last.toISOString().slice(0, 10);
}

function movingAverage(bars, days, cutoff) {
  let sum = 0;
  return bars.flatMap(({ time, close }, i) => {
    sum += close;
    if (i >= days) sum -= bars[i - days].close;
    return i >= days - 1 && time >= cutoff ? [{ time, value: sum / days }] : [];
  });
}

export default function PriceChart({ bars, range, style, indicators, benchmark, onHover }) {
  const host = useRef(null);
  const hover = useRef(onHover);
  hover.current = onHover;

  useEffect(() => {
    if (!bars?.length) return undefined;
    const chart = createChart(host.current, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' }, textColor: '#63746d',
        fontFamily: 'Inter Variable, sans-serif', fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: '#edf1ef' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.18 } },
      timeScale: { borderVisible: false, rightOffset: 2, minBarSpacing: 0.45 },
      crosshair: { vertLine: { color: '#8ca098', labelBackgroundColor: '#174336' }, horzLine: { color: '#8ca098', labelBackgroundColor: '#174336' } },
      localization: { locale: 'en-IN' },
    });
    const cutoff = cutoffFor(bars.at(-1).time, range);
    const visible = bars.filter(({ time }) => time >= cutoff);
    const byDate = new Map(visible.map((bar) => [bar.time, bar]));
    const priceFormat = benchmark ? { type: 'custom', formatter: (v) => `${v.toFixed(1)}%` }
      : { type: 'price', precision: 2, minMove: 0.01 };
    if (style === 'candle' && !benchmark) {
      const series = chart.addSeries(CandlestickSeries, {
        upColor: chartGreen, downColor: '#c75457', wickUpColor: chartGreen, wickDownColor: '#c75457',
        borderVisible: false, lastValueVisible: false, priceLineVisible: false, priceFormat,
      });
      series.setData(visible.filter((bar) => [bar.open, bar.high, bar.low].every(Number.isFinite)));
    } else {
      const area = chart.addSeries(AreaSeries, {
        lineColor: chartGreen, topColor: 'rgba(0, 130, 106, .15)', bottomColor: 'rgba(0, 130, 106, .01)',
        lineWidth: 2, lastValueVisible: false, priceLineVisible: false, priceFormat,
      });
      const compare = new Map(benchmark?.bars?.map((bar) => [bar.time, bar.close]) || []);
      const overlapping = benchmark ? visible.filter((bar) => compare.has(bar.time)) : visible;
      const start = overlapping[0];
      area.setData(overlapping.map(({ time, close }) => ({ time, value: benchmark ? ((close / start.close) - 1) * 100 : close })));
      if (benchmark && start) {
        const comparison = chart.addSeries(LineSeries, {
          color: benchmarkColor, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, priceFormat,
        });
        comparison.setData(overlapping.map(({ time }) => ({
          time, value: ((compare.get(time) / compare.get(start.time)) - 1) * 100,
        })));
      }
    }
    if (!benchmark) {
      for (const [key, days, color] of [['sma20', 20, '#b17824'], ['sma50', 50, benchmarkColor]]) {
        if (indicators[key]) {
          const average = chart.addSeries(LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false });
          average.setData(movingAverage(bars, days, cutoff));
        }
      }
    }
    if (indicators.volume && !benchmark) {
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' }, priceScaleId: '', lastValueVisible: false, priceLineVisible: false,
      });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      volume.setData(visible.filter((bar) => Number.isFinite(bar.volume)).map((bar) => ({
        time: bar.time, value: bar.volume, color: bar.close >= (bar.open ?? bar.close) ? '#9dcec3' : '#e5b1ae',
      })));
    }
    chart.subscribeCrosshairMove(({ time }) => {
      hover.current(time && byDate.get(time) ? byDate.get(time) : null);
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [bars, range, style, indicators, benchmark]);

  return <div className="price-chart" aria-label={style === 'candle' ? 'Daily candlestick chart' : 'Daily trend chart'} ref={host} />;
}
