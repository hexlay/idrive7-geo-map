// The controller gate (build/mgu-inputgate.so) as it sits in the HMI: preloaded (LD_PRELOAD) in front of
// CommonAPI::SomeIP::Connection::handleProxyReceive, here a fake one (test_inputgate_real.so) that records what it
// gets. Checks the NAV button feed is read only and opt-in, and that the HMI always gets every message unchanged:
//   - opt-in file absent: nothing logged or sent; the HMI gets the button
//   - opt-in present: "<ms> <length> <hex>" appended to /run/mgu-renderd/buttons.log and sent to @mgu-nav-buttons;
//     the HMI gets the same message, its payload untouched
//   - another service, the rotary event (gate open): not logged, passed on unchanged
//   - nobody listening: the call does not wait; a long payload: its first 64 bytes, the full length said
// Root in the build image (it writes /var/opt and /run):
//   make test-inputgate   (docker run ... mgu-renderd-build make in-test-inputgate)
#include <vsomeip/vsomeip.hpp>

#include <assert.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>

#include <memory>
#include <string>
#include <vector>

using namespace vsomeip;

class fake_payload : public payload {
public:
    std::vector<byte_t> d;
    bool operator==(const payload &o) override { return get_length() == o.get_length() && !memcmp(get_data(), o.get_data(), get_length()); }
    byte_t *get_data() override { return d.data(); }
    const byte_t *get_data() const override { return d.data(); }
    void set_data(const byte_t *p, length_t n) override { d.assign(p, p + n); }
    void set_data(const std::vector<byte_t> &v) override { d = v; }
    void set_data(std::vector<byte_t> &&v) override { d = std::move(v); }
    length_t get_length() const override { return length_t(d.size()); }
    void set_capacity(length_t n) override { d.reserve(n); }
    bool serialize(serializer *) const override { return false; }
    bool deserialize(deserializer *) override { return false; }
};

class fake_message : public message {
public:
    service_t svc = 0; method_t meth = 0; std::shared_ptr<payload> pl;
    std::shared_ptr<payload> get_payload() const override { return pl; }
    void set_payload(std::shared_ptr<payload> p) override { pl = p; }
    message_t get_message() const override { return message_t(svc) << 16 | meth; }
    void set_message(message_t m) override { svc = service_t(m >> 16); meth = method_t(m); }
    service_t get_service() const override { return svc; }
    void set_service(service_t s) override { svc = s; }
    instance_t get_instance() const override { return 1; }
    void set_instance(instance_t) override {}
    method_t get_method() const override { return meth; }
    void set_method(method_t m) override { meth = m; }
    length_t get_length() const override { return pl ? pl->get_length() + 8 : 8; }
    request_t get_request() const override { return 0; }
    client_t get_client() const override { return 0; }
    void set_client(client_t) override {}
    session_t get_session() const override { return 0; }
    void set_session(session_t) override {}
    protocol_version_t get_protocol_version() const override { return 1; }
    interface_version_t get_interface_version() const override { return 1; }
    void set_interface_version(interface_version_t) override {}
    message_type_e get_message_type() const override { return message_type_e::MT_NOTIFICATION; }
    void set_message_type(message_type_e) override {}
    return_code_e get_return_code() const override { return return_code_e::E_OK; }
    void set_return_code(return_code_e) override {}
    bool is_reliable() const override { return false; }
    void set_reliable(bool) override {}
    bool is_initial() const override { return false; }
    void set_initial(bool) override {}
    bool is_valid_crc() const override { return true; }
    void set_is_valid_crc(bool) override {}
    bool serialize(serializer *) const override { return false; }
    bool deserialize(deserializer *) override { return false; }
};

// the HMI's function (the gate forwards to it) and what it saw: test_inputgate_real.cpp
extern "C" void _ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE(
    void *self, const std::shared_ptr<message> &msg);
extern "C" int real_calls();
extern "C" const std::vector<byte_t> &real_last();

static const char *OPT = "/var/opt/mgu-inputgate/buttons", *LOG = "/run/mgu-renderd/buttons.log";

static std::shared_ptr<message> msg(service_t s, method_t m, std::vector<byte_t> data)
{
    auto p = std::make_shared<fake_payload>();
    p->d = data;
    auto r = std::make_shared<fake_message>();
    r->svc = s; r->meth = m; r->pl = p;
    return r;
}
static void hmi_gets(const std::shared_ptr<message> &m)
{
    _ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE(nullptr, m);
}
static std::string slurp(const char *f)
{
    std::string s; char b[4096]; int fd = open(f, O_RDONLY); if (fd < 0) return s;
    ssize_t n; while ((n = read(fd, b, sizeof b)) > 0) s.append(b, size_t(n));
    close(fd); return s;
}
static long ms() { timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return t.tv_sec * 1000L + t.tv_nsec / 1000000L; }
// the app's listener: the abstract socket the gate sends a line to
static int listen_nav()
{
    int s = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK, 0);
    sockaddr_un a{}; a.sun_family = AF_UNIX;
    static const char name[] = "\0mgu-nav-buttons";
    memcpy(a.sun_path, name, sizeof name - 1);
    assert(bind(s, reinterpret_cast<sockaddr *>(&a), socklen_t(offsetof(sockaddr_un, sun_path) + sizeof name - 1)) == 0);
    assert(listen(s, 8) == 0);
    return s;
}
static std::string accept_line(int s)
{
    int c = accept(s, nullptr, nullptr);
    if (c < 0) return "";
    std::string out; char b[512]; ssize_t n;
    long until = ms() + 500;
    while (ms() < until) { n = read(c, b, sizeof b); if (n > 0) out.append(b, size_t(n)); else if (n == 0) break; else usleep(1000); }
    close(c); return out;
}

int main()
{
    unlink(OPT); unlink(LOG);
    mkdir("/run/mgu-renderd", 0755);
    const std::vector<byte_t> nav = {0xa4, 0x01};

    // 1. opt-in absent: nothing logged; the HMI gets the button as it is
    hmi_gets(msg(0xb508, 0x8001, nav));
    assert(real_calls() == 1 && real_last() == nav);
    struct stat st;
    assert(stat(LOG, &st) != 0);
    puts("ok: without the opt-in file nothing is logged or sent; the HMI gets NAV unchanged");

    // 2. opt-in present (the gate looks at most every 2 s): logged, sent to the app, the HMI still gets it unchanged
    mkdir("/var/opt/mgu-inputgate", 0755);
    close(open(OPT, O_WRONLY | O_CREAT, 0644));
    sleep(3);
    int l = listen_nav();
    hmi_gets(msg(0xb508, 0x8001, nav));
    assert(real_calls() == 2 && real_last() == nav);
    std::string line = accept_line(l), log = slurp(LOG);
    assert(!line.empty() && line.find(" 2 a401\n") != std::string::npos);
    assert(log == line);
    printf("ok: opt-in: the app gets \"%.*s\", the log the same, the HMI the button unchanged\n", int(line.size() - 1), line.c_str());

    // 3. other services, and the rotary event with the gate open: passed on unchanged, not logged
    const std::vector<byte_t> rot = {0x01, 0x12, 0x34, 0x00, 0x00};
    hmi_gets(msg(0x1234, 0x8001, nav));
    hmi_gets(msg(0xb508, 0x8002, rot));
    assert(real_calls() == 4 && real_last() == rot);
    assert(slurp(LOG) == log);
    puts("ok: another service and the rotary event (gate open): passed on unchanged, not logged");

    // 4. a long payload: its first 64 bytes, the full length said
    std::vector<byte_t> big(100);
    for (size_t i = 0; i < big.size(); i++) big[i] = byte_t(i);
    hmi_gets(msg(0xb508, 0x8001, big));
    std::string l4 = accept_line(l);
    assert(l4.find(" 100 000102") != std::string::npos && l4.size() < 32 + 64 * 2 + 2);
    assert(real_last() == big);
    puts("ok: a long payload: 64 bytes logged, length 100, the HMI gets all of it");
    close(l);

    // 5. nobody listening (the app not running): the HMI's call does not wait
    long t0 = ms();
    for (int i = 0; i < 200; i++) hmi_gets(msg(0xb508, 0x8001, nav));
    long took = ms() - t0;
    assert(real_calls() == 205);
    printf("ok: nobody listening: 200 buttons in %ld ms (the HMI never waits)\n", took);
    assert(took < 500);

    // 6. opt-in removed: off again within 2 s
    unlink(OPT);
    sleep(3);
    std::string before = slurp(LOG);
    hmi_gets(msg(0xb508, 0x8001, nav));
    assert(slurp(LOG) == before && real_calls() == 206);
    puts("ok: opt-in file removed: off again, the HMI still gets NAV");
    unlink(LOG);
    puts("mgu-inputgate: all checks passed");
    return 0;
}
