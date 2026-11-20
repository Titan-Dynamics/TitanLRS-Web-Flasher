/**
 * Where main (TX/RX) firmware comes from. Read at runtime, so new releases and master builds appear
 * without redeploying this site:
 *
 *  - Releases: the TitanLRS R2 bucket, releases/index.json + releases/<version>/{FCC,LBT}/...
 *  - "Master (<commit>)": the latest green CI build of TitanLRS master, master/latest.json +
 *    master/<sha>/{FCC,LBT}/...
 *  - Local builds staged by scripts/stage-local-stm32.sh in public/assets/firmware/ (index.json
 *    + <version>/...), when present. They win over R2 for the same version.
 *
 * TitanLRS CI publishes to the bucket: .github/scripts/r2-publish.sh in the TitanLRS repo.
 */
import {compareSemanticVersions} from './version.js'

export const MASTER_VERSION = 'master'

export const R2_BASE = 'https://pub-6e0300ebcda2424ebd2f0d524bdb7d0f.r2.dev'
const LOCAL_BASE = './assets/firmware'
const LOG_PREFIX = '[FirmwareSource]'

// version -> base URL holding its <region>/<target>/*.bin, filled by fetchFirmwareVersions()
const bases = new Map()

/** Version list label for a master build, e.g. "Master (1a2b3c4)". */
export const masterTitle = (info) => `Master (${info.sha.slice(0, 7)})`

// JSON at url, or null if absent. A missing local file is answered with index.html by Vite's dev
// server (200), hence the content-type check.
async function fetchJson(url) {
    try {
        const response = await fetch(url, {cache: 'no-store'})
        if (!response.ok || !(response.headers.get('content-type') || '').includes('json')) {
            throw new Error(`HTTP ${response.status}`)
        }
        return await response.json()
    } catch (error) {
        console.info(`${LOG_PREFIX} unavailable`, {url, error: error?.message ?? error})
        return null
    }
}

/**
 * Fetch the firmware versions on offer.
 * @returns {Promise<{releases: string[], master: Object|null, error: string|null}>} releases newest
 *   first; master is latest.json ({sha, version, date, run}) or null; error is set when no release
 *   list could be fetched at all.
 */
export async function fetchFirmwareVersions() {
    const [r2Index, localIndex, master] = await Promise.all([
        fetchJson(`${R2_BASE}/releases/index.json`),
        fetchJson(`${LOCAL_BASE}/index.json`),
        fetchJson(`${R2_BASE}/master/latest.json`),
    ])

    bases.clear()
    for (const version of Object.keys(r2Index?.tags ?? {})) bases.set(version, `${R2_BASE}/releases/${version}`)
    for (const version of Object.keys(localIndex?.tags ?? {})) bases.set(version, `${LOCAL_BASE}/${version}`)

    const usableMaster = /^[0-9a-f]{40}$/.test(master?.sha ?? '') ? master : null
    if (usableMaster) bases.set(MASTER_VERSION, `${R2_BASE}/master/${usableMaster.sha}`)

    const releases = [...bases.keys()].filter(v => v !== MASTER_VERSION).sort(compareSemanticVersions).reverse()
    const error = r2Index || localIndex ? null : 'Failed to fetch the firmware release list.'
    console.info(`${LOG_PREFIX} versions`, {releases, master: usableMaster?.sha ?? null, local: Object.keys(localIndex?.tags ?? {})})
    return {releases, master: usableMaster, error}
}

/** Base URL of a version from the last fetchFirmwareVersions(): <base>/<region>/<target>/... */
export function firmwareBase(version) {
    const base = bases.get(version)
    if (!base) throw new Error(`Unknown firmware version ${version}`)
    return base
}
