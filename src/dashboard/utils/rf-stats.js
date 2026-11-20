/*
 * rf-stats.js — bookkeeping for the RSSI scanner (rf-tools-panel.js).
 *
 * Samples arrive from GET /rfdiag/samples as whole dBm per radio, ~1 kHz, each tagged with its
 * sequence number (and FHSS channel index when hopping). Averages are taken in the power domain:
 * the mean of a fluctuating noise floor in dB sits ~2.5 dB under its true power, and averaging
 * in mW is what a power meter or spectrum analyser channel-power reading does.
 */

export const dbmToMw = (dbm) => Math.pow(10, dbm / 10)
export const mwToDbm = (mw) => 10 * Math.log10(mw)

/** Running statistics for one radio since the last reset. */
export class RunningStats {
  constructor() { this.reset() }

  reset() {
    this.n = 0
    this.sumMw = 0
    this.sumDb = 0
    this.sumSqDb = 0
    this.max = -Infinity
    this.min = Infinity
    this.last = null
  }

  add(dbm) {
    this.n++
    this.sumMw += dbmToMw(dbm)
    this.sumDb += dbm
    this.sumSqDb += dbm * dbm
    if (dbm > this.max) this.max = dbm
    if (dbm < this.min) this.min = dbm
    this.last = dbm
  }

  get avg() { return this.n ? mwToDbm(this.sumMw / this.n) : null }

  get std() {
    if (this.n < 2) return null
    const mean = this.sumDb / this.n
    return Math.sqrt(Math.max(0, this.sumSqDb / this.n - mean * mean))
  }
}

/**
 * Every sample since the last reset (up to `capacity`), for windowed statistics and the CSV
 * export. Fixed typed arrays used as a ring, so a long capture costs no allocations.
 */
export class SampleStore {
  constructor(capacity = 600000) {
    this.capacity = capacity
    this.ch = new Uint8Array(capacity)
    this.r = [new Int16Array(capacity), new Int16Array(capacity)]
    this.reset()
  }

  reset() {
    this.start = 0      // ring index of the oldest sample
    this.length = 0
    this.firstSeq = 0   // sequence number of the oldest sample
  }

  push(seq, ch, r1, r2) {
    if (this.length === 0) this.firstSeq = seq
    const i = (this.start + this.length) % this.capacity
    this.ch[i] = ch
    this.r[0][i] = r1
    this.r[1][i] = r2
    if (this.length < this.capacity) {
      this.length++
    } else {
      this.start = (this.start + 1) % this.capacity
      this.firstSeq++
    }
  }

  /** Power mean and dB standard deviation of the newest `count` samples of radio `idx`. */
  window(idx, count) {
    const n = Math.min(count, this.length)
    if (!n) return {avg: null, std: null, n: 0}
    const values = this.r[idx]
    let sumMw = 0
    let sum = 0
    let sumSq = 0
    for (let k = this.length - n; k < this.length; k++) {
      const v = values[(this.start + k) % this.capacity]
      sumMw += dbmToMw(v)
      sum += v
      sumSq += v * v
    }
    const mean = sum / n
    return {
      avg: mwToDbm(sumMw / n),
      std: n > 1 ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : null,
      n,
    }
  }

  forEach(cb) {
    for (let k = 0; k < this.length; k++) {
      const i = (this.start + k) % this.capacity
      cb(this.firstSeq + k, this.ch[i], this.r[0][i], this.r[1][i])
    }
  }
}

/**
 * The time chart's points: samples folded into fixed buckets (min, max and power mean per radio),
 * so a minute at 1 kHz draws as a few hundred points with its full envelope.
 */
export class BucketSeries {
  constructor(bucketSamples = 50, maxBuckets = 1300) {
    this.bucketSamples = bucketSamples
    this.maxBuckets = maxBuckets
    this.reset()
  }

  reset() {
    this.buckets = []
  }

  add(seq, r1, r2, radios) {
    const key = Math.floor(seq / this.bucketSamples)
    let b = this.buckets[this.buckets.length - 1]
    if (!b || b.key !== key) {
      b = {key, n: 0, min: [Infinity, Infinity], max: [-Infinity, -Infinity], sumMw: [0, 0]}
      this.buckets.push(b)
      if (this.buckets.length > this.maxBuckets) this.buckets.shift()
    }
    b.n++
    const values = [r1, r2]
    for (let i = 0; i < 2; i++) {
      if (!(radios & (1 << i))) continue
      const v = values[i]
      if (v < b.min[i]) b.min[i] = v
      if (v > b.max[i]) b.max[i] = v
      b.sumMw[i] += dbmToMw(v)
    }
  }
}

/** Per-channel statistics while walking the FHSS hop table. */
export class ChannelStats {
  constructor(count = 0) { this.resize(count) }

  resize(count) {
    this.count = count
    this.reset()
  }

  reset() {
    const make = (fill) => [new Float64Array(this.count).fill(fill), new Float64Array(this.count).fill(fill)]
    this.n = [new Uint32Array(this.count), new Uint32Array(this.count)]
    this.sumMw = make(0)
    this.max = make(-Infinity)
    this.min = make(Infinity)
    this.last = make(NaN)
  }

  add(ch, idx, dbm) {
    if (ch >= this.count) return
    this.n[idx][ch]++
    this.sumMw[idx][ch] += dbmToMw(dbm)
    if (dbm > this.max[idx][ch]) this.max[idx][ch] = dbm
    if (dbm < this.min[idx][ch]) this.min[idx][ch] = dbm
    this.last[idx][ch] = dbm
  }

  avg(idx, ch) {
    const n = this.n[idx][ch]
    return n ? mwToDbm(this.sumMw[idx][ch] / n) : null
  }

  /** The channel with the highest average for radio `idx`, or -1 before any sample. */
  loudest(idx) {
    let best = -1
    let bestAvg = -Infinity
    for (let ch = 0; ch < this.count; ch++) {
      const a = this.avg(idx, ch)
      if (a !== null && a > bestAvg) {
        bestAvg = a
        best = ch
      }
    }
    return best
  }
}
