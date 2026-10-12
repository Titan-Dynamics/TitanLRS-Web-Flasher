/*
 * usbconfig.js — shared definitions for the TitanLRS device config API.
 *
 * The real transport is HttpConfigSession in netconfig.js: STM32 firmware serves the config API
 * over HTTP on its USB network interface (TitanLRS/src/lib/USBConfig/usbcfg_api.h). The feature
 * bits below are the `features` bitmask of GET /hello; keep them in sync with that header.
 */

/** API version reported by the current firmware (/hello "api-version"). */
export const PROTOCOL_VERSION = 2

export const FEATURE_OPTIONS_WRITE = 1 << 0
export const FEATURE_CW = 1 << 1
export const FEATURE_LR1121_UPDATE = 1 << 2
export const FEATURE_CRSF_PARAMS = 1 << 3
export const FEATURE_DFU = 1 << 4
export const FEATURE_HARDWARE_WRITE = 1 << 5

/* DeviceError codes. The HTTP transport maps response statuses onto these, so callers can keep
 * testing e.g. `code === ERR_BUSY` (module armed) regardless of transport. */
export const ERR_UNSUPPORTED = 1
export const ERR_BUSY = 2
export const ERR_BAD_REQUEST = 3
export const ERR_TOO_LARGE = 4
export const ERR_PARSE = 5
export const ERR_NO_SESSION = 6
export const ERR_INTERNAL = 7

const ERR_NAMES = {
  [ERR_UNSUPPORTED]: 'UNSUPPORTED', [ERR_BUSY]: 'BUSY', [ERR_BAD_REQUEST]: 'BAD_REQUEST',
  [ERR_TOO_LARGE]: 'TOO_LARGE', [ERR_PARSE]: 'PARSE', [ERR_NO_SESSION]: 'NO_SESSION',
  [ERR_INTERNAL]: 'INTERNAL',
}

/** The device answered, with an error. */
export class DeviceError extends Error {
  constructor(code, message) {
    super(`${ERR_NAMES[code] || 'ERR' + code}: ${message}`)
    this.code = code
    this.deviceMessage = message
  }
}
