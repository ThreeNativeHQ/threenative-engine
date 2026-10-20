#pragma once

#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <vector>

namespace tn::engine::world {

/**
 * The world's completion queue (PRD-520, §12). IO, decode and upload work finishes on worker
 * threads and posts a completion here; the game thread runs them at the frame boundary with
 * `drain`, so game code never runs on a worker. Completions run in posting order, so each source's
 * own order is kept. The core has no Promise: a language adapter maps a completion to its own
 * async form.
 *
 * Destroying the queue (`destroy`, or the destructor) drops every pending completion and refuses
 * later posts: no completion of a destroyed world ever runs, even one already taken by a drain in
 * progress when a completion destroys the world.
 */
class CompletionQueue {
  public:
    using Completion = std::function<void()>;

    /** What a worker posts through: it holds the queue weakly, so it may outlive the world. */
    class Poster {
      public:
        Poster() = default;
        /** Queues `completion` for the next drain; false, and the completion dropped, once destroyed. */
        bool post(Completion completion) const;

      private:
        friend class CompletionQueue;
        struct State;
        explicit Poster(std::weak_ptr<State> state) : state_(std::move(state)) {}
        std::weak_ptr<State> state_;
    };

    CompletionQueue();
    ~CompletionQueue();
    CompletionQueue(const CompletionQueue&) = delete;
    CompletionQueue& operator=(const CompletionQueue&) = delete;

    [[nodiscard]] Poster poster() const;

    /** Game thread, at the frame boundary: runs what was posted before this call. Returns how many ran. */
    std::size_t drain();
    /** Drops what is pending and refuses later posts. */
    void destroy();
    [[nodiscard]] bool destroyed() const;
    [[nodiscard]] std::size_t pending() const;

  private:
    std::shared_ptr<Poster::State> state_;
};

} // namespace tn::engine::world
