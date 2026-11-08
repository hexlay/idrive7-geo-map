/* ivi-list - what the compositor (winston, wayland-0) shows: screens, layer ids, and each surface's visibility, place,
 * size and owning process. READ ONLY, for running on a car (deploy/car/nav-recon.sh):
 *   - it never creates, resizes, moves, orders, shows or hides anything and never commits: there is no
 *     ivi_controller_layer_create, no *_set_*, no screen_* and no commit_changes in this program at all;
 *   - per surface it makes exactly the calls mgu-render's own HMI probe makes on cars (src/main.c hmi_probe):
 *     ivi_controller_surface_create (a handle on a surface that exists, from the compositor's own list),
 *     send_stats (who owns it), then ivi_controller_surface_destroy(handle, 0): the handle only, the surface stays;
 *   - layers are listed by id only (their properties would need a layer handle: left out on purpose).
 * Output (kit/tools/nav-recon-diff.js reads it):
 *   N screens, N layers, N surfaces / "  screen <id>" / "  layer <id>(0x..)" /
 *   "  surface <id>(0x..)" then "    surface <id>(0x..) <visibility|opacity|src|dst|config|pid ...>" lines
 * Run: WAYLAND_DISPLAY=wayland-0 XDG_RUNTIME_DIR=/run/wayland ivi-list   (no arguments: it does only this) */
#include <stdio.h>
#include <string.h>
#include <wayland-client.h>
#include "ivi-controller-client-protocol.h"

static struct ivi_controller *ctl;
#define MAXN 256
static uint32_t screens[16]; static int nscreens;
static uint32_t layers[MAXN]; static int nlayers;
static uint32_t surfs[MAXN]; static int nsurfs;

static void c_screen(void *d, struct ivi_controller *c, uint32_t id, struct ivi_controller_screen *s) {
    (void)d, (void)c, (void)s;
    if (nscreens < 16) screens[nscreens++] = id;
}
static void c_layer(void *d, struct ivi_controller *c, uint32_t id) { (void)d, (void)c; if (nlayers < MAXN) layers[nlayers++] = id; }
static void c_surface(void *d, struct ivi_controller *c, uint32_t id) { (void)d, (void)c; if (nsurfs < MAXN) surfs[nsurfs++] = id; }
static void c_error(void *d, struct ivi_controller *c, int32_t oid, int32_t ot, int32_t code, const char *t) {
    (void)d, (void)c;
    fprintf(stderr, "ivi error obj %d type %d code %d: %s\n", oid, ot, code, t ? t : "");
}
static const struct ivi_controller_listener ctl_l = { c_screen, c_layer, c_surface, c_error };

static char cur[64];
static void s_vis(void *d, struct ivi_controller_surface *s, int32_t v) { (void)d, (void)s; printf("    %s visibility %d\n", cur, v); }
static void s_op(void *d, struct ivi_controller_surface *s, wl_fixed_t v) { (void)d, (void)s; printf("    %s opacity %.2f\n", cur, wl_fixed_to_double(v)); }
static void s_src(void *d, struct ivi_controller_surface *s, int32_t x, int32_t y, int32_t w, int32_t h) { (void)d, (void)s; printf("    %s src %d,%d %dx%d\n", cur, x, y, w, h); }
static void s_dst(void *d, struct ivi_controller_surface *s, int32_t x, int32_t y, int32_t w, int32_t h) { (void)d, (void)s; printf("    %s dst %d,%d %dx%d\n", cur, x, y, w, h); }
static void s_conf(void *d, struct ivi_controller_surface *s, int32_t w, int32_t h) { (void)d, (void)s; printf("    %s config %dx%d\n", cur, w, h); }
static void s_int(void *d, struct ivi_controller_surface *s, int32_t v) { (void)d, (void)s, (void)v; }
static void s_layer(void *d, struct ivi_controller_surface *s, struct ivi_controller_layer *l) { (void)d, (void)s, (void)l; }
static void s_stats(void *d, struct ivi_controller_surface *s, uint32_t a, uint32_t b, uint32_t c, uint32_t pid, const char *n) {
    (void)d, (void)s, (void)a, (void)b, (void)c;
    printf("    %s pid %u (%s)\n", cur, pid, n ? n : "?");
}
static void s_destroyed(void *d, struct ivi_controller_surface *s) { (void)d, (void)s; }
static const struct ivi_controller_surface_listener surf_l = {
    s_vis, s_op, s_src, s_dst, s_conf, s_int, s_int, s_layer, s_stats, s_destroyed, s_int,
};

static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver) {
    (void)d, (void)ver;
    if (!strcmp(iface, "ivi_controller") && !ctl) {
        ctl = wl_registry_bind(r, name, &ivi_controller_interface, 1);
        ivi_controller_add_listener(ctl, &ctl_l, NULL);
    }
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t n) { (void)d, (void)r, (void)n; }
static const struct wl_registry_listener reg_l = { reg_global, reg_remove };

int main(int argc, char **argv) {
    (void)argv;
    if (argc != 1) { fprintf(stderr, "ivi-list takes no arguments: it only lists (read only)\n"); return 2; }
    struct wl_display *dpy = wl_display_connect(NULL);
    if (!dpy) { perror("wl_display_connect"); return 1; }
    struct wl_registry *reg = wl_display_get_registry(dpy);
    wl_registry_add_listener(reg, &reg_l, NULL);
    wl_display_roundtrip(dpy); wl_display_roundtrip(dpy);
    if (!ctl) { fprintf(stderr, "no ivi_controller\n"); wl_display_disconnect(dpy); return 1; }
    printf("%d screens, %d layers, %d surfaces\n", nscreens, nlayers, nsurfs);
    for (int i = 0; i < nscreens; i++) printf("  screen %u\n", screens[i]);
    for (int i = 0; i < nlayers; i++) printf("  layer %u(0x%x)\n", layers[i], layers[i]);
    for (int i = 0; i < nsurfs; i++) {
        snprintf(cur, sizeof cur, "surface %u(0x%x)", surfs[i], surfs[i]);
        printf("  %s\n", cur);
        struct ivi_controller_surface *s = ivi_controller_surface_create(ctl, surfs[i]);
        ivi_controller_surface_add_listener(s, &surf_l, NULL);
        ivi_controller_surface_send_stats(s);
        wl_display_roundtrip(dpy); wl_display_roundtrip(dpy);
        ivi_controller_surface_destroy(s, 0);          /* our handle only: the surface stays */
        wl_display_roundtrip(dpy);
    }
    fflush(stdout);
    wl_display_disconnect(dpy);
    return 0;
}
