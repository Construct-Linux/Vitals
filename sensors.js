/*
  Copyright (c) 2018, Chris Monahan <chris@corecoding.com>

  Redistribution and use in source and binary forms, with or without
  modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of the GNOME nor the names of its contributors may be
      used to endorse or promote products derived from this software without
      specific prior written permission.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
  ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
  WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
  DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY
  DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
  (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
  LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
  ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
  (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
  SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import * as FileModule from './helpers/file.js';

let GTop, hasGTop = true;
try {
    ({default: GTop} = await import('gi://GTop'));
} catch (err) {
    log(err);
    hasGTop = false;
};

const FREQUENCY_KEYS = ['_processor_frequency_', '_processor_max_frequency_', '_processor_min_frequency_'];

export const Sensors = GObject.registerClass({
    GTypeName: 'Sensors',
}, class Sensors extends GObject.Object {
    _init(settings, sensorIcons, gettext) {
        this._settings = settings;
        this._sensorIcons = sensorIcons;
        this._gettext = gettext || (s => s);

        this.resetHistory();

        this._last_processor = { 'core': {}, 'time': 0 };

        this._gpu_drm_vendors = [];
        this._gpu_drm_indices = [];

        this._refreshRate = 0;

        this._storageDevice = '';
        this._findStorageDevice();
        this._lastRead = 0;
        this._lastWrite = 0;
        this._lastDiskTime = 0;

        if (hasGTop)
            this.storage = new GTop.glibtop_fsusage();
    }

    _findStorageDevice() {
        new FileModule.File('/proc/mounts').read("\n").then(lines => {
            for (let line of lines) {
                let loadArray = line.trim().split(/\s+/);
                if (loadArray[1] == this._settings.get_string('storage-path')) {
                    this._storageDevice = loadArray[0];
                    break;
                }
            }
        }).catch(err => { });
    }

    query(callback, wantedKeys) {
        if (!this._hardware_detected) {
            // we could set _hardware_detected in discoverHardwareMonitors, but by
            // doing it here, we guarantee avoidance of race conditions
            this._hardware_detected = true;
            this._discoverHardwareMonitors(callback);
        } else if (this._static_info_refresh) {
            // menu redraw / Refresh: re-emit static CPU/kernel and rediscover NICs
            this._static_info_refresh = false;
            this._queryStaticInfo(callback);
            this._discoverNetworkIfaces(callback);
        }

        for (let sensor in this._sensorIcons) {
            // Process Time needs core counts from _queryProcessor even if Processor is hidden
            if (!this._settings.get_boolean('show-' + sensor)) {
                if (sensor === 'processor' && wantedKeys &&
                    wantedKeys.has('_processor_process_time_'))
                    this._queryProcessor(callback, wantedKeys);
                continue;
            }

            // menu closed: read only the groups something in the panel shows
            if (wantedKeys && !this._groupWanted(sensor, wantedKeys))
                continue;

            if (sensor == 'temperature' || sensor == 'voltage' || sensor == 'fan') {
                // wantedKeys filters individual hwmon files when the menu is closed
                this._queryTempVoltFan(callback, sensor, wantedKeys);
            } else {
                let method = '_query' + sensor[0].toUpperCase() + sensor.slice(1);
                this[method](callback, wantedKeys);
            }
        }
    }

    _groupWanted(sensor, wantedKeys) {
        // Process Time is read with the system stats and divided by the core count
        if ((sensor === 'system' || sensor === 'processor') &&
            wantedKeys.has('_processor_process_time_'))
            return true;

        // keys are _<type>_<label>_ or __<type>_<stat>__, and gpu types are gpu#<n>
        for (let key of wantedKeys) {
            if (key.replace(/^_+/, '').startsWith(sensor))
                return true;
        }
        return false;
    }

    _queryTempVoltFan(callback, type, wantedKeys) {
        let readAll = !wantedKeys ||
            wantedKeys.has('__' + type + '_avg__') ||
            wantedKeys.has('__' + type + '_min__') ||
            wantedKeys.has('__' + type + '_max__');

        for (let label in this._tempVoltFanSensors[type]) {
            if (!readAll &&
                !wantedKeys.has('_' + type + '_' + label.replaceAll(' ', '_').toLowerCase() + '_'))
                continue;

            let sensor = this._tempVoltFanSensors[type][label];

            new FileModule.File(sensor['path']).read().then(value => {
                this._returnValue(callback, label, value, type, sensor['format']);
            }).catch(err => {
                this._returnValue(callback, label, 'disabled', type, sensor['format']);
            });
        }
    }

    _queryMemory(callback) {
        // check memory info
        new FileModule.File('/proc/meminfo').read().then(lines => {
            let m = Object.fromEntries([...lines.matchAll(/^(\w+):\s+(\d+)/gm)].map(x => [x[1], +x[2]]));
            let total = m.MemTotal || 0, avail = m.MemAvailable || 0, swapTotal = m.SwapTotal || 0;
            let swapFree = m.SwapFree || 0, cached = m.Cached || 0, memFree = m.MemFree || 0;

            let used = total - avail;
            let utilized = total ? used / total : 0;
            let swapUsed = swapTotal - swapFree;
            let swapUtilized = swapTotal ? swapUsed / swapTotal : 0;

            this._returnValue(callback, 'Usage', utilized, 'memory', 'percent');
            this._returnValue(callback, 'memory', utilized, 'memory-group', 'percent');
            this._returnValue(callback, 'Physical', total, 'memory', 'memory');
            this._returnValue(callback, 'Available', avail, 'memory', 'memory');
            this._returnValue(callback, 'Allocated', used, 'memory', 'memory');
            this._returnValue(callback, 'Cached', cached, 'memory', 'memory');
            this._returnValue(callback, 'Free', memFree, 'memory', 'memory');
            this._returnValue(callback, 'Swap Total', swapTotal, 'memory', 'memory');
            this._returnValue(callback, 'Swap Free', swapFree, 'memory', 'memory');
            this._returnValue(callback, 'Swap Used', swapUsed, 'memory', 'memory');
            this._returnValue(callback, 'Swap Usage', swapUtilized, 'memory', 'percent');
        }).catch(err => { });
    }

    _queryProcessor(callback, wantedKeys) {
        // check processor usage
        new FileModule.File('/proc/stat').read("\n").then(lines => {
            // rates divide by the time since this file was last read, not since
            // the last poll: a poll can skip the processor group
            let now = GLib.get_monotonic_time();
            let dwell = (now - this._last_processor['time']) / 1000000;
            this._last_processor['time'] = now;
            let statistics = {};

            for (let line of lines) {
                let reverse_data = line.match(/^(cpu\d*\s)(.+)/);
                if (reverse_data) {
                    let cpu = reverse_data[1].trim();

                    if (!(cpu in this._last_processor['core']))
                        this._last_processor['core'][cpu] = 0;

                    let s = reverse_data[2].trim().split(' ');
                    statistics[cpu] = parseInt(s[0]) + parseInt(s[1]) + parseInt(s[2]);
                }
            }

            let cores = Object.keys(statistics).length - 1;

            for (let cpu in statistics) {
                let total = statistics[cpu];

                // make sure we have data to report
                if (this._last_processor['core'][cpu] > 0 && dwell > 0) {
                    let delta = (total - this._last_processor['core'][cpu]) / dwell;

                    // /proc/stat provides overall usage for us under the 'cpu' heading
                    if (cpu == 'cpu') {
                        delta = delta / cores;
                        this._returnValue(callback, 'processor', delta / 100, 'processor-group', 'percent');
                        this._returnValue(callback, 'Usage', delta / 100, 'processor', 'percent');
                    } else {
                        this._returnValue(callback, this._gettext('Core %d').format(cpu.substr(3)), delta / 100, 'processor', 'percent');
                    }
                }

                this._last_processor['core'][cpu] = total;
            }

            // /proc/cpuinfo formats every flag of every core to give the same
            // value; read the per-core cpufreq files, and only when shown
            if (!wantedKeys || FREQUENCY_KEYS.some(k => wantedKeys.has(k)))
                this._queryFrequencies(callback, Object.keys(statistics).filter(cpu => cpu != 'cpu'));
        }).catch(err => { });
    }

    _queryFrequencies(callback, cpus) {
        Promise.allSettled(cpus.map(cpu =>
            new FileModule.File('/sys/devices/system/cpu/' + cpu + '/cpufreq/scaling_cur_freq').read()
        )).then(results => {
            let freqs = results.filter(r => r.status === 'fulfilled').map(r => parseInt(r.value));
            if (freqs.length)
                this._returnFrequencies(callback, freqs);
        });
    }

    // freqs in kHz, as cpufreq reports them
    _returnFrequencies(callback, freqs) {
        let scale = 1000;
        let sum = 0, min = freqs[0], max = freqs[0];
        for (let v of freqs) { sum += v; if (v < min) min = v; if (v > max) max = v; }
        this._returnValue(callback, 'Frequency', (sum / freqs.length) * scale, 'processor', 'hertz');
        this._returnValue(callback, 'Max frequency', max * scale, 'processor', 'hertz');
        this._returnValue(callback, 'Min frequency', min * scale, 'processor', 'hertz');
    }

    _querySystem(callback) {
        // check load average
        new FileModule.File('/proc/sys/fs/file-nr').read("\t").then(loadArray => {
            this._returnValue(callback, 'Open Files', loadArray[0], 'system', 'string');
        }).catch(err => { });

        // check load average
        new FileModule.File('/proc/loadavg').read(' ').then(loadArray => {
            let proc = loadArray[3].split('/');

            this._returnValue(callback, 'Load 1m', parseFloat(loadArray[0]), 'system', 'load');
            this._returnValue(callback, 'system', parseFloat(loadArray[0]), 'system-group', 'load');
            this._returnValue(callback, 'Load 5m', parseFloat(loadArray[1]), 'system', 'load');
            this._returnValue(callback, 'Load 15m', parseFloat(loadArray[2]), 'system', 'load');
            this._returnValue(callback, 'Threads Active', proc[0], 'system', 'string');
            this._returnValue(callback, 'Threads Total', proc[1], 'system', 'string');
        }).catch(err => { });

        // check uptime
        new FileModule.File('/proc/uptime').read(' ').then(upArray => {
            this._returnValue(callback, 'Uptime', upArray[0], 'system', 'uptime');

            let cores = Object.keys(this._last_processor['core']).length - 1;
            if (cores > 0)
                this._returnValue(callback, 'Process Time', upArray[0] - upArray[1] / cores, 'processor', 'uptime');
        }).catch(err => { });
    }

    _queryNetwork(callback) {
        for (let sensor of this._networkIfaces) {
            new FileModule.File(sensor.path).read().then(value => {
                this._returnValue(callback, sensor.name, value, sensor.type, 'storage');
            }).catch(err => {
                // issue #557 - the interface went away (docker veth, VPN tun); rediscover
                // now, or its last speed stays in the Device total until a Refresh.
                // Rediscovery replaces the list, so the other failed reads skip this
                if (this._networkIfaces.includes(sensor))
                    this._discoverNetworkIfaces(callback);
            });
        }

        if (this._hasWireless)
            this._queryWireless(callback);
    }

    _queryWireless(callback) {
        new FileModule.File('/proc/net/wireless').read("\n", true).then(lines => {
            // wireless has two headers - first is stripped in helper function
            lines.shift();

            // if multiple wireless device, we use the last one
            let line = lines[lines.length - 1];
            if (!line)
                return;
            let netArray = line.trim().split(/\s+/);
            let quality_pct = netArray[2].substr(0, netArray[2].length-1) / 70;
            let signal = netArray[3].substr(0, netArray[3].length-1);

            this._returnValue(callback, 'WiFi Link Quality', quality_pct, 'network', 'percent');
            this._returnValue(callback, 'WiFi Signal Level', signal, 'network', 'string');
        }).catch(err => { });
    }

    _queryStorage(callback) {
        // check disk performance stats
        new FileModule.File('/proc/diskstats').read("\n").then(lines => {
            let now = GLib.get_monotonic_time();
            let dwell = (now - this._lastDiskTime) / 1000000;
            this._lastDiskTime = now;
            for (let line of lines) {
                let loadArray = line.trim().split(/\s+/);
                if ('/dev/' + loadArray[2] == this._storageDevice) {
                    var read = (loadArray[5] * 512);
                    var write = (loadArray[9] * 512);
                    this._returnValue(callback, 'Read total', read, 'storage', 'storage');
                    this._returnValue(callback, 'Write total', write, 'storage', 'storage');
                    // skip rates until counters are seeded (same pattern as processor cores)
                    if (this._lastRead > 0 && dwell > 0)
                        this._returnValue(callback, 'Read rate', (read - this._lastRead) / dwell, 'storage', 'storage');
                    if (this._lastWrite > 0 && dwell > 0)
                        this._returnValue(callback, 'Write rate', (write - this._lastWrite) / dwell, 'storage', 'storage');
                    this._lastRead = read;
                    this._lastWrite = write;
                    break;
                }
            }
        }).catch(err => { });

        // skip rest of stats if gtop not available
        if (!hasGTop) return;

        GTop.glibtop_get_fsusage(this.storage, this._settings.get_string('storage-path'));

        let total = this.storage.blocks * this.storage.block_size;
        let avail = this.storage.bavail * this.storage.block_size;
        let free = this.storage.bfree * this.storage.block_size;
        let used = total - free;
        let reserved = (total - avail) - used;
        let freePercent = 0;
        let usedPercent = 0;
        if (total > 0) {
          freePercent = Math.round((free / total) * 100);
          usedPercent = Math.round((used / total) * 100);
        }

        this._returnValue(callback, 'Total', total, 'storage', 'storage');
        this._returnValue(callback, 'Used', used, 'storage', 'storage');
        this._returnValue(callback, 'Reserved', reserved, 'storage', 'storage');
        this._returnValue(callback, 'Free', avail, 'storage', 'storage');
        this._returnValue(callback, 'Used %', usedPercent + '%', 'storage', 'string');
        this._returnValue(callback, 'Free %', freePercent + '%', 'storage', 'string');
        this._returnValue(callback, 'storage', avail, 'storage-group', 'storage');
    }

    _queryBattery(callback) {
        let battery_slot = this._settings.get_int('battery-slot');

        // create a mapping of indices to battery paths (from prefs.ui)
        const BATTERY_PATHS = {
            0: 'BAT0',
            1: 'BAT1',
            2: 'BAT2',
            3: 'BATT',
            4: 'CMB0',
            5: 'CMB1',
            6: 'CMB2',
            7: 'macsmc-battery'
        };

        // uevent has all necessary fields, no need to read individual files
        let battery_path = '/sys/class/power_supply/' + BATTERY_PATHS[battery_slot] + '/uevent';
        new FileModule.File(battery_path).read("\n").then(lines => {
            let output = {};
            for (let line of lines) {
                let split = line.split('=');
                output[split[0].replace('POWER_SUPPLY_', '')] = split[1];
            }

            if ('STATUS' in output) {
                this._returnValue(callback, 'State', output['STATUS'], 'battery', '');
            }

            if ('CYCLE_COUNT' in output) {
                this._returnValue(callback, 'Cycles', output['CYCLE_COUNT'], 'battery', '');
            }

            if ('VOLTAGE_NOW' in output) {
                this._returnValue(callback, 'Voltage', output['VOLTAGE_NOW'] / 1000, 'battery', 'in');
            }

            if ('CAPACITY_LEVEL' in output) {
                this._returnValue(callback, 'Level', output['CAPACITY_LEVEL'], 'battery', '');
            }

            if ('CAPACITY' in output) {
                this._returnValue(callback, 'Percentage', output['CAPACITY'] / 100, 'battery', 'percent');
            }

            if ('VOLTAGE_NOW' in output && 'CURRENT_NOW' in output && (!('POWER_NOW' in output))) {
                output['POWER_NOW'] = (output['VOLTAGE_NOW'] * output['CURRENT_NOW']) / 1000000;
            }

            if ('POWER_NOW' in output) {
                const powerValue = (
                    parseFloat(output['POWER_NOW']) * (output['STATUS'] === 'Discharging' ? -1 : 1)
                );
                this._returnValue(callback, 'Power Rate', powerValue, 'battery', 'watt');
                this._returnValue(callback, 'battery', powerValue, 'battery-group', 'watt');
            }

            if ('CHARGE_FULL' in output && 'VOLTAGE_MIN_DESIGN' in output && (!('ENERGY_FULL' in output))) {
                output['ENERGY_FULL'] = (output['CHARGE_FULL'] * output['VOLTAGE_MIN_DESIGN']) / 1000000;
            }

            if ('ENERGY_FULL' in output) {
                this._returnValue(callback, 'Energy (full)', output['ENERGY_FULL'], 'battery', 'watt-hour');
            }

            if ('CHARGE_FULL_DESIGN' in output && 'VOLTAGE_MIN_DESIGN' in output && (!('ENERGY_FULL_DESIGN' in output))) {
                output['ENERGY_FULL_DESIGN'] = (output['CHARGE_FULL_DESIGN'] * output['VOLTAGE_MIN_DESIGN']) / 1000000;
            }

            if ('ENERGY_FULL_DESIGN' in output) {
                this._returnValue(callback, 'Energy (design)', output['ENERGY_FULL_DESIGN'], 'battery', 'watt-hour');

                if ('ENERGY_FULL' in output) {
                    this._returnValue(callback, 'Capacity', (output['ENERGY_FULL'] / output['ENERGY_FULL_DESIGN']), 'battery', 'percent');
                }
            }

            if ('VOLTAGE_MIN_DESIGN' in output && 'CHARGE_NOW' in output && (!('ENERGY_NOW' in output))) {
                output['ENERGY_NOW'] = (output['VOLTAGE_MIN_DESIGN'] * output['CHARGE_NOW']) / 1000000;
            }

            if ('ENERGY_NOW' in output) {
                this._returnValue(callback, 'Energy (now)', output['ENERGY_NOW'], 'battery', 'watt-hour');
            }

            if ('ENERGY_FULL' in output && 'ENERGY_NOW' in output && 'POWER_NOW' in output &&
                output['POWER_NOW'] !== 0 && 'STATUS' in output &&
                (output['STATUS'] == 'Charging' || output['STATUS'] == 'Discharging')) {

                let timeLeft = 0;

                // two different formulas depending on if we are charging or discharging
                if (output['STATUS'] == 'Charging') {
                    timeLeft = ((output['ENERGY_FULL'] - output['ENERGY_NOW']) / output['POWER_NOW']);
                } else {
                    timeLeft = (output['ENERGY_NOW'] / Math.abs(output['POWER_NOW']));
                }

                // don't process Infinity values
                if (timeLeft !== Infinity) {
                    if (this._battery_charge_status != output['STATUS']) {
                        // clears history due to state change
                        this._battery_time_left_history = [];

                        // clear time left history when laptop goes in and out of charging
                        this._battery_charge_status = output['STATUS'];
                    }

                    // add latest time left estimate to our history
                    this._battery_time_left_history.push(parseInt(timeLeft * 3600));

                    // keep track of last 15 time left estimates by erasing the first
                    if (this._battery_time_left_history.length > 10)
                        this._battery_time_left_history.shift();

                    // sum up and create average of our time left history
                    let sum = this._battery_time_left_history.reduce((a, b) => a + b);
                    let avg = sum / this._battery_time_left_history.length;

                    // use time left history to update screen
                    this._returnValue(callback, 'Time left', parseInt(avg), 'battery', 'runtime');
                }
            } else {
                this._returnValue(callback, 'Time left', output['STATUS'], 'battery', '');
            }
        }).catch(err => { });
    }

    // the panel, and with it this menu, sits on the primary monitor
    _primaryRefreshRate() {
        // prefs builds Sensors outside gnome-shell
        if (typeof global === 'undefined')
            return 0;

        let monitor = global.display.get_primary_monitor();
        if (monitor < 0)
            return 0;

        let primary = global.display.get_monitor_geometry(monitor);
        for (let view of global.stage.peek_stage_views()) {
            // get_layout() takes an unannotated MtkRectangle*, an in-argument
            // to GI (clutter-stage-view.h:53); the layout property is readable
            let layout = view.layout;
            if (layout.x === primary.x && layout.y === primary.y)
                return view.get_refresh_rate();
        }
        return 0;
    }

    _returnGpuGroupHeader(callback, typeName, utilization) {
        if (utilization !== null && !isNaN(utilization)) {
            this._returnGpuValue(callback, 'Graphics', utilization, typeName + '-group', 'percent');
            return;
        }

        if (this._refreshRate > 0)
            this._returnGpuValue(callback, 'Graphics', this._refreshRate, typeName + '-group', 'hertz');
    }

    _queryGpu(callback) {
        this._refreshRate = this._primaryRefreshRate();
        if (this._refreshRate > 0)
            this._returnValue(callback, 'Refresh Rate', this._refreshRate, 'gpu#1', 'hertz');

        // sysfs DRM, if any card was discovered
        if (!this._gpu_drm_indices.length) {
            this._returnGpuGroupHeader(callback, 'gpu#1', null);
            this._disableGpuLabels(callback);
            return;
        }

        this._readGpuDrm(callback);
    }

    _readGpuDrm(callback) {
        const unit = this._settings.get_int('memory-measurement') ? 1000 : 1024;
        for (let z = 0; z < this._gpu_drm_indices.length; z++) {
            let i = this._gpu_drm_indices[z];
            const typeName = 'gpu#' + (z + 1);
            const vendor = (this._gpu_drm_vendors[z] || '').toLowerCase();
            const cardBase = '/sys/class/drm/card' + i + '/device/';

            this._returnGpuGroupHeader(callback, typeName, null);

            if (this._settings.get_boolean('include-static-gpu-info')) {
                let vendorName = null;
                switch (vendor) {
                    case '0x1002': vendorName = 'AMD'; break;
                    case '0x10de': vendorName = 'NVIDIA'; break;
                    case '0x13b5': vendorName = 'ARM'; break;
                    case '0x5143': vendorName = 'Qualcomm'; break;
                    case '0x8086': vendorName = 'Intel'; break;
                    case '0x1234': vendorName = 'QEMU'; break;
                }
                if (vendorName)
                    this._returnGpuValue(callback, 'Vendor', vendorName, typeName, 'string');
            }

            if (vendor === '0x1002') {
                new FileModule.File(cardBase + 'gpu_busy_percent').read().then(value => {
                    let usage = parseInt(value) * 0.01;
                    this._returnGpuGroupHeader(callback, typeName, usage);
                    this._returnGpuValue(callback, 'Usage', usage, typeName, 'percent');
                }).catch(err => {
                    this._returnGpuGroupHeader(callback, typeName, null);
                });
                new FileModule.File(cardBase + 'mem_info_vram_used').read().then(value => {
                    this._returnGpuValue(callback, 'Memory Used', parseInt(value) / unit, typeName, 'memory');
                }).catch(err => { });
                new FileModule.File(cardBase + 'mem_info_vram_total').read().then(value => {
                    this._returnGpuValue(callback, 'Memory Total', parseInt(value) / unit, typeName, 'memory');
                }).catch(err => { });
            }
        }
    }

    _disableGpuLabels(callback) {
        for (let labelObj of this._gpuLabels.values()) {
            if (labelObj.type.includes('-group'))
                continue;
            this._returnValue(callback, labelObj.label, 'disabled', labelObj.type, labelObj.format);
        }
    }

    _returnGpuValue(callback, label, value, type, format) {
        if (format !== 'string' && isNaN(value))
            return;

        if (!this._gpuLabels.has(label + type))
            this._gpuLabels.set(label + type, {label, type, format});

        this._returnValue(callback, label, value, type, format);
    }

    _returnValue(callback, label, value, type, format) {
        // issue #542 - file reads cannot be cancelled, so ones still in flight when the
        // extension is disabled (every screen lock) resolve after the menu is disposed
        if (this._destroyed)
            return;

        if (value != 'disabled' && value != 'destroy' && format !== 'string' && isNaN(value))
            return;
        callback(label, value, type, format);
    }

    _discoverHardwareMonitors(callback) {
        this._tempVoltFanSensors = { 'temperature': {}, 'voltage': {}, 'fan': {} };

        let hwbase = '/sys/class/hwmon/';

        // process sensor_types now so it is not called multiple times below
        let sensor_types = {};

        if (this._settings.get_boolean('show-temperature'))
            sensor_types['temp'] = 'temperature';

        if (this._settings.get_boolean('show-voltage'))
            sensor_types['in'] = 'voltage';

        if (this._settings.get_boolean('show-fan'))
            sensor_types['fan'] = 'fan';

        // a little informal, but this code has zero I/O block
        new FileModule.File(hwbase).list().then(files => {
            for (let file of files) {
                // grab name of sensor
                new FileModule.File(hwbase + file + '/name').read().then(name => {
                    // are we dealing with a CPU?
                    if (name == 'coretemp') {
                        // determine which processor (socket) we are dealing with
                        new FileModule.File(hwbase + file + '/temp1_label').read().then(prefix => {
                            this._processTempVoltFan(callback, sensor_types, prefix, hwbase + file, file);
                        }).catch(err => {
                            // this shouldn't be necessary, but just in case temp1_label doesn't exist
                            // attempt to fix #266
                            this._processTempVoltFan(callback, sensor_types, name, hwbase + file, file);
                        });
                    } else {
                        // not a CPU, process all other sensors
                        this._processTempVoltFan(callback, sensor_types, name, hwbase + file, file);
                    }
                }).catch(err => {
                    new FileModule.File(hwbase + file + '/device/name').read().then(name => {
                        this._processTempVoltFan(callback, sensor_types, name, hwbase + file + '/device', file);
                    }).catch(err => { });
                });
            }
        }).catch(err => { });

        // is static CPU information enabled?
        this._queryStaticInfo(callback);

        this._discoverGpuDrm();
        this._discoverNetworkIfaces(callback);
    }

    _queryStaticInfo(callback) {
        if (!this._settings.get_boolean('include-static-info'))
            return;

        // grab static CPU information
        new FileModule.File('/proc/cpuinfo').read("\n").then(lines => {
            let vendor_id = '';
            let bogomips = '';
            let sockets = {};
            let cache = '';

            for (let line of lines) {
                let value = '';

                // grab cpu vendor
                if (value = line.match(/^vendor_id(\s+): (\w+.*)/)) vendor_id = value[2];

                // grab bogomips
                if (value = line.match(/^bogomips(\s+): (\d*\.?\d*)$/)) bogomips = value[2];

                // grab processor count
                if (value = line.match(/^physical id(\s+): (\d+)$/)) sockets[value[2]] = 1;

                // grab cache
                if (value = line.match(/^cache size(\s+): (\d+) KB$/)) cache = value[2];
            }

            this._returnValue(callback, 'Vendor', vendor_id, 'processor', 'string');
            this._returnValue(callback, 'Bogomips', bogomips, 'processor', 'string');
            this._returnValue(callback, 'Sockets', Object.keys(sockets).length, 'processor', 'string');
            this._returnValue(callback, 'Cache', cache, 'processor', 'memory');
        }).catch(err => { });

        // grab static CPU information
        new FileModule.File('/proc/version').read(' ').then(kernelArray => {
            this._returnValue(callback, 'Kernel', kernelArray[2], 'system', 'string');
        }).catch(err => { });
    }

    _discoverNetworkIfaces(callback) {
        let previous = this._networkIfaces;
        // a rediscovery still in flight keeps filling its own, discarded list
        let ifaces = this._networkIfaces = [];
        this._hasWireless = false;
        let netbase = '/sys/class/net/';
        let directions = ['tx', 'rx'];

        new FileModule.File(netbase).list().then(interfaces => {
            for (let iface of interfaces) {
                new FileModule.File(netbase + iface).list().then(entries => {
                    // issue #319 - bridges, veths, tun and VPN devices carry traffic that a
                    // physical interface (one with a device link) counts again, so leave
                    // them out of the rows and the Device/Boot/Session totals
                    if (iface != 'lo' && !entries.includes('device'))
                        return;

                    for (let direction of directions) {
                        // lo tx and rx are the same
                        if (iface == 'lo' && direction == 'rx')
                            continue;

                        // issue #217 - don't include 'lo' traffic in Maximum calculations in values.js
                        // by not using network-rx or network-tx
                        let name = iface + ((iface == 'lo') ? '' : ' ' + direction);
                        let type = 'network' + ((iface == 'lo') ? '' : '-' + direction);
                        let path = netbase + iface + '/statistics/' + direction + '_bytes';
                        ifaces.push({name, type, path});

                        // update screen on initial build to prevent delay on update
                        new FileModule.File(path).read().then(value => {
                            this._returnValue(callback, name, value, type, 'storage');
                        }).catch(err => { });
                    }
                }).catch(err => { });
            }

            // issue #557 - drop ifaces that disappeared since last discovery
            for (let sensor of previous) {
                if (!interfaces.includes(sensor.name.split(' ')[0]))
                    this._returnValue(callback, sensor.name, 'destroy', sensor.type, 'storage');
            }

            new FileModule.File('/proc/net/wireless').read("\n", true).then(lines => {
                lines.shift();
                if (!lines[lines.length - 1])
                    return;
                this._hasWireless = true;
                this._queryWireless(callback);
            }).catch(err => { });
        }).catch(err => { });
    }

    _discoverGpuDrm() {
        // discovered even with the GPU group hidden, so showing it later
        // finds the cards without a hardware rediscovery
        this._gpu_drm_indices = [];
        this._gpu_drm_vendors = [];
        // try to discover up to 10 cards starting from index 0
        for (let i = 0; i < 10; i++) {
            new FileModule.File('/sys/class/drm/card' + i + '/device/vendor').read().then(value => {
                this._gpu_drm_indices.push(i);
                this._gpu_drm_vendors.push(value);
            }).catch(err => { });
        }
    }

    _processTempVoltFan(callback, sensor_types, name, path, file) {
        let sensor_files = [ 'input', 'label' ];

        // grab files from directory
        new FileModule.File(path).list().then(files2 => {
            let trisensors = {};

            // loop over files from directory
            for (let file2 of Object.values(files2)) {
                // simple way of processing input and label (from above)
                for (let key of Object.values(sensor_files)) {
                    // process toggled on sensors from extension preferences
                    for (let sensor_type in sensor_types) {
                        if (file2.substr(0, sensor_type.length) == sensor_type && file2.substr(-(key.length+1)) == '_' + key) {
                            let key2 = file + file2.substr(0, file2.indexOf('_'));

                            if (!(key2 in trisensors)) {
                                trisensors[key2] = {
                                    'type': sensor_types[sensor_type],
                                  'format': sensor_type,
                                   'label': path + '/name'
                                };
                            }

                            trisensors[key2][key] = path + '/' + file2;
                        }
                    }
                }
            }

            for (let obj of Object.values(trisensors)) {
                if (!('input' in obj))
                    continue;

                new FileModule.File(obj['input']).read().then(value => {
                    let extra = (obj['label'].indexOf('_label')==-1) ? ' ' + obj['input'].substr(obj['input'].lastIndexOf('/')+1).split('_')[0] : '';

                    if (value > 0 || !this._settings.get_boolean('hide-zeros') || obj['type'] == 'fan') {
                        new FileModule.File(obj['label']).read().then(label => {
                            this._addTempVoltFan(callback, obj, name, label, extra, value);
                        }).catch(err => {
                            let tmpFile = obj['label'].substr(0, obj['label'].lastIndexOf('/')) + '/name';
                            new FileModule.File(tmpFile).read().then(label => {
                                this._addTempVoltFan(callback, obj, name, label, extra, value);
                            }).catch(err => { });
                        });
                    }
                }).catch(err => { });
            }
        }).catch(err => { });
    }

    _addTempVoltFan(callback, obj, name, label, extra, value) {
        // prepend module that provided sensor data
        if (name != label) label = name + ' ' + label;

        label = label + extra;

        // in the future we will read /etc/sensors3.conf
        if (label == 'acpitz temp1') label = 'ACPI Thermal Zone';
        if (label == 'pch_cannonlake temp1') label = 'Platform Controller Hub';
        if (label == 'iwlwifi_1 temp1') label = 'Wireless Adapter';
        if (label == 'Package id 0') label = 'Processor 0';
        if (label == 'Package id 1') label = 'Processor 1';
        label = label.replace('Package id', 'CPU');

        let types = [ 'temperature', 'voltage', 'fan' ];
        for (let type of types) {
            // check if this label already exists
            if (label in this._tempVoltFanSensors[type]) {
                for (let i = 2; i <= 9; i++) {
                    // append an incremented number to end
                    let new_label = label + ' ' + i;

                    // if new label is available, use it
                    if (!(new_label in this._tempVoltFanSensors[type])) {
                        label = new_label;
                        break;
                    }
                }
            }
        }

        // update screen on initial build to prevent delay on update
        this._returnValue(callback, label, value, obj['type'], obj['format']);

        this._tempVoltFanSensors[obj['type']][label] = {
          'format': obj['format'],
            'path': obj['input']
        };
    }

    // rediscover=false keeps network/TVF/GPU discovery across cosmetic menu redraws
    resetHistory(rediscover = true) {
        this._static_info_refresh = false;
        if (rediscover) {
            this._hardware_detected = false;
            this._networkIfaces = [];
            this._hasWireless = false;
        } else {
            this._static_info_refresh = true;
        }
        this._battery_time_left_history = [];
        this._battery_charge_status = '';
        this._gpuLabels = new Map();
    }

    destroy() {
        this._destroyed = true;
    }
});
