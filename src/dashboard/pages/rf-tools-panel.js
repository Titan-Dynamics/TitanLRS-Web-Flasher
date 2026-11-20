import {html, LitElement, nothing} from 'lit'
import {customElement, state} from 'lit/decorators.js'
import {transport} from '../utils/transport.js'
import {cuteAlert, errorAlert} from '../utils/feedback.js'
import FEATURES from '../features.js'
import {BucketSeries, ChannelStats, RunningStats, SampleStore} from '../utils/rf-stats.js'
import {ChannelChart, SpectrumChart, TimeChart, fmtDbm} from '../utils/rf-charts.js'

/*
 * RF Tools — flasher-only (the STM32 firmware has no on-device web UI). The bench tools of
 * TitanLRS/src/src/rf_diag.cpp over the USB config API:
 *
 *   RSSI scanner     the radio listens and reports raw RSSI ~1000 times a second, on one channel
 *                    or walking the bound FHSS hop table.
 *   Continuous wave  an unmodulated carrier on one channel at a power-table level or a raw radio
 *                    output.
 *
 * Starting either drops the RF link; Stop reboots the device, which brings it back. Starting one
 * while the other runs switches over. While a tool runs, its setting changes apply straight away.
 */

const POLL_MS = 100
const TIME_WINDOW_S = 30
const RADIO_NAMES = ['Radio 1', 'Radio 2']
// Crystal check thresholds of the ESP web UI's CW page for the LR11xx/LR20xx family (32 MHz XO).
const XO_NOMINAL_HZ = 32000000
const XO_WARN_HZ = 100000
const XO_BAD_HZ = 125000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function bandLabel(band) {
  return band.start >= 1e9 ? '2.4 GHz' : band.start >= 6e8 ? `${Math.round(band.start / 1e8) * 100} MHz` : '433 MHz'
}

function mhz(hz, digits = 3) {
  return (hz / 1e6).toFixed(digits)
}

function fmtBandwidth(hz) {
  return hz >= 1e6 ? `${hz / 1e6} MHz` : `${hz / 1e3} kHz`
}

function fmtMw(mw) {
  return mw >= 1000 ? `${mw / 1000} W` : `${mw} mW`
}

@customElement('rf-tools-panel')
export class RfToolsPanel extends LitElement {
  @state() accessor info = null       // GET /rfdiag
  @state() accessor loadError = ''
  @state() accessor running = null    // the device's tool: 'rssi' | 'cw' | null
  @state() accessor busy = false      // a start / change is in flight
  @state() accessor ending = false
  @state() accessor rssi = null       // {band, channel, hop, radio, bandwidth}
  @state() accessor cw = null         // {band, channel, radio, power, raw-power (null: power table)}
  @state() accessor measured = ''
  @state() accessor tick = 0

  createRenderRoot() {
    return this
  }

  connectedCallback() {
    super.connectedCallback()
    this._resetCapture()
    this._load()
  }

  disconnectedCallback() {
    super.disconnectedCallback()
    this._stopStream()
    clearTimeout(this._rawTimer)
    this._timeChart?.destroy()
    this._channelChart?.destroy()
    this._spectrumChart?.destroy()
    this._revealObserver?.disconnect()
    this._timeChart = this._channelChart = this._spectrumChart = null
  }

  // ---- device ------------------------------------------------------------------------------
  async _load() {
    try {
      const info = await transport.getRfDiag()
      this.info = info
      const st = info.state
      const mode = st.mode === 'off' ? null : st.mode
      const both = info.radios > 1 ? 3 : 1
      this.rssi = {band: st.band, channel: st.channel, hop: st.hop, bandwidth: st.bandwidth,
        radio: mode === 'rssi' ? st.radio : both}
      this.cw = {band: st.band, channel: st.channel, radio: st.radio === 3 ? 1 : st.radio,
        power: st.power, 'raw-power': st['raw-power']}
      this._setRunning(mode, st.since)
    } catch (err) {
      this.loadError = (err && err.message) || 'Could not read the RF tools from the device.'
    }
  }

  _band(id) {
    return this.info?.bands.find((b) => b.id === id) || this.info?.bands[0]
  }

  _freq(bandId, ch) {
    const b = this._band(bandId)
    return b ? b.start + b.spread * ch : 0
  }

  _setRunning(mode, since) {
    const was = this.running
    this.running = mode
    if (mode === 'rssi') {
      if (was !== 'rssi' || since !== this._since) this._resetCapture(since)
      this._startStream()
    } else {
      this._stopStream()
    }
    if (was !== mode) {
      window.dispatchEvent(new CustomEvent('td-rfdiag-state', {detail: {active: !!mode || FEATURES.RF_DIAG_ACTIVE, mode}}))
    }
  }

  /** Send a tool's settings; the device answers with its new state. */
  async _send(mode) {
    this.busy = true
    try {
      const info = await transport.setRfDiag({mode, ...this[mode]})
      this.info = info
      this._setRunning(info.state.mode === 'off' ? null : info.state.mode, info.state.since)
    } catch (err) {
      await errorAlert('RF Tools', (err && err.deviceMessage) || (err && err.message) || 'Request failed')
    } finally {
      this.busy = false
    }
  }

  async _start(mode) {
    const st = this.cw
    const level = this.info['power-levels'].find((l) => l.level === st.power)
    const power = st['raw-power'] !== null ? `${st['raw-power']} dBm at the radio pin` : level ? fmtMw(level.mw) : ''
    const carrier = `It will transmit an unmodulated carrier on ${mhz(this._freq(st.band, st.channel))} MHz at ${power} ` +
      'until stopped, so connect an antenna or a 50&nbsp;Ω load first.'
    let title
    let message
    if (!this.running) {
      if (mode === 'rssi') {
        title = 'Start RSSI scan'
        message = 'Starting a scan will stop this device from transmitting, causing it to lose any active link. ' +
          'Stopping the scan will restart the device and recover the link. Are you sure you want to start the RSSI scan?'
      } else {
        title = 'Start transmitting'
        message = 'Starting continuous wave will stop the RF link, causing this device to lose any active link. ' +
          `${carrier} Stopping will restart the device and recover the link. Are you sure you want to start transmitting?`
      }
    } else if (mode === 'cw') {
      title = 'Start transmitting'
      message = `This will stop the scan. ${carrier} Are you sure you want to start transmitting?`
    }
    if (title) {
      const res = await cuteAlert({
        type: 'question',
        title,
        message,
        confirmText: mode === 'rssi' ? 'Start scan' : 'Start transmitting',
        cancelText: 'Cancel',
      })
      if (res !== 'confirm') return
    }
    await this._send(mode)
  }

  /** A setting changed: keep it, and apply it at once if that tool is running. */
  _change(mode, patch, {defer = false} = {}) {
    const next = {...this[mode], ...patch}
    if (patch.band && patch.band !== this[mode].band) {
      const b = this._band(patch.band)
      next.channel = b.center
      if (mode === 'rssi') next.bandwidth = b['default-bandwidth']
      if (mode === 'cw' && next['raw-power'] !== null) {
        next['raw-power'] = Math.min(b['raw-power'].max, Math.max(b['raw-power'].min, next['raw-power']))
      }
    }
    this[mode] = next
    if (this.running !== mode) return
    clearTimeout(this._rawTimer)
    if (defer) {
      this._rawTimer = setTimeout(() => this._send(mode), 250)
    } else {
      this._send(mode)
    }
  }

  async _end() {
    this.ending = true
    this._stopStream()
    try {
      await transport.endRfDiag()
    } catch (err) {
      this.ending = false
      await errorAlert('RF Tools', (err && err.message) || 'Could not stop the RF tools')
    }
  }

  // ---- RSSI stream -------------------------------------------------------------------------
  _resetCapture(since = this._since ?? 0) {
    this._since = since
    this._next = since
    this._stats = [new RunningStats(), new RunningStats()]
    this._store = this._store || new SampleStore()
    this._store.reset()
    this._buckets = this._buckets || new BucketSeries()
    this._buckets.reset()
    const band = this.rssi && this._band(this.rssi.band)
    this._channels = new ChannelStats(band ? band.count : 0)
    this._radios = 0
    this._hop = false
    this._latestSeq = since
    this._recent = [null, null]
    this._timeChart?.resetRange()
    this._channelChart?.resetRange()
    this.tick++
  }

  _startStream() {
    if (this._streaming) return
    this._streaming = true
    this._loop()
  }

  _stopStream() {
    this._streaming = false
  }

  async _loop() {
    while (this._streaming) {
      let doc
      try {
        doc = await transport.getRfDiagSamples(this._next)
      } catch {
        // the shell's watchdog decides whether the device has gone; just back off
        await sleep(500)
        continue
      }
      if (!this._streaming) break
      if (doc.mode !== 'rssi') {
        this._streaming = false
        break
      }
      this._ingest(doc)
      if (!doc.more) await sleep(POLL_MS)
    }
  }

  _ingest(doc) {
    if (doc.since !== this._since) this._resetCapture(doc.since)
    this._next = doc.next
    const radios = (doc.r1 ? 1 : 0) | (doc.r2 ? 2 : 0)
    this._radios = radios
    this._hop = !!doc.hop
    this._period = doc.period
    const n = doc.next - doc.from
    const fixedCh = this.rssi?.channel ?? 0
    const recentSum = [0, 0]
    let recentN = 0
    for (let k = 0; k < n; k++) {
      const seq = doc.from + k
      if (seq < this._since) continue
      const ch = doc.ch ? doc.ch[k] : fixedCh
      const r1 = doc.r1 ? doc.r1[k] : 0
      const r2 = doc.r2 ? doc.r2[k] : 0
      if (radios & 1) {
        this._stats[0].add(r1)
        recentSum[0] += Math.pow(10, r1 / 10)
        if (doc.hop) this._channels.add(ch, 0, r1)
      }
      if (radios & 2) {
        this._stats[1].add(r2)
        recentSum[1] += Math.pow(10, r2 / 10)
        if (doc.hop) this._channels.add(ch, 1, r2)
      }
      recentN++
      this._store.push(seq, ch, r1, r2)
      this._buckets.add(seq, r1, r2, radios)
    }
    if (recentN) {
      this._recent = recentSum.map((s) => (s ? 10 * Math.log10(s / recentN) : null))
      this._latestSeq = doc.next
    }
    this._pushCharts()
    this.tick++
  }

  _pushCharts() {
    if (this._timeChart) {
      this._timeChart.setData({
        buckets: this._buckets.buckets,
        bucketSamples: this._buckets.bucketSamples,
        periodUs: this._period || 1000,
        radios: this._radios,
        latestSeq: this._latestSeq,
        windowSec: TIME_WINDOW_S,
        names: RADIO_NAMES,
      })
    }
    if (this._channelChart) {
      const bandId = this.rssi.band
      this._channelChart.setData({
        stats: this._channels,
        radios: this._radios,
        freqOf: (ch) => this._freq(bandId, ch),
        names: RADIO_NAMES,
      })
    }
  }

  _exportCsv() {
    const bandId = this.rssi.band
    const radios = this._radios
    const rows = ['seq,time_s,channel,freq_mhz' + (radios & 1 ? ',radio1_dbm' : '') + (radios & 2 ? ',radio2_dbm' : '')]
    const period = (this._period || 1000) / 1e6
    const first = this._store.firstSeq
    this._store.forEach((seq, ch, r1, r2) => {
      rows.push(`${seq},${((seq - first) * period).toFixed(3)},${ch},${mhz(this._freq(bandId, ch))}` +
        (radios & 1 ? `,${r1}` : '') + (radios & 2 ? `,${r2}` : ''))
    })
    const url = URL.createObjectURL(new Blob([rows.join('\n') + '\n'], {type: 'text/csv'}))
    const a = document.createElement('a')
    a.href = url
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    a.download = `rssi-${this._hop ? 'fhss' : `ch${this.rssi.channel}`}-${stamp}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  updated(changed) {
    const timeHost = this.querySelector('#rf-time-chart')
    if (timeHost && this._timeChart?.host !== timeHost) {
      this._timeChart?.destroy()
      this._timeChart = new TimeChart(timeHost)
    } else if (!timeHost && this._timeChart) {
      this._timeChart.destroy()
      this._timeChart = null
    }
    const chHost = this.querySelector('#rf-channel-chart')
    if (chHost && this._channelChart?.host !== chHost) {
      this._channelChart?.destroy()
      this._channelChart = new ChannelChart(chHost)
    } else if (!chHost && this._channelChart) {
      this._channelChart.destroy()
      this._channelChart = null
    }
    const spHost = this.querySelector('#rf-spectrum-chart')
    if (spHost && this._spectrumChart?.host !== spHost) {
      this._spectrumChart?.destroy()
      this._spectrumChart = new SpectrumChart(spHost)
    } else if (!spHost && this._spectrumChart) {
      this._spectrumChart.destroy()
      this._spectrumChart = null
    }
    if (this._spectrumChart) {
      this._spectrumChart.setData({
        freqHz: this._freq(this.cw.band, this.cw.channel),
        dbm: this._cwOutput(),
        maxDbm: Math.max(...this.info['power-levels'].map((l) => 10 * Math.log10(l.mw))),
        band: this._band(this.cw.band),
        series: this.cw.radio === 2 ? 1 : 0,
      })
    }
    if (changed.has('running') && this.running) this._revealCard(this.running)
    this._pushCharts()
  }

  // ---- rendering ---------------------------------------------------------------------------
  render() {
    let body
    if (this.loadError || !this.info) {
      body = html`
        <div class="td-card"><div class="td-card-body td-small td-mute">
          ${this.loadError || 'Reading the device…'}
        </div></div>`
    } else {
      body = html`<div class="rf">${this._rssiCard()}${this._cwCard()}</div>`
    }
    return html`
      <div class="td-row td-spread" style="margin-bottom: var(--td-s-4);">
        <span class="td-h2">RF Tools</span>
      </div>
      ${body}`
  }

  _row(label, control) {
    return html`
      <div class="td-card-row">
        <span class="td-label">${label}</span>
        <div>${control}</div>
      </div>`
  }

  _select(value, options, onPick) {
    return html`
      <select class="td-select" style="width: auto;" ?disabled=${this.busy}
              @change=${(e) => onPick(e.target.value)}>
        ${options.map((o) => html`<option value=${o.value} ?selected=${String(o.value) === String(value)}>${o.label}</option>`)}
      </select>`
  }

  _bandRow(mode) {
    const bands = this.info.bands
    const st = this[mode]
    if (bands.length < 2) return this._row('Band', bandLabel(bands[0]))
    return this._row('Band', this._select(st.band, bands.map((b) => ({value: b.id, label: bandLabel(b)})),
      (v) => this._change(mode, {band: v})))
  }

  _channelOptions(b) {
    return Array.from({length: b.count}, (_, ch) => ({value: ch, label: `${mhz(b.start + b.spread * ch)} MHz`}))
  }

  /** Footer: the tool's Start / Stop button, plus anything that only makes sense while it runs. */
  _statusChip(mode) {
    if (this.running !== mode) return html`<span class="td-chip">Off</span>`
    return mode === 'rssi'
      ? html`<span class="td-chip td-chip-info">Scanning</span>`
      : html`<span class="td-chip td-chip-bad">Transmitting</span>`
  }

  _footer(mode, extra = nothing) {
    const on = this.running === mode
    const blocked = this.info.blocked && !this.running
    let button
    if (on || (this.ending && !this.running)) {
      button = html`
        <button class="td-btn" ?disabled=${this.ending} title="Reboots the device to bring the RF link back"
                @click=${this._end}>${this.ending ? 'Rebooting…' : mode === 'rssi' ? 'Stop scan' : 'Stop transmitting'}</button>`
    } else {
      button = html`
        <button class="td-btn td-btn-primary" ?disabled=${this.busy || this.ending || blocked}
                @click=${() => this._start(mode)}>${mode === 'rssi' ? 'Start scan' : 'Start transmitting'}</button>`
    }
    return html`
      <div class="rf-footer">
        ${blocked ? html`<span class="td-small td-mute">Disarm to use the RF tools.</span>` : extra}
        <div style="flex: 1;"></div>
        ${button}
      </div>`
  }

  // ---- RSSI scanner ------------------------------------------------------------------------
  _rssiCard() {
    const st = this.rssi
    const b = this._band(st.band)
    const on = this.running === 'rssi'
    return html`
      <div class="td-card" id="rf-card-rssi" style="margin-bottom: var(--td-s-4);">
        <div class="td-card-header">
          <span class="td-h4">RSSI scanner</span>
          ${this._statusChip('rssi')}
        </div>
        ${this._bandRow('rssi')}
        ${this._row('Frequency', this._select(st.hop ? 'hop' : st.channel,
          [{value: 'hop', label: `Hop table (all ${b.count})`}, ...this._channelOptions(b)],
          (v) => this._change('rssi', v === 'hop' ? {hop: true} : {hop: false, channel: Number(v)})))}
        ${this.info.radios > 1 ? this._row('Radio', this._select(st.radio,
          [{value: 1, label: 'Radio 1'}, {value: 2, label: 'Radio 2'}, {value: 3, label: 'Both'}],
          (v) => this._change('rssi', {radio: Number(v)}))) : nothing}
        ${this._row('Bandwidth', this._select(st.bandwidth,
          b.bandwidths.map((bw) => ({value: bw, label: fmtBandwidth(bw)})),
          (v) => this._change('rssi', {bandwidth: Number(v)})))}
        ${on ? this._rssiResults(st) : nothing}
        ${this._footer('rssi', on ? html`
          <button class="td-btn" @click=${() => this._resetCapture(this._since)}>Reset</button>
          <button class="td-btn" ?disabled=${!this._store.length} @click=${this._exportCsv}>Export CSV</button>` : nothing)}
      </div>`
  }

  _rssiResults(st) {
    const radios = [0, 1].filter((i) => this._radios & (1 << i))
    const named = this.info.radios > 1
    return html`
      <div class="rf-results">
        <table class="td-table rf-table">
          <thead><tr>
            ${named ? html`<th></th>` : nothing}
            <th>Now</th><th>Average</th><th>Max</th><th>Min</th><th>Samples</th>
          </tr></thead>
          <tbody>
            ${radios.map((i) => {
              const s = this._stats[i]
              return html`<tr>
                ${named ? html`<td class="rf-name"><span class="rf-key" style="background: var(--rf-series-${i + 1})"></span>${RADIO_NAMES[i]}</td>` : nothing}
                <td>${fmtDbm(this._recent[i])} dBm</td>
                <td>${fmtDbm(s.avg)} dBm</td>
                <td>${fmtDbm(s.n ? s.max : null, 0)} dBm</td>
                <td>${fmtDbm(s.n ? s.min : null, 0)} dBm</td>
                <td>${s.n}</td>
              </tr>`
            })}
          </tbody>
        </table>
        ${st.hop ? html`
          <div class="rf-chart" id="rf-channel-chart">
            <canvas role="img" aria-label="Average RSSI per hop channel"></canvas>
            <div class="rf-chart-tip" hidden></div>
          </div>` : html`
          <div class="rf-chart" id="rf-time-chart">
            <canvas role="img" aria-label="RSSI over the last ${TIME_WINDOW_S} seconds"></canvas>
            <div class="rf-chart-tip" hidden></div>
          </div>`}
      </div>`
  }

  // ---- continuous wave ---------------------------------------------------------------------
  _cwCard() {
    const st = this.cw
    const b = this._band(st.band)
    const on = this.running === 'cw'
    const raw = st['raw-power'] !== null
    const rp = b['raw-power']
    const levels = this.info['power-levels']
    return html`
      <div class="td-card" id="rf-card-cw" style="margin-bottom: var(--td-s-4);">
        <div class="td-card-header">
          <span class="td-h4">Continuous wave</span>
          ${this._statusChip('cw')}
        </div>
        ${this._bandRow('cw')}
        ${this._row('Frequency', this._select(st.channel, this._channelOptions(b),
          (v) => this._change('cw', {channel: Number(v)})))}
        ${this.info.radios > 1 ? this._row('Radio', this._select(st.radio,
          [{value: 1, label: 'Radio 1'}, {value: 2, label: 'Radio 2'}],
          (v) => this._change('cw', {radio: Number(v)}))) : nothing}
        ${this._row('Output power', html`
          <div class="rf-inline">
            ${this._select(raw ? 'raw' : st.power, [
              ...levels.map((l) => ({value: l.level, label: fmtMw(l.mw)})),
              {value: 'raw', label: 'Custom Power Value'},
            ], (v) => {
              if (v === 'raw') {
                const idx = Math.max(0, levels.findIndex((l) => l.level === st.power))
                const start = b['power-values'][idx] ?? 0
                this._change('cw', {'raw-power': Math.min(rp.max, Math.max(rp.min, start))})
              } else {
                this._change('cw', {power: Number(v), 'raw-power': null})
              }
            })}
            ${raw ? html`
              <div class="td-input-group" style="width: 120px;">
                <input class="td-input td-input-mono" type="number" min=${rp.min} max=${rp.max} step=${rp.step}
                       title="${fmtDbm(rp.min)} to ${fmtDbm(rp.max)} dBm" .value=${String(st['raw-power'])}
                       @input=${(e) => this._rawInput(e, rp, true)} @change=${(e) => this._rawInput(e, rp, false)}>
                <span class="td-btn" style="cursor: default; background: var(--td-bg-3);">dBm</span>
              </div>` : nothing}
            <span class="td-small td-mute" style="flex: 1 1 260px;">
              The mW levels use the target JSON power values, which assume the PA gain.
              Custom Power Value sets the Semtech radio output directly, pre-PA gain.
            </span>
          </div>`)}
        ${on ? this._crystalRow() : nothing}
        ${on ? html`
          <div class="rf-results">
            <div class="rf-chart" id="rf-spectrum-chart">
              <canvas role="img" aria-label="Carrier at ${mhz(this._freq(st.band, st.channel))} MHz"></canvas>
            </div>
          </div>` : nothing}
        ${this._footer('cw')}
      </div>`
  }

  /** Output power in dBm: at the antenna for a table level, at the radio pin for a custom value. */
  _cwOutput() {
    const st = this.cw
    if (st['raw-power'] !== null) return st['raw-power']
    const level = this.info['power-levels'].find((l) => l.level === st.power)
    return level ? 10 * Math.log10(level.mw) : 0
  }

  /**
   * Starting a tool expands its card downwards; keep its bottom in view. The card grows again
   * when the first samples arrive, so follow it for a moment rather than scrolling once.
   */
  _revealCard(mode) {
    const card = this.querySelector(`#rf-card-${mode}`)
    if (!card) return
    this._revealObserver?.disconnect()
    const reveal = () => card.querySelector('.rf-footer')?.scrollIntoView({block: 'nearest', behavior: 'smooth'})
    this._revealObserver = new ResizeObserver(reveal)
    this._revealObserver.observe(card)
    setTimeout(() => this._revealObserver?.disconnect(), 1500)
  }

  _rawInput(e, rp, typing) {
    const v = Number(e.target.value)
    if (!Number.isFinite(v) || e.target.value === '') return
    const clamped = Math.min(rp.max, Math.max(rp.min, Math.round(v * 2) / 2))
    if (!typing) e.target.value = String(clamped)
    if (typing && clamped !== v) return
    this._change('cw', {'raw-power': clamped}, {defer: typing})
  }

  _crystalRow() {
    const freq = this._freq(this.cw.band, this.cw.channel)
    const measuredHz = Number(this.measured) * 1e6
    let result = nothing
    if (this.measured !== '' && Number.isFinite(measuredHz) && measuredHz > 0) {
      const shift = measuredHz - freq
      const xo = measuredHz / freq * XO_NOMINAL_HZ
      const ppm = (xo - XO_NOMINAL_HZ) / (XO_NOMINAL_HZ / 1e6)
      const verdict = Math.abs(shift) < XO_WARN_HZ ? html`<span class="td-chip td-chip-ok">Good</span>`
        : Math.abs(shift) < XO_BAD_HZ ? html`<span class="td-chip td-chip-warn">Marginal</span>`
          : html`<span class="td-chip td-chip-bad">Out of range</span>`
      result = html`
        <span class="td-mono td-small">${(shift / 1000).toFixed(1)} kHz, ${ppm.toFixed(2)} ppm</span>
        ${verdict}`
    }
    return this._row('Crystal check', html`
      <div class="rf-inline">
        <div class="td-input-group" style="width: 180px;">
          <input class="td-input td-input-mono" type="number" inputmode="decimal" step="0.000001"
                 placeholder=${mhz(freq, 6)} .value=${this.measured}
                 @input=${(e) => { this.measured = e.target.value }}>
          <span class="td-btn" style="cursor: default; background: var(--td-bg-3);">MHz</span>
        </div>
        ${result}
      </div>`)
  }
}
