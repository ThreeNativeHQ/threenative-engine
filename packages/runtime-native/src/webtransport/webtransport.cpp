/**
 * WebTransport API implementation (client) over quiche QUIC + HTTP/3.
 *
 * See include/mystral/webtransport/webtransport.h for the high-level design.
 */

#include "mystral/webtransport/webtransport.h"

#include <iostream>

// Full implementation requires quiche. The QUIC UDP socket and timers are driven
// directly on the runtime's per-frame poll loop using raw non-blocking sockets
// (no libuv), so WebTransport works on every platform — desktop and mobile.
// Otherwise we fall back to a stub that makes WebTransport construction reject.
#if defined(MYSTRAL_HAS_QUICHE)

#include "mystral/js/engine.h"
#include "runtime_scripts.h"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX  // quiche.h includes Winsock, which otherwise defines min()/max()
#endif
#endif

#include <quiche.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <cmath>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <map>
#include <memory>
#include <queue>
#include <random>
#include <set>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX  // prevent windows.h from defining min()/max() macros
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace mystral {
namespace webtransport {

namespace {

// ---------------------------------------------------------------------------
// Cross-platform raw UDP socket helpers (no libuv)
// ---------------------------------------------------------------------------

#ifdef _WIN32
using socket_t = SOCKET;
constexpr socket_t kInvalidSocket = INVALID_SOCKET;
inline void closeSocket(socket_t s) { ::closesocket(s); }
inline bool setSocketNonBlocking(socket_t s) {
    u_long mode = 1;
    return ::ioctlsocket(s, FIONBIO, &mode) == 0;
}
#else
using socket_t = int;
constexpr socket_t kInvalidSocket = -1;
inline void closeSocket(socket_t s) { ::close(s); }
inline bool setSocketNonBlocking(socket_t s) {
    int flags = ::fcntl(s, F_GETFL, 0);
    return flags >= 0 && ::fcntl(s, F_SETFL, flags | O_NONBLOCK) == 0;
}
#endif

// ---------------------------------------------------------------------------
// WebTransport / HTTP/3 wire constants
// ---------------------------------------------------------------------------

// Signal frame type prepended to a client-initiated bidirectional WT stream.
constexpr uint64_t WT_STREAM_BIDI_SIGNAL = 0x41;
// Stream type prepended to a unidirectional WT stream.
constexpr uint64_t WT_STREAM_UNI_SIGNAL = 0x54;

// HTTP/3 unidirectional stream types that belong to the h3 layer (must not be
// treated as WebTransport streams).
constexpr uint64_t H3_CONTROL_STREAM_TYPE = 0x00;
constexpr uint64_t H3_PUSH_STREAM_TYPE = 0x01;
constexpr uint64_t H3_QPACK_ENCODER_STREAM_TYPE = 0x02;
constexpr uint64_t H3_QPACK_DECODER_STREAM_TYPE = 0x03;

// WebTransport HTTP/3 SETTINGS (advertised to the server so it accepts the
// extended CONNECT). Multiple draft identifiers are sent for compatibility.
constexpr uint64_t SETTINGS_WEBTRANSPORT_MAX_SESSIONS_DRAFT = 0x2b603742;  // draft-02 ENABLE_WEBTRANSPORT
constexpr uint64_t SETTINGS_WT_MAX_SESSIONS = 0xc671706a;                  // draft-07+ WT_MAX_SESSIONS

constexpr size_t MAX_DATAGRAM_SIZE = 1350;
constexpr size_t STREAM_READ_CHUNK = 16 * 1024;
constexpr size_t kStreamLimit = 64;
constexpr size_t kStreamReadCreditLimit = 16 * 1024;
constexpr size_t kStreamReadBytesPerTick = 256 * 1024;
constexpr size_t kStreamReadCallsPerTick = 256;
constexpr size_t kSocketReadsPerTick = 64;
constexpr const char* kInsecurePeerVerificationEnv = "MYSTRAL_WEBTRANSPORT_INSECURE";
// Lowers the negotiated datagram capacity so a test can prove an oversize
// refusal against a small number instead of whatever the current path allows.
// It only ever lowers: a value above the negotiated capacity is ignored.
constexpr const char* kMaxDatagramEnv = "MYSTRAL_WEBTRANSPORT_MAX_DATAGRAM";

// Operator-supplied, process-local trust anchor file. The packaged quiche did not
// pick this up through its own default verify paths
// (docs/verification/prd-359-tls-preflight-2026-09-05.md), so it is loaded
// explicitly below. It names anchors this process trusts; it never decides
// *whether* the peer is verified, and verify-peer stays on either way.
constexpr const char* kPeerTrustFileEnv = "SSL_CERT_FILE";

// Outgoing datagrams waiting for capacity, per session. PROTOCOL.md's default
// of 256 queued datagrams per direction; past it the oldest waiting datagram is
// discarded to admit the newest, which is what unreliable delivery is for.
constexpr size_t kDatagramQueueLimit = 256;

// Status returned by __wtSendDatagram. The JS polyfill mirrors these values —
// they are the only thing that tells a closed session, a payload that cannot
// fit and a local queue drop apart at the call site.
constexpr int kDatagramAccepted = 0;
constexpr int kDatagramInvalidSession = -1;
constexpr int kDatagramTooLarge = -2;
constexpr int kDatagramDropped = -3;
// The path refused the frame outright. Distinct from kDatagramDropped: that one
// is this host trimming its own backlog and is normal for an unreliable
// transport, this one is a transport failure the caller must not read as sent.
constexpr int kDatagramSendFailed = -4;

// __wtStreamWrite is a whole-write bridge: the current JS caller treats every
// non-negative result as the complete write, so it must never expose quiche's
// partial admission as a successful return. The queue bound is bytes across
// all streams in one session, not a per-stream guess.
constexpr size_t kStreamWriteQueueLimit = 1u * 1024u * 1024u;
constexpr int64_t kStreamWriteInvalid = -1;
constexpr int64_t kStreamWriteQueueFull = -2;
constexpr int64_t kStreamWriteTooLarge = -3;

bool isTruthyEnvironmentValue(const char* value) {
    return value != nullptr && std::string(value) == "1";
}

// Applies an explicit process-local trust anchor file to `config`. A trust input
// that was supplied and cannot be used is refused rather than quietly falling back
// to whatever else this machine trusts, which would let a misconfigured deployment
// look verified. Nothing supplied means nothing changes: no load call is made and
// quiche keeps its own default verify paths. Whether a loaded file adds to those
// defaults or replaces them is not measured here, so nothing depends on it.
bool applyPeerTrust(quiche_config* config, const char* rawPath, std::string* error) {
    if (rawPath == nullptr) return true;
    const std::string path(rawPath);
    if (path.empty()) {
        *error = std::string(kPeerTrustFileEnv) +
                 " is set but empty; refusing to guess a trust source";
        return false;
    }
    const int rc = quiche_config_load_verify_locations_from_file(config, path.c_str());
    if (rc != 0) {
        *error = std::string(kPeerTrustFileEnv) + "=" + path +
                 " could not be loaded as trusted CA certificates (quiche error " +
                 std::to_string(rc) + ")";
        return false;
    }
    return true;
}

// ---------------------------------------------------------------------------
// Varint helpers (QUIC variable-length integer encoding, RFC 9000 §16)
// ---------------------------------------------------------------------------

void varintEncode(std::vector<uint8_t>& out, uint64_t v) {
    if (v <= 63) {
        out.push_back(static_cast<uint8_t>(v));
    } else if (v <= 16383) {
        out.push_back(static_cast<uint8_t>(0x40 | (v >> 8)));
        out.push_back(static_cast<uint8_t>(v & 0xff));
    } else if (v <= 1073741823ull) {
        out.push_back(static_cast<uint8_t>(0x80 | (v >> 24)));
        out.push_back(static_cast<uint8_t>((v >> 16) & 0xff));
        out.push_back(static_cast<uint8_t>((v >> 8) & 0xff));
        out.push_back(static_cast<uint8_t>(v & 0xff));
    } else {
        out.push_back(static_cast<uint8_t>(0xc0 | (v >> 56)));
        out.push_back(static_cast<uint8_t>((v >> 48) & 0xff));
        out.push_back(static_cast<uint8_t>((v >> 40) & 0xff));
        out.push_back(static_cast<uint8_t>((v >> 32) & 0xff));
        out.push_back(static_cast<uint8_t>((v >> 24) & 0xff));
        out.push_back(static_cast<uint8_t>((v >> 16) & 0xff));
        out.push_back(static_cast<uint8_t>((v >> 8) & 0xff));
        out.push_back(static_cast<uint8_t>(v & 0xff));
    }
}

// Decodes a varint from buf at offset. Returns the number of bytes consumed, or
// 0 if there are not enough bytes available yet.
size_t varintDecode(const uint8_t* buf, size_t len, uint64_t* out) {
    if (len == 0) return 0;
    uint8_t first = buf[0];
    size_t length = 1u << (first >> 6);  // 1, 2, 4 or 8
    if (len < length) return 0;
    uint64_t v = first & 0x3f;
    for (size_t i = 1; i < length; i++) {
        v = (v << 8) | buf[i];
    }
    *out = v;
    return length;
}

// Bytes varintEncode() will spend on v, without encoding it.
size_t varintLength(uint64_t v) {
    if (v <= 63) return 1;
    if (v <= 16383) return 2;
    if (v <= 1073741823ull) return 4;
    return 8;
}

// ---------------------------------------------------------------------------
// Datagram capacity and admission (pure; no session state)
// ---------------------------------------------------------------------------

// The browser-style `datagrams.maxDatagramSize`: what quiche says it can write
// right now, minus the HTTP/3 session framing this client prepends to every
// datagram (the quarter-stream-id varint, whose width follows the CONNECT
// stream id). `maxWritable` is quiche_conn_dgram_max_writable_len, which is
// negative when the peer never enabled datagrams. Reports 0 rather than a guess
// whenever there is no usable capacity.
size_t datagramPayloadCapacity(ssize_t maxWritable, int64_t connectStreamId) {
    if (maxWritable <= 0 || connectStreamId < 0) return 0;
    const size_t framing = varintLength(static_cast<uint64_t>(connectStreamId) / 4);
    const size_t writable = static_cast<size_t>(maxWritable);
    return writable > framing ? writable - framing : 0;
}

// Applies the explicit test clamp, which only ever lowers the measured
// capacity. Unset means no clamp and is not an error. An explicit value that
// cannot be used fails closed — returns false with a message and writes no
// capacity — because keeping the negotiated number while whoever set the
// variable believes a limit is in force is the same silent substitution the
// hardcoded limit was. Never throws: the caller fails the session instead.
bool clampDatagramCapacity(size_t capacity, const char* clampValue, size_t* out,
                           std::string* error) {
    if (clampValue == nullptr) {  // unset: no clamp
        *out = capacity;
        return true;
    }
    const auto refuse = [&](const char* why) {
        *error = std::string("Unusable ") + kMaxDatagramEnv + "=\"" + clampValue + "\": " + why +
                 ". Set a positive byte count, or unset it to use the negotiated capacity.";
        return false;
    };
    if (*clampValue == '\0') return refuse("the value is empty");
    // strtoll silently skips leading whitespace and accepts a leading '+', so a
    // value like " 64" would parse clean. Neither is a byte count anyone meant
    // to write, and guessing at one is how a wrong limit gets in.
    if (*clampValue != '-' && (*clampValue < '0' || *clampValue > '9')) {
        return refuse("expected a base-10 integer with no other characters");
    }
    char* end = nullptr;
    errno = 0;
    const long long parsed = std::strtoll(clampValue, &end, 10);
    if (errno == ERANGE) return refuse("the value does not fit in a byte count");
    if (errno != 0 || end == clampValue || *end != '\0') {
        return refuse("expected a base-10 integer with no other characters");
    }
    if (parsed <= 0) return refuse("a datagram limit must be greater than zero");
    const size_t clamp = static_cast<size_t>(parsed);
    *out = clamp < capacity ? clamp : capacity;
    return true;
}

// What a datagram write is, before anything is copied or queued. An unusable
// session outranks the size check: a caller whose session has gone must not be
// told to send a smaller datagram.
int classifyDatagramSend(bool sessionUsable, size_t capacity, size_t length) {
    if (!sessionUsable) return kDatagramInvalidSession;
    if (length > capacity) return kDatagramTooLarge;
    return kDatagramAccepted;
}

// Admits a datagram to a bounded queue, discarding the oldest waiting ones to
// make room. Returns how many were discarded — a legitimate local drop, which
// is backlog and never network packet loss. A bound of zero would discard the
// datagram being admitted, so the smallest usable queue is one.
size_t admitDatagram(std::deque<std::vector<uint8_t>>& queue, size_t limit,
                     std::vector<uint8_t> payload) {
    const size_t bound = limit == 0 ? 1 : limit;
    size_t dropped = 0;
    while (queue.size() >= bound) {
        queue.pop_front();
        dropped += 1;
    }
    queue.push_back(std::move(payload));
    return dropped;
}

// Reads at most `budget` datagrams from `recv` (quiche_conn_dgram_recv's
// contract: >0 is a datagram, anything else means nothing waiting), strips the
// session framing and hands each payload to `emit`. Returns how many reads it
// spent, which is what the budget bounds: a datagram for another session costs
// budget too, because the point is to bound work per tick and not only events.
template <typename Recv, typename Emit>
size_t drainDatagramReads(const Recv& recv, uint64_t expectedFlow, size_t budget,
                          const Emit& emit) {
    uint8_t buf[MAX_DATAGRAM_SIZE];
    size_t reads = 0;
    while (reads < budget) {
        const ssize_t len = recv(buf, sizeof(buf));
        if (len <= 0) break;
        reads += 1;
        uint64_t flowId = 0;
        const size_t consumed = varintDecode(buf, static_cast<size_t>(len), &flowId);
        if (consumed == 0 || flowId != expectedFlow) continue;  // not our session
        emit(buf + consumed, static_cast<size_t>(len) - consumed);
    }
    return reads;
}

// Spends from a budget that belongs to the whole poll tick rather than to this
// call. pumpSocket() calls the reader once per inbound UDP packet, so a budget
// that restarts on every call bounds nothing — a burst still pushes an
// unbounded number of events at JS in one turn. `used` is the caller's tick
// counter and is only ever reset at the top of a poll pass.
template <typename Recv, typename Emit>
void readDatagramsBudgeted(size_t& used, size_t limit, const Recv& recv, uint64_t expectedFlow,
                           const Emit& emit) {
    if (used >= limit) return;
    used += drainDatagramReads(recv, expectedFlow, limit - used, emit);
}

// What a drain of the outgoing queue did. `hardErrors` is a transport failure,
// never backlog: it is deliberately separate from the legitimate local-drop
// count so the two cannot be confused at the call site.
struct DatagramDrainResult {
    size_t sent = 0;
    size_t hardErrors = 0;
    ssize_t lastError = 0;
};

// Drains queued datagrams into `send` (quiche_conn_dgram_send's contract).
// QUICHE_ERR_DONE alone means "no room right now": the queue is left intact and
// the rest wait for the next frame, exactly as pumpStream does for a
// congestion-blocked stream write. Any other negative is a hard failure on this
// path — the frame is discarded, the drain stops, and the caller is told so it
// can fail the session rather than report the write as sent.
template <typename Send>
DatagramDrainResult drainDatagramQueue(std::deque<std::vector<uint8_t>>& queue, const Send& send) {
    DatagramDrainResult result;
    while (!queue.empty()) {
        const std::vector<uint8_t>& packet = queue.front();
        const ssize_t r = send(packet.data(), packet.size());
        if (r == QUICHE_ERR_DONE) break;
        if (r < 0) {
            result.hardErrors += 1;
            result.lastError = r;
            queue.pop_front();
            break;
        }
        result.sent += 1;
        queue.pop_front();
    }
    return result;
}

// ---------------------------------------------------------------------------
// Event queue: native -> JS, drained on the main thread in processEvents().
// ---------------------------------------------------------------------------

enum class EventType {
    Ready,            // code = negotiated datagram payload capacity
    Closed,           // graceful / remote close (message = reason)
    Error,            // failure before/around ready (message = reason)
    DatagramCapacity, // code = new capacity, when the path changes it
    Datagram,         // data
    IncomingUni,  // streamId
    IncomingBidi, // streamId
    StreamData,   // streamId, data, fin
    StreamReset,  // streamId, code
    StreamWriteError,  // streamId, code
    StreamWriteClosed, // streamId: all buffered bytes and FIN were sent
    Writable,      // session-wide capacity recovery; no additional payload
};

struct Event {
    uint32_t sessionId = 0;
    EventType type;
    int64_t streamId = -1;
    uint64_t code = 0;
    bool fin = false;
    std::vector<uint8_t> data;
    std::string message;
};

std::queue<Event> g_events;

// ---------------------------------------------------------------------------
// Per-stream parse state
// ---------------------------------------------------------------------------

struct StreamState {
    bool serverInitiated = false;
    bool isUni = false;
    // For server-initiated streams we must consume the WT signal frame + session
    // id before delivering payload. h3-owned streams are drained and ignored.
    bool headerConsumed = false;
    bool isH3Owned = false;   // server control/qpack stream — drain & ignore
    bool announced = false;   // IncomingUni/IncomingBidi already emitted
    bool finDelivered = false;
    bool readReleased = false;
    size_t readCredit = 0;
    size_t inFlightReadBytes = 0;
    std::vector<uint8_t> pending;  // inbound bytes awaiting header parse

    // Outbound buffering. quiche's stream_send can return Done when the
    // congestion-control window is momentarily exhausted, so writes (and the
    // initial WT signal frame) are buffered here and flushed by pumpStreamSends()
    // whenever capacity becomes available.
    bool isOutgoing = false;
    std::vector<uint8_t> outBuf;
    bool outFin = false;   // a FIN has been requested by the writer
    bool finSent = false;  // the FIN has been flushed to quiche
    bool sendError = false;
};

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

struct ResolvedPeer {
    sockaddr_storage address{};
    socklen_t length = 0;
};

struct Resolution {
    std::string host;
    int port = 0;
    unsigned delayMs = 0;
    bool useTestAddresses = false;
    uint64_t epoch = 0;
    std::atomic<bool> done{false};
    std::atomic<bool> cancelled{false};
    std::vector<ResolvedPeer> candidates;
};

void cancelResolution(const std::shared_ptr<Resolution>& job);
uint64_t g_resolverEpoch = 1;

struct Session {
    uint32_t id = 0;

    // Raw non-blocking UDP socket; polled each frame in pumpSocket(). The QUIC
    // loss/idle timers are tracked with steady_clock (no libuv timer handle).
    socket_t sock = kInvalidSocket;
    std::chrono::steady_clock::time_point timeoutAt{};
    bool hasTimeout = false;

    quiche_conn* conn = nullptr;
    quiche_h3_conn* h3 = nullptr;
    quiche_config* config = nullptr;
    quiche_h3_config* h3config = nullptr;

    struct sockaddr_storage peer{};
    socklen_t peerLen = 0;
    struct sockaddr_storage local{};
    socklen_t localLen = 0;

    std::string host;
    int port = 0;
    std::string path;
    std::shared_ptr<Resolution> resolution;
    std::vector<ResolvedPeer> candidates;
    size_t nextCandidate = 0;
    std::chrono::steady_clock::time_point connectDeadline{};
    std::chrono::steady_clock::time_point candidateDeadline{};

    bool established = false;  // QUIC handshake complete
    bool h3Created = false;
    bool wtReady = false;      // CONNECT 200 received
    bool reportedReady = false;
    bool reportedClosed = false;
    bool failed = false;
    // An unusable trust input fails every candidate identically, so candidate
    // iteration stops on it instead of repeating one diagnostic per address.
    bool trustFailed = false;
    bool wantClose = false;    // teardown requested
    uint64_t closeCode = 0;
    std::string closeReason;

    int64_t connectStreamId = -1;

    // Next client-initiated stream ids for WT data streams. h3 uses client bidi
    // 0 (the CONNECT request) and client uni 2/6/10 (control + qpack), so WT
    // streams start beyond those.
    uint64_t nextClientBidi = 4;
    uint64_t nextClientUni = 14;

    std::map<uint64_t, StreamState> streams;

    // Datagram plane. `datagramCapacity` is the negotiated payload limit last
    // reported to JS; `outgoingDatagrams` holds framed datagrams waiting for
    // quiche capacity, bounded by kDatagramQueueLimit. `droppedDatagrams`
    // counts what this host discarded locally — backlog, not packet loss.
    size_t datagramCapacity = 0;
    std::deque<std::vector<uint8_t>> outgoingDatagrams;
    uint64_t droppedDatagrams = 0;
    // Receive admissions spent in the current processEvents() pass. Reset once
    // per pass, never by the reader: pumpSocket() reads once per inbound UDP
    // packet, so a per-call budget would not bound a burst at all.
    size_t datagramReadsThisTick = 0;
    // Set when the path refused a frame outright, so the next send answers
    // kDatagramSendFailed instead of reporting a queued write as accepted.
    bool datagramSendFailed = false;
    bool writableEventQueued = false;
    size_t streamReadBytesThisTick = 0;
    size_t streamReadCallsThisTick = 0;
    uint64_t lastReadStreamId = 0;

    ~Session() {
        cancelResolution(resolution);
        if (sock != kInvalidSocket) closeSocket(sock);
        if (h3) quiche_h3_conn_free(h3);
        if (conn) quiche_conn_free(conn);
        if (h3config) quiche_h3_config_free(h3config);
        if (config) quiche_config_free(config);
    }
};

std::map<uint32_t, std::unique_ptr<Session>> g_sessions;
uint32_t g_nextSessionId = 1;

Session* findSession(uint32_t id) {
    auto it = g_sessions.find(id);
    return it == g_sessions.end() ? nullptr : it->second.get();
}

// ---------------------------------------------------------------------------
// QUIC packet I/O
// ---------------------------------------------------------------------------

// Forward declarations (definitions appear later in this file).
void readDatagrams(Session* s);
void readStreams(Session* s);
void failSession(Session* s, const std::string& message);

// Re-arm the QUIC timeout deadline based on quiche's schedule. Driven on the
// per-frame poll loop in pumpSocket(); no libuv timer involved.
void armTimeout(Session* s) {
    if (!s->conn) { s->hasTimeout = false; return; }
    uint64_t ms = quiche_conn_timeout_as_millis(s->conn);
    if (ms == UINT64_MAX) {  // quiche: no timeout currently scheduled
        s->hasTimeout = false;
        return;
    }
    s->timeoutAt = std::chrono::steady_clock::now() + std::chrono::milliseconds(ms);
    s->hasTimeout = true;
}

void flushEgress(Session* s) {
    if (!s->conn || s->sock == kInvalidSocket) return;
    static uint8_t out[MAX_DATAGRAM_SIZE];
    while (true) {
        quiche_send_info sendInfo;
        ssize_t written = quiche_conn_send(s->conn, out, sizeof(out), &sendInfo);
        if (written == QUICHE_ERR_DONE) break;
        if (written < 0) {
            std::cerr << "[WebTransport] quiche_conn_send failed: " << written << std::endl;
            break;
        }
        // Non-blocking sendto; QUIC handles loss/retransmission. EWOULDBLOCK just
        // means the OS buffer is momentarily full — quiche will resend later.
        int sent = static_cast<int>(::sendto(
            s->sock, reinterpret_cast<const char*>(out), static_cast<int>(written), 0,
            reinterpret_cast<const struct sockaddr*>(&sendInfo.to),
            static_cast<socklen_t>(sendInfo.to_len)));
        if (sent < 0) {
            // Drop on transient error; retransmission is the QUIC layer's job.
            break;
        }
    }
    armTimeout(s);
}

// Drain all datagrams currently readable on the socket, feed them to quiche, and
// (once the session is up) read out datagrams/streams immediately. Reading right
// after quiche_conn_recv matters: quiche garbage-collects a server-initiated
// stream that arrives complete (data + FIN) if it is not read promptly. Also
// fires the QUIC timeout when its deadline has passed. Runs on the main thread.
void pumpSocket(Session* s) {
    if (!s->conn || s->sock == kInvalidSocket) return;

    static thread_local std::vector<uint8_t> rbuf(65536);
    for (size_t packet = 0; packet < kSocketReadsPerTick && !s->failed && !s->wantClose; ++packet) {
        struct sockaddr_storage from{};
        socklen_t fromLen = sizeof(from);
        auto n = ::recvfrom(s->sock, reinterpret_cast<char*>(rbuf.data()),
                            static_cast<int>(rbuf.size()), 0,
                            reinterpret_cast<struct sockaddr*>(&from), &fromLen);
        if (n < 0) break;  // EWOULDBLOCK / no more data this tick (or transient error)

        quiche_recv_info recvInfo;
        recvInfo.from = reinterpret_cast<struct sockaddr*>(&from);
        recvInfo.from_len = fromLen;
        recvInfo.to = reinterpret_cast<struct sockaddr*>(&s->local);
        recvInfo.to_len = s->localLen;

        ssize_t done = quiche_conn_recv(s->conn, rbuf.data(),
                                        static_cast<size_t>(n), &recvInfo);
        if (done < 0 && done != QUICHE_ERR_DONE) {
            std::cerr << "[WebTransport] quiche_conn_recv failed: " << done << std::endl;
            continue;
        }
        if (s->wtReady) {
            readDatagrams(s);
            readStreams(s);
        }
    }

    // quiche can retain DATAGRAM frames after the socket has no new UDP packet.
    // Drain once per poll pass so that backlog makes progress on an idle socket,
    // while the session's shared per-tick read budget still caps repeated calls.
    if (s->wtReady && !s->failed && !s->wantClose) {
        readDatagrams(s);
        readStreams(s);
    }

    // Drive QUIC timers off a monotonic clock instead of a libuv timer.
    if (s->hasTimeout && std::chrono::steady_clock::now() >= s->timeoutAt) {
        quiche_conn_on_timeout(s->conn);
        flushEgress(s);
    }
}

// ---------------------------------------------------------------------------
// Address resolution
// ---------------------------------------------------------------------------

unsigned g_resolverDelayMs = 0;
constexpr size_t kResolverJobLimit = 64;
constexpr size_t kResolverCandidateLimit = 16;

bool numericPeer(const std::string& host, int port, ResolvedPeer& peer) {
    auto* ipv4 = reinterpret_cast<sockaddr_in*>(&peer.address);
    if (inet_pton(AF_INET, host.c_str(), &ipv4->sin_addr) == 1) {
        ipv4->sin_family = AF_INET;
        ipv4->sin_port = htons(static_cast<uint16_t>(port));
        peer.length = sizeof(sockaddr_in);
        return true;
    }
    auto* ipv6 = reinterpret_cast<sockaddr_in6*>(&peer.address);
    if (inet_pton(AF_INET6, host.c_str(), &ipv6->sin6_addr) == 1) {
        ipv6->sin6_family = AF_INET6;
        ipv6->sin6_port = htons(static_cast<uint16_t>(port));
        peer.length = sizeof(sockaddr_in6);
        return true;
    }
    return false;
}

std::vector<ResolvedPeer> resolveAddresses(const std::string& host, int port) {
    addrinfo hints{};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_DGRAM;
    addrinfo* addresses = nullptr;
    const std::string service = std::to_string(port);
    if (getaddrinfo(host.c_str(), service.c_str(), &hints, &addresses) != 0) return {};
    std::vector<ResolvedPeer> result;
    for (auto* item = addresses; item && result.size() < kResolverCandidateLimit;
         item = item->ai_next) {
        if ((item->ai_family != AF_INET && item->ai_family != AF_INET6) ||
            item->ai_addrlen > sizeof(sockaddr_storage)) continue;
        ResolvedPeer peer;
        std::memcpy(&peer.address, item->ai_addr, item->ai_addrlen);
        peer.length = static_cast<socklen_t>(item->ai_addrlen);
        result.push_back(peer);
    }
    if (addresses) freeaddrinfo(addresses);
    return result;
}

// Process-only fixture controls cannot redirect an ordinary game hostname. Values
// are validated and copied on the main thread before the bounded job is admitted.
bool readResolverTestOptions(Resolution& job) {
    if (job.host != "networking-test.invalid") return true;
    if (const char* delay = std::getenv("MYSTRAL_WEBTRANSPORT_TEST_DNS_DELAY_MS")) {
        const std::string value(delay);
        if (value.empty() || value.size() > 4) return false;
        unsigned milliseconds = 0;
        for (char digit : value) {
            if (digit < '0' || digit > '9') return false;
            milliseconds = milliseconds * 10 + static_cast<unsigned>(digit - '0');
        }
        if (milliseconds > 2000) return false;
        job.delayMs = milliseconds;
    }
    if (const char* addresses = std::getenv("MYSTRAL_WEBTRANSPORT_TEST_DNS_ADDRESSES")) {
        const std::string value(addresses);
        if (value.empty() || value.size() > 1024) return false;
        size_t start = 0;
        for (;;) {
            const auto end = value.find(',', start);
            ResolvedPeer peer;
            if (job.candidates.size() >= kResolverCandidateLimit ||
                !numericPeer(value.substr(start, end == std::string::npos ? end : end - start),
                             job.port, peer)) return false;
            job.candidates.push_back(peer);
            if (end == std::string::npos) break;
            start = end + 1;
        }
        job.useTestAddresses = true;
    }
    return true;
}

struct ResolverPool {
    std::mutex mutex;
    std::condition_variable ready;
    std::deque<std::shared_ptr<Resolution>> queued;
    size_t active = 0;
    size_t workers = 0;
};

std::shared_ptr<ResolverPool> resolverPool() {
    // Workers retain this heap state for the process lifetime. In particular, a
    // Runtime destructor never joins an uncancellable OS getaddrinfo operation.
    // The handle itself is immortal too: global Session destruction may still
    // cancel a job after other function-static objects have been destroyed.
    static const auto* pool = new std::shared_ptr<ResolverPool>(std::make_shared<ResolverPool>());
    return *pool;
}

void resolverWorker(const std::shared_ptr<ResolverPool>& pool) {
#ifdef _WIN32
    // Keep Winsock alive independently of any Runtime that may close mid-lookup.
    WSADATA workerWsa{};
    const bool available = WSAStartup(MAKEWORD(2, 2), &workerWsa) == 0;
#else
    const bool available = true;
#endif
    for (;;) {
        std::shared_ptr<Resolution> job;
        {
            std::unique_lock lock(pool->mutex);
            pool->ready.wait(lock, [&] { return !pool->queued.empty(); });
            job = std::move(pool->queued.front());
            pool->queued.pop_front();
            ++pool->active;
        }
        if (!job->cancelled.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(job->delayMs));
            if (!job->useTestAddresses && available && !job->cancelled.load()) {
                auto candidates = resolveAddresses(job->host, job->port);
                if (!job->cancelled.load()) job->candidates = std::move(candidates);
            }
        }
        job->done.store(true, std::memory_order_release);
        {
            std::lock_guard lock(pool->mutex);
            --pool->active;
        }
    }
}

std::shared_ptr<Resolution> startResolution(const std::string& host, int port) {
    auto job = std::make_shared<Resolution>();
    job->host = host;
    job->port = port;
    job->delayMs = g_resolverDelayMs;
    job->epoch = g_resolverEpoch;
    if (!readResolverTestOptions(*job)) return nullptr;
    auto pool = resolverPool();
    std::lock_guard lock(pool->mutex);
    if (pool->queued.size() + pool->active >= kResolverJobLimit) return nullptr;
    while (pool->workers < 2) {
        try {
            std::thread([pool] { resolverWorker(pool); }).detach();
            ++pool->workers;
        } catch (const std::system_error&) {
            if (pool->workers == 0) return nullptr;
            break;
        }
    }
    pool->queued.push_back(job);
    pool->ready.notify_one();
    return job;
}

void cancelResolution(const std::shared_ptr<Resolution>& job) {
    if (!job) return;
    job->cancelled.store(true);
    auto pool = resolverPool();
    std::lock_guard lock(pool->mutex);
    pool->queued.erase(std::remove(pool->queued.begin(), pool->queued.end(), job),
                       pool->queued.end());
}

// ---------------------------------------------------------------------------
// Handshake: HTTP/3 extended CONNECT
// ---------------------------------------------------------------------------

void sendConnectRequest(Session* s) {
    const std::string authorityHost = s->host.find(':') == std::string::npos
        ? s->host : "[" + s->host + "]";
    std::string authority = authorityHost + ":" + std::to_string(s->port);
    std::string path = s->path.empty() ? "/" : s->path;
    std::string origin = "https://" + authority;

    quiche_h3_header headers[] = {
        {(const uint8_t*)":method", 7, (const uint8_t*)"CONNECT", 7},
        {(const uint8_t*)":protocol", 9, (const uint8_t*)"webtransport", 12},
        {(const uint8_t*)":scheme", 7, (const uint8_t*)"https", 5},
        {(const uint8_t*)":authority", 10, (const uint8_t*)authority.c_str(), authority.size()},
        {(const uint8_t*)":path", 5, (const uint8_t*)path.c_str(), path.size()},
        {(const uint8_t*)"origin", 6, (const uint8_t*)origin.c_str(), origin.size()},
    };

    int64_t streamId = quiche_h3_send_request(s->h3, s->conn, headers, 6, /*fin=*/false);
    if (streamId < 0) {
        std::cerr << "[WebTransport] CONNECT send failed: " << streamId << std::endl;
        s->failed = true;
        g_events.push({s->id, EventType::Error, -1, 0, false, {}, "Failed to send CONNECT request"});
        return;
    }
    s->connectStreamId = streamId;
}

int headerCollect(uint8_t* name, size_t nameLen, uint8_t* value, size_t valueLen, void* argp) {
    auto* status = static_cast<std::string*>(argp);
    if (nameLen == 7 && std::memcmp(name, ":status", 7) == 0) {
        status->assign(reinterpret_cast<char*>(value), valueLen);
    }
    return 0;
}

void pollHandshake(Session* s) {
    if (!s->h3 || s->wtReady || s->failed) return;
    while (true) {
        quiche_h3_event* ev = nullptr;
        int64_t streamId = quiche_h3_conn_poll(s->h3, s->conn, &ev);
        if (streamId < 0) break;  // QUICHE_H3_ERR_DONE or error

        switch (quiche_h3_event_type(ev)) {
            case QUICHE_H3_EVENT_HEADERS: {
                std::string status;
                quiche_h3_event_for_each_header(ev, headerCollect, &status);
                if (streamId == s->connectStreamId) {
                    if (!status.empty() && status[0] == '2') {
                        s->wtReady = true;
                    } else {
                        s->failed = true;
                        g_events.push({s->id, EventType::Error, -1, 0, false, {},
                                       "WebTransport CONNECT rejected with status " + status});
                    }
                }
                break;
            }
            case QUICHE_H3_EVENT_FINISHED:
            case QUICHE_H3_EVENT_RESET:
                if (streamId == s->connectStreamId && !s->wtReady) {
                    s->failed = true;
                    g_events.push({s->id, EventType::Error, -1, 0, false, {},
                                   "WebTransport CONNECT stream closed before establishment"});
                }
                break;
            default:
                break;
        }
        quiche_h3_event_free(ev);
        if (s->wtReady || s->failed) break;
    }
}

// ---------------------------------------------------------------------------
// Datagram I/O (HTTP/3 datagram = quarter-stream-id varint + payload)
// ---------------------------------------------------------------------------

// Bounded across the whole poll tick, not per call: pumpSocket() calls this
// once for every inbound UDP packet. Whatever is left stays in quiche's own
// receive queue for the next tick instead of pushing an unbounded burst of
// events at the JS side in one turn; nothing is discarded here.
void readDatagrams(Session* s) {
    if (!s->conn || s->connectStreamId < 0) return;
    const uint64_t expectedFlow = static_cast<uint64_t>(s->connectStreamId) / 4;
    readDatagramsBudgeted(
        s->datagramReadsThisTick, kDatagramQueueLimit,
        [s](uint8_t* out, size_t cap) { return quiche_conn_dgram_recv(s->conn, out, cap); },
        expectedFlow,
        [s](const uint8_t* payload, size_t len) {
            Event e;
            e.sessionId = s->id;
            e.type = EventType::Datagram;
            e.data.assign(payload, payload + len);
            g_events.push(std::move(e));
        });
}

// ---------------------------------------------------------------------------
// Stream I/O
// ---------------------------------------------------------------------------

// Tries to consume the leading WT signal (frame type + session id) from a
// server-initiated stream's pending buffer. Returns true once consumed.
bool consumeStreamHeader(Session* s, uint64_t streamId, StreamState& st) {
    if (st.headerConsumed) return true;
    const uint8_t* p = st.pending.data();
    size_t avail = st.pending.size();

    uint64_t signal = 0;
    size_t n1 = varintDecode(p, avail, &signal);
    if (n1 == 0) return false;  // need more bytes

    if (st.isUni) {
        if (signal == H3_CONTROL_STREAM_TYPE || signal == H3_PUSH_STREAM_TYPE ||
            signal == H3_QPACK_ENCODER_STREAM_TYPE || signal == H3_QPACK_DECODER_STREAM_TYPE) {
            // An HTTP/3 control/qpack stream — drain and ignore from now on.
            st.isH3Owned = true;
            st.headerConsumed = true;
            st.pending.clear();
            return true;
        }
        if (signal != WT_STREAM_UNI_SIGNAL) {
            // Unknown unidirectional stream type — ignore.
            st.isH3Owned = true;
            st.headerConsumed = true;
            st.pending.clear();
            return true;
        }
    } else {
        if (signal != WT_STREAM_BIDI_SIGNAL) {
            st.isH3Owned = true;
            st.headerConsumed = true;
            st.pending.clear();
            return true;
        }
    }

    // Consume the session id varint that follows the signal.
    uint64_t sessionId = 0;
    size_t n2 = varintDecode(p + n1, avail - n1, &sessionId);
    if (n2 == 0) return false;  // need more bytes

    // This connection owns one CONNECT session. A foreign session header must
    // never lend its payload this session's receive credit or JS stream identity.
    if (!s || s->connectStreamId < 0 ||
        sessionId != static_cast<uint64_t>(s->connectStreamId)) {
        if (s) failSession(s, "WebTransport stream names a different session");
        return false;
    }

    // Strip signal + session id; remainder is payload.
    st.pending.erase(st.pending.begin(), st.pending.begin() + n1 + n2);
    st.headerConsumed = true;
    return true;
}

// Header reads stop at each varint boundary, so no payload is consumed before
// the application has a readable and has granted its measured queue capacity.
size_t streamHeaderBytesNeeded(const StreamState& st) {
    if (st.pending.empty()) return 1;
    const size_t first = size_t{1} << (st.pending[0] >> 6);
    if (st.pending.size() < first) return first - st.pending.size();
    if (st.pending.size() == first) return 1;
    const size_t second = size_t{1} << (st.pending[first] >> 6);
    return first + second - st.pending.size();
}

int streamReadCredit(uint32_t id, uint64_t streamId, size_t desiredBytes) {
    Session* s = findSession(id);
    if (!s || s->failed || s->wantClose) return -1;
    auto it = s->streams.find(streamId);
    if (it == s->streams.end() || it->second.readReleased) return -1;
    StreamState& st = it->second;
    const size_t desired = std::min(desiredBytes, kStreamReadCreditLimit);
    st.readCredit = desired > st.inFlightReadBytes ? desired - st.inFlightReadBytes : 0;
    return 0;
}

void readStream(Session* s, uint64_t streamId) {
    if (!s->conn || s->failed || s->wantClose) return;
    const bool connect = streamId == static_cast<uint64_t>(s->connectStreamId);
    auto found = s->streams.find(streamId);
    if (!connect && found == s->streams.end()) {
        if (s->streams.size() >= kStreamLimit) {
            failSession(s, "WebTransport incoming stream limit exceeded");
            return;
        }
        found = s->streams.emplace(streamId, StreamState{}).first;
        auto& st = found->second;
        st.serverInitiated = (streamId & 1) != 0;
        st.isUni = (streamId & 2) != 0;
        st.headerConsumed = !st.serverInitiated;
        st.isOutgoing = !st.isUni;
    }
    StreamState* st = connect ? nullptr : &found->second;
    if (st && (st->finDelivered || st->readReleased)) return;
    uint8_t scratch[STREAM_READ_CHUNK];
    while (!s->failed && s->streamReadCallsThisTick < kStreamReadCallsPerTick &&
           s->streamReadBytesThisTick < kStreamReadBytesPerTick) {
        if (st && !st->headerConsumed && !st->pending.empty()) {
            consumeStreamHeader(s, streamId, *st);
            if (s->failed) return;
        }
        if (st && st->headerConsumed && !st->isH3Owned &&
            st->serverInitiated && !st->announced) {
            g_events.push({s->id, st->isUni ? EventType::IncomingUni : EventType::IncomingBidi,
                           static_cast<int64_t>(streamId), 0, false, {}, ""});
            st->announced = true;
        }
        const bool header = st && !st->headerConsumed;
        const bool ignored = connect || (st && st->isH3Owned);
        size_t capacity = header ? streamHeaderBytesNeeded(*st) :
            ignored ? sizeof(scratch) : std::min(st->readCredit, sizeof(scratch));
        capacity = std::min(capacity, kStreamReadBytesPerTick - s->streamReadBytesThisTick);
        bool fin = false;
        uint64_t errorCode = 0;
        ++s->streamReadCallsThisTick;
        const ssize_t received = quiche_conn_stream_recv(s->conn, streamId, scratch,
                                                         capacity, &fin, &errorCode);
        if (received == QUICHE_ERR_DONE) return;
        if (received < 0) {
            if (connect) { failSession(s, "WebTransport CONNECT stream reset"); return; }
            if (!st->isH3Owned) {
                g_events.push({s->id, EventType::StreamReset, static_cast<int64_t>(streamId),
                               errorCode, false, {}, ""});
            }
            st->readCredit = 0;
            st->readReleased = true;
            std::vector<uint8_t>().swap(st->pending);
            return;
        }
        const size_t count = static_cast<size_t>(received);
        s->streamReadBytesThisTick += count;
        if (connect) {
            if (fin) { s->wantClose = true; return; }
        } else if (header) {
            st->pending.insert(st->pending.end(), scratch, scratch + count);
            const bool parsed = consumeStreamHeader(s, streamId, *st);
            if (s->failed) return;
            if (st->isH3Owned) st->isOutgoing = false;
            if (fin && !parsed) { failSession(s, "Truncated WebTransport stream header"); return; }
            if (parsed && !st->isH3Owned && !st->announced) {
                g_events.push({s->id, st->isUni ? EventType::IncomingUni : EventType::IncomingBidi,
                               static_cast<int64_t>(streamId), 0, false, {}, ""});
                st->announced = true;
            }
        } else if (!ignored && (count > 0 || fin)) {
            st->readCredit -= count;
            st->inFlightReadBytes += count;
            Event event{s->id, EventType::StreamData, static_cast<int64_t>(streamId),
                        0, fin, {}, ""};
            event.data.assign(scratch, scratch + count);
            g_events.push(std::move(event));
        }
        if (st && fin) {
            st->finDelivered = true;
            if (st->isH3Owned) st->readReleased = true;
            // A header-only stream still needs its empty FIN delivered to JS.
            if (header && !st->isH3Owned) {
                g_events.push({s->id, EventType::StreamData, static_cast<int64_t>(streamId),
                               0, true, {}, ""});
            }
            return;
        }
        if (received == 0) return;
    }
}

void readStreams(Session* s) {
    if (!s->conn || s->failed || s->wantClose ||
        s->streamReadCallsThisTick >= kStreamReadCallsPerTick ||
        s->streamReadBytesThisTick >= kStreamReadBytesPerTick) return;
    quiche_stream_iter* iterator = quiche_conn_readable(s->conn);
    if (!iterator) return;
    uint64_t id = 0;
    std::vector<uint64_t> ids;
    while (quiche_stream_iter_next(iterator, &id)) {
        if (ids.size() >= kStreamLimit + 1) {
            failSession(s, "WebTransport readable stream limit exceeded");
            break;
        }
        ids.push_back(id);
    }
    quiche_stream_iter_free(iterator);
    std::sort(ids.begin(), ids.end());
    const size_t first = std::upper_bound(ids.begin(), ids.end(), s->lastReadStreamId) - ids.begin();
    for (size_t offset = 0; offset < ids.size(); ++offset) {
        if (s->streamReadCallsThisTick >= kStreamReadCallsPerTick ||
            s->streamReadBytesThisTick >= kStreamReadBytesPerTick || s->failed) break;
        id = ids[(first + offset) % ids.size()];
        readStream(s, id);
        s->lastReadStreamId = id;
    }
}

// ---------------------------------------------------------------------------
// JS dispatch
// ---------------------------------------------------------------------------

js::Engine* g_engine = nullptr;
js::JSValueHandle g_dispatch{};  // protected handle to globalThis.__wtDispatch
bool g_hasDispatch = false;

void dispatchEvent(const Event& e) {
    if (!g_engine || !g_hasDispatch) return;

    const char* typeStr = "";
    switch (e.type) {
        case EventType::Ready: typeStr = "ready"; break;
        case EventType::Closed: typeStr = "closed"; break;
        case EventType::Error: typeStr = "error"; break;
        case EventType::DatagramCapacity: typeStr = "datagramCapacity"; break;
        case EventType::Datagram: typeStr = "datagram"; break;
        case EventType::IncomingUni: typeStr = "incomingUni"; break;
        case EventType::IncomingBidi: typeStr = "incomingBidi"; break;
        case EventType::StreamData: typeStr = "streamData"; break;
        case EventType::StreamReset: typeStr = "streamReset"; break;
        case EventType::StreamWriteError: typeStr = "streamWriteError"; break;
        case EventType::StreamWriteClosed: typeStr = "streamWriteClosed"; break;
        case EventType::Writable: typeStr = "writable"; break;
    }

    std::vector<js::JSValueHandle> args;
    args.push_back(g_engine->newNumber(e.sessionId));
    args.push_back(g_engine->newString(typeStr));

    switch (e.type) {
        case EventType::Ready:
        case EventType::DatagramCapacity:
            // The negotiated datagram payload capacity, in bytes.
            args.push_back(g_engine->newNumber(static_cast<double>(e.code)));
            break;
        case EventType::Datagram:
            args.push_back(g_engine->createUint8Array(e.data.data(), e.data.size()));
            break;
        case EventType::StreamData:
            args.push_back(g_engine->newNumber(static_cast<double>(e.streamId)));
            args.push_back(g_engine->createUint8Array(e.data.data(), e.data.size()));
            args.push_back(g_engine->newBoolean(e.fin));
            break;
        case EventType::IncomingUni:
        case EventType::IncomingBidi:
            args.push_back(g_engine->newNumber(static_cast<double>(e.streamId)));
            break;
        case EventType::StreamReset:
            args.push_back(g_engine->newNumber(static_cast<double>(e.streamId)));
            args.push_back(g_engine->newNumber(static_cast<double>(e.code)));
            break;
        case EventType::StreamWriteError:
            args.push_back(g_engine->newNumber(static_cast<double>(e.streamId)));
            args.push_back(g_engine->newNumber(static_cast<double>(e.code)));
            break;
        case EventType::StreamWriteClosed:
            args.push_back(g_engine->newNumber(static_cast<double>(e.streamId)));
            break;
        case EventType::Writable:
            break;
        case EventType::Error:
            args.push_back(g_engine->newString(e.message.c_str()));
            break;
        case EventType::Closed:
            args.push_back(g_engine->newString(e.message.c_str()));
            args.push_back(g_engine->newNumber(static_cast<double>(e.code)));
            break;
        default:
            break;
    }

    js::JSValueGuard receiver(*g_engine, g_engine->newUndefined());
    js::JSValueGuard result(*g_engine, g_engine->call(g_dispatch, receiver.get(), args));
    for (auto argument : args) g_engine->freeHandle(argument);
    if (g_engine->hasException()) {
        std::cerr << "[WebTransport] dispatch threw: " << g_engine->getException() << std::endl;
    }
}

// ---------------------------------------------------------------------------
// Native bridge functions (called from the JS polyfill)
// ---------------------------------------------------------------------------

// Parses an https URL into host, port, path. Returns false on malformed input.
bool parseUrl(const std::string& url, std::string& host, int& port, std::string& path) {
    const std::string scheme = "https://";
    if (url.compare(0, scheme.size(), scheme) != 0) return false;
    size_t start = scheme.size();
    size_t pathStart = url.find('/', start);
    std::string authority = (pathStart == std::string::npos)
                                ? url.substr(start)
                                : url.substr(start, pathStart - start);
    path = (pathStart == std::string::npos) ? "/" : url.substr(pathStart);
    size_t colon = authority.rfind(':');
    if (colon == std::string::npos) return false;  // WebTransport requires explicit port
    host = authority.substr(0, colon);
    if (!host.empty() && host.front() == '[') {
        if (host.size() < 3 || host.back() != ']') return false;
        host = host.substr(1, host.size() - 2);
        in6_addr literal{};
        if (inet_pton(AF_INET6, host.c_str(), &literal) != 1) return false;
    } else if (host.find(':') != std::string::npos) {
        return false;
    }
    const std::string portText = authority.substr(colon + 1);
    if (portText.empty() || portText.find_first_not_of("0123456789") != std::string::npos) return false;
    try {
        port = std::stoi(portText);
    } catch (...) {
        return false;
    }
    return host.size() > 0 && port > 0 && port < 65536;
}

// Creates a non-blocking UDP socket bound to an ephemeral local port matching the
// peer's address family, and records the local address. Returns kInvalidSocket on
// failure.
socket_t createUdpSocket(Session* s) {
    socket_t fd = ::socket(s->peer.ss_family, SOCK_DGRAM, 0);
    if (fd == kInvalidSocket) return kInvalidSocket;

    struct sockaddr_storage bindAddr{};
    socklen_t bindLen;
    if (s->peer.ss_family == AF_INET6) {
        struct sockaddr_in6 a{};
        a.sin6_family = AF_INET6;
        std::memcpy(&bindAddr, &a, sizeof(a));
        bindLen = sizeof(struct sockaddr_in6);
    } else {
        struct sockaddr_in a{};
        a.sin_family = AF_INET;
        std::memcpy(&bindAddr, &a, sizeof(a));
        bindLen = sizeof(struct sockaddr_in);
    }
    if (::bind(fd, reinterpret_cast<const struct sockaddr*>(&bindAddr), bindLen) != 0) {
        closeSocket(fd);
        return kInvalidSocket;
    }
    if (!setSocketNonBlocking(fd)) {
        closeSocket(fd);
        return kInvalidSocket;
    }

    s->localLen = sizeof(s->local);
    if (::getsockname(fd, reinterpret_cast<struct sockaddr*>(&s->local), &s->localLen) != 0) {
        closeSocket(fd);
        return kInvalidSocket;
    }
    return fd;
}

void resetCandidate(Session* s) {
    if (s->sock != kInvalidSocket) closeSocket(s->sock);
    if (s->h3) quiche_h3_conn_free(s->h3);
    if (s->conn) quiche_conn_free(s->conn);
    if (s->h3config) quiche_h3_config_free(s->h3config);
    if (s->config) quiche_config_free(s->config);
    s->sock = kInvalidSocket;
    s->h3 = nullptr;
    s->conn = nullptr;
    s->h3config = nullptr;
    s->config = nullptr;
    s->hasTimeout = false;
    s->established = false;
    s->h3Created = false;
    s->connectStreamId = -1;
}

bool openCandidate(Session* s) {
    s->sock = createUdpSocket(s);
    if (s->sock == kInvalidSocket) {
        std::cerr << "[WebTransport] failed to create UDP socket" << std::endl;
        return false;
    }

    // quiche config.
    s->config = quiche_config_new(QUICHE_PROTOCOL_VERSION);
    if (!s->config) return false;
    static const uint8_t alpn[] = "\x02h3";  // length-prefixed "h3"
    quiche_config_set_application_protos(s->config, alpn, sizeof(alpn) - 1);
    quiche_config_set_max_idle_timeout(s->config, 30000);
    quiche_config_set_max_recv_udp_payload_size(s->config, MAX_DATAGRAM_SIZE);
    quiche_config_set_max_send_udp_payload_size(s->config, MAX_DATAGRAM_SIZE);
    quiche_config_set_initial_max_data(s->config, 1024 * 1024);
    quiche_config_set_max_connection_window(s->config, 1024 * 1024);
    quiche_config_set_max_stream_window(s->config, 64 * 1024);
    quiche_config_set_initial_max_stream_data_bidi_local(s->config, 64 * 1024);
    quiche_config_set_initial_max_stream_data_bidi_remote(s->config, 64 * 1024);
    quiche_config_set_initial_max_stream_data_uni(s->config, 64 * 1024);
    quiche_config_set_initial_max_streams_bidi(s->config, kStreamLimit);
    quiche_config_set_initial_max_streams_uni(s->config, kStreamLimit);
    quiche_config_set_disable_active_migration(s->config, true);
    const char* insecurePeerVerificationValue = std::getenv(kInsecurePeerVerificationEnv);
    const bool allowInsecurePeerVerification =
        isTruthyEnvironmentValue(insecurePeerVerificationValue);
    // Status, not a fault: the secure default is the ordinary case, and a game's playtest
    // fails closed on anything the host writes to stderr. Reporting "verification is on"
    // as an error failed every scenario with noConsoleErrors on a correctly behaving host.
    // Disabling verification is still shouted about, on stderr, just below.
    std::cout << "[WebTransport] TLS peer verification mode: "
              << (allowInsecurePeerVerification ? "insecure-override" : "verify-peer")
              << " (parsed from " << kInsecurePeerVerificationEnv << "="
              << (insecurePeerVerificationValue ? insecurePeerVerificationValue : "<unset>")
              << ")" << std::endl;
    if (allowInsecurePeerVerification) {
        std::cerr << "[WebTransport] WARNING: TLS peer verification disabled by "
                  << kInsecurePeerVerificationEnv << "=1 (development only)" << std::endl;
    }
    // Certificate hashes are not implemented yet, so verification remains the secure default.
    quiche_config_verify_peer(s->config, !allowInsecurePeerVerification);
    std::string trustError;
    if (!applyPeerTrust(s->config, std::getenv(kPeerTrustFileEnv), &trustError)) {
        std::cerr << "[WebTransport] " << trustError << std::endl;
        s->trustFailed = true;
        return false;
    }
    // Disable GREASE: quiche would otherwise open an extra unidirectional stream
    // with a reserved type and then close it. That stream consumes the first WT
    // unidirectional stream id, so reusing it later fails (the id is "collected").
    quiche_config_grease(s->config, false);
    quiche_config_enable_dgram(s->config, true, 1024, 1024);
    quiche_config_set_cc_algorithm(s->config, QUICHE_CC_CUBIC);

    // h3 config with extended CONNECT + WebTransport SETTINGS.
    s->h3config = quiche_h3_config_new();
    if (!s->h3config) return false;
    quiche_h3_config_enable_extended_connect(s->h3config, true);
    const uint64_t wtSettings[] = {
        SETTINGS_WT_MAX_SESSIONS, 1,
        SETTINGS_WEBTRANSPORT_MAX_SESSIONS_DRAFT, 1,
    };
    quiche_h3_config_set_additional_settings(s->h3config, wtSettings, 2);

    // Random source connection id.
    uint8_t scid[QUICHE_MAX_CONN_ID_LEN];
    std::random_device rd;
    for (auto& b : scid) b = static_cast<uint8_t>(rd());

    s->conn = quiche_connect(
        s->host.c_str(), scid, sizeof(scid),
        reinterpret_cast<struct sockaddr*>(&s->local), s->localLen,
        reinterpret_cast<struct sockaddr*>(&s->peer), s->peerLen, s->config);
    if (!s->conn) {
        std::cerr << "[WebTransport] quiche_connect failed" << std::endl;
        return false;
    }

    flushEgress(s);  // send the initial QUIC handshake packet(s)

    return true;
}

bool tryNextCandidate(Session* s) {
    while (s->nextCandidate < s->candidates.size()) {
        const auto now = std::chrono::steady_clock::now();
        if (now >= s->connectDeadline) return false;
        resetCandidate(s);
        const size_t remaining = s->candidates.size() - s->nextCandidate;
        const auto& peer = s->candidates[s->nextCandidate++];
        s->peer = peer.address;
        s->peerLen = peer.length;
        if (!openCandidate(s)) {
            // A refused trust input is a configuration failure, not an
            // unreachable address: the next candidate would fail the same way.
            if (s->trustFailed) return false;
            continue;
        }
        auto budget = (s->connectDeadline - now) / static_cast<int64_t>(remaining);
        // Give an unreachable candidate an initial QUIC retry, then try the
        // next address. The last address retains the original remaining budget.
        if (remaining > 1 && s->hasTimeout) {
            budget = std::min(budget, 2 * (s->timeoutAt - now));
        }
        s->candidateDeadline = now + budget;
        return true;
    }
    return false;
}

// Numeric endpoints keep their immediate path; hostname resolution owns no JS
// or Session pointer and is observed only by the main-thread poll below.
uint32_t connectSession(const std::string& url) {
    std::string host, path;
    int port = 0;
    if (!parseUrl(url, host, port, path) || host.size() > 253) return 0;
    auto session = std::make_unique<Session>();
    auto* s = session.get();
    s->id = g_nextSessionId++;
    s->host = host;
    s->port = port;
    s->path = path;
    s->connectDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    ResolvedPeer numeric;
    if (g_resolverDelayMs == 0 && numericPeer(host, port, numeric)) {
        s->candidates.push_back(numeric);
        if (!tryNextCandidate(s)) return 0;
    } else {
        s->resolution = startResolution(host, port);
        if (!s->resolution) return 0;
    }
    const uint32_t id = s->id;
    g_sessions[id] = std::move(session);
    return id;
}

void closeSession(uint32_t id, uint64_t code, const std::string& reason) {
    Session* s = findSession(id);
    if (!s) return;
    if (s->conn && !quiche_conn_is_closed(s->conn)) {
        quiche_conn_close(s->conn, /*app=*/true, code,
                          reinterpret_cast<const uint8_t*>(reason.data()), reason.size());
        flushEgress(s);
    }
    s->closeCode = code;
    s->closeReason = reason;
    s->wantClose = true;
}

// Outcome of recomputing the negotiated datagram capacity. Invalid is a
// configuration error the caller turns into a session failure, so an unusable
// clamp cannot pass for a working connection.
enum class CapacityUpdate { Unchanged, Changed, Invalid };

// Recomputes the negotiated datagram capacity from quiche's current writable
// length. Reports a change so JS is told rather than left holding a stale
// `datagrams.maxDatagramSize`.
CapacityUpdate refreshDatagramCapacity(Session* s, std::string* error) {
    if (!s->conn) return CapacityUpdate::Unchanged;
    size_t capacity = 0;
    if (!clampDatagramCapacity(
            datagramPayloadCapacity(quiche_conn_dgram_max_writable_len(s->conn),
                                    s->connectStreamId),
            std::getenv(kMaxDatagramEnv), &capacity, error)) {
        return CapacityUpdate::Invalid;
    }
    if (capacity == s->datagramCapacity) return CapacityUpdate::Unchanged;
    s->datagramCapacity = capacity;
    return CapacityUpdate::Changed;
}

// Fails a session and tells JS why, through the same error/closed path a
// handshake failure takes.
void failSession(Session* s, const std::string& message) {
    if (s->failed) return;
    s->failed = true;
    g_events.push({s->id, EventType::Error, -1, 0, false, {}, message});
}

void queueWritable(Session* s) {
    if (s->writableEventQueued || s->failed || s->wantClose || s->reportedClosed) return;
    s->writableEventQueued = true;
    g_events.push({s->id, EventType::Writable, -1, 0, false, {}, ""});
}

void releaseDrainedBuffer(StreamState& st) {
    if (st.outBuf.empty()) {
        std::vector<uint8_t>().swap(st.outBuf);
        return;
    }
    if (st.outBuf.size() < st.outBuf.capacity() / 2) {
        std::vector<uint8_t> compacted(st.outBuf.begin(), st.outBuf.end());
        st.outBuf.swap(compacted);
    }
}

size_t queuedStreamBytes(const Session* s) {
    size_t total = 0;
    for (const auto& [streamId, st] : s->streams) {
        (void)streamId;
        if (total > kStreamWriteQueueLimit ||
            st.outBuf.size() > kStreamWriteQueueLimit - total) {
            return kStreamWriteQueueLimit;
        }
        total += st.outBuf.size();
    }
    return total;
}

// Drains queued datagrams into quiche. Done means the send queue is momentarily
// full and the rest wait for the next frame; any other error is a transport
// failure that fails the session rather than being filed as backlog.
void pumpDatagramSends(Session* s) {
    if (!s->conn) return;
    const DatagramDrainResult r = drainDatagramQueue(
        s->outgoingDatagrams, [s](const uint8_t* p, size_t n) {
            return quiche_conn_dgram_send(s->conn, p, n);
        });
    if (r.hardErrors == 0) return;
    // Not backlog: the path refused the frame. droppedDatagrams is deliberately
    // untouched — labelling this a local drop is what made a broken connection
    // look like normal unreliable delivery.
    s->datagramSendFailed = true;
    failSession(s, "Datagram send failed: quiche error " + std::to_string(r.lastError));
}

// __wtSendDatagram(id, bytes) -> one of the kDatagram* statuses. The caller
// needs to tell a closed session from a payload that cannot fit from a local
// queue drop, so each answers with its own value; a single -1 for "something
// went wrong" is what the JS side used to have to ignore.
int sendDatagram(uint32_t id, const uint8_t* data, size_t len) {
    Session* s = findSession(id);
    const bool usable = s != nullptr && s->conn != nullptr && s->wtReady && !s->failed &&
                        s->connectStreamId >= 0 && !quiche_conn_is_closed(s->conn);
    const int status = classifyDatagramSend(usable, usable ? s->datagramCapacity : 0, len);
    if (status != kDatagramAccepted) return status;

    std::vector<uint8_t> packet;
    varintEncode(packet, static_cast<uint64_t>(s->connectStreamId) / 4);
    packet.insert(packet.end(), data, data + len);
    const size_t dropped =
        admitDatagram(s->outgoingDatagrams, kDatagramQueueLimit, std::move(packet));
    s->droppedDatagrams += dropped;

    pumpDatagramSends(s);
    flushEgress(s);
    // A hard failure during that drain outranks everything: the path refused a
    // frame, so this write must not be reported as sent.
    if (s->datagramSendFailed) return kDatagramSendFailed;
    // The write was admitted either way — unreliable delivery does not fail
    // because a backlog was trimmed — but the caller is told a drop happened.
    return dropped > 0 ? kDatagramDropped : kDatagramAccepted;
}

// Attempts to flush a single stream's buffered outbound bytes to quiche. Safe to
// call repeatedly; advances the buffer by however much quiche accepts.
void pumpStream(Session* s, uint64_t streamId, StreamState& st) {
    if (!st.isOutgoing || st.sendError || st.finSent) return;
    if (st.outBuf.empty() && !st.outFin) return;

    uint64_t errCode = 0;
    // quiche only applies the FIN once the final byte is written, so it is safe
    // to pass outFin even on a partial write.
    ssize_t w = quiche_conn_stream_send(s->conn, streamId, st.outBuf.data(),
                                        st.outBuf.size(), st.outFin, &errCode);
    if (w == QUICHE_ERR_DONE) {
        return;  // no capacity right now; retry next frame
    }
    if (w < 0) {
        const bool releasedBytes = !st.outBuf.empty();
        st.sendError = true;
        std::vector<uint8_t>().swap(st.outBuf);
        st.outFin = false;
        g_events.push({s->id, EventType::StreamWriteError,
                       static_cast<int64_t>(streamId), errCode, false, {},
                       "Stream send failed: quiche error " + std::to_string(w)});
        if (releasedBytes) queueWritable(s);
        std::cerr << "[WebTransport] stream " << streamId << " send error: " << w << std::endl;
        return;
    }
    st.outBuf.erase(st.outBuf.begin(), st.outBuf.begin() + w);
    releaseDrainedBuffer(st);
    if (st.outBuf.empty() && st.outFin) {
        st.finSent = true;
        g_events.push({s->id, EventType::StreamWriteClosed,
                       static_cast<int64_t>(streamId), 0, false, {}, ""});
    }
    if (w > 0) {
        queueWritable(s);
    }
}

// Flushes every outgoing stream that still has buffered data.
void pumpStreamSends(Session* s) {
    if (!s->conn) return;
    for (auto& [streamId, st] : s->streams) {
        pumpStream(s, streamId, st);
    }
}

// __wtCreateStream(id, bidi) -> streamId or -1.
int64_t createStream(uint32_t id, bool bidi) {
    Session* s = findSession(id);
    if (!s || !s->conn || !s->wtReady || s->connectStreamId < 0 || s->failed ||
        s->wantClose || quiche_conn_is_closed(s->conn)) {
        return kStreamWriteInvalid;
    }

    std::vector<uint8_t> header;
    varintEncode(header, bidi ? WT_STREAM_BIDI_SIGNAL : WT_STREAM_UNI_SIGNAL);
    varintEncode(header, static_cast<uint64_t>(s->connectStreamId));
    const size_t queued = queuedStreamBytes(s);
    if (header.size() > kStreamWriteQueueLimit || queued > kStreamWriteQueueLimit ||
        header.size() > kStreamWriteQueueLimit - queued) {
        return kStreamWriteQueueFull;
    }

    if (s->streams.size() >= kStreamLimit) return kStreamWriteQueueFull;
    uint64_t streamId = bidi ? s->nextClientBidi : s->nextClientUni;
    if (bidi) {
        s->nextClientBidi += 4;
    } else {
        s->nextClientUni += 4;
    }

    auto& st = s->streams[streamId];
    st.isOutgoing = true;
    st.isUni = !bidi;
    st.readReleased = !bidi;
    st.serverInitiated = false;
    st.isUni = !bidi;
    st.headerConsumed = true;  // inbound (bidi echo) on our stream is pure payload

    // The WT signal frame + session id must lead the stream.
    st.outBuf = std::move(header);

    pumpStream(s, streamId, st);
    flushEgress(s);
    if (st.sendError) {
        s->streams.erase(streamId);
        // quiche has seen this stream id even though the local header failed;
        // keep the allocator advanced so a queued error cannot target a future
        // stream that accidentally reuses the id.
        return kStreamWriteInvalid;
    }
    return static_cast<int64_t>(streamId);
}

// __wtStreamWrite(id, streamId, data, fin) -> bytes accepted or a named negative status.
int64_t streamWrite(uint32_t id, uint64_t streamId, const uint8_t* data, size_t len, bool fin) {
    Session* s = findSession(id);
    if (!s || !s->conn || !s->wtReady || s->failed || s->wantClose ||
        s->connectStreamId < 0 || quiche_conn_is_closed(s->conn)) {
        return kStreamWriteInvalid;
    }
    auto it = s->streams.find(streamId);
    if (it == s->streams.end() || !it->second.isOutgoing) return kStreamWriteInvalid;
    StreamState& st = it->second;
    if (st.sendError || st.outFin || st.finSent) return kStreamWriteInvalid;
    if (len > 0 && data == nullptr) return kStreamWriteInvalid;
    if (len > kStreamWriteQueueLimit) return kStreamWriteTooLarge;

    const size_t queued = queuedStreamBytes(s);
    if (queued > kStreamWriteQueueLimit || len > kStreamWriteQueueLimit - queued) {
        return kStreamWriteQueueFull;
    }

    if (len > 0) st.outBuf.insert(st.outBuf.end(), data, data + len);
    if (fin) st.outFin = true;

    pumpStream(s, streamId, st);
    flushEgress(s);
    if (st.sendError) return kStreamWriteInvalid;
    return static_cast<int64_t>(len);
}

void streamShutdown(uint32_t id, uint64_t streamId, uint64_t code,
                    enum quiche_shutdown direction = QUICHE_SHUTDOWN_WRITE) {
    Session* s = findSession(id);
    if (!s || !s->conn) return;
    auto it = s->streams.find(streamId);
    if (it == s->streams.end()) return;
    auto& st = it->second;
    if (direction == QUICHE_SHUTDOWN_READ) {
        st.readReleased = true;
        st.readCredit = 0;
        std::vector<uint8_t>().swap(st.pending);
    } else {
        const bool releasedBytes = !st.outBuf.empty();
        st.sendError = true;
        st.outFin = false;
        std::vector<uint8_t>().swap(st.outBuf);
        if (releasedBytes) queueWritable(s);
    }
    quiche_conn_stream_shutdown(s->conn, streamId, direction, code);
    flushEgress(s);
}

int streamReleaseRead(uint32_t id, uint64_t streamId) {
    Session* s = findSession(id);
    if (!s) return -1;
    auto it = s->streams.find(streamId);
    if (it == s->streams.end() || !it->second.finDelivered) return -1;
    it->second.readReleased = true;
    it->second.readCredit = 0;
    return 0;
}

void releaseCompletedStreams(Session* s) {
    bool released = false;
    for (auto it = s->streams.begin(); it != s->streams.end();) {
        const auto& st = it->second;
        if (st.readReleased && st.inFlightReadBytes == 0 &&
            (!st.isOutgoing || st.finSent || st.sendError)) {
            it = s->streams.erase(it);
            released = true;
        } else ++it;
    }
    if (released) queueWritable(s);
}

}  // namespace

// ---------------------------------------------------------------------------
// Per-frame driver
// ---------------------------------------------------------------------------

void processEvents() {
    // Advance each session's state machine and collect events.
    std::vector<uint32_t> toTeardown;
    for (auto& [id, sessPtr] : g_sessions) {
        Session* s = sessPtr.get();
        if (s->wantClose) {
            if (!s->reportedClosed) {
                s->reportedClosed = true;
                g_events.push({id, EventType::Closed, -1, s->closeCode, false, {}, s->closeReason});
            }
            toTeardown.push_back(id);
            continue;
        }
        const auto now = std::chrono::steady_clock::now();
        if (!s->reportedReady && now >= s->connectDeadline) {
            failSession(s, "WebTransport connection deadline expired");
        }
        if (s->resolution && !s->failed) {
            auto job = s->resolution;
            if (!job->done.load(std::memory_order_acquire)) continue;
            if (job->cancelled.load() || job->epoch != g_resolverEpoch) {
                failSession(s, "WebTransport DNS result was cancelled");
            } else {
                s->candidates = std::move(job->candidates);
                if (!tryNextCandidate(s)) failSession(s, "WebTransport DNS or endpoint connection failed");
            }
            s->resolution.reset();
        }
        if (!s->conn || s->failed) {
            if (s->failed && !s->reportedClosed) {
                s->reportedClosed = true;
                g_events.push({id, EventType::Closed, -1, 0, false, {}, "WebTransport connection failed"});
                toTeardown.push_back(id);
            }
            continue;
        }
        if (!s->established && now >= s->candidateDeadline &&
            s->nextCandidate < s->candidates.size()) {
            if (!tryNextCandidate(s)) {
                failSession(s, "WebTransport endpoint candidates exhausted");
                continue;
            }
        }

        // One receive budget per pass over this session, spent by however many
        // pumpSocket() reads happen below. This is the only place it resets.
        s->datagramReadsThisTick = 0;
        s->streamReadBytesThisTick = 0;
        s->streamReadCallsThisTick = 0;

        // Drain inbound UDP, feed quiche, read the data plane, and fire timers.
        pumpSocket(s);
        if (!s->established && quiche_conn_is_closed(s->conn) &&
            s->nextCandidate < s->candidates.size() &&
            std::chrono::steady_clock::now() < s->connectDeadline) {
            if (!tryNextCandidate(s)) failSession(s, "WebTransport endpoint candidates exhausted");
            continue;
        }

        // QUIC handshake completion.
        if (!s->established && quiche_conn_is_established(s->conn)) {
            s->established = true;
        }
        // Create the h3 connection and send CONNECT once QUIC is up.
        if (s->established && !s->h3Created) {
            s->h3 = quiche_h3_conn_new_with_transport(s->conn, s->h3config);
            s->h3Created = true;
            if (s->h3) {
                sendConnectRequest(s);
            } else {
                s->failed = true;
                g_events.push({s->id, EventType::Error, -1, 0, false, {}, "Failed to create HTTP/3 connection"});
            }
            flushEgress(s);
        }
        // Drive the CONNECT handshake.
        if (s->h3Created && !s->wtReady && !s->failed) {
            pollHandshake(s);
            if (s->wtReady && !s->reportedReady) {
                s->reportedReady = true;
                // Detach the HTTP/3 layer now that the CONNECT handshake is done.
                // quiche routes all incoming unidirectional streams into an
                // attached h3 connection (which would drain WebTransport streams),
                // so freeing it lets server-initiated WT streams surface to the
                // transport layer where we read them directly. The underlying QUIC
                // streams (including the CONNECT/session stream) stay open.
                if (s->h3) {
                    quiche_h3_conn_free(s->h3);
                    s->h3 = nullptr;
                }
                // Ready carries the negotiated datagram capacity, so JS never
                // sees a session whose `maxDatagramSize` is a placeholder. An
                // unusable explicit clamp fails the session here instead of
                // handing back a connection whose limit is not the one asked for.
                std::string capacityError;
                if (refreshDatagramCapacity(s, &capacityError) == CapacityUpdate::Invalid) {
                    failSession(s, capacityError);
                } else {
                    g_events.push({s->id, EventType::Ready, -1,
                                   static_cast<uint64_t>(s->datagramCapacity), false, {}, ""});
                }
            }
            flushEgress(s);
        }
        // Data plane: datagram/stream READS happen in pumpSocket() (right after
        // quiche_conn_recv) so server-initiated streams are not garbage-collected
        // before we read them. Here we only retry blocked writes and flush egress.
        if (s->wtReady && !s->failed) {
            // The path's datagram capacity moves with the connection, so a
            // change is reported instead of leaving JS on the ready-time value.
            std::string capacityError;
            switch (refreshDatagramCapacity(s, &capacityError)) {
                case CapacityUpdate::Invalid:
                    failSession(s, capacityError);
                    break;
                case CapacityUpdate::Changed:
                    g_events.push({s->id, EventType::DatagramCapacity, -1,
                                   static_cast<uint64_t>(s->datagramCapacity), false, {}, ""});
                    break;
                case CapacityUpdate::Unchanged:
                    break;
            }
            pumpDatagramSends(s);  // retry datagrams quiche had no room for
            pumpStreamSends(s);    // retry any congestion-blocked writes
            flushEgress(s);
        }

        // Connection-level closure / failure detection.
        if (s->wantClose || quiche_conn_is_closed(s->conn)) {
            if (!s->reportedClosed) {
                s->reportedClosed = true;
                bool isApp = false;
                uint64_t errCode = 0;
                const uint8_t* reason = nullptr;
                size_t reasonLen = 0;
                std::string msg;
                if (quiche_conn_peer_error(s->conn, &isApp, &errCode, &reason, &reasonLen) && reason) {
                    msg.assign(reinterpret_cast<const char*>(reason), reasonLen);
                }
                g_events.push({s->id, EventType::Closed, -1, errCode, false, {}, msg});
            }
            toTeardown.push_back(id);
        } else if (s->failed) {
            // Handshake failure without a transport-level close yet.
            if (!s->reportedClosed) {
                s->reportedClosed = true;
                g_events.push({s->id, EventType::Closed, -1, 0, false, {}, "WebTransport session failed"});
            }
            if (s->conn && !quiche_conn_is_closed(s->conn)) {
                quiche_conn_close(s->conn, true, 0, nullptr, 0);
                flushEgress(s);
            }
            toTeardown.push_back(id);
        }
    }

    // Drain the event queue to JS (on the main thread).
    while (!g_events.empty()) {
        Event e = std::move(g_events.front());
        g_events.pop();
        if (e.type == EventType::StreamData) {
            Session* s = findSession(e.sessionId);
            if (s) {
                auto it = s->streams.find(static_cast<uint64_t>(e.streamId));
                if (it != s->streams.end()) {
                    auto& pending = it->second.inFlightReadBytes;
                    pending -= std::min(pending, e.data.size());
                }
            }
        }
        if (e.type == EventType::Writable) {
            Session* s = findSession(e.sessionId);
            if (s != nullptr) s->writableEventQueued = false;
        }
        dispatchEvent(e);
    }

    for (auto& [id, session] : g_sessions) releaseCompletedStreams(session.get());

    // Free finished sessions (Session dtor closes the socket and frees quiche
    // objects). Safe here: we are no longer iterating g_sessions.
    for (uint32_t id : toTeardown) {
        g_sessions.erase(id);
    }
}

bool hasActiveSessions() {
    return !g_sessions.empty();
}

unsigned activeResolutionsForTesting() {
    auto pool = resolverPool();
    std::lock_guard lock(pool->mutex);
    return static_cast<unsigned>(pool->active);
}

void setResolverDelayForTesting(unsigned milliseconds) {
    g_resolverDelayMs = milliseconds;
}

void init() {
#ifdef _WIN32
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);
#endif
    if (std::getenv("MYSTRAL_WT_QUICHE_LOG")) {
        quiche_enable_debug_logging(
            [](const char* line, void*) { std::cerr << "[quiche] " << line << std::endl; },
            nullptr);
    }
}

void shutdown() {
    ++g_resolverEpoch;
    for (auto& [id, sessPtr] : g_sessions) {
        Session* s = sessPtr.get();
        if (s->conn && !quiche_conn_is_closed(s->conn)) {
            quiche_conn_close(s->conn, true, 0, nullptr, 0);
            flushEgress(s);
        }
    }
    g_sessions.clear();  // Session dtors close sockets and free quiche objects
    if (g_hasDispatch && g_engine) {
        g_engine->freeHandle(g_dispatch);
        g_hasDispatch = false;
    }
#ifdef _WIN32
    WSACleanup();
#endif
}

// ---------------------------------------------------------------------------
// JS bindings
// ---------------------------------------------------------------------------

bool initBindings(js::Engine* engine) {
    g_engine = engine;

    engine->setGlobalProperty("__wtConnect",
        engine->newFunction("__wtConnect", [](void* ctx, const std::vector<js::JSValueHandle>& args) {
            if (args.empty()) return g_engine->newNumber(0);
            std::string url = g_engine->toString(args[0]);
            uint32_t id = connectSession(url);
            return g_engine->newNumber(id);
        }));

    engine->setGlobalProperty("__wtClose",
        engine->newFunction("__wtClose", [](void* ctx, const std::vector<js::JSValueHandle>& args) {
            if (args.size() >= 1) {
                uint32_t id = static_cast<uint32_t>(g_engine->toNumber(args[0]));
                uint64_t code = args.size() >= 2 ? static_cast<uint64_t>(g_engine->toNumber(args[1])) : 0;
                std::string reason = args.size() >= 3 ? g_engine->toString(args[2]) : "";
                closeSession(id, code, reason);
            }
            return g_engine->newUndefined();
        }));

    engine->setGlobalProperty("__wtSendDatagram",
        engine->newFunction("__wtSendDatagram", [](void* ctx, const std::vector<js::JSValueHandle>& args) {
            if (args.size() < 2) return g_engine->newNumber(-1);
            uint32_t id = static_cast<uint32_t>(g_engine->toNumber(args[0]));
            size_t length = 0;
            auto* bytes = static_cast<const uint8_t*>(g_engine->getArrayBufferData(args[1], &length));
            if (length > 0 && !bytes) return g_engine->newNumber(kDatagramInvalidSession);
            int r = sendDatagram(id, bytes, length);
            return g_engine->newNumber(r);
        }));

    engine->setGlobalProperty("__wtCreateStream",
        engine->newFunction("__wtCreateStream", [](void* ctx, const std::vector<js::JSValueHandle>& args) {
            if (args.size() < 2) return g_engine->newNumber(-1);
            uint32_t id = static_cast<uint32_t>(g_engine->toNumber(args[0]));
            bool bidi = g_engine->toBoolean(args[1]);
            int64_t sid = createStream(id, bidi);
            return g_engine->newNumber(static_cast<double>(sid));
        }));

    engine->setGlobalProperty("__wtStreamWrite",
        engine->newFunction("__wtStreamWrite", [](void* ctx, const std::vector<js::JSValueHandle>& args) {
            if (args.size() < 4) return g_engine->newNumber(-1);
            uint32_t id = static_cast<uint32_t>(g_engine->toNumber(args[0]));
            uint64_t sid = static_cast<uint64_t>(g_engine->toNumber(args[1]));
            size_t byteLength = 0;
            void* borrowedData = g_engine->getArrayBufferData(args[2], &byteLength);
            if (byteLength > 0 && borrowedData == nullptr) {
                return g_engine->newNumber(static_cast<double>(kStreamWriteInvalid));
            }
            bool fin = g_engine->toBoolean(args[3]);
            int64_t w = streamWrite(id, sid, static_cast<const uint8_t*>(borrowedData),
                                    byteLength, fin);
            return g_engine->newNumber(static_cast<double>(w));
        }));

    engine->setGlobalProperty("__wtNativeStats",
        engine->newFunction("__wtNativeStats", [](void*, const std::vector<js::JSValueHandle>&) {
            size_t streams = 0, queuedBytes = 0, queuedDatagrams = 0;
            size_t inFlight = 0, credit = 0, headers = 0;
            for (const auto& [id, session] : g_sessions) {
                streams += session->streams.size();
                queuedDatagrams += session->outgoingDatagrams.size();
                for (const auto& [streamId, stream] : session->streams) {
                    queuedBytes += stream.outBuf.size();
                    inFlight += stream.inFlightReadBytes;
                    credit += stream.readCredit;
                    headers += stream.pending.size();
                }
            }
            auto result = g_engine->newObject();
            for (const auto& field : std::initializer_list<std::pair<const char*, size_t>>{
                    {"sessions", g_sessions.size()}, {"streams", streams},
                    {"queuedReliableBytes", queuedBytes}, {"queuedDatagrams", queuedDatagrams},
                    {"queuedEvents", g_events.size()}, {"inFlightReceiveBytes", inFlight},
                    {"readCreditBytes", credit}, {"pendingHeaderBytes", headers}}) {
                js::JSValueGuard value(*g_engine, g_engine->newNumber(static_cast<double>(field.second)));
                g_engine->setProperty(result, field.first, value.get());
            }
            return result;
        }));

    engine->setGlobalProperty("__wtStreamReadCredit",
        engine->newFunction("__wtStreamReadCredit", [](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() < 3) return g_engine->newNumber(-1);
            const double desired = g_engine->toNumber(args[2]);
            if (!std::isfinite(desired) || desired < 0 || std::floor(desired) != desired)
                return g_engine->newNumber(-1);
            const int status = streamReadCredit(static_cast<uint32_t>(g_engine->toNumber(args[0])),
                static_cast<uint64_t>(g_engine->toNumber(args[1])),
                static_cast<size_t>(std::min(desired, static_cast<double>(kStreamReadCreditLimit))));
            return g_engine->newNumber(status);
        }));

    engine->setGlobalProperty("__wtStreamReleaseRead",
        engine->newFunction("__wtStreamReleaseRead", [](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() < 2) return g_engine->newNumber(-1);
            return g_engine->newNumber(streamReleaseRead(
                static_cast<uint32_t>(g_engine->toNumber(args[0])),
                static_cast<uint64_t>(g_engine->toNumber(args[1]))));
        }));

    engine->setGlobalProperty("__wtStreamShutdown",
        engine->newFunction("__wtStreamShutdown", [](void* ctx, const std::vector<js::JSValueHandle>& args) {
            if (args.size() >= 2) {
                uint32_t id = static_cast<uint32_t>(g_engine->toNumber(args[0]));
                uint64_t sid = static_cast<uint64_t>(g_engine->toNumber(args[1]));
                uint64_t code = args.size() >= 3 ? static_cast<uint64_t>(g_engine->toNumber(args[2])) : 0;
                const double direction = args.size() >= 4 ? g_engine->toNumber(args[3]) : 1;
                if (direction != 0 && direction != 1) return g_engine->newNumber(-1);
                streamShutdown(id, sid, code, direction == 0 ? QUICHE_SHUTDOWN_READ : QUICHE_SHUTDOWN_WRITE);
            }
            return g_engine->newUndefined();
        }));

    // Register the JS dispatcher target. The embedded polyfill defines
    // globalThis.__wtDispatch; we freeze it after eval.
    const auto script = runtime_scripts::require(runtime_scripts::Script::webtransport_polyfill);
    if (!engine->eval(std::string(script.data, script.size).c_str(), "webtransport-polyfill.js")) {
        std::cerr << "[WebTransport] polyfill eval failed: " << engine->getException() << std::endl;
        return false;
    }

    g_dispatch = engine->getGlobalProperty("__wtDispatch");
    if (engine->isFunction(g_dispatch)) {
        engine->freezeHandle(g_dispatch);
        g_hasDispatch = true;
    } else {
        std::cerr << "[WebTransport] __wtDispatch not defined by polyfill" << std::endl;
        return false;
    }
    return true;
}

}  // namespace webtransport
}  // namespace mystral

#else  // !MYSTRAL_HAS_QUICHE

// ---------------------------------------------------------------------------
// Stub: WebTransport unavailable (quiche not compiled in).
// ---------------------------------------------------------------------------

#include "mystral/js/engine.h"
#include "runtime_scripts.h"

namespace mystral {
namespace webtransport {

void init() {}
void setResolverDelayForTesting(unsigned) {}
unsigned activeResolutionsForTesting() { return 0; }
void shutdown() {}
void processEvents() {}
bool hasActiveSessions() { return false; }

bool initBindings(js::Engine* engine) {
    // Provide a WebTransport that always rejects so feature-detecting code can
    // handle the absence gracefully.
    const auto script = runtime_scripts::require(runtime_scripts::Script::webtransport_stub);
    const std::string source(script.data, script.size);
    return engine->eval(source.c_str(), "webtransport-stub.js");
}

}  // namespace webtransport
}  // namespace mystral

#endif
