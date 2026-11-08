/* navwatch.c: see navwatch.h. */
#include "navwatch.h"

#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int navwatch_due(navwatch_surf *s)
{
    if (!s->used || !s->have_vis) return 0;
    const char *proc = s->proc[0] ? s->proc : "?";
    int due = !s->sent || s->vis != s->sent_vis || abs(s->dst[2] - s->sent_w) > 16 || abs(s->dst[3] - s->sent_h) > 16 ||
              strcmp(proc, s->sent_proc) != 0;
    if (!due) return 0;
    s->sent = 1;
    s->sent_vis = s->vis;
    s->sent_w = s->dst[2];
    s->sent_h = s->dst[3];
    snprintf(s->sent_proc, sizeof s->sent_proc, "%s", proc);
    return 1;
}

int navwatch_line(char *buf, size_t n, long ms, const navwatch_surf *s)
{
    char proc[32];
    /* one word, printable: the app splits the line on spaces */
    size_t k = 0;
    for (const char *p = s->proc[0] ? s->proc : "?"; *p && k + 1 < sizeof proc; p++)
        proc[k++] = (*p > ' ' && *p < 127) ? *p : '_';
    proc[k] = 0;
    int r = snprintf(buf, n, "%ld surface %u %d %d %d %d %d %s %s\n", ms, s->id, s->vis ? 1 : 0,
                     s->dst[0], s->dst[1], s->dst[2], s->dst[3], s->yield ? "y" : "-", proc);
    return r < 0 || (size_t)r >= n ? -1 : r;
}

int navwatch_send(const char *name, const char *line, size_t len)
{
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (fd < 0) return -1;
    struct sockaddr_un a;
    memset(&a, 0, sizeof a);
    a.sun_family = AF_UNIX;
    size_t nl = strlen(name);
    if (nl + 1 > sizeof a.sun_path) { close(fd); return -1; }
    memcpy(a.sun_path + 1, name, nl);           /* abstract: a leading NUL */
    int r = -1;
    if (connect(fd, (struct sockaddr *)&a, (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1 + nl)) == 0 &&
        send(fd, line, len, MSG_DONTWAIT | MSG_NOSIGNAL) == (ssize_t)len)
        r = 0;
    close(fd);
    return r;
}
