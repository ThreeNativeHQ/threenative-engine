#pragma once

#include <cstdint>
#include <span>
#include <string>

#include "engine/inspect/endpoint.h"

namespace tn::engine::player {

/**
 * The desktop playtest file mailbox (PRD-529 phase 2): the same three files the legacy native host
 * speaks in src/runtime.cpp, mirrored here so this player reaches the runner without a JS bridge.
 *
 *   TN_PLAYTEST_MAILBOX_ROOT/tn-playtest-request.json            one request frame; we delete it
 *   TN_PLAYTEST_MAILBOX_ROOT/tn-playtest-response.json           one response frame; the runner deletes it
 *   TN_PLAYTEST_MAILBOX_ROOT/tn-playtest-screenshot-request.txt  the destination PNG path; we delete it
 *
 * `{"id":"ready","result":null}` is published unprompted once the player can serve requests, because
 * packages/playtest waits for exactly that id before it calls anything. Every write goes through a
 * `.tmp` file plus a rename, so the reader never sees a half-written frame.
 */
class Mailbox {
  public:
    /** The configured root, or empty when the process was not launched by the runner. */
    static std::string rootFromEnvironment();

    explicit Mailbox(std::string root);

    /** Publishes the ready handshake. False when the root is unusable, which is not a playtest run. */
    bool announceReady();

    /**
     * One frame in, one frame out. Returns false when no request is waiting or the frame could not
     * be read; the caller keeps its own frame budget either way.
     */
    bool poll(inspect::Endpoint& endpoint);

    /**
     * Picks up a screenshot request: reads the destination path out of the request file and deletes
     * it, which is the pickup signal the runner watches for (desktop.ts). True while a picked-up
     * request still has no frame to answer with; a false return means nothing is waiting.
     */
    bool screenshotRequested();

    /** Answers the picked-up request with `frame` (RGBA8 rows tightly packed). False when none is. */
    bool answerScreenshot(std::span<const uint8_t> frame, uint32_t width, uint32_t height);

  private:
    std::string requestPath_;
    std::string responsePath_;
    std::string screenshotRequestPath_;
    std::string screenshotPath_;
    bool announced_ = false;
    bool answered_ = true;
    // A request whose answer is still settling (a bridge promise): asked again every poll until it answers.
    std::string deferred_;
};

}  // namespace tn::engine::player