import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { convertUint8ArrayToString } from './bytes.js';

export function File(path) {
    this.path = path;
    this.file = Gio.File.new_for_path(path);
}

// procfs builds these files in memory on read and never waits on a disk,
// so a plain read costs less than a GTask thread round trip. /proc/net
// files can wait on the rtnl lock, and sysfs attributes call into drivers
// (hwmon, power_supply, DRM) that may talk to slow hardware: those stay async.
function isMemoryOnly(path) {
    return path.startsWith('/proc/') && !path.startsWith('/proc/net/');
}

function parse(contents, delimiter, strip_header) {
    // convert contents to string
    contents = convertUint8ArrayToString(contents);

    // split contents by delimiter if passed in
    if (delimiter) contents = contents.split(delimiter);

    // optionally strip header when converting to a list
    if (strip_header) contents.shift();

    return contents;
}

File.prototype.read = function(delimiter = '', strip_header = false) {
    return new Promise((resolve, reject) => {
        try {
            if (isMemoryOnly(this.path)) {
                resolve(parse(GLib.file_get_contents(this.path)[1], delimiter, strip_header));
                return;
            }

            this.file.load_contents_async(null, function(file, res) {
                try {
                    resolve(parse(file.load_contents_finish(res)[1], delimiter, strip_header));
                } catch (e) {
                    reject(e.message);
                }
            });
        } catch (e) {
            reject(e.message);
        }
    });
};

File.prototype.list = function() {
    return new Promise((resolve, reject) => {
        let max_items = 125, results = [];

        try {
            this.file.enumerate_children_async(Gio.FILE_ATTRIBUTE_STANDARD_NAME, Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null, function(file, res) {
                try {
                    let enumerator = file.enumerate_children_finish(res);

                    let callback = function(enumerator, res) {
                        try {
                            let files = enumerator.next_files_finish(res);
                            for (let i = 0; i < files.length; i++) {
                                results.push(files[i].get_attribute_as_string(Gio.FILE_ATTRIBUTE_STANDARD_NAME));
                            }

                            if (files.length == 0) {
                                enumerator.close_async(GLib.PRIORITY_LOW, null, function(){});
                                resolve(results);
                            } else {
                                enumerator.next_files_async(max_items, GLib.PRIORITY_LOW, null, callback);
                            }
                        } catch (e) {
                            reject(e.message);
                        }
                    };

                    enumerator.next_files_async(max_items, GLib.PRIORITY_LOW, null, callback);
                } catch (e) {
                    reject(e.message);
                }
            });
        } catch (e) {
            reject(e.message);
        }
    });
};
