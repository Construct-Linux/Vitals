/* Cached GSettings reads for the poll and formatting paths (shell only). */

// Every GSettings getter looks the key up in dconf and builds a GVariant;
// the poll loop and the value formatter ask for the same few keys for every
// sensor on every tick. Values are kept until the key changes.
export class SettingsCache {
    constructor(settings) {
        this._settings = settings;
        this._values = new Map();
        this._changedId = settings.connect('changed', (s, key) => this._values.delete(key));
    }

    _get(key) {
        if (!this._values.has(key))
            this._values.set(key, this._settings.get_value(key).deepUnpack());
        return this._values.get(key);
    }

    get_boolean(key) {
        return this._get(key);
    }

    get_int(key) {
        return this._get(key);
    }

    get_string(key) {
        return this._get(key);
    }

    get_strv(key) {
        return this._get(key);
    }

    destroy() {
        this._settings.disconnect(this._changedId);
    }
}
