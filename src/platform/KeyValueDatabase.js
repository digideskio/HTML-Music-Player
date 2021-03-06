import {iDbPromisify, applyStoreSpec} from "utils/indexedDbUtil";
import {DatabaseClosedError} from "platform/platform";
import EventEmitter from "events";
import DatabaseClosedEmitterTrait from "platform/DatabaseClosedEmitterTrait";

const VERSION = 2;
const NAME = `AppDatabase`;
const KEY_VALUE_PAIRS_KEY_NAME = `key`;
const KEY_VALUE_PAIRS_OBJECT_STORE_NAME = `keyValuePairs`;
const READ_WRITE = `readwrite`;
const READ_ONLY = `readonly`;

const LOG_OBJECT_STORE_NAME = `logs`;
const LOG_PRIMARY_KEY_NAME = `id`;

const TMP_FILES_OBJECT_STORE_NAME = `tmpFiles`;
const TMP_FILE_KEY_NAME = `tmpFileId`;
const SOURCE_KEY = `source`;


const objectStoreSpec = {
    [KEY_VALUE_PAIRS_OBJECT_STORE_NAME]: {
        keyPath: KEY_VALUE_PAIRS_KEY_NAME
    },
    [LOG_OBJECT_STORE_NAME]: {
        keyPath: LOG_PRIMARY_KEY_NAME,
        autoIncrement: true
    },
    [TMP_FILES_OBJECT_STORE_NAME]: {
        keyPath: TMP_FILE_KEY_NAME,
        autoIncrement: true,
        indexSpec: {
            [SOURCE_KEY]: {
                unique: false,
                multiEntry: false,
                keyPath: SOURCE_KEY
            }
        }
    }
};

export default class KeyValueDatabase extends EventEmitter {
    constructor() {
        super();
        this._closed = false;
        /* eslint-disable no-undef */
        const request = indexedDB.open(NAME, VERSION);
        /* eslint-enable no-undef */
        this.db = iDbPromisify(request);
        request.onupgradeneeded = (event) => {
            applyStoreSpec(event.target.transaction, objectStoreSpec);
        };
        this.initialValues = this.getAll();
        this.keySetters = Object.create(null);

        this._uiLogRef = self.uiLog;
        self.uiLog = this.uiLogOverwrite.bind(this);
        this._lastLog = null;
        this._setHandlers();
    }

    async _setHandlers() {
        const db = await this.db;
        db.onversionchange = () => {
            this._closed = true;
            db.close();
            this.databaseClosed();
        };
        db.onclose = function() {
            this._closed = true;
            this.databaseClosed();
        };
    }

    _checkClosed() {
        if (this._closed) {
            throw new DatabaseClosedError();
        }
    }

    async close() {
        const db = await this.db;
        this._closed = true;
        db.close();
        this.databaseClosed();
    }

    getKeySetter(key) {
        if (!this.keySetters[key]) {
            const keySetter = {
                async method(value) {
                    this._checkClosed();
                    const db = await this.db;
                    const transaction = db.transaction(KEY_VALUE_PAIRS_OBJECT_STORE_NAME, READ_WRITE);
                    const store = transaction.objectStore(KEY_VALUE_PAIRS_OBJECT_STORE_NAME);
                    const existingData = await iDbPromisify(store.get(key));
                    if (existingData) {
                        existingData.value = value;
                        return iDbPromisify(store.put(existingData));
                    } else {
                        const data = {key, value};
                        return iDbPromisify(store.add(data));
                    }
                }
            };
            this.keySetters[key] = keySetter.method;
        }
        return this.keySetters[key];
    }

    getInitialValues() {
        return this.initialValues;
    }

    uiLogOverwrite(...args) {
        const msg = args.join(` `);
        if (msg === this._lastLog) {
            return;
        }
        this._lastLog = msg;
        this.storeLog(msg);
        this._uiLogRef(...args);
    }

    async storeLog(message) {
        if (this.isClosedAndEmit()) return null;
        const date = new Date();
        const db = await this.db;
        const store = db.transaction(LOG_OBJECT_STORE_NAME, READ_WRITE).objectStore(LOG_OBJECT_STORE_NAME);
        return iDbPromisify(store.add({message, date}));
    }

    set(key, value) {
        if (this.isClosedAndEmit()) return null;
        return this.getKeySetter(`${key}`).call(this, value);
    }

    async get(key) {
        if (this.isClosedAndEmit()) return null;
        key = `${key}`;
        const db = await this.db;
        const store = db.transaction(KEY_VALUE_PAIRS_OBJECT_STORE_NAME, READ_ONLY).objectStore(KEY_VALUE_PAIRS_OBJECT_STORE_NAME);
        return iDbPromisify(store.get(key));
    }

    async getAll() {
        if (this.isClosedAndEmit()) return {};
        const db = await this.db;
        const store = db.transaction(KEY_VALUE_PAIRS_OBJECT_STORE_NAME, READ_ONLY).objectStore(KEY_VALUE_PAIRS_OBJECT_STORE_NAME);
        const keyValuePairs = await iDbPromisify(store.getAll());

        const ret = Object.create(null);
        keyValuePairs.forEach((pair) => {
            ret[pair.key] = pair.value;
        });
        return ret;
    }

    async setAll(preferenceKeyValuePairs) {
        if (this.isClosedAndEmit()) return;
        const db = await this.db;
        const store = db.transaction(KEY_VALUE_PAIRS_OBJECT_STORE_NAME, READ_WRITE).objectStore(KEY_VALUE_PAIRS_OBJECT_STORE_NAME);

        for (const preferenceKeyValuePair of preferenceKeyValuePairs) {
            await store.put(preferenceKeyValuePair);
        }
    }

    async setAllObject(preferences) {
        if (this.isClosedAndEmit()) return;
        const db = await this.db;
        const store = db.transaction(KEY_VALUE_PAIRS_OBJECT_STORE_NAME, READ_WRITE).objectStore(KEY_VALUE_PAIRS_OBJECT_STORE_NAME);

        const keys = Object.keys(preferences);

        for (const key of keys) {
            const obj = {key, value: preferences[key]};
            await store.put(obj);
        }
    }

    getDb() {
        return this.db;
    }

    async getTmpFiles() {
        this._checkClosed();
        const db = await this.db;
        const store = db.transaction(TMP_FILES_OBJECT_STORE_NAME, READ_ONLY).objectStore(TMP_FILES_OBJECT_STORE_NAME);
        return iDbPromisify(store.getAll());
    }

    async consumeTmpFileById(tmpFileId) {
        this._checkClosed();
        const db = await this.db;
        const store = db.transaction(TMP_FILES_OBJECT_STORE_NAME, READ_WRITE).objectStore(TMP_FILES_OBJECT_STORE_NAME);
        const ret = await iDbPromisify(store.get(tmpFileId));
        await iDbPromisify(store.delete(tmpFileId));
        return ret;
    }

    async getTmpFileById(tmpFileId) {
        this._checkClosed();
        const db = await this.db;
        const store = db.transaction(TMP_FILES_OBJECT_STORE_NAME, READ_ONLY).objectStore(TMP_FILES_OBJECT_STORE_NAME);
        return iDbPromisify(store.get(tmpFileId));
    }

    async addTmpFile(file, source) {
        this._checkClosed();
        const db = await this.db;
        const store = db.transaction(TMP_FILES_OBJECT_STORE_NAME, READ_WRITE).objectStore(TMP_FILES_OBJECT_STORE_NAME);
        const obj = {
            created: new Date(),
            file,
            [SOURCE_KEY]: source
        };
        const ret = await iDbPromisify(store.add(obj));
        return ret;
    }

    async clearTmpFiles() {
        this._checkClosed();
        const db = await this.db;
        const store = db.transaction(TMP_FILES_OBJECT_STORE_NAME, READ_WRITE).objectStore(TMP_FILES_OBJECT_STORE_NAME);
        await iDbPromisify(store.clear());
    }

    async deleteTmpFile(tmpFileId) {
        this._checkClosed();
        const db = await this.db;
        const store = db.transaction(TMP_FILES_OBJECT_STORE_NAME, READ_WRITE).objectStore(TMP_FILES_OBJECT_STORE_NAME);
        await iDbPromisify(store.delete(tmpFileId));
    }

    isClosed() {
        return this._closed;
    }

    isClosedAndEmit() {
        if (this.isClosed()) {
            this.databaseClosed();
            return true;
        }
        return false;
    }
}

Object.assign(KeyValueDatabase.prototype, DatabaseClosedEmitterTrait);
