Vitals for CONSTRUCT
====================

Vitals is a GNOME Shell extension that shows temperature, voltage, fan
speed, memory, processor load, system resources, network speed and storage
in the top bar, read with asynchronous polling. This repository is
CONSTRUCT's fork of [corecoding/Vitals](https://github.com/corecoding/Vitals)
(upstream `v84.0.0`), on the `gnome-51` branch. It targets GNOME Shell 51
only; nothing older runs it.

## Patches carried over upstream

- **Prune network interfaces that no longer exist** (upstream #557, #360).
  Backport of upstream develop's two commits: an interface that goes away
  (a docker veth or bridge, a VPN tun) gets a `destroy` value, so its menu
  rows, panel item and last speed are dropped instead of staying frozen in
  the Device rx/tx total. Interfaces are rediscovered on menu redraw and on
  Refresh.
- **Rediscover interfaces when one disappears.** A failed statistics read of
  a listed interface triggers rediscovery at once, instead of waiting for a
  redraw.
- **Count only physical network interfaces** (upstream #319, #377). Device
  rx/tx, Boot and Session sum only interfaces with a device link, so
  traffic through bridges, veths and VPN devices is not counted two or
  three times.
- **Drop sensor values that arrive after destroy** (upstream #542). Reads in
  flight when the extension is disabled (every screen lock) no longer write
  into disposed labels.
- **GNOME Shell 51 only**, and the extensions.gnome.org release tooling,
  issue templates and screencast removed.

## Installation

The extension has no build system: its source tree is the extension.
CONSTRUCT's `gnome-shell-extension-vitals` melange recipe (spin-desktop,
`recipes/gnome-shell-extension-vitals.yaml`) checks out this branch and
copies `extension.js`, `helpers/`, `icons/`, `menuItem.js`,
`metadata.json`, `prefs.js`, `prefs.ui`, `sensors.js`, `stylesheet.css`
and `values.js` to
`/usr/share/gnome-shell/extensions/Vitals@CoreCoding.com/`, the compiled
`locale/*/LC_MESSAGES/vitals.mo` catalogs next to them, and the schema to
`/usr/share/glib-2.0/schemas/`. Storage usage needs libgtop's `GTop`
typelib; without it that sensor is left out.

Translations are edited in `locale/*/LC_MESSAGES/vitals.po` (template
`locale/vitals.pot`) and compiled with `msgfmt vitals.po -o vitals.mo`.

## Credits

Vitals is written by Chris Monahan (Core Coding) and its contributors, and
was originally forked from
[gnome-shell-extension-freon](https://github.com/UshakovVasilii/gnome-shell-extension-freon).

Icons, original theme: voltage and fan from Freon; system and storage from
the Pop!_OS theme; temperature by [iconnice studio](https://www.iconfinder.com/iconnice);
cpu and memory by [DinosoftLabs](https://www.iconfinder.com/dinosoftlabs);
network by [Yannick Lung](https://www.iconfinder.com/yanlu); health icon by
[Dod Cosmin](https://www.iconfinder.com/icons/458267/cross_doctor_drug_health_healthcare_hospital_icon).
GNOME theme: battery and storage from the
[Adwaita Icon Theme](https://gitlab.gnome.org/GNOME/adwaita-icon-theme);
memory, network, system and voltage from the
[Icon Development Kit](https://gitlab.gnome.org/Teams/Design/icon-development-kit);
fan from Freon, modified; temperature and cpu by
[daudix](https://github.com/daudix).

Sensor data comes from hwmon and GTop; the Vitals authors are not
responsible for improperly represented data. No warranty expressed or
implied.

## License

GPL-2.0-or-later; see `LICENSE`.
