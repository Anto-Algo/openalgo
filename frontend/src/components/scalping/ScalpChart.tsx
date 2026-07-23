/**
 * ScalpChart - a high-performance live charting component for the scalping terminal
 * powered by the official openalgo-charts engine.
 *
 * Capabilities:
 *   - Powered by openalgo-charts createChart and buildChartTheme (dark/light/analyzer themes).
 *   - Multi-Chart Type support: Candlesticks, Heikin-Ashi, Line, Area, and Bars (OHLC).
 *   - Real-time technical indicator overlays: SMA(20), EMA(9), and VWAP.
 *   - Interactive overlay toolbar: Chart type selection, indicator toggles, reset zoom.
 *   - Staggered history reconciliation (20-30s) + zero-latency tick streaming.
 */

import { createChart } from 'openalgo-charts'
import { HeikinAshiTransform, runTransform } from 'openalgo-charts/transform'
import { BarChart2, ChevronDown, Maximize2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { scalpingApi } from '@/api/scalping'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useMarketData } from '@/hooks/useMarketData'
import { buildChartTheme } from '@/lib/trading/chartTheme'
import { priceDecimals } from '@/lib/scalpingPrice'
import { useThemeStore } from '@/stores/themeStore'

const IST_OFFSET = 19800
const INTERVAL_SEC: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900 }

const UP = '#26a69a'
const DOWN = '#ef5350'

// Indicator Line Colors
const SMA_COLOR = '#f59e0b' // Amber
const EMA_COLOR = '#06b6d4' // Cyan
const VWAP_COLOR = '#a855f7' // Purple

export type ScalpChartType = 'candlestick' | 'heikin-ashi' | 'line' | 'area' | 'bar'

interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function fmtPrice(n: number, decimals = 2): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}
function fmtVol(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (a >= 1e3) return `${(n / 1e3).toFixed(2)}K`
  return String(Math.round(n))
}

function calcSMA(candles: Candle[], period = 20): { time: number; value: number }[] {
  const res: { time: number; value: number }[] = []
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) continue
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) {
      sum += candles[j].close
    }
    res.push({ time: candles[i].time, value: sum / period })
  }
  return res
}

function calcEMA(candles: Candle[], period = 9): { time: number; value: number }[] {
  const res: { time: number; value: number }[] = []
  if (candles.length < period) return res
  const k = 2 / (period + 1)
  let prevEma = 0
  for (let i = 0; i < period; i++) {
    prevEma += candles[i].close
  }
  prevEma /= period
  res.push({ time: candles[period - 1].time, value: prevEma })
  for (let i = period; i < candles.length; i++) {
    const ema = candles[i].close * k + prevEma * (1 - k)
    res.push({ time: candles[i].time, value: ema })
    prevEma = ema
  }
  return res
}

function calcVWAP(candles: Candle[]): { time: number; value: number }[] {
  const res: { time: number; value: number }[] = []
  let cumVolPrice = 0
  let cumVol = 0
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]
    const typPrice = (c.high + c.low + c.close) / 3
    const vol = c.volume > 0 ? c.volume : 1
    cumVolPrice += typPrice * vol
    cumVol += vol
    res.push({ time: c.time, value: cumVolPrice / cumVol })
  }
  return res
}

export function ScalpChart({
  symbol,
  exchange,
  interval,
  title,
  initialChartType = 'candlestick',
}: {
  symbol: string
  exchange: string
  interval: string
  title?: string
  initialChartType?: ScalpChartType
}) {
  const { mode, appMode } = useThemeStore()

  const containerRef = useRef<HTMLDivElement | null>(null)
  const legendRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<any | null>(null)
  const priceSeriesRef = useRef<any | null>(null)
  const volRef = useRef<any | null>(null)

  // Indicator Series References
  const smaSeriesRef = useRef<any | null>(null)
  const emaSeriesRef = useRef<any | null>(null)
  const vwapSeriesRef = useRef<any | null>(null)

  const renderLegendRef = useRef<(time?: number) => void>(() => {})
  const colorsRef = useRef({ title: '#d6dde6', muted: '#8a97a5' })

  // State controls for Chart Type & Indicators
  const [chartType, setChartType] = useState<ScalpChartType>(initialChartType)
  const [showSMA, setShowSMA] = useState(false)
  const [showEMA, setShowEMA] = useState(false)
  const [showVWAP, setShowVWAP] = useState(false)

  // Model state
  const candlesRef = useRef<Map<number, Candle>>(new Map())
  const sortedRef = useRef<Candle[]>([])
  const idxByTimeRef = useRef<Map<number, number>>(new Map())
  const currentBucketRef = useRef<number | null>(null)
  const tradingDateRef = useRef<string | null>(null)
  const intervalSecRef = useRef<number>(INTERVAL_SEC[interval] ?? 60)
  const intervalRef = useRef<string>(interval)
  const barStartVolRef = useRef<number | null>(null)
  const readyRef = useRef(false)

  const [status, setStatus] = useState('')

  const enabled = !!(symbol && exchange)
  const { data } = useMarketData({
    symbols: enabled ? [{ symbol, exchange }] : [],
    mode: 'Quote',
    enabled,
    autoReconnect: true,
  })

  // Apply model data onto chart series & indicator lines
  const applyModelToSeries = (preserveRange: boolean) => {
    const chart = chartRef.current
    const priceSeries = priceSeriesRef.current
    const vol = volRef.current
    if (!chart || !priceSeries || !vol) return

    const rawBars = Array.from(candlesRef.current.values()).sort((a, b) => a.time - b.time)
    sortedRef.current = rawBars
    const idxMap = new Map<number, number>()
    rawBars.forEach((k, i) => idxMap.set(k.time, i))
    idxByTimeRef.current = idxMap

    const range = preserveRange ? chart.getVisibleLogicalRange?.() : null

    // Transform price bars based on active chartType
    let formattedBars: any[] = []
    if (chartType === 'heikin-ashi') {
      const openAlgoBars = rawBars.map((b) => ({ ...b }))
      const transformed = runTransform(new HeikinAshiTransform(), openAlgoBars)
      formattedBars = transformed.map((k) => ({
        time: k.time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      }))
    } else if (chartType === 'line' || chartType === 'area') {
      formattedBars = rawBars.map((k) => ({
        time: k.time,
        open: 0,
        high: k.close,
        low: 0,
        close: k.close,
      }))
    } else {
      formattedBars = rawBars.map((k) => ({
        time: k.time,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
      }))
    }

    priceSeries.setData(formattedBars)

    // Volume histogram
    vol.setData(
      rawBars.map((k) => ({
        time: k.time,
        open: 0,
        high: k.volume,
        low: 0,
        close: k.volume,
      }))
    )

    // Indicators calculation
    if (smaSeriesRef.current) {
      const smaData = showSMA ? calcSMA(rawBars, 20).map(d => ({ time: d.time, open: 0, high: d.value, low: 0, close: d.value })) : []
      smaSeriesRef.current.setData(smaData)
    }
    if (emaSeriesRef.current) {
      const emaData = showEMA ? calcEMA(rawBars, 9).map(d => ({ time: d.time, open: 0, high: d.value, low: 0, close: d.value })) : []
      emaSeriesRef.current.setData(emaData)
    }
    if (vwapSeriesRef.current) {
      const vwapData = showVWAP ? calcVWAP(rawBars).map(d => ({ time: d.time, open: 0, high: d.value, low: 0, close: d.value })) : []
      vwapSeriesRef.current.setData(vwapData)
    }

    if (range) {
      try {
        chart.setVisibleLogicalRange?.(range)
      } catch {
        /* range no longer valid */
      }
    }
    renderLegendRef.current()
  }

  // Create openalgo-charts instance
  useEffect(() => {
    const container = containerRef.current
    if (!container || !enabled) return

    const decimals = priceDecimals(exchange)

    const chart = createChart(container, {
      theme: buildChartTheme(mode, appMode),
    })

    let seriesType = 'candlestick'
    if (chartType === 'line') seriesType = 'line'
    else if (chartType === 'area') seriesType = 'area'
    else if (chartType === 'bar') seriesType = 'bar'

    const priceSeries = chart.addSeries(seriesType as any, {
      paneIndex: 0,
    })

    const vol = chart.addSeries('histogram' as any, {
      paneIndex: 1,
    })

    const smaSeries = chart.addSeries('line' as any, {
      paneIndex: 0,
      style: { color: SMA_COLOR },
    })
    const emaSeries = chart.addSeries('line' as any, {
      paneIndex: 0,
      style: { color: EMA_COLOR },
    })
    const vwapSeries = chart.addSeries('line' as any, {
      paneIndex: 0,
      style: { color: VWAP_COLOR },
    })

    chartRef.current = chart
    priceSeriesRef.current = priceSeries
    volRef.current = vol
    smaSeriesRef.current = smaSeries
    emaSeriesRef.current = emaSeries
    vwapSeriesRef.current = vwapSeries

    // OHLC & Indicator legend overlay
    const renderLegend = (time?: number) => {
      const el = legendRef.current
      const arr = sortedRef.current
      if (!el) return
      if (!arr.length) {
        el.innerHTML = ''
        return
      }
      let idx = arr.length - 1
      if (time != null) {
        const i = idxByTimeRef.current.get(time)
        if (i != null) idx = i
      }
      const bar = arr[idx]
      const ref = idx > 0 ? arr[idx - 1].close : bar.open
      const chg = bar.close - ref
      const pct = ref ? (chg / ref) * 100 : 0
      const col = chg >= 0 ? UP : DOWN
      const sign = chg >= 0 ? '+' : ''
      const { title: titleColor, muted } = colorsRef.current

      let indHtml = ''
      if (showSMA && idx >= 19) {
        const smaVal = calcSMA(arr.slice(0, idx + 1), 20).pop()?.value
        if (smaVal) indHtml += ` <span style="color:${SMA_COLOR}">SMA20 ${fmtPrice(smaVal, decimals)}</span>`
      }
      if (showEMA && idx >= 8) {
        const emaVal = calcEMA(arr.slice(0, idx + 1), 9).pop()?.value
        if (emaVal) indHtml += ` <span style="color:${EMA_COLOR}">EMA9 ${fmtPrice(emaVal, decimals)}</span>`
      }
      if (showVWAP && arr.length) {
        const vwapVal = calcVWAP(arr.slice(0, idx + 1)).pop()?.value
        if (vwapVal) indHtml += ` <span style="color:${VWAP_COLOR}">VWAP ${fmtPrice(vwapVal, decimals)}</span>`
      }

      el.innerHTML =
        `<div style="color:${titleColor};font-weight:600">${symbol} ` +
        `<span style="color:${muted};font-weight:500">· ${intervalRef.current} · ${exchange}</span></div>` +
        `<div style="color:${col};margin-top:1px">O${fmtPrice(bar.open, decimals)} H${fmtPrice(bar.high, decimals)} ` +
        `L${fmtPrice(bar.low, decimals)} C${fmtPrice(bar.close, decimals)} ${sign}${fmtPrice(chg, decimals)} (${sign}${pct.toFixed(2)}%)</div>` +
        `<div style="color:${muted};margin-top:1px">Vol <span style="color:${col}">${fmtVol(bar.volume)}</span>${indHtml}</div>`
    }

    renderLegendRef.current = renderLegend

    // Populate data if model already loaded
    if (sortedRef.current.length > 0) {
      applyModelToSeries(false)
    }

    return () => {
      chart.destroy()
      chartRef.current = null
      priceSeriesRef.current = null
      volRef.current = null
      smaSeriesRef.current = null
      emaSeriesRef.current = null
      vwapSeriesRef.current = null
    }
  }, [symbol, exchange, enabled, chartType, mode, appMode])

  // Load history & run reconciliation loop
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !enabled) return
    let disposed = false
    let inflight = false
    let timer: ReturnType<typeof setTimeout> | null = null

    candlesRef.current = new Map()
    sortedRef.current = []
    idxByTimeRef.current = new Map()
    currentBucketRef.current = null
    barStartVolRef.current = null
    intervalSecRef.current = INTERVAL_SEC[interval] ?? 60
    intervalRef.current = interval
    readyRef.current = false
    setStatus('loading...')

    const reconcile = async () => {
      if (disposed || inflight) return
      inflight = true
      try {
        const d = await scalpingApi.getHistory(
          symbol,
          exchange,
          interval,
          tradingDateRef.current || undefined
        )
        if (disposed || d.status !== 'success') return
        const fetched = d.candles || []
        if (!fetched.length) return
        const cur = currentBucketRef.current
        const completed = cur == null ? fetched : fetched.filter((k) => k.time < cur)
        let changed = false
        for (const k of completed.slice(-10)) {
          const prev = candlesRef.current.get(k.time)
          if (
            !prev ||
            prev.open !== k.open ||
            prev.high !== k.high ||
            prev.low !== k.low ||
            prev.close !== k.close ||
            prev.volume !== k.volume
          ) {
            candlesRef.current.set(k.time, { ...k })
            changed = true
          }
        }
        if (changed) applyModelToSeries(true)
      } catch {
        /* transient reconcile error */
      } finally {
        inflight = false
      }
    }

    const schedule = () => {
      const delay = 20000 + Math.random() * 10000
      timer = setTimeout(async () => {
        await reconcile()
        if (!disposed) schedule()
      }, delay)
    }

    scalpingApi
      .getHistory(symbol, exchange, interval)
      .then((d) => {
        if (disposed) return
        if (d.status !== 'success') {
          setStatus(`error: ${d.message || 'history failed'}`)
          schedule()
          return
        }
        const candles = d.candles || []
        tradingDateRef.current = d.date || null
        if (!candles.length) {
          readyRef.current = true
          currentBucketRef.current = null
          setStatus('waiting for live ticks…')
          schedule()
          return
        }
        candlesRef.current = new Map(candles.map((k) => [k.time, { ...k }]))
        applyModelToSeries(false)
        currentBucketRef.current = candles[candles.length - 1].time
        setStatus('')
        readyRef.current = true
        schedule()
      })
      .catch(() => {
        if (!disposed) {
          setStatus('history fetch failed')
          schedule()
        }
      })

    return () => {
      disposed = true
      readyRef.current = false
      if (timer) clearTimeout(timer)
    }
  }, [symbol, exchange, interval, enabled])

  // Update indicators when toggles change
  useEffect(() => {
    if (sortedRef.current.length > 0) {
      applyModelToSeries(true)
    }
  }, [showSMA, showEMA, showVWAP])

  // Process forming candle live from market data ticks
  const tick = data.get(`${exchange}:${symbol}`)?.data
  const ltp = tick?.ltp
  const ts = tick?.timestamp
  const tickVol = typeof tick?.volume === 'number' ? tick.volume : null

  useEffect(() => {
    const priceSeries = priceSeriesRef.current
    const vol = volRef.current
    if (!priceSeries || !vol || !readyRef.current || ltp == null || !Number.isFinite(ltp)) return

    const parsed = ts ? Date.parse(ts) : Number.NaN
    const epochUtc = Number.isNaN(parsed) ? Math.floor(Date.now() / 1000) : Math.floor(parsed / 1000)
    const sec = intervalSecRef.current
    const bucket = Math.floor((epochUtc + IST_OFFSET) / sec) * sec
    const cur = currentBucketRef.current

    let bar: Candle
    let isNew = false
    if (cur == null || bucket > cur) {
      isNew = true
      barStartVolRef.current = tickVol
      bar = { time: bucket, open: ltp, high: ltp, low: ltp, close: ltp, volume: 0 }
      currentBucketRef.current = bucket
    } else if (bucket === cur) {
      const prev = candlesRef.current.get(bucket)
      const v =
        tickVol != null && barStartVolRef.current != null
          ? Math.max(0, tickVol - barStartVolRef.current)
          : (prev?.volume ?? 0)
      bar = prev
        ? {
            time: bucket,
            open: prev.open,
            high: Math.max(prev.high, ltp),
            low: Math.min(prev.low, ltp),
            close: ltp,
            volume: v,
          }
        : { time: bucket, open: ltp, high: ltp, low: ltp, close: ltp, volume: v }
    } else {
      return
    }

    candlesRef.current.set(bucket, bar)
    const arr = sortedRef.current
    if (isNew) {
      arr.push(bar)
      idxByTimeRef.current.set(bucket, arr.length - 1)
    } else if (arr.length) {
      arr[arr.length - 1] = bar
    }

    if (chartType === 'line' || chartType === 'area') {
      priceSeries.update({ time: bar.time, open: 0, high: bar.close, low: 0, close: bar.close })
    } else if (chartType === 'heikin-ashi') {
      const transformed = runTransform(new HeikinAshiTransform(), arr.map((b) => ({ ...b })))
      const lastTransformed = transformed[transformed.length - 1]
      if (lastTransformed) {
        priceSeries.update({
          time: lastTransformed.time,
          open: lastTransformed.open,
          high: lastTransformed.high,
          low: lastTransformed.low,
          close: lastTransformed.close,
        })
      }
    } else {
      priceSeries.update({
        time: bar.time,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })
    }

    vol.update({ time: bar.time, open: 0, high: bar.volume, low: 0, close: bar.volume })

    // Live update indicators for latest bar
    if (showSMA && smaSeriesRef.current && arr.length >= 20) {
      const smaVal = calcSMA(arr, 20).pop()
      if (smaVal) smaSeriesRef.current.update({ time: smaVal.time, open: 0, high: smaVal.value, low: 0, close: smaVal.value })
    }
    if (showEMA && emaSeriesRef.current && arr.length >= 9) {
      const emaVal = calcEMA(arr, 9).pop()
      if (emaVal) emaSeriesRef.current.update({ time: emaVal.time, open: 0, high: emaVal.value, low: 0, close: emaVal.value })
    }
    if (showVWAP && vwapSeriesRef.current && arr.length > 0) {
      const vwapVal = calcVWAP(arr).pop()
      if (vwapVal) vwapSeriesRef.current.update({ time: vwapVal.time, open: 0, high: vwapVal.value, low: 0, close: vwapVal.value })
    }

    renderLegendRef.current()
    setStatus((s) => (s ? '' : s))
  }, [ltp, ts, tickVol, chartType, showSMA, showEMA, showVWAP])

  if (!enabled) {
    return (
      <div className="flex h-full w-full items-center justify-center rounded-lg border bg-card text-xs text-muted-foreground">
        {title ? `${title} — not selected` : 'No instrument'}
      </div>
    )
  }

  return (
    <div className="relative h-full w-full overflow-hidden rounded-lg border bg-card shadow-xs transition-all hover:border-border/80">
      {/* Top Controls Toolbar */}
      <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md border bg-background/80 p-1 backdrop-blur-sm shadow-2xs">
        {/* Chart Type Dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="h-6 px-1.5 text-[11px] font-medium gap-1">
              <BarChart2 className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="capitalize">{chartType.replace('-', ' ')}</span>
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36 text-xs">
            <DropdownMenuItem onClick={() => setChartType('candlestick')}>
              Candlesticks
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setChartType('heikin-ashi')}>
              Heikin-Ashi
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setChartType('bar')}>
              Bars (OHLC)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setChartType('line')}>
              Line
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setChartType('area')}>
              Area
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="h-3 w-px bg-border my-auto" />

        {/* Quick Indicators Toggles */}
        <button
          type="button"
          onClick={() => setShowSMA((v) => !v)}
          className={`h-5 rounded px-1.5 text-[10px] font-semibold transition-colors ${
            showSMA
              ? 'bg-amber-500/20 text-amber-500 border border-amber-500/40'
              : 'text-muted-foreground hover:bg-muted'
          }`}
          title="Simple Moving Average (20)"
        >
          SMA
        </button>

        <button
          type="button"
          onClick={() => setShowEMA((v) => !v)}
          className={`h-5 rounded px-1.5 text-[10px] font-semibold transition-colors ${
            showEMA
              ? 'bg-cyan-500/20 text-cyan-500 border border-cyan-500/40'
              : 'text-muted-foreground hover:bg-muted'
          }`}
          title="Exponential Moving Average (9)"
        >
          EMA
        </button>

        <button
          type="button"
          onClick={() => setShowVWAP((v) => !v)}
          className={`h-5 rounded px-1.5 text-[10px] font-semibold transition-colors ${
            showVWAP
              ? 'bg-purple-500/20 text-purple-500 border border-purple-500/40'
              : 'text-muted-foreground hover:bg-muted'
          }`}
          title="Volume Weighted Average Price"
        >
          VWAP
        </button>

        <div className="h-3 w-px bg-border my-auto" />

        {/* Fit Content Button */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="h-6 w-6"
          onClick={() => chartRef.current?.fitContent?.()}
          title="Reset Zoom / Fit Content"
        >
          <Maximize2 className="h-3 w-3 text-muted-foreground" />
        </Button>
      </div>

      {/* Chart Canvas */}
      <div ref={containerRef} className="absolute inset-0" />

      {/* Legend */}
      <div
        ref={legendRef}
        className="pointer-events-none absolute left-2.5 top-2 z-10 font-mono text-[11px] leading-tight"
      />

      {status && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
          {status}
        </div>
      )}
    </div>
  )
}
