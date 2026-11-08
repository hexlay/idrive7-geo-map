# BMW iDrive 7 (MGU) — Offline Navigation (`osm_nav`)

> [!CAUTION]
> **EXTREMELY EXPERIMENTAL. It has not been run in a car yet.** Everything below was built and tested on a PC only
> (unit tests, the PC preview and the emulator). It may not install, may not find the car's position, and may
> show wrong directions. **Never rely on it to drive, and keep your eyes on the road.** Install it only if you
> can get a head unit back to stock yourself (SSH access, the MGU Store's uninstall). You use it at your own risk.

<p align="center">
  <b>Offline OpenStreetMap navigation for BMW iDrive 7 (MGU High / Intel Atom A3960), in place of the BMW map, which has no usable map of Georgia. Drawn on the head unit's GPU and installed through the MGU Store.</b>
</p>

<p align="center">
  <img alt="Extremely experimental" src="https://img.shields.io/badge/status-extremely%20experimental-d73a49?style=for-the-badge">
  <img alt="Not tested in a car" src="https://img.shields.io/badge/car%20tested-no-d73a49?style=for-the-badge">
  <img alt="OpenGL ES 2" src="https://img.shields.io/badge/render-OpenGL%20ES%202-1c6dd0?style=for-the-badge">
  <img alt="BMW iDrive 7" src="https://img.shields.io/badge/BMW-iDrive%207%20MGU-e4002b?style=for-the-badge">
</p>

---

## Credits & Acknowledgements

This repository is built on the open-source BMW iDrive 7 platform:

* [**cauliflowermossgrape/idrive7-apps**](https://github.com/cauliflowermossgrape/idrive7-apps) — the app runtime, the native OpenGL ES renderer and SOME/IP vehicle signals.
* [**mgu-store**](https://github.com/robertnisipeanu/mgu-store) — the in-car app store, package manager and internet uplink by Robert Nisipeanu.
* Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), extracts by [Geofabrik](https://download.geofabrik.de/).

> [!NOTE]
> For SDK extraction, toolchain documentation, SOME/IP signal catalogs and renderer internals, see [**cauliflowermossgrape/idrive7-apps**](https://github.com/cauliflowermossgrape/idrive7-apps).

---

## Status

| Part | State |
| :--- | :--- |
| Map, routing, guidance, search, fuel logic | Works on the PC (tests, preview). **Not run on a head unit.** |
| The car's GPS position | **Blocked**: the head unit's position signal is not known yet (`deploy/car/nav-recon.sh` looks for it). Until then the app only estimates the position from the car's speed and turning, starting from the last known or a hand-set point, so it drifts. |
| Console NAV button opens Navigation | **Blocked**: needs a controller gate (`mgu-inputgate.so`) built with the NAV hook in `kit/renderd/inputgate`. The prebuilt gate in `kit/renderd/prebuilt` and the one the MGU Store installs do **not** have it, and it has not been compiled yet (needs Docker or Linux). |
| Fuel level and range | Reads the cluster's values (`KombiIF`, same fields the `m_copilot` app reads), not yet checked in this app on a car. Assumes the range is in km. |
| Frame rate | Designed for 60 fps. On the PC a street-level frame takes about 2 ms; the head unit's speed is not measured yet. |
| Memory | Target under 150 MB. The app logs its use every 10 minutes and cuts its caches back above 140 MB; not measured on a car yet. |
| Map in the instrument cluster, arrows in the head-up display | Not built. The recon tools to find out where CarPlay puts them are ready (see Development). |
| Spoken turn prompts | Not built. |
| Speed limits | Shown only where OpenStreetMap has them: about 10% of Georgia's road length today. Nothing is ever sent to the car's camera, cruise control or Speed Limit Assist. |

---

## Navigation (`osm_nav`)

| Version | Needs internet | Touches vehicle ECUs |
| :---: | :---: | :--- |
| 1.0.0 | No | No (reads speed, acceleration, gear, fuel level and range; writes nothing) |

* **The map**: all of Georgia from OpenStreetMap, on the car (no internet), drawn by the GPU, heading up or north up, day and night colours, street names in Georgian, English or both, road numbers (ს1 / S1, E60).
* **Guidance**: routes are planned on the car (fastest, avoid tolls, avoid motorways), with the next turn, its distance and street, roundabout exits, the arrival time, a new route when you leave it, and the speed limit of the road where OpenStreetMap has it (BMW style sign, red when you are over it).
* **Fuel**: the tank level and range from the cluster (read only, `KombiIF`). The trip bar shows the range, or with a route the range on arrival (amber under 50 km). When it is short, *Add fuel stop* routes you through the furthest station on the way that you still reach with 30 km to spare; filling up (seen while the car stands, or at the next start) removes the stop. Under 60 km with no route, a *Fuel* button takes you to the nearest station ahead. Cars without these signals install and run without it.
* **Search** in Georgian and Latin letters, by category (fuel, charging, parking, hospitals ...), Home, Work, favourites, recent places and coordinates. The keyboard locks while the car drives.
* **The NAV button** (blocked, see Status): Navigation is meant to open itself when you press the console's NAV button. Nothing in the HMI is blocked or changed: the HMI still gets NAV and opens its own screen, and Navigation is then opened over it. If Navigation is not running, NAV works exactly as stock. Learn the button on the **Route** page (press NAV three times); *Forget* undoes it. It needs the button events from a controller gate with the NAV hook (read only) or a SOME/IP button field found with `deploy/car/nav-recon.sh`.
* **Start with the car**: place Navigation's widget on the home screen. MainApp then starts the app with the head unit (the supported way: no start setting is changed), and the widget shows the map and the next turn.
* **Position**: the car's speed, acceleration and gear, matched to the roads; the car's own GPS once its signal is known (a position that is on no installed map is never used). On the car the demo drive never starts by itself: with no signal the app says "no position". The demo drive through Tbilisi runs in the PC preview and the emulator, or when chosen in Settings.
* **Never touches the stock navigation**: its process keeps running (KAFAS and the assistants need it) and its screen is not hidden or changed.
* **Other countries**: `python3 kit/tools/pack_osm.py --fetch <region> -o <region>.pack` compiles any Geofabrik extract; `--builtin-georgia` makes a small demo map without a download.

---

## How to Install via MGU Store

> [!WARNING]
> Extremely experimental: see the caution at the top. Not tested on a head unit.

1. On the central display, open **MGU Store > Sources > Add source**.
2. Enter this repository:
   ```text
   hexlay/idrive7-geo-map
   ```
3. Tap **OK**. The MGU Store reads `mgu-repo.json` and lists Navigation. It needs the GPU renderer (`idrive7-renderd`) and the controller gate (`mgu-inputgate`), which this repo doesn't ship: add [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) as a source too and install them from there (most cars have them already). That gate has no NAV hook, so the NAV button does not open Navigation yet.
4. Tap Navigation to install it. Updates appear in the store when a new version is pushed.

### Older firmware (e.g. MainApp 6.5.5)

The head unit's installer refuses an app outright if its SOME/IP manifest names an interface, field or method the firmware's catalog (`/etc/oap/someip/someip-interfaces.json`) doesn't have. The MGU Store builds the app on the head unit, and the build fits its vehicle signals to that unit's catalog: what the unit lacks is left out, so the app installs and runs without those values. The app's log lists them at start (`this unit has no ... - running without it`).

---

## What is needed from a car

| Need | For | How |
| :--- | :--- | :--- |
| The position signal (interface, field, its structure) | Real positioning (blocker) | `nav-recon.sh`: `someip-navigation.txt`, `someip-position-types.json` |
| Speed, acceleration and gear arriving | Following the car between fixes and in tunnels | The app's log: each signal `subscribed` |
| Fuel values and the range's unit | Fuel features | The Route page's Fuel line, the log |
| What the NAV button sends | The NAV button | A FrontCCU field from recon, or the gate's button log |
| Build facts (C / C++ library, CommonAPI, hook point) | Building a gate with the NAV hook that loads safely | `nav-recon.sh`: `build-facts.txt` |
| CPU and memory while driving, frame rate | The 150 MB / 60 fps targets | `cpu.txt`, the app's `memory:` log lines, the renderer's log |
| Two recon runs, CarPlay off and CarPlay guiding in the cluster | Cluster map and HUD arrows | See Development |
| Audio devices and services | Spoken prompts later | `nav-recon.sh`: `audio.txt` |

---

## Development

* Build: `python3 kit/tools/build.py osm_nav` writes `dist/osm_nav@<version>.mgu` and `.tgz` (needs your own `oap-sdk/`, see the credits).
* Emulator: `node kit/tools/emu.js osm_nav` runs the app in the browser emulator; `node kit/tools/preview.js dist/osm_nav <outDir>` renders it to PNGs.
* Tests: `node kit/tools/test_osm_nav.js [map.pack]` (NAV button learning, GPS decoding, routing, guidance, search, fuel stops and refuelling) and `node kit/tools/test_nav_recon_diff.js`.
* Map pack: `python3 kit/tools/pack_osm.py --fetch georgia -o apps/osm_nav/georgia.pack`.
* On the head unit (read only): `deploy/car/nav-recon.sh` finds the GPS and button signals and writes `cpu.txt` (what each process costs), `build-facts.txt` and `audio.txt`.
* Where CarPlay puts its cluster map and HUD arrows: run `LABEL=base SNIFF=60 sh nav-recon.sh` (CarPlay off) and `LABEL=carplay SNIFF=60 sh nav-recon.sh` (CarPlay guiding, its map in the cluster, the HUD on), then `node kit/tools/nav-recon-diff.js <base report> <carplay report>`. It lists the surfaces, processes and SOME/IP services that appear with CarPlay's guidance. Only display is in scope: nothing is sent to KAFAS, cruise control or Speed Limit Assist.
* Preview with a nearly empty demo tank: `OSM_NAV_DEMO_FUEL=6 node kit/tools/preview.js dist/osm_nav <outDir>`.
* Line endings: `.gitattributes` keeps everything that runs on the head unit in Unix line endings, also in a Windows checkout.

---

## License

This project is released under the GNU General Public License v3.0 or later. Map data is © OpenStreetMap contributors under the Open Database License.
Not affiliated with or endorsed by Bayerische Motoren Werke (BMW) AG.
