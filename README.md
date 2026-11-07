# BMW iDrive 7 (MGU) — Offline Navigation (`osm_nav`)

<p align="center">
  <b>Offline OpenStreetMap navigation for BMW iDrive 7 (MGU High / Intel Atom A3960), in place of the BMW map, which has no usable map of Georgia. Rendered at 60 fps on the head unit's GPU and installed through the MGU Store.</b>
</p>

<p align="center">
  <img alt="60 fps" src="https://img.shields.io/badge/frame%20rate-60%20fps-2ea44f?style=for-the-badge">
  <img alt="OpenGL ES 2" src="https://img.shields.io/badge/render-OpenGL%20ES%202-1c6dd0?style=for-the-badge">
  <img alt="BMW iDrive 7" src="https://img.shields.io/badge/BMW-iDrive%207%20MGU-e4002b?style=for-the-badge">
  <img alt="MGU Store Ready" src="https://img.shields.io/badge/MGU%20Store-Compatible-8957e5?style=for-the-badge">
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

## Navigation (`osm_nav`)

| Version | Needs internet | Touches vehicle ECUs |
| :---: | :---: | :--- |
| 1.0.0 | No | No (reads speed, acceleration and gear) |

* **The map**: all of Georgia from OpenStreetMap, on the car (no internet), drawn by the GPU at 60 fps, heading up or north up, day and night colours, street names in Georgian, English or both, road numbers (ს1 / S1, E60).
* **Guidance**: routes are planned on the car (fastest, avoid tolls, avoid motorways), with the next turn, its distance and street, roundabout exits, the arrival time, a new route when you leave it, and the speed limit of the road when OpenStreetMap has it (BMW style sign, red when you are over it).
* **Fuel**: the tank level and range from the cluster (read only, `KombiIF`). The trip bar shows the range, or with a route the range on arrival (amber under 50 km). When it is short, *Add fuel stop* routes you through the furthest station on the way that you still reach with 30 km to spare; filling up removes the stop. Under 60 km with no route, a *Fuel* button takes you to the nearest station ahead. Cars without these signals install and run without it.
* **Search** in Georgian and Latin letters, by category (fuel, charging, parking, hospitals ...), Home, Work, favourites, recent places and coordinates. The keyboard locks while the car drives.
* **The NAV button**: Navigation can open itself when you press the console's NAV button. Nothing in the HMI is blocked or changed: the HMI still gets NAV and opens its own screen, and Navigation is then opened over it. If Navigation is not running, NAV works exactly as stock. Learn the button on the **Route** page (press NAV three times); *Forget* undoes it. It needs the button events from the controller gate (`mgu-inputgate.so` built from `kit/renderd/inputgate`, read only) or a SOME/IP button field found with `deploy/car/nav-recon.sh`.
* **Start with the car**: place Navigation's widget on the home screen. MainApp then starts the app with the head unit (the supported way: no start setting is changed), so NAV works from the first press, and the widget shows the map and the next turn.
* **Position**: the car's speed, acceleration and gear, matched to the roads. The car's own GPS is used once its interface is known (`deploy/car/nav-recon.sh` finds it; a build on the head unit tries to find it itself, and a position that is on no installed map is never used). Without a car (emulator, preview) a demo drive through Tbilisi.
* **Never touches the stock navigation**: its process keeps running (KAFAS and the assistants need it) and its screen is not hidden or changed.
* **Other countries**: `python3 kit/tools/pack_osm.py --fetch <region> -o <region>.pack` compiles any Geofabrik extract; `--builtin-georgia` makes a small demo map without a download.

---

## How to Install via MGU Store

1. On the central display, open **MGU Store > Sources > Add source**.
2. Enter this repository:
   ```text
   hexlay/idrive7-geo-map
   ```
3. Tap **OK**. The MGU Store reads `mgu-repo.json` and lists Navigation. It needs the GPU renderer (`idrive7-renderd`) and the controller gate (`mgu-inputgate`), which this repo doesn't ship: add [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) as a source too and install them from there (most cars have them already).
4. Tap Navigation to install it. Updates appear in the store when a new version is pushed.

### Older firmware (e.g. MainApp 6.5.5)

The head unit's installer refuses an app outright if its SOME/IP manifest names an interface, field or method the firmware's catalog (`/etc/oap/someip/someip-interfaces.json`) doesn't have. The MGU Store builds the app on the head unit, and the build fits its vehicle signals to that unit's catalog: what the unit lacks is left out, so the app installs and runs without those values. The app's log lists them at start (`this unit has no ... - running without it`).

---

## Development

* Build: `python3 kit/tools/build.py osm_nav` writes `dist/osm_nav@<version>.tgz`.
* Emulator: `node kit/tools/emu.js osm_nav` runs the app in the browser emulator; `node kit/tools/preview.js dist/osm_nav <outDir>` renders it to PNGs.
* Tests: `node kit/tools/test_osm_nav.js [map.pack]` (NAV button learning, GPS decoding, routing, guidance, search and fuel stops) and `node kit/tools/test_nav_recon_diff.js`.
* Map pack: `python3 kit/tools/pack_osm.py --fetch georgia -o apps/osm_nav/georgia.pack`.
* Finding the car's GPS and button signals: `deploy/car/nav-recon.sh` on the head unit (read only). `cpu.txt` in its report shows what each process costs.
* Where CarPlay puts its cluster map and HUD arrows: run `LABEL=base SNIFF=60 sh nav-recon.sh` (CarPlay off) and `LABEL=carplay SNIFF=60 sh nav-recon.sh` (CarPlay guiding, its map in the cluster, the HUD on), then `node kit/tools/nav-recon-diff.js <base report> <carplay report>`. It lists the surfaces, processes and SOME/IP services that appear with CarPlay's guidance. Only display is in scope: nothing is sent to KAFAS, cruise control or Speed Limit Assist.
* Preview with a nearly empty demo tank: `OSM_NAV_DEMO_FUEL=6 node kit/tools/preview.js dist/osm_nav <outDir>`.

---

## License

This project is released under the GNU General Public License v3.0 or later. Map data is © OpenStreetMap contributors under the Open Database License.
Not affiliated with or endorsed by Bayerische Motoren Werke (BMW) AG.
