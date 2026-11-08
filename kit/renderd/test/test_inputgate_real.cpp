// The HMI's own handleProxyReceive for test_inputgate.cpp: counts the messages the gate passes on and keeps the last
// payload, so the test can check the HMI gets every message, unchanged.
#include <vsomeip/vsomeip.hpp>
#include <memory>
#include <vector>

static int g_calls;
static std::vector<vsomeip::byte_t> g_last;

extern "C" void _ZN9CommonAPI6SomeIP10Connection18handleProxyReceiveERKSt10shared_ptrIN7vsomeip7messageEE(
    void *, const std::shared_ptr<vsomeip::message> &msg)
{
    g_calls++;
    std::shared_ptr<vsomeip::payload> p = msg ? msg->get_payload() : nullptr;
    g_last = p ? std::vector<vsomeip::byte_t>(p->get_data(), p->get_data() + p->get_length()) : std::vector<vsomeip::byte_t>();
}
extern "C" int real_calls() { return g_calls; }
extern "C" const std::vector<vsomeip::byte_t> &real_last() { return g_last; }
