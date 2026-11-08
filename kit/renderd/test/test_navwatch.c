/* navwatch.c: which changes become lines, what a line says, and that sending never waits.
 *   cc -std=gnu11 -Isrc -o build/test_navwatch test/test_navwatch.c src/navwatch.c && build/test_navwatch */
#include "navwatch.h"

#include <assert.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

static long ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000L + t.tv_nsec / 1000000L; }

static int listen_abstract(const char *name)
{
    int s = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0);
    struct sockaddr_un a; memset(&a, 0, sizeof a); a.sun_family = AF_UNIX;
    memcpy(a.sun_path + 1, name, strlen(name));
    assert(bind(s, (struct sockaddr *)&a, (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + strlen(name))) == 0);
    assert(listen(s, 8) == 0);
    return s;
}
static int read_line(int s, char *buf, size_t n)
{
    int c = accept(s, NULL, NULL);
    if (c < 0) return -1;
    int k = 0; long until = ms() + 500;
    while (ms() < until && k < (int)n - 1) {
        ssize_t r = read(c, buf + k, n - 1 - (size_t)k);
        if (r > 0) k += (int)r; else if (r == 0) break; else usleep(1000);
    }
    buf[k] = 0; close(c); return k;
}

int main(void)
{
    navwatch_surf s; memset(&s, 0, sizeof s);
    s.used = 1; s.id = 4100;
    assert(!navwatch_due(&s));                                  /* nothing known yet */
    s.vis = 0; s.have_vis = 1;
    assert(navwatch_due(&s) && !navwatch_due(&s));              /* first state, then nothing new */
    s.dst[2] = 1920; s.dst[3] = 720;
    assert(navwatch_due(&s));                                   /* resized */
    s.dst[2] = 1910;
    assert(!navwatch_due(&s));                                  /* 10 px: a frame of an animation, no line */
    s.dst[0] = 300;
    assert(!navwatch_due(&s));                                  /* moved only: no line */
    s.vis = 1;
    assert(navwatch_due(&s));                                   /* shown */
    snprintf(s.proc, sizeof s.proc, "NaviMapRenderer");
    assert(navwatch_due(&s));                                   /* its process now known */
    puts("ok: lines for shown / hidden, a real resize, the process; none for an animation frame or a move");

    char line[160];
    s.dst[0] = 0; s.dst[1] = 0; s.dst[2] = 1920; s.dst[3] = 720;
    int n = navwatch_line(line, sizeof line, 12345, &s);
    assert(n > 0 && !strcmp(line, "12345 surface 4100 1 0 0 1920 720 - NaviMapRenderer\n"));
    navwatch_surf y = s; y.yield = 1; snprintf(y.proc, sizeof y.proc, "cam era\tx");
    navwatch_line(line, sizeof line, 1, &y);
    assert(!strcmp(line, "1 surface 4100 1 0 0 1920 720 y cam_era_x\n"));
    assert(navwatch_line(line, 10, 1, &s) == -1);
    printf("ok: \"%s\" (a yield surface marked y, a process name one word)\n", "12345 surface 4100 1 0 0 1920 720 - NaviMapRenderer");

    int l = listen_abstract("navwatch-test");
    n = navwatch_line(line, sizeof line, 7, &s);
    assert(navwatch_send("navwatch-test", line, (size_t)n) == 0);
    char got[200];
    assert(read_line(l, got, sizeof got) == n && !strcmp(got, line));
    close(l);
    long t0 = ms();
    for (int i = 0; i < 500; i++) assert(navwatch_send("navwatch-test", line, (size_t)n) == -1);
    long took = ms() - t0;
    printf("ok: sent to a listener; nobody listening: 500 lines refused in %ld ms\n", took);
    assert(took < 500);
    puts("navwatch: all checks passed");
    return 0;
}
