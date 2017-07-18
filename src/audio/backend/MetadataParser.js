import getCodecName from "audio/backend/sniffer";
import FileView from "platform/FileView";
import parseMp3Metadata from "metadata/mp3_metadata";
import parseAcoustId from "metadata/acoustId";
import {sha1Binary, queryString, capitalize} from "util";
import {XMLHttpRequest} from "platform/platform";
import AcoustIdApiError, {ERROR_TIMEOUT, ERROR_INVALID_RESPONSE_SYNTAX} from "metadata/AcoustIdApiError";

export const albumNameKey = function(obj) {
    return (`${obj.album} ${obj.albumArtist}`).toLowerCase();
};

const UNKNOWN = `Unknown`;
const separatorPattern = /(.+)\s*-\s*(.+)/;
export const stripExtensionPattern = new RegExp(`\\.(?:[a-z0-9_\\-]{1,8})$`, `i`);
const trackInfoFromFileName = function(inputFileName) {
    const fileName = inputFileName.replace(stripExtensionPattern, ``);
    const matches = fileName.match(separatorPattern);
    let artist, title;

    if (!matches) {
        title = capitalize(fileName);
        artist = UNKNOWN;
    } else {
        artist = capitalize(matches[1]) || UNKNOWN;
        title = capitalize(matches[2]) || UNKNOWN;
    }

    return {
        artist,
        title
    };
};

const codecNotSupportedError = function() {
    const e = new Error(`codec not supported`);
    e.name = `CodecNotSupportedError`;
    return e;
};

const ajaxGet = function(url) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.timeout = 5000;

        function error() {
            reject(new AcoustIdApiError(`request timed out`, ERROR_TIMEOUT));
        }

        xhr.addEventListener(`load`, () => {
            try {
              const result = JSON.parse(xhr.responseText);
              resolve(result);
            } catch (e) {
              reject(e);
            }
        }, false);

        xhr.addEventListener(`timeout`, error);
        xhr.addEventListener(`error`, (event) => {
            debugger;
            reject(new AcoustIdApiError(`Response status: ${xhr.status}`, ERROR_INVALID_RESPONSE_SYNTAX));
        });

        xhr.open(`GET`, url);
        xhr.send(null);
    });
};

const runknown = /^[\s<{[(]*unknown[}\])>\s]*$/i;
const isUnknown = function(value) {
    if (!value) {
        return true;
    }
    return runknown.test(`${value}`);
};

export const getFileCacheKey = function(file) {
    return sha1Binary(`${file.lastModified}-${file.name}-${file.size}-${file.type}`);
};

function buildTrackInfo(metadata, demuxData) {
    const {title = null, album = null, artist = null, albumArtist = null,
           year = null, albumIndex = 0, trackCount = 1,
           genres = []} = metadata;
    return Object.assign({}, metadata, {
        lastPlayed: 0,
        rating: -1,
        playthroughCounter: 0,
        skipCounter: 0,
        acoustIdCoverArt: null,
        hasBeenAnalyzed: false,
        title, album, artist, albumArtist, year, albumIndex, trackCount, genres
    }, {
        sampleRate: demuxData.sampleRate,
        channels: demuxData.channels,
        duration: demuxData.duration
    });
}

export default class MetadataParser {
    constructor(tagDatabase) {
        this._tagDatabase = tagDatabase;
        this._maxParsersActive = 8;
        this._parserQueue = [];
        this._parsersActive = 0;
        this._imageFetchQueue = [];
        this._currentlyFetchingImage = false;
    }

    _nextParse() {
        this._parsersActive--;
        if (this._parserQueue.length > 0) {
            const item = this._parserQueue.shift();
            this._parsersActive++;
            this._parse(item.file, item.uid, item.resolve);
        }
    }

    _nextImageFetch() {
        if (this._imageFetchQueue.length > 0) {
            const {acoustIdCoverArt, albumKey, resolve} = this._imageFetchQueue.shift();
            resolve(this._fetchAcoustIdImage(acoustIdCoverArt, albumKey));
        } else {
            this._currentlyFetchingImage = false;
        }
    }

    async _fetchAcoustIdImage(acoustIdCoverArt, albumKey) {
        const image = await this._tagDatabase.getAlbumImage(albumKey);
        if (image) {
            return image;
        }

        if (acoustIdCoverArt) {
            const {type, mbid} = acoustIdCoverArt;
            const url = `https://coverartarchive.org/${type}/${mbid}/front-250`;
            const ret = {url};
            await this._tagDatabase.setAlbumImage(albumKey, url);
            return ret;
        } else {
            return null;
        }
    }

    async _parse(file, trackUid, resolve) {
        let trackInfo = await this._tagDatabase.getTrackInfoByTrackUid(trackUid);

        if (trackInfo) {
            resolve(trackInfo);
            return;
        }

        const data = {
            trackUid,
            codecName: null,
            duration: 0,
            autogenerated: false
        };
        const fileView = new FileView(file);
        const codecName = await getCodecName(fileView);
        if (!codecName) {
            throw codecNotSupportedError();
        }

        switch (codecName) {
            case `wav`:
            case `webm`:
            case `aac`:
            case `ogg`:
                throw codecNotSupportedError();
            case `mp3`:
                await parseMp3Metadata(data, fileView);
                break;
            default: break;
        }
        data.codecName = codecName;
        data.duration = data.demuxData.duration;
        data.trackUid = trackUid;

        if (!data.artist || !data.title) {
            const {artist, title} = trackInfoFromFileName(file.name);
            data.artist = artist;
            data.title = title;
            data.autogenerated = true;
        }

        trackInfo = buildTrackInfo(data, data.demuxData);
        await this._tagDatabase.replaceTrackInfo(trackUid, trackInfo);
        resolve(trackInfo);
    }

    setEstablishedGain(trackUid, establishedGain) {
        return this._tagDatabase.updateEstablishedGain(trackUid, establishedGain);
    }

    async getTrackInfoByFile(file) {
        const trackUid = await getFileCacheKey(file);
        return this._tagDatabase.getTrackInfoByTrackUid(trackUid);
    }

    async fetchAcoustId(uid, fingerprint, duration) {
        const data = queryString({
            client: `djbbrJFK`,
            format: `json`,
            duration: duration | 0,
            meta: `recordings+releasegroups+compress`,
            fingerprint
        });
        const url = `https://api.acoustId.org/v2/lookup?${data}`;

        let result;
        let retries = 0;
        let fullResponse = null;
        while (retries < 5) {
            try {
                const response = await ajaxGet(url);
                if (response &&
                    response.status !== `error` &&
                    response.results &&
                    response.results.length > 0) {
                    fullResponse = response.results;
                }
                result = parseAcoustId(response);
                break;
            } catch (e) {
                debugger;
                if (!e.isRetryable()) {

                    throw e;
                }
                retries++;
            }
        }
        let acoustIdCoverArt = null;
        if (result) {
            const {album, title} = result;
            if (album && album.mbid) {
                acoustIdCoverArt = {
                    mbid: album.mbid,
                    type: album.type
                };
            } else if (title && title.mbid) {
                acoustIdCoverArt = {
                    mbid: title.mbid,
                    type: title.type
                };
            }
        }
        const trackInfo = await this._tagDatabase.getTrackInfoByTrackUid(uid);
        const wasAutogenerated = trackInfo.autogenerated;
        trackInfo.autogenerated = false;

        let trackInfoUpdated = acoustIdCoverArt !== null;
        if (result) {
            const {album: albumResult,
                   title: titleResult,
                   artist: artistResult,
                   albumArtist: albumArtistResult} = result;
            const {name: album} = albumResult || {};
            const {name: title} = titleResult || {};
            const {name: artist} = artistResult || {};
            const {name: albumArtist} = albumArtistResult || {};

            if ((isUnknown(trackInfo.title) || wasAutogenerated) && title) {
                trackInfo.title = title;
                trackInfoUpdated = true;
            }

            if ((isUnknown(trackInfo.album) || wasAutogenerated) && album) {
                trackInfo.album = album;
                trackInfoUpdated = true;
            }

            if ((isUnknown(trackInfo.albumArtist) || wasAutogenerated) && albumArtist) {
                trackInfo.albumArtist = albumArtist;
                trackInfoUpdated = true;
            }

            if ((isUnknown(trackInfo.artist) || wasAutogenerated) && artist) {
                trackInfo.artist = artist;
                trackInfoUpdated = true;
            }
        }

        trackInfo.acoustIdCoverArt = acoustIdCoverArt;
        trackInfo.acoustIdFullResponse = fullResponse;
        await this._tagDatabase.replaceTrackInfo(uid, trackInfo);
        return {
            trackInfo,
            trackInfoUpdated
        };
    }

    async parse(file, uid) {
        try {
            const ret = await new Promise((resolve) => {
                if (this._parsersActive >= this._maxParsersActive) {
                    this._parserQueue.push({
                        file,
                        resolve,
                        uid
                    });
                } else {
                    this._parsersActive++;
                    this._parse(file, uid, resolve);
                }
            });
            return ret;
        } finally {
            this._nextParse();
        }
    }

    async fetchAcoustIdImage(acoustIdCoverArt, albumKey) {
        const ret = new Promise((resolve) => {
            if (!this._currentlyFetchingImage) {
                this._currentlyFetchingImage = true;
                resolve(this._fetchAcoustIdImage(acoustIdCoverArt, albumKey));
            } else {
                this._imageFetchQueue.push({
                    acoustIdCoverArt, albumKey, resolve
                });
            }
        });

        try {
            const value = await ret;
            return value;
        } finally {
            this._nextImageFetch();
        }
    }
}
