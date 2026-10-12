#include "engine/world/events/completion_queue.h"

#include <utility>

namespace tn::engine::world {

struct CompletionQueue::Poster::State {
    mutable std::mutex mutex;
    std::vector<Completion> pending;
    bool alive = true;
};

bool CompletionQueue::Poster::post(Completion completion) const {
    const std::shared_ptr<State> state = state_.lock();
    if (!state)
        return false;
    std::unique_lock lock(state->mutex);
    if (!state->alive) {
        lock.unlock();
        completion = nullptr; // what it captured is released outside the lock
        return false;
    }
    state->pending.push_back(std::move(completion));
    return true;
}

CompletionQueue::CompletionQueue() : state_(std::make_shared<Poster::State>()) {}

CompletionQueue::~CompletionQueue() { destroy(); }

CompletionQueue::Poster CompletionQueue::poster() const { return Poster(state_); }

std::size_t CompletionQueue::drain() {
    std::vector<Completion> batch;
    {
        std::lock_guard lock(state_->mutex);
        if (!state_->alive)
            return 0;
        batch.swap(state_->pending); // completions posted while this batch runs wait for the next drain
    }
    std::size_t ran = 0;
    for (Completion& completion : batch) {
        {
            std::lock_guard lock(state_->mutex);
            if (!state_->alive)
                break; // a completion destroyed the world: the rest never run
        }
        completion();
        ++ran;
    }
    return ran;
}

void CompletionQueue::destroy() {
    std::vector<Completion> dropped;
    {
        std::lock_guard lock(state_->mutex);
        state_->alive = false;
        dropped.swap(state_->pending);
    }
    // `dropped` is released here, outside the lock: a captured destructor may post or take locks.
}

bool CompletionQueue::destroyed() const {
    std::lock_guard lock(state_->mutex);
    return !state_->alive;
}

std::size_t CompletionQueue::pending() const {
    std::lock_guard lock(state_->mutex);
    return state_->pending.size();
}

} // namespace tn::engine::world
