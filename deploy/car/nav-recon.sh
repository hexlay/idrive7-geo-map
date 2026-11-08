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
#   LABEL=carplay SNIFF=60 sh nav-recon.sh
#                                    name the run (nav-recon-carplay-<time>) and record 60 s of
#                                    the unit's network traffic, first 256 bytes of each packet
#                                    (SOME/IP headers: which service talks to the cluster / HUD)
#   SAMPLE=20 sh nav-recon.sh        measure CPU over 20 s instead of 10
#
# The cluster map: run it twice, the same way, and compare on the PC:
#   1. LABEL=base SNIFF=60 sh nav-recon.sh       the cluster on its normal view, the home screen in the centre
#   2. LABEL=cluster SNIFF=60 sh nav-recon.sh    the cluster on its map view: the BMW map projected there (blank
#                                                where it has no map, as in Georgia: still a picture sent to it)
#   node kit/tools/nav-recon-diff.js nav-recon-base-<time> nav-recon-cluster-<time>
# What changes between them (a surface shown, a process busy, a SOME/IP service sending) is how the head unit's
# picture reaches the cluster: the place a map of osm_nav's would go. Firmware from 2021 on also projects CarPlay
# to the cluster: LABEL=carplay (Waze / Google Maps guiding, its map in the cluster, the HUD on) shows its route
# and the HUD's turn arrows. The HUD's arrows need a route guided: the BMW map cannot in Georgia.
#
# The stock BMW map, so Navigation can open in its place however it is opened (left menu bar NAV, the tile, voice):
#   1. LABEL=base SNIFF=60 sh nav-recon.sh       the home screen, the BMW map closed
#   2. LABEL=stocknav SNIFF=60 sh nav-recon.sh   the BMW map open, opened from the left menu bar
#   node kit/tools/nav-recon-diff.js nav-recon-base-<time> nav-recon-stocknav-<time>
# A surface turning visible at full size is the stock map's (osm_nav learns it on the car anyway: Route page,
# Learn BMW map, with mgu-render's nav_watch); none: the HMI draws the map itself, and the SOME/IP flow that
# changes is the one for app.json config.stockNav (iface, field, match).
#
# Collects, without changing anything on the unit:
#   1. SOME/IP: every interface in /etc/oap/someip/someip-interfaces.json about positioning,
#      GNSS / GPS, navigation guidance, the head-up display, the instrument cluster (KombiIF,
#      KombiInterface) and speed limit info, with their fields, getters / notifiers, methods,
#      events and instances; and the matching vsomeip service ids in /etc/vsomeip/*.json.
#      osm_nav reads its position from such a field once it is named in its app.json
#      "config.positioning" (apps/osm_nav/app.json says how).
#      The controller's (FrontCCU) fields too: where the console buttons (NAV) come from.
#   2. Wayland (Winston, wayland-0): ivi-list (read only, next to this script) - screens, layer ids and surfaces
#      with their visibility, size and owning process (HmiMain3D, the stock navigation's map
#      renderer, the KOMBI video stream) - and which process is which.
#   3. The HMI binary: its eGfxId* / surface strings for Nav, Map, EmbeddedSurface, WelcomeApp.
#   4. The stock map: the /mnt/map mount and its files (names and sizes only: none is opened).
#   3b. Build facts for the controller gate: C / C++ library versions, CommonAPI, the hook point, the
#      gate as loaded now (build-facts.txt). 3c. Audio devices, processes and services (audio.txt).
#   5. Processes and services that look like navigation, CarPlay / projection, the cluster or the
#      HUD (names only, nothing is stopped), and every process's CPU over SAMPLE seconds
#      (cpu.txt: what the stock navigation, the HMI and CarPlay cost).
#   6. Optional (SNIFF=<s>): a capture of the unit's network traffic, 256 bytes a packet, SSH left
#      out (someip.pcap): the SOME/IP services between the head unit, the cluster and the HUD.
#      It stays in the report folder: keep it on your own PC (it can carry the car's position).
#
# Writes only into its own output folder. Never stops, kills or deletes anything of the unit's
# (it ends only the tcpdump it started itself): the stock navigation daemon has to stay up
# (KAFAS, the driving assistants and the gearbox read its electronic horizon and country state).
# ============================================================================
set -u
NOW=$(date +%Y%m%d-%H%M%S 2>/dev/null || echo now)
LABEL=${LABEL:-}
case "$LABEL" in *[!A-Za-z0-9_-]*) echo "nav-recon: LABEL: letters, digits, - and _ only" >&2; exit 1 ;; esac
OUT=${OUT:-$(pwd)/nav-recon-${LABEL:+$LABEL-}$NOW}
CATALOG=${CATALOG:-/etc/oap/someip/someip-interfaces.json}
PATTERN=${PATTERN:-'[Pp]osition|[Gg][Nn][Ss][Ss]|[Gg][Pp][Ss]|[Nn]avi|[Gg]uidance|[Mm]aneuver|[Mm]anoeuvre|[Rr]oute|[Hh][Uu][Dd]|[Hh]ead[Uu]p|[Kk]ombi|[Ss]peed[Ll]imit|[Ss][Ll][Ii]|[Ee]horizon|[Ee]lectronicHorizon|[Hh]eading|[Gg]eo|[Ll]atitude|[Ll]ongitude|[Cc]ompass|[Tt]imeZone|FrontCCU|[Cc]ontrol[Ee]lement|[Hh]ard[Kk]ey|[Bb]utton|[Cc]ar[Pp]lay|[Pp]rojection|[Ss]martphone[Ii]ntegration|[Tt]urn[Bb]y[Tt]urn|[Rr]oute[Gg]uidance|[Ii]nstrument[Cc]luster|[Ee]xternal[Nn]av|[Aa]ndroid[Aa]uto|[Aa]udio[Mm]anag|[Aa]udio[Ss]ource|[Ss]peech|[Pp]rompt|[Aa]nnouncement'}
BUTTONS=${BUTTONS:-0}
SNIFF=${SNIFF:-0}
SAMPLE=${SAMPLE:-10}

# ---- safety first ---------------------------------------------------------------------------------
# Lowest CPU and disk priority for this script and everything it starts: the HMI and the car's services always come
# first. Room: at least 300 MB free where the report goes (the capture is capped far below that), else nothing runs.
renice -n 19 $$ >/dev/null 2>&1
command -v ionice >/dev/null 2>&1 && ionice -c 3 -p $$ >/dev/null 2>&1
PARENT=$(dirname "$OUT")
# the free space where the report would go: the nearest folder that exists (nothing is created before the check)
P=$PARENT; while [ ! -d "$P" ] && [ "$P" != / ]; do P=$(dirname "$P"); done
FREE_MB=$(df -m "$P" 2>/dev/null | awk 'NR == 2 {print $4}')
case "$FREE_MB" in ''|*[!0-9]*) echo "nav-recon: cannot tell the free space at $PARENT: stopping" >&2; exit 1 ;; esac
[ "$FREE_MB" -ge 300 ] || { echo "nav-recon: only $FREE_MB MB free at $PARENT (needs 300): stopping, nothing written" >&2; exit 1; }
# free memory (kB): the catalog's parse is skipped unless the unit has plenty (it never competes with the HMI for it)
MEM_KB=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null)

mkdir -p "$OUT" || { echo "nav-recon: cannot write $OUT" >&2; exit 1; }
say() { echo "[nav-recon] $*"; echo "$*" >> "$OUT/summary.txt"; }
run() {   # run <file> <command...>: its output (and errors) into the report, never fatal
    f=$1; shift
    { echo "\$ $*"; "$@"; echo "(exit $?)"; } > "$OUT/$f" 2>&1
}
# node: the unit's own (MainApp's apps run on it), and only if it says it is node
NODE=""
for n in "$(command -v node 2>/dev/null)" /usr/bin/node; do
    [ -n "$n" ] && [ -x "$n" ] && case "$("$n" --version 2>/dev/null)" in v[0-9]*) NODE=$n; break ;; esac
done
say "free: ${FREE_MB} MB at $PARENT, memory available: $(( ${MEM_KB:-0} / 1024 )) MB; running at the lowest priority"

say "nav-recon $NOW${LABEL:+ ($LABEL)} on $(hostname 2>/dev/null) ($(uname -r 2>/dev/null))"
echo "${LABEL:-unlabelled} $NOW" > "$OUT/label.txt"
run uname.txt uname -a
[ -r /etc/os-release ] && cp /etc/os-release "$OUT/os-release.txt"
for f in /etc/version /etc/sw_version /etc/build /etc/issue; do [ -r "$f" ] && cp "$f" "$OUT/$(basename "$f").txt"; done

# ---- 1. SOME/IP catalog ----------------------------------------------------------------------
CAT_MB=$( [ -r "$CATALOG" ] && du -m "$CATALOG" 2>/dev/null | cut -f1 )
if [ -r "$CATALOG" ]; then
    cp "$CATALOG" "$OUT/someip-interfaces.json" 2>/dev/null
    # the parse holds the catalog in memory (a few times its size): only with a small catalog, plenty of memory free
    # (1 GB), and node's heap capped (256 MB: node stops itself before it could press the unit for memory)
    if [ -n "$NODE" ] && [ "${CAT_MB:-999}" -le 40 ] && [ "${MEM_KB:-0}" -ge 1048576 ]; then
        "$NODE" --max-old-space-size=256 -e '
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
        say "SOME/IP: interface names only (someip-navigation.txt; node ${NODE:-missing}, catalog ${CAT_MB:-?} MB, memory $(( ${MEM_KB:-0} / 1024 )) MB): the full catalog copy is in the report, read on the PC"
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
# ivi-list only, from next to this script (kit/renderd/tools/ivi-list.c): read only by construction, it lists and
# changes nothing. Never ivi-probe or anything else found on the unit: ivi-probe's own list asks the compositor to
# "create" each existing layer (the HMI's too), which an unknown compositor might take as a change.
LISTER="$(cd "$(dirname "$0")" && pwd)/ivi-list"
if [ -x "$LISTER" ]; then
    # exported in a subshell (an assignment in front of a shell function does not reach the programs it starts), and
    # always the compositor's own folder, whatever an SSH session has in XDG_RUNTIME_DIR
    ( XDG_RUNTIME_DIR=/run/wayland; WAYLAND_DISPLAY=wayland-0; export XDG_RUNTIME_DIR WAYLAND_DISPLAY; run ivi-list.txt "$LISTER" )
    say "Wayland: $(grep -c '^  surface' "$OUT/ivi-list.txt" 2>/dev/null) surfaces (ivi-list.txt)"
else
    say "Wayland: no ivi-list next to this script (deploy/car/ivi-list): surfaces not listed"
fi
ls -l /run/wayland/ > "$OUT/wayland-sockets.txt" 2>&1
# which process owns which wayland client: pids of the HMI and anything map / nav / kombi
{
    for d in /proc/[0-9]*; do
        pid=${d#/proc/}
        cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null | cut -c 1-200)
        [ -z "$cmd" ] && continue
        case "$cmd" in
            *HmiMain*|*[Nn]avi*|*[Mm]ap*|*[Kk]ombi*|*[Kk][Oo][Mm][Bb][Ii]*|*[Hh][Uu][Dd]*|*[Pp]osition*|*[Gg][Nn][Ss][Ss]*|*winston*|*weston*|*[Dd]isplay*|*mgu-render*|*[Cc]ar[Pp]lay*|*[Ii][Aa][Pp]2*|*[Pp]rojection*|*[Ss]martphone*|*[Aa]ndroid[Aa]uto*|*[Cc]luster*|*[Vv]ideo*)
                rss=$(awk '/VmRSS/ {print $2 $3}' "$d/status" 2>/dev/null)
                echo "$pid  $rss  $cmd"
                ;;
        esac
    done
} > "$OUT/processes.txt" 2>&1
say "processes: $(wc -l < "$OUT/processes.txt") look like HMI / navigation / map / KOMBI / CarPlay / display (processes.txt)"
command -v systemctl >/dev/null 2>&1 && systemctl list-units --all --no-pager 2>/dev/null | grep -Ei 'nav|map|kombi|hud|posit|gnss|gps|hmi|render|carplay|projection|smartphone|cluster' > "$OUT/services.txt"

# every process's CPU time over SAMPLE seconds (/proc/<pid>/stat utime + stime): cpu.txt, busiest
# first - "cpu% pid rss command". A share of one core: 100 = one core busy all the time.
ticks() {
    for d in /proc/[0-9]*; do
        [ -r "$d/stat" ] || continue
        awk -v p="${d#/proc/}" '{ sub(/^.*\) /, ""); print p, $12 + $13 }' "$d/stat" 2>/dev/null
    done
}
HZ=$(getconf CLK_TCK 2>/dev/null || echo 100)
unit_ticks() { awk '/^cpu / { s = 0; for (i = 2; i <= NF; i++) s += $i; print s, $5 + $6 }' /proc/stat 2>/dev/null; }
ticks > "$OUT/.cpu0"
U0=$(unit_ticks)
sleep "$SAMPLE"
ticks > "$OUT/.cpu1"
U1=$(unit_ticks)
BUSY=$(echo "$U0 $U1" | awk 'NF == 4 && $3 > $1 { printf "%.0f", 100 - ($4 - $2) * 100 / ($3 - $1) }')
{
    echo "# cpu% (of one core) over ${SAMPLE} s, pid, rss, command; HZ $HZ, $(grep -c '^processor' /proc/cpuinfo 2>/dev/null) cores, whole unit ${BUSY:-?}% busy"
    awk -v hz="$HZ" -v secs="$SAMPLE" 'NR == FNR { a[$1] = $2; next } ($1 in a) { d = $2 - a[$1]; if (d > 0) printf "%.1f %s\n", d * 100 / hz / secs, $1 }' "$OUT/.cpu0" "$OUT/.cpu1" |
        sort -rn | head -n 80 | while read -r pct pid; do
            rss=$(awk '/VmRSS/ {print $2 $3}' "/proc/$pid/status" 2>/dev/null)
            cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c 1-160)
            [ -z "$cmd" ] && cmd="[$(cat "/proc/$pid/comm" 2>/dev/null)]"
            echo "$pct $pid ${rss:-?} $cmd"
        done
} > "$OUT/cpu.txt" 2>&1
rm -f "$OUT/.cpu0" "$OUT/.cpu1"
say "CPU: unit ${BUSY:-?}% busy over ${SAMPLE} s; busiest: $(sed -n 2p "$OUT/cpu.txt" | cut -c 1-100) (cpu.txt)"

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

# ---- 3b. build facts for the controller gate (mgu-inputgate.so, LD_PRELOAD into the HMI) --------------
# A gate built for another C library, C++ library or CommonAPI would not load (or worse) - what it must match:
# Everything here is read from files: nothing is run (no ldd, which has the loader process the HMI's binary), the
# libraries are the ones the running HMI has loaded (/proc/<pid>/maps).
{
    echo "== C library";   getconf GNU_LIBC_VERSION 2>/dev/null; ls -l /lib/libc.so.6 /lib/libc-*.so 2>/dev/null
    echo "== C++ library"; ls -l /usr/lib/libstdc++.so* /lib/libstdc++.so* 2>/dev/null
    for l in /usr/lib/libstdc++.so.6 /lib/libstdc++.so.6; do [ -r "$l" ] && grep -aoE 'GLIBCXX_[0-9.]+' "$l" | sort -t. -k3 -n -u | tail -n 3; done
    echo "== vsomeip / CommonAPI"; ls -l /usr/lib/libvsomeip* /usr/lib/libCommonAPI* 2>/dev/null
    SYM=_ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE
    for d in /proc/[0-9]*; do
        # the HMI process itself (its name), not a shell whose command line mentions it
        case "$(cat "$d/comm" 2>/dev/null)" in HmiMain3D)
            echo "== HmiMain3D pid ${d#/proc/}: libraries it has loaded"
            awk '$6 ~ /\.so/ {print $6}' "$d/maps" 2>/dev/null | sort -u | grep -Ei 'CommonAPI|vsomeip|stdc|libc[.-]|boost|inputgate' | head -n 40
            for l in $(awk '$6 ~ /CommonAPI-SomeIP/ {print $6}' "$d/maps" 2>/dev/null | sort -u); do
                echo "== $l has the gate's hook point: $(grep -ac "$SYM" "$l" 2>/dev/null)"
            done
            echo "== its LD_PRELOAD: $(tr '\0' '\n' < "$d/environ" 2>/dev/null | grep '^LD_PRELOAD=')" ;;
        esac
    done
    echo "== the gate's opt-in folder"; ls -l /var/opt/mgu-inputgate/ 2>/dev/null
} > "$OUT/build-facts.txt" 2>&1
say "build facts: C / C++ library, CommonAPI and the gate as loaded now (build-facts.txt)"

# ---- 3c. audio, for spoken turn prompts later: who plays sound and how the HMI mixes it ---------------
{
    # from /proc and /dev listings only: no sound device is opened (no aplay)
    echo "== sound devices"; ls -l /dev/snd 2>/dev/null; cat /proc/asound/cards 2>/dev/null; cat /proc/asound/pcm 2>/dev/null
    echo "== processes"
    for d in /proc/[0-9]*; do
        cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null | cut -c 1-200)
        case "$cmd" in *[Aa]udio*|*[Ss]ound*|*pulse*|*pipewire*|*[Tt][Tt][Ss]*|*[Ss]peech*|*[Pp]rompt*|*[Aa]nnounce*|*[Mm]ixer*) echo "${d#/proc/}  $cmd" ;; esac
    done
    echo "== services"; command -v systemctl >/dev/null 2>&1 && systemctl list-units --all --no-pager 2>/dev/null | grep -Ei 'audio|sound|tts|speech|prompt|pulse'
} > "$OUT/audio.txt" 2>&1
say "audio: $(grep -c '^[0-9]' "$OUT/audio.txt" 2>/dev/null) audio-like processes (audio.txt)"

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
    # the stock map's files are only listed (names, sizes): none is opened, so nothing the navigation reads is locked
    root=$(find "$m" -maxdepth 3 -iname 'ROOT.NDS' 2>/dev/null | head -n 1)
    [ -n "$root" ] && say "stock map: $root ($(ls -la "$root" | awk '{print $5}') bytes)"
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

# ---- 6. network traffic (optional): which SOME/IP services reach the cluster and the HUD -----------
# The cluster and the HUD are other control units: what the head unit sends them (CarPlay's turn
# arrows, the map's guidance) crosses the car's Ethernet as SOME/IP. tcpdump only listens; the
# first 256 bytes of each packet are kept (the SOME/IP header and the start of the data), SSH not.
if [ "$SNIFF" -gt 0 ] 2>/dev/null; then
    { ip -o addr 2>/dev/null || ifconfig -a 2>/dev/null; } > "$OUT/net-addrs.txt"
    { ip -o link 2>/dev/null; ip route 2>/dev/null; } > "$OUT/net-links.txt"
    TCPDUMP=$(command -v tcpdump 2>/dev/null)
    [ -z "$TCPDUMP" ] && for p in /usr/sbin/tcpdump /sbin/tcpdump "$(dirname "$0")/tcpdump" ./tcpdump; do [ -x "$p" ] && TCPDUMP=$p && break; done
    if [ -n "$TCPDUMP" ]; then
        say "network: recording ${SNIFF} s (someip.pcap) - keep the car as it is meanwhile"
        # listen only: -p (no promiscuous mode: the interfaces are left as they are), 256 bytes a packet, at most
        # 150000 packets (~40 MB), SSH left out; stopped after SNIFF s, and also if this script ends early (SSH lost)
        "$TCPDUMP" -p -i any -n -s 256 -c 150000 -U -w "$OUT/someip.pcap" 'not port 22' > "$OUT/tcpdump.log" 2>&1 &
        TD=$!
        trap 'kill "$TD" 2>/dev/null' EXIT HUP INT TERM
        sleep "$SNIFF"
        kill "$TD" 2>/dev/null; wait "$TD" 2>/dev/null
        trap - EXIT HUP INT TERM
        say "network: $(ls -la "$OUT/someip.pcap" 2>/dev/null | awk '{print $5}') bytes captured (someip.pcap: kit/tools/nav-recon-diff.js reads it)"
    else
        say "network: no tcpdump on this unit (a static ARM tcpdump next to this script works too)"
    fi
fi

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
  * ivi-list.txt: the surface of the stock map (its owning pid in processes.txt): with LABEL=base (home
    screen) and LABEL=stocknav (the BMW map opened from the left menu bar), nav-recon-diff.js shows it turning
    visible. Navigation follows it (app.json config.stockNav; or learn it on the Route page). Never stop that
    process, never hide its surface: Navigation opens over it.
  * The console's NAV button: Navigation opens itself over the stock screen when NAV is pressed (the HMI still
    gets the button: nothing is blocked, and with the app not running NAV is stock). Its Route page learns the
    button (press NAV three times) from either source:
      - the controller gate's read-only feed (mgu-inputgate.so built from kit/renderd/inputgate, and
        /var/opt/mgu-inputgate/buttons): buttons.txt has what it sends;
      - a SOME/IP field of FrontCCU (someip-navigation.txt): put it in app.json "config.navButton"
        { "iface": "...FrontCCU", "field": "<field>" } and in "signals" with "_optional".
    Put Navigation's widget on the home screen: MainApp then starts the app with the car, so NAV works from the start.
  * build-facts.txt: what a controller gate with the NAV hook must be built for (C / C++ library, CommonAPI,
    the hook point) and whether a gate is loaded now. audio.txt: who plays sound, for spoken prompts later.
  * cpu.txt: what each process costs now. Run once with the stock map on screen and once with Navigation
    (osm_nav) in front: the difference is what the stock map costs while it is covered.
  * The cluster map: two runs, LABEL=base and LABEL=cluster (the cluster on its map view, the BMW map projected
    there), each with SNIFF=60, then on the PC:
      node kit/tools/nav-recon-diff.js <base report> <cluster report>
    It lists the surfaces, processes and SOME/IP services that appear or get busy with the cluster's map. On 2021+
    firmware LABEL=carplay (CarPlay guiding, its map in the cluster, the HUD on) also shows the HUD's turn arrows.
    Only showing things is in scope (a surface on the cluster's screen, turn data for the HUD): nothing
    for KAFAS, cruise control or Speed Limit Assist.
EOF
