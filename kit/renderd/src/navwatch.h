/* navwatch: which of the compositor's surfaces are shown, told to a navigation app (read only).
 *
 * mgu-render watches the other processes' ivi surfaces on wayland-0 (nav_watch = 1) and, when one is shown or hidden
 * or changes size, sends one line to the abstract socket @mgu-nav-buttons, where osm_nav listens:
 *     <monotonic ms> surface <id> <visible 0|1> <x> <y> <w> <h> <y: a yield surface (camera, video) | -> <process>\n
 * osm_nav learns which one is the stock BMW map and opens itself over it when it is shown. Nothing here changes a
 * surface: no ivi_controller_surface_set_*; a connection nobody accepts is closed at once (the app not running). */
#ifndef MGU_NAVWATCH_H
#define MGU_NAVWATCH_H
#include <stddef.h>
#include <stdint.h>

#define NAVWATCH_MAX 64

typedef struct {
    uint32_t id;
    int used, yield;
    int vis, have_vis;
    int dst[4];
    char proc[32];          /* the owning process' name (stats); "?" until known */
    /* what was sent last */
    int sent, sent_vis, sent_w, sent_h;
    char sent_proc[32];
} navwatch_surf;

/* Something worth a line since the last one: shown / hidden, the size changed by more than 16 px (not every frame of
 * a sliding animation), or the process became known. Records it as sent. */
int navwatch_due(navwatch_surf *s);
/* The line for s at ms (NUL-terminated); its length, or -1 if it does not fit. */
int navwatch_line(char *buf, size_t n, long ms, const navwatch_surf *s);
/* The line to @<name> (abstract socket): 0 sent, -1 nobody listening. Never waits. */
int navwatch_send(const char *name, const char *line, size_t len);

#endif
