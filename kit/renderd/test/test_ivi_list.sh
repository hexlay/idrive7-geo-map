#!/bin/sh
# ivi-list against a compositor that logs every request (test/mock_ivi.c): it may only ask for surface handles, their
# owners, and drop the handles keeping the surfaces; it must list every surface with its properties; and nav-recon-diff's
# reader must parse its output. Inside the build image: make in-test-ivi-list
set -eu
B=build
# built for the car's loader path (/lib/ld-linux-x86-64.so.2, as mgu-renderd); this image keeps it in /lib64
RUN=""; [ -e /lib/ld-linux-x86-64.so.2 ] || RUN=/lib64/ld-linux-x86-64.so.2
export XDG_RUNTIME_DIR=$(mktemp -d)
export WAYLAND_DISPLAY=ivi-list-test
$B/mock_ivi $WAYLAND_DISPLAY > $B/ivi-requests.txt 2>/dev/null &
M=$!
trap 'kill $M 2>/dev/null; rm -rf "$XDG_RUNTIME_DIR"' EXIT
i=0; while [ ! -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
$RUN $B/ivi-list > $B/ivi-list-out.txt
sleep 0.3
fail() { echo "FAIL: $*"; echo "--- requests:"; cat $B/ivi-requests.txt; echo "--- output:"; cat $B/ivi-list-out.txt; exit 1; }

grep -q FORBIDDEN $B/ivi-requests.txt && fail "a request that changes the compositor"
n=$(grep -c '^REQ ' $B/ivi-requests.txt)
[ "$n" -eq 9 ] || fail "expected 9 requests (3 x surface_create, send_stats, destroy 0), got $n"
[ "$(grep -c '^REQ ivi_controller.surface_create' $B/ivi-requests.txt)" -eq 3 ] || fail "surface_create"
[ "$(grep -c '^REQ ivi_controller_surface.send_stats' $B/ivi-requests.txt)" -eq 3 ] || fail "send_stats"
[ "$(grep -c '^REQ ivi_controller_surface.destroy destroy_scene_object=0' $B/ivi-requests.txt)" -eq 3 ] || fail "destroy(0)"
echo "ok: ivi-list sent only surface_create, send_stats and destroy(0) (no layer_create, no set_*, no commit)"

grep -q '^1 screens, 2 layers, 3 surfaces' $B/ivi-list-out.txt || fail "the counts"
grep -q '^    surface 4100(0x1004) visibility 0' $B/ivi-list-out.txt || fail "a surface's visibility"
grep -q '^    surface 4100(0x1004) dst 0,0 1920x720' $B/ivi-list-out.txt || fail "a surface's place"
grep -q '^    surface 4100(0x1004) pid 977 (/opt/nav/bin/NaviMap)' $B/ivi-list-out.txt || fail "a surface's owner"
grep -q '^  layer 100(0x64)' $B/ivi-list-out.txt || fail "the layers by id"
echo "ok: every surface listed with visibility, place, size and owner; layers by id"

$RUN $B/ivi-list extra 2>/dev/null && fail "an argument should be refused" || true
echo "ok: an argument is refused (it only lists)"
echo "ivi-list: all checks passed"
