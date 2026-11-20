/*
 * rf-charts.js — the RSSI scanner's two live charts, drawn on canvas (a 1 kHz stream redraws ten
 * times a second; SVG would rebuild hundreds of nodes each time).
 *
 *   TimeChart     power-mean line per radio (50 ms buckets), crosshair + tooltip on hover.
 *   ChannelChart  one bar per FHSS channel (power mean), tooltip on hover.
 *   SpectrumChart the continuous-wave carrier across the band, as an analyser trace would show it.
 *                 Drawn from the settings, not measured: the radio cannot see its own output.
 *
 * Colours come from CSS custom properties on the chart host (rf-tools.css), so the charts follow
 * the dashboard tokens rather than carrying their own palette.
 */

import {mwToDbm} from './rf-stats.js'

const PAD = {left: 44, right: 16, top: 14, bottom: 26}

function cssVar(el, name, fallback) {
  const v = getComputedStyle(el).getPropertyValue(name).trim()
  return v || fallback
}

export function fmtDbm(v, digits = 1) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  return v.toFixed(digits).replace('-', '−')
}

/** A y range in dBm snapped to 10 dB, at least `span` tall, that holds [lo, hi]. */
function niceRange(lo, hi, span = 30) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-130, -40]
  let top = Math.ceil((hi + 3) / 10) * 10
  let bottom = Math.floor((lo - 3) / 10) * 10
  if (top - bottom < span) {
    const extra = span - (top - bottom)
    bottom -= Math.ceil(extra / 20) * 10
    top += Math.floor(extra / 20) * 10
    if (top - bottom < span) bottom -= 10
  }
  return [bottom, top]
}

/**
 * Keeps the y range from twitching: it widens at once but only narrows once the data has sat well
 * inside the new range for a while.
 */
class StableRange {
  constructor() { this.range = null; this.shrinkSince = 0 }

  reset() { this.range = null }

  update(target) {
    const now = performance.now()
    if (!this.range || target[0] < this.range[0] || target[1] > this.range[1]) {
      this.range = [Math.min(target[0], this.range?.[0] ?? target[0]), Math.max(target[1], this.range?.[1] ?? target[1])]
      this.shrinkSince = now
    } else if (target[0] > this.range[0] || target[1] < this.range[1]) {
      if (now - this.shrinkSince > 3000) {
        this.range = target
        this.shrinkSince = now
      }
    } else {
      this.shrinkSince = now
    }
    return this.range
  }
}

class CanvasChart {
  constructor(host) {
    this.host = host
    this.canvas = host.querySelector('canvas')
    this.tip = host.querySelector('.rf-chart-tip')
    this.ctx = this.canvas.getContext('2d')
    this.hover = null
    this.data = null
    this._frame = 0
    this._ro = new ResizeObserver(() => this.requestDraw())
    this._ro.observe(host)
    this._move = (e) => {
      const rect = this.canvas.getBoundingClientRect()
      this.hover = {x: e.clientX - rect.left, y: e.clientY - rect.top}
      this.requestDraw()
    }
    this._leave = () => {
      this.hover = null
      this.requestDraw()
    }
    this.canvas.addEventListener('pointermove', this._move)
    this.canvas.addEventListener('pointerdown', this._move)
    this.canvas.addEventListener('pointerleave', this._leave)
  }

  destroy() {
    this._ro.disconnect()
    this.canvas.removeEventListener('pointermove', this._move)
    this.canvas.removeEventListener('pointerdown', this._move)
    this.canvas.removeEventListener('pointerleave', this._leave)
    if (this._frame) cancelAnimationFrame(this._frame)
  }

  setData(data) {
    this.data = data
    this.requestDraw()
  }

  requestDraw() {
    if (this._frame) return
    this._frame = requestAnimationFrame(() => {
      this._frame = 0
      this._render()
    })
  }

  _render() {
    const w = this.host.clientWidth
    const h = this.host.clientHeight
    if (!w || !h) return
    const dpr = window.devicePixelRatio || 1
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr)
      this.canvas.height = Math.round(h * dpr)
      this.canvas.style.width = `${w}px`
      this.canvas.style.height = `${h}px`
    }
    const ctx = this.ctx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    this.colors = {
      grid: cssVar(this.host, '--rf-grid', 'rgba(255,255,255,0.07)'),
      axis: cssVar(this.host, '--rf-axis', 'rgba(255,255,255,0.18)'),
      label: cssVar(this.host, '--rf-label', '#A0A4AB'),
      text: cssVar(this.host, '--rf-text', '#F1F2F4'),
      surface: cssVar(this.host, '--rf-surface', '#16181B'),
      hover: cssVar(this.host, '--rf-hover', 'rgba(255,255,255,0.05)'),
      series: [cssVar(this.host, '--rf-series-1', '#3987e5'), cssVar(this.host, '--rf-series-2', '#d95926')],
      font: cssVar(this.host, '--rf-font', '11px monospace'),
    }
    this.draw(ctx, w, h)
  }

  /** Horizontal gridlines every 10 dB with their labels; returns the value -> y mapping. */
  _yAxis(ctx, w, h, range, step = range[1] - range[0] > 60 ? 20 : 10) {
    const [lo, hi] = range
    const plotH = h - PAD.top - PAD.bottom
    const y = (v) => PAD.top + (hi - v) / (hi - lo) * plotH
    ctx.font = this.colors.font
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      const yy = Math.round(y(v)) + 0.5
      ctx.strokeStyle = this.colors.grid
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(PAD.left, yy)
      ctx.lineTo(w - PAD.right, yy)
      ctx.stroke()
      ctx.fillStyle = this.colors.label
      ctx.fillText(String(v).replace('-', '−'), PAD.left - 8, yy)
    }
    return y
  }

  _showTip(html, x, y) {
    if (!this.tip) return
    this.tip.innerHTML = html
    this.tip.hidden = false
    const w = this.host.clientWidth
    const tw = this.tip.offsetWidth
    const left = x + 14 + tw > w ? x - 14 - tw : x + 14
    this.tip.style.transform = `translate(${Math.max(0, left)}px, ${Math.max(0, y - 10)}px)`
  }

  _hideTip() {
    if (this.tip) this.tip.hidden = true
  }
}

function tipRow(color, label, value) {
  return `<div class="rf-tip-row"><span class="rf-key" style="background:${color}"></span>` +
    `<span class="rf-tip-label">${label}</span><span class="rf-tip-value">${value}</span></div>`
}

export class TimeChart extends CanvasChart {
  constructor(host) {
    super(host)
    this.yRange = new StableRange()
  }

  resetRange() { this.yRange.reset() }

  /**
   * data: {buckets, bucketSamples, periodUs, radios (bitmask), latestSeq, windowSec,
   *        names: ['Radio 1', 'Radio 2']}
   */
  draw(ctx, w, h) {
    const d = this.data
    const plotW = w - PAD.left - PAD.right
    if (!d || !d.buckets.length || plotW <= 0) {
      this.yRange.reset()
      this._yAxis(ctx, w, h, [-130, -40])
      this._hideTip()
      return
    }
    const samplesPerSec = 1e6 / d.periodUs
    const windowSamples = d.windowSec * samplesPerSec
    const x0 = d.latestSeq - windowSamples
    const x = (seq) => PAD.left + (seq - x0) / windowSamples * plotW
    const visible = d.buckets.filter((b) => (b.key + 1) * d.bucketSamples >= x0)
    // the newest bucket is still filling; drawn early it shows as a spike or dip at the line's end
    if (visible.length > 1 && visible[visible.length - 1].n < d.bucketSamples / 2) visible.pop()
    const radios = [0, 1].filter((i) => d.radios & (1 << i))

    let lo = Infinity
    let hi = -Infinity
    for (const b of visible) {
      for (const i of radios) {
        if (b.min[i] < lo) lo = b.min[i]
        if (b.max[i] > hi) hi = b.max[i]
      }
    }
    const range = this.yRange.update(niceRange(lo, hi))
    const y = this._yAxis(ctx, w, h, range)

    // x ticks, in seconds before the newest sample
    const tickStep = [1, 2, 5, 10, 15, 20, 30].find((s) => s / d.windowSec * plotW >= 56) || d.windowSec
    ctx.font = this.colors.font
    ctx.textBaseline = 'top'
    ctx.fillStyle = this.colors.label
    for (let s = 0; s <= d.windowSec + 1e-9; s += tickStep) {
      const xx = PAD.left + plotW - s / d.windowSec * plotW
      ctx.fillStyle = this.colors.label
      ctx.textAlign = s === 0 ? 'right' : s === d.windowSec ? 'left' : 'center'
      ctx.fillText(s === 0 ? 'now' : `−${s} s`, xx, h - PAD.bottom + 8)
    }
    ctx.strokeStyle = this.colors.axis
    ctx.beginPath()
    ctx.moveTo(PAD.left, Math.round(h - PAD.bottom) + 0.5)
    ctx.lineTo(w - PAD.right, Math.round(h - PAD.bottom) + 0.5)
    ctx.stroke()

    ctx.save()
    ctx.beginPath()
    ctx.rect(PAD.left, PAD.top - 2, plotW, h - PAD.top - PAD.bottom + 4)
    ctx.clip()
    const mid = (b) => x((b.key + 0.5) * d.bucketSamples)
    for (const i of radios) {
      const color = this.colors.series[i]
      ctx.strokeStyle = color
      ctx.lineWidth = 2
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      visible.forEach((b, k) => {
        const v = y(mwToDbm(b.sumMw[i] / b.n))
        k ? ctx.lineTo(mid(b), v) : ctx.moveTo(mid(b), v)
      })
      ctx.stroke()
    }
    ctx.restore()

    this._drawHover(ctx, w, h, visible, mid, y, radios, d)
  }

  _drawHover(ctx, w, h, visible, mid, y, radios, d) {
    const hv = this.hover
    if (!hv || hv.x < PAD.left || hv.x > w - PAD.right) {
      this._hideTip()
      return
    }
    let best = null
    let bestDist = Infinity
    for (const b of visible) {
      const dist = Math.abs(mid(b) - hv.x)
      if (dist < bestDist) {
        bestDist = dist
        best = b
      }
    }
    if (!best) {
      this._hideTip()
      return
    }
    const bx = Math.round(mid(best)) + 0.5
    ctx.strokeStyle = this.colors.axis
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(bx, PAD.top)
    ctx.lineTo(bx, h - PAD.bottom)
    ctx.stroke()
    let rows = ''
    for (const i of radios) {
      const avg = mwToDbm(best.sumMw[i] / best.n)
      ctx.fillStyle = this.colors.surface
      ctx.beginPath()
      ctx.arc(bx, y(avg), 6, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = this.colors.series[i]
      ctx.beginPath()
      ctx.arc(bx, y(avg), 4, 0, Math.PI * 2)
      ctx.fill()
      rows += tipRow(this.colors.series[i], d.names[i],
        `${fmtDbm(avg)} <span class="rf-tip-dim">(${fmtDbm(best.min[i], 0)} … ${fmtDbm(best.max[i], 0)})</span>`)
    }
    const ago = (d.latestSeq - (best.key + 0.5) * d.bucketSamples) * d.periodUs / 1e6
    const head = ago < 0.05 ? 'now' : `${ago.toFixed(2)} s ago`
    this._showTip(`<div class="rf-tip-head">${head}<span class="rf-tip-dim"> · ${Math.round(best.n)} samples</span></div>${rows}`,
      bx, hv.y)
  }
}

export class ChannelChart extends CanvasChart {
  constructor(host) {
    super(host)
    this.yRange = new StableRange()
  }

  resetRange() { this.yRange.reset() }

  /** data: {stats (ChannelStats), radios, freqOf(ch) -> Hz, names} */
  draw(ctx, w, h) {
    const d = this.data
    const plotW = w - PAD.left - PAD.right
    if (!d || !d.stats.count || plotW <= 0) {
      this._yAxis(ctx, w, h, [-130, -40])
      this._hideTip()
      return
    }
    const {stats} = d
    const count = stats.count
    const radios = [0, 1].filter((i) => d.radios & (1 << i))
    let lo = Infinity
    let hi = -Infinity
    for (const i of radios) {
      for (let ch = 0; ch < count; ch++) {
        const a = stats.avg(i, ch)
        if (a !== null && a < lo) lo = a
        if (a !== null && a > hi) hi = a
      }
    }
    const range = this.yRange.update(niceRange(lo - 6, hi, 40))
    const y = this._yAxis(ctx, w, h, range)
    const base = h - PAD.bottom
    const slot = plotW / count
    const groupW = Math.min(slot - 2, 24 * radios.length + 2 * (radios.length - 1))
    const barW = Math.max(1, (groupW - 2 * (radios.length - 1)) / radios.length)
    const slotX = (ch) => PAD.left + ch * slot

    let hoverCh = -1
    const hv = this.hover
    if (hv && hv.x >= PAD.left && hv.x <= w - PAD.right) {
      hoverCh = Math.min(count - 1, Math.max(0, Math.floor((hv.x - PAD.left) / slot)))
      ctx.fillStyle = this.colors.hover
      ctx.fillRect(slotX(hoverCh), PAD.top, slot, base - PAD.top)
    }

    for (let ch = 0; ch < count; ch++) {
      const gx = slotX(ch) + (slot - groupW) / 2
      radios.forEach((i, k) => {
        const a = stats.avg(i, ch)
        if (a === null) return
        const bx = gx + k * (barW + 2)
        const top = Math.min(base - 1, y(a))
        const r = Math.min(2, barW / 2, base - top)
        ctx.fillStyle = this.colors.series[i]
        ctx.beginPath()
        ctx.moveTo(bx, base)
        ctx.lineTo(bx, top + r)
        ctx.arcTo(bx, top, bx + r, top, r)
        ctx.lineTo(bx + barW - r, top)
        ctx.arcTo(bx + barW, top, bx + barW, top + r, r)
        ctx.lineTo(bx + barW, base)
        ctx.closePath()
        ctx.fill()
      })
    }

    ctx.strokeStyle = this.colors.axis
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(PAD.left, Math.round(base) + 0.5)
    ctx.lineTo(w - PAD.right, Math.round(base) + 0.5)
    ctx.stroke()

    // frequency ticks, about one every 90 px, on whole channels
    const every = Math.max(1, Math.ceil(count / Math.max(2, Math.floor(plotW / 90))))
    ctx.font = this.colors.font
    ctx.textBaseline = 'top'
    ctx.fillStyle = this.colors.label
    for (let ch = 0; ch < count; ch += every) {
      const xx = slotX(ch) + slot / 2
      ctx.textAlign = ch === 0 ? 'left' : 'center'
      ctx.fillText((d.freqOf(ch) / 1e6).toFixed(1), ch === 0 ? PAD.left : xx, base + 8)
    }
    ctx.textAlign = 'right'
    ctx.fillText('MHz', w - PAD.right, base + 8)

    if (hoverCh < 0) {
      this._hideTip()
      return
    }
    let rows = ''
    for (const i of radios) {
      const n = stats.n[i][hoverCh]
      rows += tipRow(this.colors.series[i], d.names[i], n
        ? `avg ${fmtDbm(stats.avg(i, hoverCh))} · max ${fmtDbm(stats.max[i][hoverCh], 0)} · last ${fmtDbm(stats.last[i][hoverCh], 0)}`
        : 'no samples yet')
    }
    const samples = stats.n[radios[0]][hoverCh]
    this._showTip(`<div class="rf-tip-head">${(d.freqOf(hoverCh) / 1e6).toFixed(3)} MHz` +
      `<span class="rf-tip-dim"> · ${samples} samples</span></div>${rows}`, slotX(hoverCh) + slot / 2, hv.y)
  }
}

export class SpectrumChart extends CanvasChart {
  /**
   * data: {freqHz, dbm, series (0 or 1), maxDbm (the highest power-table level),
   *        band: {start, spread, count}}
   */
  draw(ctx, w, h) {
    const d = this.data
    const plotW = w - PAD.left - PAD.right
    if (!d || plotW <= 0) return
    const {band} = d
    const stopHz = band.start + band.spread * (band.count - 1)
    const lo = band.start - (stopHz - band.start) * 0.05
    const hi = stopHz + (stopHz - band.start) * 0.05
    // Fixed per band, like an analyser's reference level: 80 dB below the strongest table level,
    // so the peak height follows the power setting.
    const top = Math.ceil((Math.max(d.maxDbm, d.dbm) + 5) / 10) * 10
    const floorDbm = top - 74
    const y = this._yAxis(ctx, w, h, [top - 80, top], 10)
    const base = h - PAD.bottom
    const x = (f) => PAD.left + (f - lo) / (hi - lo) * plotW

    // Gaussian main lobe, a phase-noise skirt falling 20 dB/decade and a noise floor with a fixed
    // per-pixel jitter so the trace does not crawl between redraws.
    const sigma = (hi - lo) / 250
    const peakMw = Math.pow(10, d.dbm / 10)
    const level = (px) => {
      const df = lo + px / plotW * (hi - lo) - d.freqHz
      const lobe = peakMw * Math.exp(-0.5 * (df / sigma) ** 2)
      const skirt = peakMw * 1e-7 / (1 + (Math.abs(df) / (4 * sigma)) ** 2)
      const jitter = (Math.sin(px * 12.9898) * 43758.5453) % 1
      const floor = Math.pow(10, (floorDbm + 2 * Math.abs(jitter) - 1) / 10)
      return 10 * Math.log10(lobe + skirt + floor)
    }
    ctx.strokeStyle = this.colors.series[d.series]
    ctx.lineWidth = 1.5
    ctx.lineJoin = 'round'
    ctx.beginPath()
    for (let px = 0; px <= plotW; px++) {
      const yy = Math.min(base, y(level(px)))
      if (px === 0) ctx.moveTo(PAD.left, yy)
      else ctx.lineTo(PAD.left + px, yy)
    }
    ctx.stroke()
    // the per-pixel trace can step over the peak; take it up to the exact level
    const px = x(d.freqHz)
    const py = y(d.dbm)
    ctx.beginPath()
    ctx.moveTo(px, Math.min(base, y(level(Math.round(px - PAD.left)))))
    ctx.lineTo(px, py)
    ctx.stroke()

    ctx.strokeStyle = this.colors.axis
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(PAD.left, Math.round(base) + 0.5)
    ctx.lineTo(w - PAD.right, Math.round(base) + 0.5)
    ctx.stroke()

    ctx.fillStyle = this.colors.text
    ctx.beginPath()
    ctx.moveTo(px, py - 3)
    ctx.lineTo(px - 5, py - 11)
    ctx.lineTo(px + 5, py - 11)
    ctx.closePath()
    ctx.fill()

    // readout in the top corner away from the peak, on two lines if one does not fit beside it
    ctx.font = this.colors.font
    ctx.textBaseline = 'top'
    const onRight = px < PAD.left + plotW / 2
    const room = onRight ? w - PAD.right - px - 14 : px - PAD.left - 14
    const tx = onRight ? w - PAD.right : PAD.left + 8
    ctx.textAlign = onRight ? 'right' : 'left'
    const readout = [`${(d.freqHz / 1e6).toFixed(3)} MHz`, `${fmtDbm(d.dbm)} dBm`]
    const oneLine = readout.join('  ')
    if (ctx.measureText(oneLine).width <= room) {
      ctx.fillText(oneLine, tx, PAD.top)
    } else {
      readout.forEach((t, i) => ctx.fillText(t, tx, PAD.top + i * 15))
    }

    // a tick on every channel, labelled about every 70 px and clear of the unit
    ctx.strokeStyle = this.colors.axis
    ctx.beginPath()
    for (let ch = 0; ch < band.count; ch++) {
      const xx = Math.round(x(band.start + band.spread * ch)) + 0.5
      ctx.moveTo(xx, base)
      ctx.lineTo(xx, base + 4)
    }
    ctx.stroke()
    ctx.fillStyle = this.colors.label
    ctx.textBaseline = 'top'
    ctx.textAlign = 'right'
    ctx.fillText('MHz', w - PAD.right, base + 8)
    const unitLeft = w - PAD.right - ctx.measureText('MHz').width - 8
    const every = Math.max(1, Math.ceil(70 / (band.spread / (hi - lo) * plotW)))
    ctx.textAlign = 'center'
    for (let ch = 0; ch < band.count; ch += every) {
      const f = band.start + band.spread * ch
      const label = (f / 1e6).toFixed(1)
      if (x(f) + ctx.measureText(label).width / 2 > unitLeft) break
      ctx.fillText(label, x(f), base + 8)
    }
  }
}
