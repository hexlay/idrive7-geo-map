#!/bin/sh
# ============================================================================
# nav-recon.sh - what the head unit offers a navigation app (read-only).
#
# Run on the MGU as root (SSH), from anywhere:
#
#   sh nav-recon.sh                  report to ./nav-recon-<time>/ and a .tar.gz of it
#   OUT=/var/tmp/recon sh nav-recon.sh
#   BUTTONS=30 sh nav-recon.sh       also record 30 s of console button codes (needs the
#                                    controller gate's opt-in, see the end of the report)
#
# Collects, without changing anything on the unit:
#   1. SOME/IP: every interface in /etc/oap/someip/someip-interfaces.json about positioning,
#      GNSS / GPS, navigation guidance, the head-up display, the instrument cluster (KombiIF,
#      KombiInterface) and speed limit info, with their fields, getters / notifiers, methods,
#      events and instances; and the matching vsomeip service ids in /etc/vsomeip/*.json.
#      osm_nav reads its position from such a field once it is named in its app.json
#      "config.positioning" (apps/osm_nav/app.json says how).
#      The controller's (FrontCCU) fields too: where the console buttons (NAV) come from.
#   2. Wayland (Winston, wayland-0): ivi-probe list - screens, layer order, layers and surfaces
#      with their visibility, size and owning process (HmiMain3D, the stock navigation's map
#      renderer, the KOMBI video stream) - and which process is which.
#   3. The HMI binary: its eGfxId* / surface strings for Nav, Map, EmbeddedSurface, WelcomeApp.
#   4. The stock map: the /mnt/map mount, ROOT.NDS / PRODUCT metadata (names, sizes, versions).
#   5. Processes and services that look like navigation (names only, nothing is stopped).
#
# Writes only into its own output folder. Never stops, kills or deletes anything: the stock
# navigation daemon has to stay up (KAFAS, the driving assistants and the gearbox read its
# electronic horizon and country state).
# ============================================================================
set -u
NOW=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo now)
OUT=${OUT:-$(pwd)/nav-recon-$NOW}
CATALOG=${CATALOG:-/etc/oap/someip/someip-interfaces.json}
PATTERN=${PATTERN:-'[Pp]osition|[Gg][Nn][Ss][Ss]|[Gg][Pp][Ss]|[Nn]avi|[Gg]uidance|[Mm]aneuver|[Mm]anoeuvre|[Rr]oute|[Hh][Uu][Dd]|[Hh]ead[Uu]p|[Kk]ombi|[Ss]peed[Ll]imit|[Ss][Ll][Ii]|[Ee]horizon|[Ee]lectronicHorizon|[Hh]eading|[Gg]eo|[Ll]atitude|[Ll]ongitude|[Cc]ompass|[Tt]imeZone|FrontCCU|[Cc]ontrol[Ee]lement|[Hh]ard[Kk]ey|[Bb]utton'}
BUTTONS=${BUTTONS:-0}

mkdir -p "$OUT" || { echo "nav-recon: cannot write $OUT" >&2; exit 1; }
say() { echo "[nav-recon] $*"; echo "$*" >> "$OUT/summary.txt"; }
run() {   # run <file> <command...>: its output (and errors) into the report, never fatal
    f=$1; shift
    { echo "\$ $*"; "$@"; echo "(exit $?)"; } > "$OUT/$f" 2>&1
}
NODE=$(command -v node 2>/dev/null || ls /usr/bin/node* 2>/dev/null | head -n 1)

say "nav-recon $NOW on $(hostname 2>/dev/null) ($(uname -r 2>/dev/null))"
run uname.txt uname -a
[ -r /etc/os-release ] && cp /etc/os-release "$OUT/os-release.txt"
for f in /etc/version /etc/sw_version /etc/build /etc/issue; do [ -r "$f" ] && cp "$f" "$OUT/$(basename "$f").txt"; done

# ---- 1. SOME/IP catalog ----------------------------------------------------------------------
if [ -r "$CATALOG" ]; then
    cp "$CATALOG" "$OUT/someip-interfaces.json" 2>/dev/null
    if [ -n "$NODE" ]; then
        "$NODE" -e '
            const fs = require("fs");
            const [cat, out, pat] = process.argv.slice(1);
            const re = new RegExp(pat);
            const db = JSON.parse(fs.readFileSync(cat, "utf8"));
            const ifs = db.interfaces || {}, inst = db.instanceIDs || {};
            const hit = (n, d) => re.test(n) || Object.keys(d.fields || {}).some((f) => re.test(f)) || Object.keys(d.events || {}).some((f) => re.test(f));
            const merged = (n, key, seen) => { const d = ifs[n] || {}; const b = d.extends; const o = b && !(seen || []).includes(b) ? Object.assign({}, merged(b, key, (seen || []).concat(n))) : {}; return Object.assign(o, d[key] || {}); };
            const rep = [], brief = [];
            Object.keys(ifs).sort().forEach((n) => {
                const d = ifs[n];
                if (!hit(n, d)) return;
                const fields = merged(n, "fields"), methods = merged(n, "methods"), events = merged(n, "events");
                rep.push({ interface: n, extends: d.extends || null, instances: inst[n] || null, serviceId: d.serviceId || d.id || null,
                    fields: Object.keys(fields).map((f) => ({ name: f, getter: !!(fields[f].getter && (fields[f].getter.id || fields[f].getter === true)), notifier: !!fields[f].notifier, setter: !!fields[f].setter, type: fields[f].type || fields[f].dataType || undefined })),
                    methods: Object.keys(methods), events: Object.keys(events) });
                brief.push(n + "  instances " + JSON.stringify(inst[n] ? Object.keys(inst[n]) : []) + "\n" +
                    Object.keys(fields).filter((f) => re.test(f) || re.test(n)).map((f) => "    field " + f + (fields[f].getter ? " r" : "") + (fields[f].notifier ? " s" : "") + (fields[f].setter ? " w" : "")).join("\n") +
                    (Object.keys(events).length ? "\n    events " + Object.keys(events).join(", ") : ""));
            });
            fs.writeFileSync(out + "/someip-navigation.json", JSON.stringify(rep, null, 1));
            fs.writeFileSync(out + "/someip-navigation.txt", brief.join("\n\n") + "\n");
            // the struct definitions of position-like fields: the paths config.positioning needs
            const types = db.types || db.dataTypes || db.structs || null;
            if (types) {
                const want = new Set();
                rep.forEach((r) => r.fields.forEach((f) => { if (f.type && /[Pp]osition|[Gg]nss|[Gg]ps|[Cc]oordinate/.test(f.name + f.type)) want.add(String(f.type)); }));
                const pick = {};
                want.forEach((t) => { if (types[t]) pick[t] = types[t]; });
                fs.writeFileSync(out + "/someip-position-types.json", JSON.stringify(pick, null, 1));
            }
            console.log(rep.length + " interfaces match");
        ' "$CATALOG" "$OUT" "$PATTERN" > "$OUT/someip-scan.log" 2>&1
        say "SOME/IP: $(tail -n 1 "$OUT/someip-scan.log") (someip-navigation.txt)"
    else
        grep -o '"de\.bmw[^"]*"' "$CATALOG" | sort -u | grep -E "$PATTERN" > "$OUT/someip-navigation.txt" 2>/dev/null
        say "SOME/IP: no node on this unit: interface names only (someip-navigation.txt)"
    fi
else
    say "SOME/IP: no catalog at $CATALOG"
fi
if ls /etc/vsomeip/*.json >/dev/null 2>&1; then
    mkdir -p "$OUT/vsomeip"
    for f in /etc/vsomeip/*.json; do
        if grep -Eqi "$PATTERN" "$f" 2>/dev/null; then cp "$f" "$OUT/vsomeip/"; fi
    done
    grep -Eoh '"(service|instance|name)"[^,}]*' /etc/vsomeip/*.json 2>/dev/null | sort | uniq -c | sort -rn | head -n 400 > "$OUT/vsomeip/ids.txt"
    say "vsomeip: $(ls "$OUT/vsomeip" | grep -c json) config(s) mention navigation, positioning, HUD or KOMBI"
fi
ls -l /etc/oap/someip/ > "$OUT/oap-someip-dir.txt" 2>&1

# ---- 2. Wayland surfaces -----------------------------------------------------------------------
PROBE=$(command -v ivi-probe 2>/dev/null)
for p in /var/opt/mgu-renderd/ivi-probe /var/opt/mgu-renderd/bin/ivi-probe "$(dirname "$0")/ivi-probe" ./ivi-probe; do
    [ -z "$PROBE" ] && [ -x "$p" ] && PROBE=$p
done
if [ -n "$PROBE" ]; then
    XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/wayland} WAYLAND_DISPLAY=wayland-0 run ivi-list.txt "$PROBE" list
    say "Wayland: $(grep -c 'surface' "$OUT/ivi-list.txt" 2>/dev/null) surface lines (ivi-list.txt, via $PROBE)"
else
    say "Wayland: no ivi-probe (build it: make -C kit/renderd build/ivi-probe, copy it next to this script)"
fi
ls -l /run/wayland/ > "$OUT/wayland-sockets.txt" 2>&1
# which process owns which wayland client: pids of the HMI and anything map / nav / kombi
{
    for d in /proc/[0-9]*; do
        pid=${d#/proc/}
        cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null | cut -c 1-200)
        [ -z "$cmd" ] && continue
        case "$cmd" in
            *HmiMain*|*[Nn]avi*|*[Mm]ap*|*[Kk]ombi*|*[Kk][Oo][Mm][Bb][Ii]*|*[Hh][Uu][Dd]*|*[Pp]osition*|*[Gg][Nn][Ss][Ss]*|*winston*|*weston*|*[Dd]isplay*|*mgu-render*)
                rss=$(awk '/VmRSS/ {print $2 $3}' "$d/status" 2>/dev/null)
                echo "$pid  $rss  $cmd"
                ;;
        esac
    done
} > "$OUT/processes.txt" 2>&1
say "processes: $(wc -l < "$OUT/processes.txt") look like HMI / navigation / map / KOMBI / display (processes.txt)"
command -v systemctl >/dev/null 2>&1 && systemctl list-units --all --no-pager 2>/dev/null | grep -Ei 'nav|map|kombi|hud|posit|gnss|gps|hmi|render' > "$OUT/services.txt"

# ---- 3. the HMI binary's surface ids -----------------------------------------------------------
HMI=$(command -v HmiMain3D 2>/dev/null)
[ -z "$HMI" ] && for p in /usr/bin/HmiMain3D /opt/hmi/bin/HmiMain3D; do [ -x "$p" ] && HMI=$p && break; done
if [ -n "$HMI" ]; then
    if command -v strings >/dev/null 2>&1; then
        strings -n 6 "$HMI" 2>/dev/null | grep -E 'eGfxId' | grep -Ei 'nav|map|embedded|welcome|surface' | sort -u > "$OUT/hmi-gfxids.txt"
        strings -n 6 "$HMI" 2>/dev/null | grep -Ei 'EmbeddedSurface|MapSurface|NaviMap|MapView|MapWidget' | sort -u | head -n 500 > "$OUT/hmi-map-strings.txt"
    else
        # no binutils: grep's own string scan
        grep -aoE 'eGfxId[A-Za-z0-9_]{2,80}' "$HMI" 2>/dev/null | grep -Ei 'nav|map|embedded|welcome|surface' | sort -u > "$OUT/hmi-gfxids.txt"
    fi
    say "HMI: $(wc -l < "$OUT/hmi-gfxids.txt") eGfxId strings for Nav / Map / EmbeddedSurface / WelcomeApp ($HMI)"
else
    say "HMI: HmiMain3D not found"
fi

# ---- 4. the stock map ----------------------------------------------------------------------------
{ mount | grep -Ei 'map|nds|navi'; echo; df -h 2>/dev/null | grep -Ei 'map|nds|navi|Filesystem'; } > "$OUT/map-mounts.txt" 2>&1
for m in /mnt/map /mnt/navdata /mnt/data/map; do
    [ -d "$m" ] || continue
    {
        echo "== $m"
        ls -la "$m" 2>/dev/null | head -n 100
        find "$m" -maxdepth 3 \( -iname 'ROOT.NDS' -o -iname 'PRODUCT.NDS' -o -iname '*.NDS' -o -iname '*.xml' -o -iname '*version*' \) 2>/dev/null | head -n 200 | while read -r f; do
            echo "-- $f  $(ls -la "$f" 2>/dev/null | awk '{print $5}') bytes"
        done
    } >> "$OUT/map-files.txt" 2>&1
    root=$(find "$m" -maxdepth 3 -iname 'ROOT.NDS' 2>/dev/null | head -n 1)
    if [ -n "$root" ]; then
        # ROOT.NDS is SQLite: its tables, and the readable text of its metadata (versions, regions)
        if command -v sqlite3 >/dev/null 2>&1; then
            sqlite3 -readonly "$root" '.tables' > "$OUT/root-nds-tables.txt" 2>&1
            sqlite3 -readonly "$root" "SELECT name, sql FROM sqlite_master" > "$OUT/root-nds-schema.txt" 2>&1
        fi
        head -c 100 "$root" | od -c | head -n 3 > "$OUT/root-nds-head.txt" 2>&1
        grep -aoE '[A-Za-z0-9_ .:/-]{6,80}' "$root" 2>/dev/null | grep -Ei 'version|region|product|supplier|here|nds|date|country|geo' | sort -u | head -n 300 > "$OUT/root-nds-strings.txt"
        say "stock map: $root ($(ls -la "$root" | awk '{print $5}') bytes)"
    fi
done
[ -s "$OUT/map-files.txt" ] || say "stock map: no /mnt/map"

# ---- 5. console buttons (optional) ----------------------------------------------------------------
LOG=/run/mgu-renderd/buttons.log
if [ "$BUTTONS" -gt 0 ] 2>/dev/null; then
    if [ -e /var/opt/mgu-inputgate/buttons ]; then
        say "buttons: press NAV (and other console buttons) now - recording ${BUTTONS} s"
        start=$( [ -f "$LOG" ] && wc -l < "$LOG" || echo 0 )
        sleep "$BUTTONS"
        [ -f "$LOG" ] && tail -n +"$((start + 1))" "$LOG" > "$OUT/buttons.txt"
        say "buttons: $(wc -l < "$OUT/buttons.txt" 2>/dev/null || echo 0) events recorded (buttons.txt)"
    else
        say "buttons: the controller gate's button log is off. To record (read-only, the HMI still gets every button):"
        say "         mkdir -p /var/opt/mgu-inputgate && touch /var/opt/mgu-inputgate/buttons   (needs mgu-inputgate.so with the NAV hook)"
    fi
fi
[ -f "$LOG" ] && tail -n 200 "$LOG" > "$OUT/buttons-recent.txt" 2>/dev/null

# ---- pack it up ------------------------------------------------------------------------------------
say "report: $OUT"
if command -v tar >/dev/null 2>&1; then
    tar czf "$OUT.tar.gz" -C "$(dirname "$OUT")" "$(basename "$OUT")" 2>/dev/null && say "archive: $OUT.tar.gz (copy it to the PC: scp root@<unit>:$OUT.tar.gz .)"
fi
cat <<'EOF'

Next steps
  * someip-navigation.txt: a field with a notifier ("s") that carries the car's position (latitude /
    longitude, maybe heading and speed) is what osm_nav needs. Put it in apps/osm_nav/app.json:
      "signals": { "<interface>": { "<field>": "rs", "_optional": "the car's GNSS position" } }
      "config": { "positioning": [ { "iface": "<interface>", "instance": "1", "field": "<field>",
                  "lat": "<path.in.value>", "lon": "<path>", "heading": "<path>", "speed": "<path>",
                  "scale": { "lat": 1e-7, "lon": 1e-7 } } ] }
    (someip-position-types.json has the struct of that field; the scale makes degrees of it.)
  * ivi-list.txt: the surface of the stock map (its owning pid in processes.txt) is the one to hide
    or cover in phase 2 - never stop that process.
  * The console's NAV button: Navigation opens itself over the stock screen when NAV is pressed (the HMI still
    gets the button: nothing is blocked, and with the app not running NAV is stock). Its Route page learns the
    button (press NAV three times) from either source:
      - the controller gate's read-only feed (mgu-inputgate.so built from kit/renderd/inputgate, and
        /var/opt/mgu-inputgate/buttons): buttons.txt has what it sends;
      - a SOME/IP field of FrontCCU (someip-navigation.txt): put it in app.json "config.navButton"
        { "iface": "...FrontCCU", "field": "<field>" } and in "signals" with "_optional".
    Put Navigation's widget on the home screen: MainApp then starts the app with the car, so NAV works from the start.
EOF
