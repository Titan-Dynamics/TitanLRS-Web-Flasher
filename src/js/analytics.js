import {store} from './state.js'
import {versionInfo} from './firmwareSource.js'

// PostHog project API key (phc_...). A public, write-only key: safe to ship in the site bundle.
const POSTHOG_KEY = 'phc_P6BPT83SMh6v3PW0sln5YJUI4ihN9GqMMBZnv5BQkIs'
// PostHog Cloud region of the project: US 'https://us.i.posthog.com', EU 'https://eu.i.posthog.com'.
const POSTHOG_HOST = 'https://us.i.posthog.com'

const TITAN_VENDOR = 'titan_dynamics'

/**
 * The radio chip a target uses, e.g. 'LR2021'. Not generateFirmware()'s radioType, which is the
 * firmware's options family and calls every dual-band target 'lr1121'. The firmware target name
 * says it when the board family has more than one chip (Unified_STM32H743_LR2021_RX); otherwise the
 * band decides it (Unified_ESP32_2400_TX is SX1280).
 */
function radioChip(firmware, radio) {
    const named = /LR2021|LR1121|SX128\d|SX127\d|LLCC68/i.exec(firmware ?? '')
    if (named) return named[0].toUpperCase()
    if (radio?.endsWith('_2400')) return 'SX1280'
    if (radio?.endsWith('_900')) return 'SX127X'
    if (radio?.endsWith('_dual')) return 'LR1121'
    return null
}

// Resolves with the started PostHog instance, or null if it failed to load.
let posthogReady = null

/**
 * Start PostHog (pageviews + autocapture). posthog-js is loaded on demand (its own chunk,
 * ~130 kB gzipped), so it never delays the app starting.
 */
export function initAnalytics() {
    posthogReady = import('posthog-js').then(({default: posthog}) => {
        posthog.init(POSTHOG_KEY, {
            api_host: POSTHOG_HOST,
            // Pinned set of PostHog's recommended settings, so a library update can't change behaviour.
            defaults: '2026-08-30',
            // Anonymous visitors only; no person profiles unless someone is identified.
            person_profiles: 'identified_only',
        })
        return posthog
    }).catch(error => {
        console.warn('[Analytics] PostHog failed to load', error)
        return null
    })
    return posthogReady
}

/** Send a custom event. Never throws, so analytics can't break a flash. */
export function track(event, properties) {
    posthogReady?.then(posthog => posthog?.capture(event, properties)).catch(() => {})
}

/**
 * What was flashed, onto what, and how. Deliberately never the binding phrase (or its UID) or
 * WiFi credentials: only whether they were set.
 * @param files the flash page's `files` (the generateFirmware() result)
 */
function flashProperties(files) {
    const target = store.target ?? {}
    const config = target.config ?? {}
    const {channel, commit} = versionInfo(store.version)
    const props = {
        firmware_version: store.version,
        firmware_channel: channel,  // 'release' | 'master'
        firmware_commit: commit,    // master builds only
        device_type: files.deviceType,
        vendor: target.vendor,
        target_id: [target.vendor, target.radio, target.target].join('.'),
        product_name: config.product_name,
        titan_hardware: target.vendor === TITAN_VENDOR,
        platform: config.platform,
        firmware_target: config.firmware,
        flash_method: store.options.flashMethod,
    }
    if (store.firmware === 'firmware') {
        Object.assign(props, {
            radio: target.radio,       // e.g. 'tx_2400', 'rx_dual'
            radio_chip: radioChip(config.firmware, target.radio),
            rx_as_tx: files.txType ?? null,
            region: store.options.region,
            domain: store.radio?.endsWith('_900') || store.radio?.endsWith('_dual') ? store.options.domain : null,
            binding_phrase_set: Boolean(store.options.uid),
            wifi_credentials_set: config.platform !== 'stm32' && Boolean(store.options.ssid),
        })
    }
    return props
}

// tlrs_* for TitanLRS TX/RX firmware, backpack_* for backpack firmware.
const eventName = (action) => `${store.firmware === 'firmware' ? 'tlrs' : 'backpack'}_${action}`

/**
 * Firmware was written to a device.
 * @param files the flash page's `files`
 * @param extra e.g. {duration_s, full_erase, previous_version}
 */
export function trackFlashed(files, extra = {}) {
    track(eventName('flashed'), {...flashProperties(files), ...extra})
}

/**
 * Fetching the firmware or writing it failed.
 * @param stage 'fetch' (getting the firmware files) or 'flash' (writing them)
 */
export function trackFlashFailed(files, stage, error, extra = {}) {
    track(eventName('flash_failed'), {
        ...flashProperties(files),
        stage,
        error: String(error?.message ?? error).slice(0, 300),
        error_type: error?.name,
        ...extra,
    })
}

/** Firmware was saved to a file, to be flashed outside the flasher (Local Download or WiFi). */
export function trackDownloaded(files, extra = {}) {
    track(eventName('downloaded'), {...flashProperties(files), ...extra})
}
