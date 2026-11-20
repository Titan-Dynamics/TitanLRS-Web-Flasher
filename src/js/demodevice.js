/*
 * demodevice.js — the configurator's demo device: a MockTransport that stands in for a TitanLRS
 * device, for the connect panel's "Try a demo" buttons and for hardware-free dashboard
 * development (?dashboard&mock=tx|rx opens it straight away).
 *
 * The TX and RX are the Titan Dynamics LR2021 STM32H7 Gemini targets from the targets repo
 * (TitanLRS/src/hardware), as unified STM32 builds report themselves over USB, both in MAVLink
 * mode. The receiver the TX reaches over the air is a RadioMaster XR4 (ESP32): ESP devices have
 * no config API, so it only ever appears there, on the TX's Parameters tab.
 *
 * Only DeviceDashboard.vue imports this, and lazily, so none of it ships in the main bundle.
 */

import {CRSF} from './crsf.js'
import {
  DeviceError, ERR_BAD_REQUEST, ERR_BUSY,
  FEATURE_CRSF_PARAMS, FEATURE_DFU, FEATURE_HARDWARE_WRITE, FEATURE_OPTIONS_WRITE, FEATURE_RF_DIAG, PROTOCOL_VERSION,
} from './usbconfig.js'

/*
 * The CRSF ("LUA") parameter trees, generated from a little state the way the firmware's
 * TXModuleParameters.cpp / RXParameters.cpp build theirs: folder names that embed values, options
 * blanked rather than removed (MAVLink, other RF bands), rows hidden by other settings. Each tree
 * is rebuilt on every read, so a write shows up wherever it is reflected. Parameter numbers are
 * registration order; entry 0 is the root folder, which is never sent.
 */
const P = CRSF

// LR2021 packet rates: string index i is rate (23 - i). X-Band 0-1, 2.4 GHz 2-14, sub-GHz 15-23.
const TX_RATES = [
  '100Hz Full(-112dBm)', '150Hz(-112dBm)',
  '50Hz(-115dBm)', '100Hz Full(-112dBm)', '150Hz(-112dBm)', '250Hz(-108dBm)', '333Hz Full(-105dBm)',
  '500Hz(-105dBm)', 'DK250(-103dBm)', 'DK500(-103dBm)', 'K1000(-103dBm)', 'D250(-104dBm)',
  'D500(-104dBm)', 'F500(-104dBm)', 'F1000(-104dBm)',
  'D50Hz(-112dBm)', '25Hz(-123dBm)', '50Hz(-120dBm)', '100Hz(-117dBm)', '100Hz Full(-112dBm)',
  '200Hz(-112dBm)', '200Hz Full(-111dBm)', '250Hz(-111dBm)', 'K1000 Full(-101dBm)',
]
const TX_RATE_BANDS = [[15, 23], [2, 14], [0, 1]]       // per RF Band option
const TX_RATE_DEFAULTS = [20, 5, 1]                       // 200Hz, 250Hz, 150Hz
const TX_POWERS = ['10', '25', '50', '100']
const TX_DYNAMIC = ['Off', 'Dyn', 'AUX9', 'AUX10', 'AUX11', 'AUX12']
const TLM_RATIOS = ['Std', 'Off', '1:128', '1:64', '1:32', '1:16', '1:8', '1:4', '1:2', 'Race']
const TLM_MAVLINK = 8                                     // MAVLink forces 1:2
const VTX_BANDS = ['Disabled', 'A', 'B', 'E', 'F', 'R', 'L']
const VTX_POWERS = ['-', '1', '2', '3', '4', '5', '6', '7', '8']
// AUXn up / down, as the firmware sends them: 0xC0 and 0xC1 (the Lua draws them as arrows).
const VTX_PITMODES = ['Off', 'On'].concat(...Array.from({length: 12}, (_, i) =>
  [`AUX${i + 1}À`, `AUX${i + 1}Á`]))

function rateHz(label) { return Number((/(\d+)/.exec(label) || [0, 0])[1]) }
function rateIsFull(label) { return label.includes('Full') }

/** Only the options in [first, last] survive; the rest stay as empty slots. */
function blankOutside(list, first, last) {
  return list.map((o, i) => (i >= first && i <= last ? o : ''))
}

/** Telem Ratio's units: the standard ratio, or the telemetry bandwidth the ratio gives. */
function tlmUnits(ratioIdx, label) {
  const hz = rateHz(label)
  if (ratioIdx === 1 || ratioIdx === 9) return ''         // Off, Race
  if (ratioIdx === 0) return ` (1:${hz <= 50 ? 16 : hz <= 150 ? 32 : hz <= 250 ? 64 : 128})`
  const ratio = [0, 0, 128, 64, 32, 16, 8, 4, 2][ratioIdx]
  const burst = Math.max(1, Math.floor(512 * hz / (ratio * 1000)) - 1)
  const bytesPerCall = rateIsFull(label) ? 10 : 5
  return ` (${Math.floor(bytesPerCall * 8 * burst * hz / ratio / (burst + 1))}bps)`
}

function versionInfo(settings) {
  const name = `${settings.version} ${settings.reg_domain_low}/${settings.reg_domain_high}`.slice(0, 26)
  return {type: P.PARAM_TYPE_INFO, name, value: settings['git-commit']}
}

const command = (name) => ({type: P.PARAM_TYPE_COMMAND, name, status: 0, timeout: 200, value: ''})
const select = (name, options, value, unit = '') =>
  ({type: P.PARAM_TYPE_TEXT_SELECTION, name, options, value, unit})

/**
 * The TD LR2021 STM32H7 Gemini TX (TXModuleParameters.cpp): dual band plus X-Band (Gemini), no
 * WiFi / BLE / backpack / fan, in MAVLink link mode.
 */
function txTree(st, settings) {
  const [first, last] = TX_RATE_BANDS[st.band]
  const rate = TX_RATES[st.rate[st.band]]
  const mavlink = st.linkMode === 1
  const xband = st.band === 2
  const full = rateIsFull(rate)
  const tlm = mavlink ? TLM_MAVLINK : st.tlmRatio
  const switchOptions = full ? ['8ch', '16ch Rate/2', '12ch Mixed'] : ['Wide', 'Hybrid']
  const dyn = st.dynamic ? ' ' + TX_DYNAMIC[st.dynamic] : ''
  const vtxName = st.vtxBand === 0 ? 'VTX Administrator'
    : `VTX Admin (${VTX_BANDS[st.vtxBand]}:${st.vtxChannel + 1}` +
      (st.vtxPower ? `:${VTX_POWERS[st.vtxPower]}` + (st.vtxPit === 1 ? ':P' : st.vtxPit > 1 ? ':' + VTX_PITMODES[st.vtxPit] : '') : '') + ')'
  return [
    null,
    select('RF Band', [/\d+/.exec(settings.reg_domain_low)[0] + 'MHz', '2.4GHz', 'X-Band'], st.band),
    select('Packet Rate', blankOutside(TX_RATES, first, last), st.rate[st.band]),
    // MAVLink owns the telemetry ratio and the switch mode: the other choices are blanked.
    select('Telem Ratio', mavlink ? blankOutside(TLM_RATIOS, TLM_MAVLINK, TLM_MAVLINK) : TLM_RATIOS,
           tlm, tlmUnits(tlm, rate)),
    select('Switch Mode', mavlink ? blankOutside(switchOptions, 1, 1) : switchOptions,
           mavlink ? 1 : Math.min(st.switchMode, switchOptions.length - 1)),
    select('Antenna Mode', xband ? ['Gemini', '', '', ''] : ['Gemini', 'Ant 1', 'Ant 2', 'Switch'],
           xband ? 0 : st.antenna),
    select('Link Mode', ['Normal', 'MAVLink'], st.linkMode),
    select('Model Match', ['Off', 'On'], st.modelMatch, ' (ID: 0)'),
    {type: P.PARAM_TYPE_FOLDER, name: `TX Power (${TX_POWERS[st.maxPower]}mW${dyn})`},
    {...select('Max Power', TX_POWERS, st.maxPower, 'mW'), parent: 8},
    {...select('Dynamic', TX_DYNAMIC, st.dynamic), parent: 8},
    {type: P.PARAM_TYPE_FOLDER, name: vtxName},
    {...select('Band/Enable', VTX_BANDS, st.vtxBand), parent: 11},
    {type: P.PARAM_TYPE_UINT8, name: 'Channel', value: st.vtxChannel + 1, min: 1, max: 8, def: 0,
     unit: '', parent: 11, hidden: st.vtxBand === 0},
    {...select('Pwr Lvl', VTX_POWERS, st.vtxPower), parent: 11, hidden: st.vtxBand === 0},
    {...select('Pitmode', VTX_PITMODES, st.vtxPit), parent: 11, hidden: st.vtxBand === 0 || st.vtxPower === 0},
    {...command('Send VTx'), parent: 11},
    {type: P.PARAM_TYPE_FOLDER, name: 'WiFi Connectivity'},
    {...command('Enable Rx WiFi'), parent: 17},
    command('Bind'),
    versionInfo(settings),
  ]
}

function txWrite(st, name, value) {
  switch (name) {
    case 'RF Band':
      st.band = value
      if (value === 2) st.antenna = 0           // X-Band runs both radios: Gemini only
      break
    case 'Packet Rate': st.rate[st.band] = value; break
    case 'Telem Ratio': if (st.linkMode === 0) st.tlmRatio = value; break
    case 'Switch Mode': if (st.linkMode === 0) st.switchMode = value; break
    case 'Antenna Mode': st.antenna = value; break
    case 'Link Mode': st.linkMode = value; break
    case 'Model Match': st.modelMatch = value; break
    case 'Max Power': st.maxPower = value; break
    case 'Dynamic': st.dynamic = value; break
    case 'Band/Enable': st.vtxBand = value; break
    case 'Channel': st.vtxChannel = Math.min(Math.max(value, 1), 8) - 1; break
    case 'Pwr Lvl': st.vtxPower = value; break
    case 'Pitmode': st.vtxPit = value; break
  }
}

function txInitialState() {
  return {band: 0, rate: TX_RATE_DEFAULTS.slice(), tlmRatio: 0, switchMode: 1, antenna: 0,
          linkMode: 1, modelMatch: 0, maxPower: 0, dynamic: 0,
          vtxBand: 0, vtxChannel: 0, vtxPower: 0, vtxPit: 0}
}

/**
 * A receiver's tree (RXParameters.cpp). Neither receiver here has PWM outputs or an antenna
 * switch, so those rows are never registered; Protocol2 is ESP32-only and needs serial1 pins, so
 * only the XR4 has it. Folder parents are worked out after the optional rows, as registration
 * numbers them. `cfg` is the receiver's config document, so Protocol and the Serial tab are the
 * same setting.
 */
function rxTree(st, cfg, settings) {
  const mavlink = cfg['serial-protocol'] === 7
  const tree = [
    null,
    select('Protocol', ['CRSF', 'Inverted CRSF', 'SBUS', 'Inverted SBUS', 'SUMD', 'DJI RS Pro',
                        'HoTT Telemetry', 'MAVLink', 'DisplayPort', 'GPS', 'Scorpion'], cfg['serial-protocol']),
    ...(cfg['serial1-protocol'] === undefined ? [] : [
      select('Protocol2', ['Off', 'CRSF', 'Inverted CRSF', 'SBUS', 'Inverted SBUS', 'SUMD', 'DJI RS Pro',
                           'HoTT Telemetry', 'Tramp', 'SmartAudio', 'DisplayPort', 'GPS', 'Scorpion'], cfg['serial1-protocol'])]),
    select('SBUS failsafe', ['No Pulses', 'Last Pos'], cfg['sbus-failsafe']),
    {type: P.PARAM_TYPE_UINT8, name: 'Target SysID', value: st.targetSysId, min: 1, max: 255, def: 0,
     unit: '', hidden: !mavlink},
    {type: P.PARAM_TYPE_UINT8, name: 'Source SysID', value: st.sourceSysId, min: 1, max: 255, def: 0,
     unit: '', hidden: !mavlink},
    select('Tlm Power', ['10', '25', '50', '100', 'MatchTX '], st.tlmPower, 'mW'),
    {type: P.PARAM_TYPE_FOLDER, name: 'Team Race'},
  ]
  const teamRace = tree.length - 1
  tree.push(
    {...select('Channel', ['AUX2', 'AUX3', 'AUX4', 'AUX5', 'AUX6', 'AUX7', 'AUX8', 'AUX9', 'AUX10',
                           'AUX11', 'AUX12'], st.teamChannel), parent: teamRace},
    {...select('Position', ['Disabled', '1/Low', '2', '3', 'Mid', '4', '5', '6/High'], st.teamPosition), parent: teamRace},
    select('Bind Storage', ['Persistent', 'Volatile', 'Returnable', 'Administered'], cfg.vbind),
    command('Enter Bind Mode'),
    {type: P.PARAM_TYPE_INFO, name: 'Model Id', value: cfg.modelid === 255 ? 'Off' : String(cfg.modelid)},
    versionInfo(settings),
  )
  return tree
}

function rxWrite(st, cfg, name, value) {
  switch (name) {
    case 'Protocol': cfg['serial-protocol'] = value; break
    case 'Protocol2': cfg['serial1-protocol'] = value; break
    case 'SBUS failsafe': cfg['sbus-failsafe'] = value; break
    case 'Target SysID': st.targetSysId = value; break
    case 'Source SysID': st.sourceSysId = value; break
    case 'Tlm Power': st.tlmPower = value; break
    case 'Channel': st.teamChannel = value; break
    case 'Position': st.teamPosition = value; break
    case 'Bind Storage': cfg.vbind = value; break
  }
}

/** Tlm Power starts at the layout's power_default: 10mW on the TD RX, 100mW on the XR4. */
function rxInitialState(tlmPower) {
  return {targetSysId: 1, sourceSysId: 255, tlmPower, teamChannel: 5, teamPosition: 0}
}

/** CRSFEndpoint.cpp's serialisation of one parameter (the type byte carries the hidden bit). */
function mockEncodeParam(p, tree, number) {
  const bytes = [p.parent || 0, p.type | (p.hidden ? P.PARAM_HIDDEN : 0)]
  const pushStr = (str) => { for (const ch of String(str || '')) bytes.push(ch.charCodeAt(0) & 0xFF); bytes.push(0) }
  pushStr(p.name)
  switch (p.type) {
    case P.PARAM_TYPE_TEXT_SELECTION:
      pushStr(p.options.join(';'))
      bytes.push(p.value, 0, p.options.length - 1, 0)
      pushStr(p.unit)
      break
    case P.PARAM_TYPE_UINT8:
      bytes.push(p.value, p.min, p.max, p.def)
      pushStr(p.unit)
      break
    case P.PARAM_TYPE_COMMAND:
      bytes.push(p.status, p.timeout)
      pushStr(p.value)
      break
    case P.PARAM_TYPE_INFO:
    case P.PARAM_TYPE_STRING:
      pushStr(p.value)
      break
    case P.PARAM_TYPE_FOLDER:
      // The child list, 0xFF-terminated.
      tree.forEach((c, i) => { if (c && (c.parent || 0) === number) bytes.push(i) })
      bytes.push(0xFF)
      break
  }
  return new Uint8Array(bytes)
}

// What the firmware puts in one PARAMETER_SETTINGS_ENTRY frame after the number / chunk bytes.
const MOCK_CHUNK_SIZE = 56

const MOCK_VERSION = '4.3.0-TD'

// FHSS.cpp `domains[]`, indexed by options.domain.
const MOCK_DOMAINS = ['AU915', 'FCC915', 'EU868', 'IN866', 'AU433', 'EU433', 'US433', 'US433W', 'TH920']

function mockDocument(isTx) {
  const options = {
    customised: false,
    uid: [1, 2, 3, 4, 5, 6],
    'tlm-interval': 240,
    'fan-runtime': 30,
    'is-airport': false,
    'rcvr-uart-baud': 420000,
    'airport-uart-baud': 9600,
    'lock-on-first-connection': true,
    domain: MOCK_DOMAINS.indexOf('FCC915'),
    'flash-discriminator': 12345,
  }
  if (isTx) {
    return {
      settings: {
        product_name: 'Titan Dynamics LR2021 STM32H7 TX Gemini',
        lua_name: 'TD LR2021 G TX',
        uidtype: 'Flashed',
        mode: 'USB',
        custom_hardware: false,
        has_low_band: true,
        has_high_band: true,
        reg_domain_low: MOCK_DOMAINS[options.domain],
        reg_domain_high: 'ISM2G4',
        target: 'Unified_STM32H743_LR2021_TX',
        version: MOCK_VERSION,
        'git-commit': '3c7a91',
        'module-type': 'TX',
        'radio-type': 'LR2021',
      },
      // No 'wifi-on-interval' / 'wifi-ssid': STM32 has no WiFi and lib/ConfigJson omits the keys.
      options,
      config: {
        uid: options.uid.slice(),
        'button-actions': [
          {color: 255, action: [{'is-long-press': false, count: 3, action: 6},
                                {'is-long-press': true, count: 5, action: 1}]},
        ],
        'gcs-override': {enabled: false, channel: 16, mask: 0x000F},
      },
    }
  }
  return {
    settings: {
      product_name: 'Titan Dynamics LR2021 STM32H7 RX Gemini',
      lua_name: 'TD LR2021 G RX',
      uidtype: 'Bound',
      mode: 'USB',
      custom_hardware: false,
      has_low_band: true,
      has_high_band: true,
      reg_domain_low: MOCK_DOMAINS[options.domain],
      reg_domain_high: 'ISM2G4',
      has_serial_pins: true,
      target: 'Unified_STM32H743_LR2021_RX',
      version: MOCK_VERSION,
      'git-commit': '3c7a91',
      'module-type': 'RX',
      'radio-type': 'LR2021',
    },
    options,
    // No 'serial1-protocol': lib/ConfigJson drops it on STM32 (it is ESP32-only).
    config: {
      uid: options.uid.slice(),
      modelid: 255,
      'force-tlm': false,
      'serial-protocol': 7,          // MAVLink
      'sbus-failsafe': 0,
      vbind: 0,
    },
  }
}

/* TD LR2021 STM32H7 Gemini TX.json, as a unified STM32 build reports it. */
const MOCK_TX_HARDWARE = {
  serial_rx: 'PB10', serial_tx: 'PB10',
  radio_nss: 'PE0', radio_sck: 'PE12', radio_miso: 'PE13', radio_mosi: 'PE14',
  radio_rst: 'PE7', radio_dio1: 'PE1', radio_busy: 'PE9',
  radio_nss_2: 'PE8', radio_rst_2: 'PE5', radio_dio1_2: 'PE6', radio_busy_2: 'PE15',
  radio_dcdc: true,
  config_flash_cs: 'PD6', config_flash_sck: 'PB3', config_flash_miso: 'PB4', config_flash_mosi: 'PD7',
  led: 'PE3', led_red_invert: true,
  button: 'PE2', button_active_high: true,
  power_min: 0, power_high: 3, power_max: 3, power_default: 0,
  power_control: 0,
  power_values: [19, 25, 31, 37],
  power_values2: [19, 25, 31, 37],
  power_values_dual: [0, 8, 16, 24],
}

/* TD LR2021 STM32H7 Gemini RX.json: the TX's board, with a full-duplex serial port. */
const MOCK_RX_HARDWARE = {...MOCK_TX_HARDWARE, serial_rx: 'PB11', serial_tx: 'PB10'}

/*
 * The receiver the demo TX is linked to, as its Parameters tab reaches it over the air: a
 * RadioMaster XR4 (ESP32, LR1121 true diversity) with a second UART, in MAVLink mode. Only its
 * CRSF tree is simulated: it has no config API of its own.
 */
const MOCK_XR4 = {
  name: 'RM XR4',
  power_default: 3,
  config: {modelid: 255, 'serial-protocol': 7, 'serial1-protocol': 0, 'sbus-failsafe': 0, vbind: 0},
}

/*
 * The RF diagnostics (GET/POST /rfdiag, /rfdiag/samples) of src/rf_diag.cpp, with a made-up RF
 * environment so the RSSI scanner has something to show: a noise floor that follows the receive
 * bandwidth, a steady carrier near the middle of each band, bursty Wi-Fi-like energy low in 2.4 GHz
 * and an intermittent weak signal on sub-GHz. Radio 2 sees the same air with its own noise and a
 * slightly different gain. `&armed` makes the device refuse to start, as an armed module does.
 */
const MOCK_SUBGHZ_DOMAINS = {
  AU915: [915500000, 926900000, 20],
  FCC915: [903500000, 926900000, 40],
  EU868: [863275000, 869575000, 13],
  IN866: [865375000, 866950000, 4],
  AU433: [433420000, 434420000, 3],
  EU433: [433100000, 434450000, 3],
  US433: [433250000, 438000000, 8],
  US433W: [423500000, 438000000, 20],
  TH920: [920500000, 924500000, 8],
}
const MOCK_RF_PERIOD_US = 1000
const MOCK_RF_RING = 4096
const MOCK_RF_MAX_RESPONSE = 400
const MOCK_POWER_MW = [10, 25, 50, 100, 250, 500, 1000, 2000]

function mockBand(id, domain, [start, stop, count], hardware) {
  const high = id === 'high'
  const values = high ? hardware.power_values_dual : hardware.power_values
  return {
    id, domain, start, stop, count,
    spread: Math.round((stop - start) / (count - 1)),
    center: Math.floor(count / 2),
    sequence: count * Math.floor(256 / count),
    bandwidths: high ? [62500, 500000, 812000] : [62500, 500000],
    'default-bandwidth': high ? 812000 : 500000,
    'raw-power': high ? {min: -19.5, max: 12, step: 0.5} : {min: -22, max: 22, step: 0.5},
    'power-values': values.slice(hardware.power_min, hardware.power_max + 1).map((v) => v / 2),
  }
}

class MockRfDiag {
  constructor(settings, hardware) {
    this.hardware = hardware
    this.settings = settings
    this.state = null
    this.seq = 0
    this.since = 0
    this.ring = []
    this.lastMs = 0
    this.hop = 0
    this.sequences = {}
  }

  get active() { return this.state !== null }

  bands() {
    const low = this.settings.reg_domain_low || 'FCC915'
    return [
      mockBand('low', low, MOCK_SUBGHZ_DOMAINS[low] || MOCK_SUBGHZ_DOMAINS.FCC915, this.hardware),
      mockBand('high', 'ISM2G4', [2400400000, 2479400000, 80], this.hardware),
    ]
  }

  band(id) { return this.bands().find((b) => b.id === id) }

  defaults() {
    const b = this.band('low')
    return {mode: 'off', band: 'low', channel: b.center, hop: false, radio: 1, bandwidth: b['default-bandwidth'],
      power: this.hardware.power_min, 'raw-power': null}
  }

  describe() {
    const cur = this.state || this.defaults()
    const b = this.band(cur.band)
    return {
      active: this.active,
      ...(!this.active && new URLSearchParams(window.location.search).has('armed') ? {blocked: 'module is armed'} : {}),
      radios: 2,
      'sample-period-us': MOCK_RF_PERIOD_US,
      bands: this.bands(),
      'power-levels': MOCK_POWER_MW.slice(this.hardware.power_min, this.hardware.power_max + 1)
        .map((mw, i) => ({level: this.hardware.power_min + i, mw})),
      state: {...cur, freq: b.start + b.spread * cur.channel, since: this.since},
    }
  }

  apply(req) {
    if (!this.active && new URLSearchParams(window.location.search).has('armed')) {
      throw new DeviceError(ERR_BUSY, 'module is armed')
    }
    const next = {...(this.state || this.defaults())}
    if (req.mode !== 'rssi' && req.mode !== 'cw') throw new DeviceError(ERR_BAD_REQUEST, 'mode must be "rssi" or "cw"')
    next.mode = req.mode
    if (req.band !== undefined && req.band !== next.band) {
      const b = this.band(req.band)
      if (!b) throw new DeviceError(ERR_BAD_REQUEST, 'band not available on this hardware')
      next.band = req.band
      next.channel = b.center
      if (!b.bandwidths.includes(next.bandwidth)) next.bandwidth = b['default-bandwidth']
    }
    const b = this.band(next.band)
    for (const key of ['channel', 'hop', 'radio', 'bandwidth', 'power', 'raw-power']) {
      if (req[key] !== undefined) next[key] = req[key]
    }
    if (next.channel < 0 || next.channel >= b.count) throw new DeviceError(ERR_BAD_REQUEST, 'channel out of range')
    if (next.mode === 'cw' && next.radio === 3) {
      if (req.radio !== undefined) throw new DeviceError(ERR_BAD_REQUEST, 'continuous wave runs on one radio at a time')
      next.radio = 1
    }
    if (!b.bandwidths.includes(next.bandwidth)) throw new DeviceError(ERR_BAD_REQUEST, 'bandwidth not available on this band')
    const raw = next['raw-power']
    if (raw !== null && (raw < b['raw-power'].min || raw > b['raw-power'].max)) next['raw-power'] = null
    this.state = next
    this.since = this.seq
    this.hop = 0
    this.lastMs = performance.now()
    return this.describe()
  }

  _sequence(band) {
    if (!this.sequences[band.id]) {
      // a fixed shuffle, standing in for the UID-seeded hop table
      let seed = band.count * 7919
      const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
      const seq = []
      for (let rep = 0; rep < Math.floor(256 / band.count); rep++) {
        const block = [...Array(band.count).keys()]
        for (let i = block.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          [block[i], block[j]] = [block[j], block[i]]
        }
        seq.push(...block)
      }
      this.sequences[band.id] = seq
    }
    return this.sequences[band.id]
  }

  _rssi(freq, bandwidth, radio, tMs, band) {
    const mw = (dbm) => Math.pow(10, dbm / 10)
    const floor = -174 + 10 * Math.log10(bandwidth) + (radio === 2 ? 6.2 : 5.5)
    // the RSSI estimator averages over a short window, so the floor wobbles by a few dB
    let noise = 0
    for (let k = 0; k < 4; k++) noise -= Math.log(Math.random() || 1e-9)
    let power = mw(floor) * noise / 4
    const inBand = (f, width = 0) => Math.abs(freq - f) <= bandwidth / 2 + width / 2
    const gain = radio === 2 ? 1.5 : 0
    const centre = band.start + band.spread * band.center
    if (freq < 1e9) {
      if (inBand(centre)) power += mw(-63 + gain + Math.random() * 0.8)
      if (inBand(band.start + band.spread * Math.floor(band.count / 5)) && (tMs % 900) < 280) power += mw(-96 + gain + Math.random() * 3)
    } else {
      if (inBand(2412000000, 20e6) && Math.random() < 0.35) power += mw(-79 + gain - Math.abs(freq - 2412e6) / 2e6 + Math.random() * 6)
      if (inBand(centre)) power += mw(-71 + gain + Math.random() * 0.8)
    }
    return Math.round(10 * Math.log10(power))
  }

  _generate() {
    const now = performance.now()
    let n = Math.floor((now - this.lastMs) * 1000 / MOCK_RF_PERIOD_US)
    if (n <= 0) return
    this.lastMs += n * MOCK_RF_PERIOD_US / 1000
    n = Math.min(n, MOCK_RF_RING)
    const st = this.state
    const b = this.band(st.band)
    const sequence = this._sequence(b)
    for (let k = 0; k < n; k++) {
      const ch = st.hop ? sequence[this.hop] : st.channel
      const freq = b.start + b.spread * ch
      const t = this.seq * MOCK_RF_PERIOD_US / 1000
      this.ring.push({
        ch,
        r1: st.radio & 1 ? this._rssi(freq, st.bandwidth, 1, t, b) : 0,
        r2: st.radio & 2 ? this._rssi(freq, st.bandwidth, 2, t, b) : 0,
      })
      if (this.ring.length > MOCK_RF_RING) this.ring.shift()
      this.seq++
      if (st.hop) this.hop = (this.hop + 1) % sequence.length
    }
  }

  samples(from) {
    const st = this.state
    const rssi = st && st.mode === 'rssi'
    if (rssi) this._generate()
    if (from > this.seq) from = this.seq
    let lost = 0
    if (this.seq - from > this.ring.length) {
      lost = this.seq - from - this.ring.length
      from = this.seq - this.ring.length
    }
    let count = rssi ? this.seq - from : 0
    const more = count > MOCK_RF_MAX_RESPONSE
    count = Math.min(count, MOCK_RF_MAX_RESPONSE)
    const first = this.ring.length - (this.seq - from)
    const slice = this.ring.slice(first, first + count)
    const doc = {mode: st ? st.mode : 'off', from, next: from + count, since: this.since, lost, more,
      period: MOCK_RF_PERIOD_US, hop: !!st?.hop}
    if (rssi && st.hop) doc.ch = slice.map((x) => x.ch)
    if (rssi && st.radio & 1) doc.r1 = slice.map((x) => x.r1)
    if (rssi && st.radio & 2) doc.r2 = slice.map((x) => x.r2)
    return doc
  }
}

const MOCK_CONFIG_FLASH_KEYS = ['config_flash_cs', 'config_flash_sck', 'config_flash_miso', 'config_flash_mosi']

export class MockTransport {
  constructor(moduleType = 'tx') {
    this.name = 'mock'
    this.isTx = moduleType.toLowerCase() === 'tx'
    // Current firmware persists options; `?mock=tx&ro` clears the bit so the read-only
    // rendering (what old firmware in the field still reports) stays testable.
    const params = new URLSearchParams(window.location.search)
    const readOnly = params.has('ro')
    // `&nohw` clears the hardware-override bit, i.e. firmware without config-flash storage.
    const noHardware = params.has('nohw')
    this.features = (readOnly ? 0 : FEATURE_OPTIONS_WRITE) | FEATURE_CRSF_PARAMS | FEATURE_DFU |
                    FEATURE_RF_DIAG | (noHardware ? 0 : FEATURE_HARDWARE_WRITE)
    this.doc = mockDocument(this.isTx)
    // The flashed (slot) layout and the stored override, mirroring the firmware's boot rule:
    // an override replaces the layout except for the config-flash pins.
    this.slotHardware = this.isTx ? MOCK_TX_HARDWARE : MOCK_RX_HARDWARE
    this.hardwareOverride = null
    this.rfDiag = new MockRfDiag(this.doc.settings, this.slotHardware)
    this._lostCbs = []
    this._crsfCbs = []
    // The CRSF bus as the browser sees it: the module on the cable, plus — on a TX — the
    // receiver reachable over the air through it, which is what the stacked Parameters cards are
    // for. An RX plugged in directly is alone on the bus.
    // The device's write callback takes the parameter's name: the trees register optional rows,
    // so a number does not identify the same setting on every device.
    if (this.isTx) {
      const tx = txInitialState()
      const rx = rxInitialState(MOCK_XR4.power_default)
      const xr4 = JSON.parse(JSON.stringify(MOCK_XR4.config))
      this._crsfDevices = [
        {address: CRSF.ADDR_TX, name: this.doc.settings.lua_name,
         tree: () => txTree(tx, this.doc.settings),
         write: (name, v) => txWrite(tx, name, v),
         // badPkt, goodPkt (BE u16), flags (0x01 = connected), message
         status: () => {
           const hz = rateHz(TX_RATES[tx.rate[tx.band]])
           return [0, hz >> 8, hz & 0xFF, 0x01, 0]
         }},
        // Linked, so it runs the TX's firmware version and regulatory domain.
        {address: CRSF.ADDR_RX, name: MOCK_XR4.name,
         tree: () => rxTree(rx, xr4, this.doc.settings),
         write: (name, v) => rxWrite(rx, xr4, name, v)},
      ]
    } else {
      const rx = rxInitialState(MOCK_RX_HARDWARE.power_default)
      this._crsfDevices = [
        {address: CRSF.ADDR_RX, name: this.doc.settings.lua_name,
         tree: () => rxTree(rx, this.doc.config, this.doc.settings),
         write: (name, v) => rxWrite(rx, this.doc.config, name, v)},
      ]
    }
    this.hello = {
      version: this.doc.settings.version,
      'git-commit': this.doc.settings['git-commit'],
      target: this.doc.settings.target,
      'module-type': this.doc.settings['module-type'],
      'radio-type': this.doc.settings['radio-type'],
      'proto-version': PROTOCOL_VERSION,
    }
  }

  async connect() { return this.hello }
  async disconnect() {}
  onLost(cb) {
    this._lostCbs.push(cb)
    return () => {
      const i = this._lostCbs.indexOf(cb)
      if (i >= 0) this._lostCbs.splice(i, 1)
    }
  }

  // A reboot drops the session as it does on hardware, so the page goes through its rebooting ->
  // reconnect path. Changes survive it: the page reconnects to this same instance.
  _simulateReboot() {
    setTimeout(() => {
      this._boot()
      this._lostCbs.slice().forEach((cb) => cb('Device rebooting'))
    }, 200)
  }

  // What setup() does with the stored options: the regulatory domain picks the FHSS table, and on
  // a TX the options UID becomes the running UID (config.uid) — until then it reports the old one.
  _boot() {
    this.rfDiag = new MockRfDiag(this.doc.settings, this.slotHardware)
    delete this.hello['rf-diag']
    this.doc.settings.reg_domain_low = MOCK_DOMAINS[this.doc.options.domain] || MOCK_DOMAINS[0]
    if (this.isTx && Array.isArray(this.doc.options.uid)) {
      this.doc.config.uid = this.doc.options.uid.slice()
    }
  }

  get connected() { return true }
  hasFeature(bit) { return (this.features & bit) !== 0 }

  async getConfig({export: exportMode = false} = {}) {
    const doc = JSON.parse(JSON.stringify(this.doc))
    if (exportMode) return {config: doc.config}
    return doc
  }
  async getOptions() { return JSON.parse(JSON.stringify(this.doc.options)) }
  async exportConfig(opts) { return JSON.stringify(await this.getConfig(opts), null, 2) }
  async saveConfig(config) { Object.assign(this.doc.config, config); return 'Configuration updated' }
  async saveOptions(options) {
    if (!this.hasFeature(FEATURE_OPTIONS_WRITE)) throw new Error('Options are read-only on this firmware')
    // Mirrors ConfigJson_ApplyOptions(): the same guards, so the mock exercises the same paths.
    if (options.target !== undefined && options.target !== this.doc.settings.target) {
      throw new Error('target mismatch')
    }
    if (options['flash-discriminator'] !== undefined &&
        options['flash-discriminator'] !== this.doc.options['flash-discriminator']) {
      throw new Error('mismatched device identifier, reload the configuration and try again')
    }
    if (options.domain !== undefined && options.domain >= (this.doc.settings.has_low_band ? MOCK_DOMAINS.length : 1)) {
      throw new Error('unsupported regulatory domain')
    }
    Object.assign(this.doc.options, options, {customised: true})
    if (this.isTx) {
      this.doc.settings.uidtype = this.doc.options.uid ? 'Overridden' : 'Not set (using MAC address)'
    }
    return 'Options updated - reboot to apply'
  }
  async importConfig(text) { return this.saveConfig(JSON.parse(text).config || JSON.parse(text)) }
  async previewButtonColors() {}
  async reboot() { this._simulateReboot() }

  async getRfDiag() { return this.rfDiag.describe() }
  async setRfDiag(settings) {
    const doc = this.rfDiag.apply(settings)
    this.hello['rf-diag'] = true
    return doc
  }
  async getRfDiagSamples(from) { return this.rfDiag.samples(from) }
  async endRfDiag() { this._simulateReboot() }
  async rebootToDfu() {}
  async reset(flags = {config: true}) {
    const fresh = mockDocument(this.isTx)
    if (flags.config || flags.model) this.doc.config = fresh.config
    if (flags.options) {
      this.doc.options = fresh.options
      this.doc.settings.uidtype = fresh.settings.uidtype
    }
    if (flags.hardware) {
      this.hardwareOverride = null
      this.doc.settings.custom_hardware = false
    }
    this._simulateReboot()
  }

  async getHardware() {
    return JSON.parse(JSON.stringify(this.hardwareOverride || this.slotHardware))
  }
  async saveHardware(doc) {
    if (!this.hasFeature(FEATURE_HARDWARE_WRITE)) throw new Error('UNSUPPORTED: no config flash')
    // Applied as the firmware does at the next boot (the mock has no boot, so straight away).
    const effective = {...doc}
    for (const k of MOCK_CONFIG_FLASH_KEYS) {
      if (this.slotHardware[k] !== undefined) effective[k] = this.slotHardware[k]
      else delete effective[k]
    }
    effective.customised = true
    this.hardwareOverride = effective
    this.doc.settings.custom_hardware = true
    return 'Hardware updated - reboot to apply'
  }

  // ---- CRSF tunnel ----------------------------------------------------------
  onCrsf(cb) {
    this._crsfCbs.push(cb)
    return () => {
      const i = this._crsfCbs.indexOf(cb)
      if (i >= 0) this._crsfCbs.splice(i, 1)
    }
  }

  _emit(device, type, payload) {
    // Answer on a later task, as a real device would — a synchronous reply would let the panel
    // pass tests it would fail against hardware.
    const frame = CRSF.buildFrame(type, CRSF.ADDR_RADIO_TRANSMITTER, device.address, payload)
    setTimeout(() => this._crsfCbs.slice().forEach((cb) => cb(frame)), 15)
  }

  async sendCrsf(frameBytes) {
    const frame = CRSF.parseFrame(frameBytes)
    if (!frame) return

    if (frame.type === CRSF.DEVICE_PING) {
      // A broadcast ping is answered by every device on the bus; a directed one only by its
      // target. Same rule the router applies.
      for (const device of this._crsfDevices) {
        if (frame.dest !== CRSF.ADDR_BROADCAST && frame.dest !== device.address) continue
        const info = [...device.name].map((c) => c.charCodeAt(0)).concat([0])
        // serial 'ELRS', hardware id 0, firmware id from the version (4.3.0), parameter count
        // and parameter version
        info.push(0x45, 0x4C, 0x52, 0x53, 0, 0, 0, 0, 0, 4, 3, 0,
                  device.tree().length - 1, 0)
        this._emit(device, CRSF.DEVICE_INFO, new Uint8Array(info))
      }
      return
    }

    const device = this._crsfDevices.find((d) => d.address === frame.dest)
    if (!device) return

    if (frame.type === CRSF.PARAM_READ) {
      const entry = this._entryFor(device, frame.payload[0], frame.payload[1] || 0)
      if (entry) this._emit(device, CRSF.PARAM_ENTRY, entry)
      return
    }

    if (frame.type === CRSF.PARAM_WRITE) {
      const number = frame.payload[0]
      const value = frame.payload[1]
      if (number === 0) {
        // The link-status poll. Only an ELRS TX answers it; on a receiver parameter 0 has no
        // callback and nothing happens, which is what the panel expects.
        if (device.status) this._emit(device, CRSF.ELRS_STATUS, new Uint8Array(device.status()))
        return
      }
      const p = device.tree()[number]
      if (!p) return
      if (p.type === CRSF.PARAM_TYPE_COMMAND) {
        // A command write is answered with the parameter itself (the firmware's
        // pushResponseChunk path); report "stopped" straight away, which is what a command with
        // nothing left to do looks like.
        this._emit(device, CRSF.PARAM_ENTRY, this._entryFor(device, number, 0))
        return
      }
      // A plain write is NOT acknowledged — the panel re-reads the affected fields afterwards,
      // exactly as it must against real firmware.
      device.write(p.name, value)
    }
  }

  /** One chunk of a parameter's entry: the number, the chunks still to come, then the data. */
  _entryFor(device, number, chunk) {
    const tree = device.tree()
    const p = tree[number]
    if (!p) return null
    const body = mockEncodeParam(p, tree, number)
    const chunks = Math.max(1, Math.ceil(body.length / MOCK_CHUNK_SIZE))
    if (chunk >= chunks) return null
    const data = body.subarray(chunk * MOCK_CHUNK_SIZE, (chunk + 1) * MOCK_CHUNK_SIZE)
    const out = new Uint8Array(2 + data.length)
    out[0] = number
    out[1] = chunks - 1 - chunk
    out.set(data, 2)
    return out
  }
}
