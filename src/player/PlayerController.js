import withDeps from "ApplicationDependencies";
import AudioPlayer from "audio/frontend/AudioPlayer";
import AudioManager from "audio/frontend/AudioManager";
import EventEmitter from "events";
import {noUndefinedGet} from "util";
import {URL} from "platform/platform";
import {isTouchEvent} from "platform/dom/Page";
import {FILESYSTEM_ACCESS_ERROR, DECODE_ERROR} from "tracks/Track";
import {generateSilentWavFile} from "platform/LocalFileHandler";
import {MINIMUM_DURATION} from "audio/backend/demuxer";


let loadId = 0;
const VOLUME_KEY = `volume`;
const MUTED_KEY = `muted`;

export default class PlayerController extends EventEmitter {
    constructor(opts, deps) {
        super();
        opts = noUndefinedGet(opts);
        this.localFileHandler = deps.localFileHandler;
        this.env = deps.env;
        this.page = deps.page;
        this.globalEvents = deps.globalEvents;
        this.recognizerContext = deps.recognizerContext;
        this.db = deps.db;
        this.dbValues = deps.dbValues;
        this.rippler = deps.rippler;
        this.crossfadePreferencesBindingContext = deps.crossfadePreferencesBindingContext;
        this.effectPreferencesBindingContext = deps.effectPreferencesBindingContext;
        this.applicationPreferencesBindingContext = deps.applicationPreferencesBindingContext;
        this.gestureEducator = deps.gestureEducator;
        this.tooltipContext = deps.tooltipContext;
        this.playlist = deps.playlist;

        this._domNode = this.page.$(opts.target);

        this._playButtonDomNode = this.$().find(opts.playButtonDom);
        this._previousButtonDomNode = this.$().find(opts.previousButtonDom);
        this._nextButtonDomNode = this.$().find(opts.nextButtonDom);

        this.audioManagers = [];
        this.visualizerCanvas = null;
        this.currentAudioManager = null;
        this.volume = 0.15;
        this.isStopped = true;
        this.isPaused = false;
        this.isPlaying = false;
        this.isMutedValue = false;
        this.implicitLoading = false;
        this.queuedNextTrackImplicitly = false;
        this.pictureManager = null;
        this.mediaFocusAudioElement = null;
        this.audioPlayer = withDeps({
            page: this.page,
            env: this.env,
            db: this.db,
            dbValues: this.dbValues,
            crossfadePreferencesBindingContext: this.crossfadePreferencesBindingContext,
            effectPreferencesBindingContext: this.effectPreferencesBindingContext,
            applicationPreferencesBindingContext: this.applicationPreferencesBindingContext,
            workerWrapper: deps.workerWrapper,
            timers: deps.timers
        }, d => new AudioPlayer(d));

        this.nextTrackChanged = this.nextTrackChanged.bind(this);
        this.$play().addEventListener(`click`, this.playButtonClicked.bind(this));
        this.$next().addEventListener(`click`, this.nextButtonClicked.bind(this));
        this.$previous().addEventListener(`click`, this.prevButtonClicked.bind(this));
        this.recognizerContext.createTapRecognizer(this.playButtonClicked.bind(this)).recognizeBubbledOn(this.$play());
        this.recognizerContext.createTapRecognizer(this.nextButtonClicked.bind(this)).recognizeBubbledOn(this.$next());
        this.recognizerContext.createTapRecognizer(this.prevButtonClicked.bind(this)).recognizeBubbledOn(this.$previous());

        this._playTooltip = this.tooltipContext.createTooltip(this.$play(), () => (this.isPlaying ? `Pause playback`
                                : (this.isPaused ? `Resume playback` : `Start playback`)));

        this._nextTooltip = this.tooltipContext.createTooltip(this.$next(), `Next track`);
        this._previousTooltip = this.tooltipContext.createTooltip(this.$previous(), `Previous track`);

        this.playlist.on(`currentTrackChange`, this.loadTrack.bind(this));
        this.playlist.on(`playlistEmpty`, this.stop.bind(this));
        this.playlist.on(`nextTrackChange`, this.nextTrackChanged);
        this.playlist.on(`historyChange`, this.historyChanged.bind(this));

        if (VOLUME_KEY in this.dbValues) {
            this.setVolume(this.dbValues[VOLUME_KEY]);
        }

        if (MUTED_KEY in this.dbValues) {
            if (this.dbValues[MUTED_KEY]) {
                this.toggleMute();
            }
        }

        this.ready = (async () => {
            await this.audioPlayer.ready;
            this.ready = null;
        })();

        if (this.env.mediaSessionSupport()) {
            this.mediaFocusAudioElement = this.page.createElement(`audio`, {
                loop: true,
                controls: false,
                src: URL.createObjectURL(generateSilentWavFile())
            })[0];

        }

        this.audioPlayer.on(`audioContextReset`, this.audioContextReset.bind(this));
        this.effectPreferencesBindingContext.on(`change`, this.effectPreferencesChanged.bind(this));
        this.crossfadePreferencesBindingContext.on(`change`, this.crossfadePreferencesChanged.bind(this));
        this.applicationPreferencesBindingContext.on(`change`, this.applicationPreferencesChanged.bind(this));

    }

    audioContextReset() {
        if (this.currentAudioManager) {
            this.currentAudioManager.audioContextReset();
        }
    }

    effectPreferencesChanged() {
        this.forEachAudioManager((am) => {
            am.effectsChanged(this.effectPreferencesBindingContext);
        });
    }

    crossfadePreferencesChanged() {
        this.forEachAudioManager((am) => {
            am.crossfadingChanged(this.crossfadePreferencesBindingContext);
        });
    }

    applicationPreferencesChanged() {
        // EMPTYFORNOW
    }

    setVisualizerCanvas(value) {
        this.visualizerCanvas = value;
    }

    setPictureManager(pictureManager) {
        this.pictureManager = pictureManager;
    }

    $allButtons() {
        return this.$play().add(this.$previous(), this.$next());
    }

    $() {
        return this._domNode;
    }

    $play() {
        return this._playButtonDomNode;
    }

    $previous() {
        return this._previousButtonDomNode;
    }

    decodingLatencyValue(decodingLatency) {
        this.applicationPreferencesBindingContext.decodingLatencyValue(decodingLatency);
    }

    $next() {
        return this._nextButtonDomNode;
    }

    historyChanged() {
        this.checkButtonState();
    }

    getPictureManager() {
        return this.pictureManager;
    }

    nextTrackChanged() {
        this.checkButtonState();
    }

    audioManagerDestroyed(audioManager) {
        const index = this.audioManagers.indexOf(audioManager);
        if (index >= 0) {
            this.audioManagers.splice(index, 1);
        }
        if (audioManager === this.currentAudioManager) {
            this.currentAudioManager = null;
            if (!this.playlist.getCurrentTrack() &&
                !this.playlist.getNextTrack() &&
                this.isPlaying) {
                this.stop();
            }
        }
    }

    nextTrackStartedPlaying() {
        return new Promise(resolve => this.once(`trackPlaying`, resolve));
    }

    async nextTrackImplicitly() {
        if (this.isPaused) {
            if (this.queuedNextTrackImplicitly) return;
            this.queuedNextTrackImplicitly = true;
            const playId = this.playlist.getCurrentPlayId();
            // Queue the next track load when the player resumes.
            await this.nextTrackStartedPlaying();
            this.queuedNextTrackImplicitly = false;
            // If it was exactly the same track playthrough that was resumed.
            if (!this.isPaused && this.playlist.getCurrentPlayId() === playId) {
                this.nextTrackImplicitly();
            }
            return;
        }

        this.implicitLoading = true;
        if (!this.playlist.next(false)) {
            this.implicitLoading = false;
        }
    }

    audioManagerErrored(audioManager, e) {
        if (audioManager.track) {
            let trackError;
            if (e.name === `NotFoundError` || e.name === `NotReadableError`) {
                trackError = FILESYSTEM_ACCESS_ERROR;
            } else {
                trackError = DECODE_ERROR;
            }
            audioManager.track.setError(trackError);
        }
        this.destroyAudioManagers();
        this.currentAudioManager = null;
        this.nextTrackImplicitly();
    }

    getProgress() {
        if (!this.currentAudioManager) return -1;
        const duration = this.currentAudioManager.getDuration();
        if (!duration) return -1;
        const currentTime = this.currentAudioManager.getCurrentTime();
        return Math.round((currentTime / duration) * 100) / 100;
    }

    setProgress(p) {
        if (!this.currentAudioManager || !this.currentAudioManager.isSeekable()) return;
        p = Math.min(Math.max(p, 0), 1);
        const duration = this.currentAudioManager.getDuration();
        if (!duration) return;
        this.seek(p * duration);
    }

    seekIntent(p) {
        if (!this.currentAudioManager) return;
        p = Math.min(Math.max(p, 0), 1);
        const duration = this.currentAudioManager.getDuration();
        if (!duration) return;
        this.seek(p * duration, true);
    }

    getFadeInTimeForNextTrack() {
        const preferences = this.crossfadePreferencesBindingContext.preferences();
        const fadeInTime = preferences.getInTime();
        if (fadeInTime <= 0 || !preferences.getInEnabled()) return 0;

        const audioManager = this.currentAudioManager;

        if (!audioManager) return 0;

        const nextTrack = this.playlist.getNextTrack();
        if (!nextTrack) return 0;
        if (preferences.getShouldAlbumNotCrossFade() &&
            audioManager.track.comesBeforeInSameAlbum(nextTrack)) {
            return 0;
        }

        const duration = nextTrack.getDuration();
        return !duration ? fadeInTime
                         : Math.max(Math.min(duration - MINIMUM_DURATION - preferences.getOutTime(), fadeInTime), 0);
    }

    audioManagerSeekIntent(audioManager, time) {
        if (audioManager === this.currentAudioManager) {
            this.emit(`progress`, time, audioManager.getDuration());
        }
    }

    trackFinished() {
        this.playlist.trackPlayedSuccessfully();
        this.nextTrackImplicitly();
    }

    audioManagerEnded(audioManager, haveGaplessPreloadPending) {
        if (audioManager === this.currentAudioManager) {
            const alreadyFinished = haveGaplessPreloadPending && !audioManager.hasGaplessPreload();
            if (!haveGaplessPreloadPending) {
                audioManager.destroy();
            }

            if (!alreadyFinished) {
                this.trackFinished();
                return true;
            }
        } else {
            audioManager.destroy();
        }
        return false;
    }

    audioManagerProgressed(audioManager, currentTime, totalTime, shouldHandleEnding) {
        if (audioManager === this.currentAudioManager) {
            const fadeInTime = this.getFadeInTimeForNextTrack();

            if (shouldHandleEnding &&
                (currentTime >= totalTime && totalTime > 0 && currentTime > 0) ||
                (fadeInTime > 0 && totalTime > 0 && currentTime > 0 && (totalTime - currentTime > 0) &&
                (totalTime - currentTime <= fadeInTime))) {
                this.trackFinished();
                return true;
            } else if (this.isPlaying && !this.globalEvents.isWindowBackgrounded()) {
                this.emit(`progress`, currentTime, totalTime);
            }
        }
        return false;
    }

    getSampleRate() {
        const track = this.playlist.getCurrentTrack();
        if (!track) return 44100;
        const tagData = track.getTagData();
        if (!tagData) return 44100;
        return tagData.sampleRate;
    }

    pause() {
        if (!this.isPlaying) return;
        this.isPaused = true;
        this.isStopped = false;
        this.isPlaying = false;
        this.forEachAudioManager((am) => {
            am.pause();
        });
        this.pausedPlay();
    }

    resume() {
        if (this.isPaused) {
            this.emit(`trackPlaying`);
            this.play();
        }
    }

    play() {
        if (this.isPlaying) return;

        if (!this.playlist.getCurrentTrack()) {
            this.playlist.playFirst();
            return;
        }

        this.emit(`trackPlaying`);
        this.isPaused = false;
        this.isStopped = false;
        this.isPlaying = true;
        this.forEachAudioManager((am) => {
            am.updateSchedules();
            am.resume();
        });
        this.startedPlay();
    }

    stop() {
        if (this.isStopped) return;
        this.isStopped = true;
        this.isPaused = false;
        this.isPlaying = false;
        this.currentAudioManager = null;
        this.destroyAudioManagers();
        this.playlist.stop();
        this.emit(`progress`, 0, 0);
        this.stoppedPlay();
    }

    async loadTrack(track, isUserInitiatedSkip) {
        if (this.ready) {
            const id = ++loadId;
            await this.ready;
            if (id !== loadId) {
                return;
            }
        }
        ++loadId;

        if (isUserInitiatedSkip &&
            this.currentAudioManager &&
            !this.currentAudioManager.hasPlaythroughBeenTriggered()) {

            if (this.currentAudioManager.track) {
                this.currentAudioManager.track.recordSkip();
            }
        }

        this.isStopped = false;
        this.isPlaying = true;
        this.isPaused = false;

        const implicit = this.implicitLoading;
        if (implicit) {
            this.implicitLoading = false;
        } else {
            this.destroyAudioManagers(this.currentAudioManager);
        }

        // Should never be true but there are too many moving parts to figure it out.
        if (this.currentAudioManager && this.currentAudioManager.destroyed) {
            this.currentAudioManager = null;
        }


        const explicit = !implicit;
        if (this.currentAudioManager &&
            (explicit || this.currentAudioManager.hasGaplessPreload())) {
            this.currentAudioManager.replaceTrack(track, explicit);
            this.startedPlay();
            this.emit(`trackPlaying`);
            this.emit(`newTrackLoad`, track);
            return;
        }

        if (this.currentAudioManager) {
            this.currentAudioManager.background();
        }
        this.currentAudioManager = new AudioManager(this, track, implicit);
        this.audioManagers.push(this.currentAudioManager);
        this.startedPlay();
        this.emit(`trackPlaying`);
        this.emit(`newTrackLoad`, track);
        this.currentAudioManager.start();
    }

    nextButtonClicked(e) {
        this.rippler.rippleElement(e.currentTarget, e.clientX, e.clientY);
        this.playlist.next(true);
        if (isTouchEvent(e)) {
            this.gestureEducator.educate(`next`);
        }
    }

    prevButtonClicked(e) {
        this.rippler.rippleElement(e.currentTarget, e.clientX, e.clientY);
        this.playlist.prev();
        if (isTouchEvent(e)) {
            this.gestureEducator.educate(`previous`);
        }
    }

    playButtonClicked(e) {
        this.rippler.rippleElement(e.currentTarget, e.clientX, e.clientY);
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
        if (isTouchEvent(e)) {
            this.gestureEducator.educate(`playpause`);
        }
    }

    checkButtonState() {
        this.$allButtons().addClass(`disabled`);

        if (this.playlist.getNextTrack()) {
            this.$next().removeClass(`disabled`);

            if (this.playlist.hasHistory()) {
                this.$previous().removeClass(`disabled`);
            }
        }

        if (!this.isStopped) {
            this.$play().removeClass(`disabled`);
            if (this.isPlaying) {
                this.$play().
                    find(`.play-pause-morph-icon`).
                    removeClass(`play`).
                    addClass(`pause`);
            } else if (this.isPaused) {
                this.$play().
                    find(`.play-pause-morph-icon`).
                    removeClass(`pause`).
                    addClass(`play`);
            }
        } else {
            this.$play().removeClass(`active`).
                    find(`.play-pause-morph-icon`).
                    removeClass(`pause`).
                    addClass(`play`);

            if (this.playlist.getNextTrack()) {
                this.$play().removeClass(`disabled`);
            }
        }

        this._playTooltip.refresh();
    }

    startedPlay() {
        this.checkButtonState();
        if (this.mediaFocusAudioElement) {
            try {
                this.mediaFocusAudioElement.play();
            } catch (e) {
                this.env.logError(e);
            }
        }
        this.emit(`play`);
    }

    stoppedPlay() {
        this.checkButtonState();
        if (this.mediaFocusAudioElement) {
            try {
                this.mediaFocusAudioElement.pause();
            } catch (e) {
                this.env.logError(e);
            }
        }
        this.emit(`stop`);
    }

    pausedPlay() {
        this.checkButtonState();
        if (this.mediaFocusAudioElement) {
            this.mediaFocusAudioElement.pause();
        }
        this.emit(`pause`);
    }

    seek(seconds, intent) {
        if (!this.isPlaying && !this.isPaused) return;
        if (!this.currentAudioManager || !this.currentAudioManager.isSeekable()) return;
        const maxSeek = this.currentAudioManager.getDuration();
        if (!isFinite(maxSeek)) return;
        seconds = Math.max(0, Math.min(seconds, maxSeek));

        if (intent) {
            this.currentAudioManager.seekIntent(seconds);
        } else {
            this.currentAudioManager.seek(seconds);
        }
    }

    isMuted() {
        return this.isMutedValue;
    }

    togglePlayback() {
        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    }

    toggleMute() {
        this.isMutedValue = !this.isMutedValue;
        if (this.isMutedValue) {
            this.emit(`muted`, true);
            this.forEachAudioManager((am) => {
                am.mute();
            });
            this.db.set(MUTED_KEY, true);
        } else {
            this.emit(`muted`, false);
            this.forEachAudioManager((am) => {
                am.unmute();
            });
            this.db.set(MUTED_KEY, false);
        }
    }

    getDuration() {
        if (!this.currentAudioManager) throw new Error(`cannot get duration no audioManager`);
        return this.currentAudioManager.getDuration();
    }

    getProbableDuration() {
        if (!this.currentAudioManager) throw new Error(`cannot get duration no audioManager`);
        const ret = this.currentAudioManager.getDuration();
        if (ret) return ret;
        const track = this.playlist.getCurrentTrack();
        return track.getDuration();
    }

    getVolume() {
        return this.volume;
    }

    setVolume(val) {
        val = Math.min(Math.max(0, val), 1);
        const volume = this.volume = val;
        this.forEachAudioManager((am) => {
            am.updateVolume(volume);
        });
        this.emit(`volumeChange`);
        this.db.set(VOLUME_KEY, volume);
        return this;
    }

    // Supports deletion mid-iteration.
    forEachAudioManager(fn) {
        let currentLength = this.audioManagers.length;
        for (let i = 0; i < this.audioManagers.length; ++i) {
            fn.call(this, this.audioManagers[i], i, this.audioManagers);
            // Deleted from the array.
            if (currentLength > this.audioManagers.length) {
                i -= (currentLength - this.audioManagers.length);
                currentLength = this.audioManagers.length;
            }
        }
    }

    destroyAudioManagers(exceptThisOne) {
        this.forEachAudioManager((am) => {
            if (am !== exceptThisOne) {
                am.destroy();
            }
        });
    }

    getAudioContext() {
        return this.audioPlayer.getAudioContext();
    }
}