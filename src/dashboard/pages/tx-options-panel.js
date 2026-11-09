import {html, LitElement} from "lit"
import {customElement, state} from "lit/decorators.js"
import {elrsState, saveConfig, saveOptions} from "../utils/state.js"

import {actionWithConfirm} from "../utils/feedback.js"
import {transport} from "../utils/transport.js"
import FEATURES from "../features.js"

const GCS_CHANNELS = Array.from({length: 16}, (_, i) => i + 1)
const GCS_ENABLE_CHANNELS = GCS_CHANNELS.slice(4)

@customElement('tx-options-panel')
class TxOptionsPanel extends LitElement {
    @state() accessor domain
    @state() accessor tlmInterval
    @state() accessor fanRuntime
    // The device's gcs-override config ({enabled, channel, mask}), as edited; absent on firmware without it
    @state() accessor gcsOverride

    createRenderRoot() {
        this.domain = elrsState.options.domain
        this.tlmInterval = elrsState.options['tlm-interval']
        this.fanRuntime = elrsState.options['fan-runtime']
        const gcsOverride = elrsState.config['gcs-override']
        this.gcsOverride = gcsOverride ? {...gcsOverride} : null
        return this
    }

    render() {
        return html`
            <div class="td-row td-spread" style="margin-bottom: var(--td-s-4);">
                <span class="td-h2">Runtime Options</span>
                ${elrsState.options.customised ? html`<span class="td-chip td-chip-warn">Modified</span>` : ''}
            </div>
            <div class="td-card" style="margin-bottom: var(--td-s-4);">
                <div class="td-card-header">
                    <span class="td-h4">Settings</span>
                </div>

                ${FEATURES.HAS_SUBGHZ ? html`
                <div class="td-card-row">
                    <span class="td-label">Regulatory domain</span>
                    <select class="td-select" style="width: auto;"
                            @change="${(e) => this.domain = parseInt(e.target.value)}"
                            .value="${this.domain}">
                        ${['AU915', 'FCC915', 'EU868', 'IN866', 'AU433', 'EU433', 'US433', 'US433-Wide'].map((d, i) => html`
                            <option value="${i}" ?selected="${this.domain === i}">${d}</option>
                        `)}
                    </select>
                </div>
                ` : ''}

                <div class="td-card-row">
                    <span class="td-label">TLM report interval</span>
                    <div class="td-input-group" style="width: 120px;">
                        <input class="td-input td-input-mono" id="tlm" type="number" size="5"
                               @input="${(e) => this.tlmInterval = parseInt(e.target.value)}"
                               .value="${this.tlmInterval}"/>
                        <span class="td-btn" style="cursor:default; background: var(--td-bg-3);">ms</span>
                    </div>
                </div>

                <div class="td-card-row">
                    <span class="td-label">Fan runtime</span>
                    <div class="td-input-group" style="width: 120px;">
                        <input class="td-input td-input-mono" id="fan" type="number" size="3"
                               @input="${(e) => this.fanRuntime = parseInt(e.target.value)}"
                               .value="${this.fanRuntime}"/>
                        <span class="td-btn" style="cursor:default; background: var(--td-bg-3);">s</span>
                    </div>
                </div>

                <div style="padding: var(--td-s-3) var(--td-s-4); border-top: 1px solid var(--td-line); display: flex; align-items: center; gap: var(--td-s-2);">
                    <div style="flex: 1;"></div>
                    ${elrsState.options.customised ? html`
                        <button class="td-btn td-btn-danger"
                                @click="${actionWithConfirm('Reset to defaults',
                                    'Restore the original values (including bind phrase) and reboot?',
                                    'Reset & Reboot', 'An error occurred resetting runtime options',
                                    () => transport.reset({options: true}))}">
                            Reset to defaults
                        </button>
                    ` : ''}
                    ${FEATURES.OPTIONS_WRITABLE ? html`
                        <button class="td-btn td-btn-primary"
                                ?disabled="${!this.checkChanged()}"
                                @click="${this.save}">Save &amp; Reboot</button>
                    ` : html`
                        <span class="td-small td-mute">Read-only — options are set when the firmware is flashed</span>
                    `}
                </div>
            </div>

            ${this.gcsOverride ? html`
                <div class="td-card" style="margin-bottom: var(--td-s-4);">
                    <div class="td-card-header">
                        <span class="td-h4">GCS Override</span>
                    </div>

                    <div class="td-card-row">
                        <span class="td-label">Allow a remote GCS to override channels</span>
                        <span class="td-toggle ${this.gcsOverride.enabled ? 'is-on' : ''}"
                              @click="${() => this._setGcs({enabled: !this.gcsOverride.enabled})}"></span>
                    </div>

                    ${this.gcsOverride.enabled ? html`
                        <div class="td-card-row">
                            <span class="td-label">Override enable channel (handset only)</span>
                            <select class="td-select" style="width: auto;"
                                    @change="${(e) => this._setGcsEnableChannel(parseInt(e.target.value))}"
                                    .value="${String(this.gcsOverride.channel)}">
                                ${GCS_ENABLE_CHANNELS.map((ch) => html`
                                    <option value="${ch}" ?selected="${this.gcsOverride.channel === ch}">CH${ch}</option>
                                `)}
                            </select>
                        </div>
                        <div class="td-card-row" style="align-items: flex-start;">
                            <span class="td-label">Forward these channels from the GCS</span>
                            <div class="td-channel-grid-wrap"><div class="td-channel-grid">
                                ${GCS_CHANNELS.map((ch) => html`
                                    <label style="display: inline-flex; align-items: center; gap: 4px; ${ch === this.gcsOverride.channel ? 'opacity: 0.4;' : ''}">
                                        <input type="checkbox"
                                               .checked="${this._gcsForwards(ch)}"
                                               ?disabled="${ch === this.gcsOverride.channel}"
                                               @change="${(e) => this._setGcsForward(ch, e.target.checked)}"/>
                                        <span class="td-mono">CH${ch}</span>
                                    </label>
                                `)}
                            </div></div>
                        </div>
                    ` : ''}

                    <div style="padding: var(--td-s-3) var(--td-s-4); border-top: 1px solid var(--td-line); display: flex; align-items: center; gap: var(--td-s-2);">
                        <div style="flex: 1;"></div>
                        <button class="td-btn td-btn-primary"
                                ?disabled="${!this._gcsChanged()}"
                                @click="${this._saveGcs}">Save &amp; Reboot</button>
                    </div>
                </div>
            ` : ''}
        `
    }

    save(e) {
        e.preventDefault()
        const changes = {
            ...(FEATURES.HAS_SUBGHZ ? {'domain': this.domain} : {}),
            'tlm-interval': this.tlmInterval,
            'fan-runtime': this.fanRuntime
            // `is-airport` / `airport-uart-baud` are deliberately not offered here — see the
            // AirPort note in PORTING.md. The device's stored values ride along untouched because
            // state.js posts them back as part of the merged options document.
        }
        // Every option is applied during setup(), so this is a confirm-save-reboot flow.
        saveOptions(changes, () => { return this.requestUpdate() }, {reboot: true})
    }

    _saveGcs(e) {
        e.preventDefault()
        saveConfig({'gcs-override': {...this.gcsOverride}}, () => this.requestUpdate())
    }

    _setGcs(changes) {
        this.gcsOverride = {...this.gcsOverride, ...changes}
    }

    _gcsForwards(ch) {
        return ch !== this.gcsOverride.channel && (this.gcsOverride.mask & (1 << (ch - 1))) !== 0
    }

    _setGcsForward(ch, on) {
        const bit = 1 << (ch - 1)
        this._setGcs({mask: on ? (this.gcsOverride.mask | bit) : (this.gcsOverride.mask & ~bit)})
    }

    // The enable channel can't also come from the GCS
    _setGcsEnableChannel(ch) {
        this._setGcs({channel: ch, mask: this.gcsOverride.mask & ~(1 << (ch - 1))})
    }

    _gcsChanged() {
        const saved = elrsState.config['gcs-override']
        return !!saved && ['enabled', 'channel', 'mask'].some((k) => this.gcsOverride[k] !== saved[k])
    }

    checkChanged() {
        let changed = false
        if (FEATURES.HAS_SUBGHZ) changed |= this.domain !== elrsState.options['domain']
        changed |= this.tlmInterval !== elrsState.options['tlm-interval']
        changed |= this.fanRuntime !== elrsState.options['fan-runtime']
        return !!changed
    }
}
