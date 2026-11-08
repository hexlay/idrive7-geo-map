/* A stand-in ivi_controller compositor that logs every request a client sends, for test/test_ivi_list.sh: it announces
 * one screen, layers 100 and 200 and surfaces 1000 (HmiMain3D, shown), 4100 (NaviMap, hidden) and 0x197 (camera), and
 * answers a surface handle with its properties and stats. Each request is printed as "REQ <interface>.<request> args";
 * one that would change the screen (anything but surface_create, send_stats, destroy(0)) is printed "FORBIDDEN".
 *   mock_ivi SOCKET
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wayland-server.h>

#include "ivi-controller-server-protocol.h"

static struct wl_display *dpy;
static const struct { uint32_t id; int vis, w, h; uint32_t pid; const char *name; } SURF[] = {
    { 1000, 1, 1920, 720, 812, "/usr/bin/HmiMain3D" }, { 4100, 0, 1920, 720, 977, "/opt/nav/bin/NaviMap" },
    { 0x197, 0, 1920, 720, 640, "camera" },
};
#define NS (sizeof SURF / sizeof SURF[0])

static void say(const char *iface, const char *req, const char *args, int forbidden) {
    printf("%s %s.%s %s\n", forbidden ? "FORBIDDEN" : "REQ", iface, req, args);
    fflush(stdout);
}

/* an ivi_controller_surface handle: every request logged; send_stats answered; destroy(0) ends the handle */
static int surf_dispatch(const void *impl, void *target, uint32_t op, const struct wl_message *msg, union wl_argument *args) {
    (void)impl;
    struct wl_resource *r = target;
    int i = (int)(intptr_t)wl_resource_get_user_data(r);
    char a[64] = "";
    if (!strcmp(msg->name, "destroy")) {
        snprintf(a, sizeof a, "destroy_scene_object=%d", args[0].i);
        say("ivi_controller_surface", msg->name, a, args[0].i != 0);
        wl_resource_destroy(r);
        return 0;
    }
    if (!strcmp(msg->name, "send_stats")) {
        say("ivi_controller_surface", msg->name, "", 0);
        ivi_controller_surface_send_stats(r, 0, 0, 0, SURF[i].pid, SURF[i].name);
        return 0;
    }
    say("ivi_controller_surface", msg->name, "", 1);   /* set_*, screenshot, input focus ...: changes things */
    (void)op;
    return 0;
}
static int ctl_dispatch(const void *impl, void *target, uint32_t op, const struct wl_message *msg, union wl_argument *args) {
    (void)impl, (void)op;
    struct wl_resource *ctl = target;
    if (!strcmp(msg->name, "surface_create")) {
        char a[64]; snprintf(a, sizeof a, "id=%u", args[0].u);
        say("ivi_controller", msg->name, a, 0);
        int i = -1;
        for (unsigned k = 0; k < NS; k++) if (SURF[k].id == args[0].u) i = (int)k;
        struct wl_resource *s = wl_resource_create(wl_resource_get_client(ctl), &ivi_controller_surface_interface, 1, args[1].n);
        wl_resource_set_dispatcher(s, surf_dispatch, NULL, (void *)(intptr_t)(i < 0 ? 0 : i), NULL);
        if (i >= 0) {
            ivi_controller_surface_send_visibility(s, SURF[i].vis);
            ivi_controller_surface_send_opacity(s, wl_fixed_from_int(1));
            ivi_controller_surface_send_source_rectangle(s, 0, 0, SURF[i].w, SURF[i].h);
            ivi_controller_surface_send_destination_rectangle(s, 0, 0, SURF[i].w, SURF[i].h);
            ivi_controller_surface_send_configuration(s, SURF[i].w, SURF[i].h);
        }
        return 0;
    }
    say("ivi_controller", msg->name, "", 1);           /* layer_create, commit_changes: changes things */
    return 0;
}
static void bind_ctl(struct wl_client *c, void *d, uint32_t v, uint32_t id) {
    (void)d;
    struct wl_resource *r = wl_resource_create(c, &ivi_controller_interface, (int)v, id);
    wl_resource_set_dispatcher(r, ctl_dispatch, NULL, NULL, NULL);
    struct wl_resource *scr = wl_resource_create(c, &ivi_controller_screen_interface, 1, 0);
    ivi_controller_send_screen(r, 4, scr);
    ivi_controller_send_layer(r, 100);
    ivi_controller_send_layer(r, 200);
    for (unsigned k = 0; k < NS; k++) ivi_controller_send_surface(r, SURF[k].id);
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: mock_ivi SOCKET\n"); return 2; }
    dpy = wl_display_create();
    if (wl_display_add_socket(dpy, argv[1])) { perror("socket"); return 1; }
    wl_global_create(dpy, &ivi_controller_interface, 1, NULL, bind_ctl);
    fprintf(stderr, "mock_ivi: listening on %s\n", argv[1]);
    wl_display_run(dpy);
    return 0;
}
