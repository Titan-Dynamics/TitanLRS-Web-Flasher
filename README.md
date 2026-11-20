# TitanLRS Web Flasher

Web-hosted firmware flasher for TitanLRS firmware (ExpressLRS fork for Titan Dynamics).

https://titan-dynamics.github.io/TitanLRS-Web-Flasher/

# Using the Titan Web Flasher

Usage guide: https://github.com/Titan-Dynamics/TitanLRS-Web-Flasher/wiki/Using-the-Titan-Web-Flasher

## Supported Flashing Methods

- UART (Receivers do not need to be in bootloader mode)
- Betaflight passthrough
- EdgeTX passthrough
- USB DFU

## Developing and Testing Locally

### 1. Download Backpack Firmware

Main (TX/RX) firmware is not bundled with the site. The flasher reads it at runtime from the
TitanLRS R2 bucket, so new releases and master builds appear without a redeploy:

- Releases: `releases/index.json` and `releases/<version>/{FCC,LBT}/<target>/*.bin`
- "Master (<commit>)": the latest green CI build of TitanLRS `master`, `master/latest.json` and
  `master/<sha>/...`

TitanLRS CI publishes both (`.github/scripts/r2-publish.sh` in the TitanLRS repo). See
`src/js/firmwareSource.js`.

Backpack firmware is still bundled from GitHub Releases:

```bash
./get_artifacts.sh
```

To download a specific backpack version, pass it as an argument:

```bash
./get_artifacts.sh <version>
```

Available backpack versions: https://github.com/Titan-Dynamics/TitanLRS-Backpack/releases

To flash a local TitanLRS build, stage it with `scripts/stage-local-stm32.sh` (see the script
header). Staged versions appear alongside the R2 ones.

### 2. Install Dependencies

```bash
npm install
```

### 3. Start Development Server

```bash
npm run dev
```

The development server will start (typically at http://localhost:5173).

### 4. Build for Production

```bash
npm run build
```

The built files will be in the `dist/` directory.

## Bundled Asset Structure

```
public/assets/
├── backpack/                # from get_artifacts.sh
│   ├── index.json           # Version index
│   └── {VERSION}/
├── firmware/                # optional: local builds from scripts/stage-local-stm32.sh
│   ├── index.json
│   └── {VERSION}/{FCC,LBT}/{TARGET}/firmware.bin
└── targets-local/           # optional: dev-only targets override, same script
```

## Repository Information

- **Web Flasher Fork**: https://github.com/Titan-Dynamics/TitanLRS-Web-Flasher
- **Firmware Source**: https://github.com/Titan-Dynamics/TitanLRS/releases
- **Backpack Source**: https://github.com/Titan-Dynamics/TitanLRS-Backpack/releases
- **Upstream**: https://github.com/ExpressLRS/web-flasher

## License

Developed by the ExpressLRS community. Adapted for TitanLRS by Titan Dynamics.