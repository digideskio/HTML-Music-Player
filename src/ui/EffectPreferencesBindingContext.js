import {ToggleableSlideableValue,
        SingleSelectableValue} from "ui/templates";
import {ToggleableSlideableValuePreferenceUiBinding} from "preferences/uibinders";
import AbstractUiBindingManager from "ui/AbstractUiBindingManager";
import AbstractPreferencesBindingContext from "ui/AbstractPreferencesBindingContext";
import {equalizerPresets, formatFreq, STORAGE_KEY,
        equalizerPresetKeys, equalizerBands,
        Preferences, gainValueToProgress, progressToGainValue} from "preferences/EffectPreferences";
import {_, _set} from "util";
const ALL_SLIDERS_ON_SAME_ROW_THRESHOLD = 620;

const equalizerBandGroups = [];
const groupSize = 5;
let cur = 0;
while (cur < equalizerBands.length) {
    const equalizerBandGroup = equalizerBands.slice(cur, cur + groupSize);
    equalizerBandGroups.push(equalizerBandGroup);
    cur += groupSize;
}

let sliderContainerHtml = `<div class='inputs-container'>
    <div class='label wide-label subtitle'>Equalizer</div>
</div>`;

sliderContainerHtml += `<div class='equalizer-sliders-container row'>${
    equalizerBandGroups.map(bands => `<div class='equalizer-band-group-container col-lg-6'>${
                bands.map((band) => {
                    const sliderId = `equalizer-band-${band[0]}-slider`;
                    return `<div class='equalizer-band-configurator-container'>
                            <div class='equalizer-slider-container'>
                                <div class='${sliderId} slider equalizer-slider vertical-slider'>
                                    <div class='slider-knob'></div>
                                    <div class='slider-background'>
                                        <div class='slider-fill'></div>
                                    </div>
                                </div>
                            </div>
                            <div class='equalizer-band-label-container'>
                                <div class='notextflow band-frequency-label'>${formatFreq(band[0])}</div>
                            </div>
                        </div>`;
                }).join(``)
        }</div>`).join(``)}</div>`;


const TEMPLATE = `<div class='settings-container equalizer-popup-content-container'>
                <div class="inputs-container">
                    <div class="label wide-label subtitle">Noise sharpening</div>
                </div>
                <div class='section-container noise-sharpening-container'></div>
                <div class='section-separator'></div>
                <div class='section-container'>${sliderContainerHtml}</div>
                <div class='section-container preset-selector-container'></div>
            </div>`;


const frequencyToIndexMap = Object.create(null);

equalizerBands.forEach((band, index) => {
    frequencyToIndexMap[band[0]] = index;
});

export default class EffectPreferencesBindingContext extends AbstractPreferencesBindingContext {
    constructor(deps) {
        super(new Preferences(), deps, {
            storageKey: STORAGE_KEY,
            title: `Effects`,
            template: TEMPLATE
        });
        deps.mainMenu.on(`effects`, this.openPopup.bind(this));
    }

    /* eslint-disable no-use-before-define */
    _createManager() {
        return new EffectManager(`.equalizer-popup-content-container`, this);
    }
    /* eslint-enable no-use-before-define */

    amplitudeRatioToDecibelChange(ratio) {
        if (!isFinite(+ratio)) throw new Error(`ratio must be a number`);
        return 20 * Math.log(ratio) * Math.LOG10E;
    }

    decibelChangeToAmplitudeRatio(decibel) {
        if (!isFinite(+decibel)) return 1;
        return Math.pow(10, (decibel / 20));
    }

    frequencyToIndex(freq) {
        return frequencyToIndexMap[freq];
    }

    indexToFrequency(index) {
        return equalizerBands[index][0];
    }

    getEqualizerSetup() {
        return {
            specs: equalizerBands,
            gains: this.preferences().getEqualizer()
        };
    }

    getAudioPlayerEffects() {
        const pref = this.preferences();
        return [{
            name: `noise-sharpening`,
            effectSize: pref.getNoiseSharpeningEnabled() ? pref.getNoiseSharpeningStrength() : 0
        }];
    }
}

class EqualizerUiBinding {
    constructor(effectsManager) {
        this._effectsManager = effectsManager;
        this._equalizerSliders = equalizerBands.map((band, index) => {
            const slider = effectsManager.bindingContext().sliderContext().createSlider({
                direction: `vertical`,
                target: this.$().find(`.equalizer-band-${band[0]}-slider`)
            });

            let eq;
            slider.on(`slideBegin`, () => {
                eq = this._effectsManager.preferences.getEqualizer();
            });

            slider.on(`slide`, (p) => {
                const value = progressToGainValue(p);
                eq[index] = value;
                this._effectsManager.preferences.setInPlaceEqualizer(eq);
                this._effectsManager.preferencesUpdated();
                this._updatePreset();
            });

            slider.on(`slideEnd`, () => {
                eq = null;
            });

            return slider;
        });

        this._presetSelector = new SingleSelectableValue({
            label: `Preset`,
            valueTextMap: equalizerPresetKeys,
            onValueChange: this.equalizerPresetChanged.bind(this)
        });
        this._presetSelector.renderTo(this.$().find(`.preset-selector-container`));
    }

    $() {
        return this._effectsManager.$();
    }

    $equalizerSlidersContainer() {
        return this.$().find(`.equalizer-sliders-container`);
    }

    $equalizerSliderContainers() {
        return this.$equalizerSlidersContainer().find(`.equalizer-band-configurator-container`);
    }

    layoutUpdated() {
        const widthAvailable = this.$equalizerSlidersContainer().innerWidth();
        const slidersPerRow = widthAvailable >= ALL_SLIDERS_ON_SAME_ROW_THRESHOLD ? this._equalizerSliders.length
                                                                                  : this._equalizerSliders.length / 2;
        const sliderContainerWidth = (widthAvailable / slidersPerRow) | 0;
        this.$equalizerSliderContainers().mapToArray(_.style).forEach(_set.width(`${sliderContainerWidth}px`));
    }

    equalizerPresetChanged(val) {
        if (equalizerPresets[val]) {
            this._effectsManager.preferences.setEqualizer(equalizerPresets[val]);
            this._effectsManager.preferencesUpdated();
            this._updateSliders();
        }
    }

    _updatePreset() {
        const presetName = this._effectsManager.preferences.getMatchingEqualizerPresetName();
        this._presetSelector.setValue(presetName);
    }

    _updateSliders() {
        const eq = this._effectsManager.preferences.getInPlaceEqualizer();
        for (let i = 0; i < eq.length; ++i) {
            this._equalizerSliders[i].setValue(gainValueToProgress(eq[i]));
        }
    }

    update() {
        this._updatePreset();
        this._updateSliders();
    }
}

class EffectManager extends AbstractUiBindingManager {
    constructor(rootSelector, bindingContext) {
        super(rootSelector, bindingContext, new Preferences());

        const toggleableSlideableValue = new ToggleableSlideableValue({
            checkboxLabel: `Enable noise sharpening`,
            sliderLabel: `Strength`,
            valueFormatter: value => value.toFixed(1),
            minValue: 0,
            maxValue: 2
        }, {
            sliderContext: bindingContext.sliderContext()
        });

        this.addBinding(new EqualizerUiBinding(this)).
            addBinding(new ToggleableSlideableValuePreferenceUiBinding(
                this.$().find(`.noise-sharpening-container`),
                toggleableSlideableValue,
                `noiseSharpeningStrength`,
                `noiseSharpeningEnabled`,
                this
            ));
        this.update();
    }
}
