#pragma once

#include <memory>
#if defined(__EMSCRIPTEN__) || !defined(__APPLE__)
#include <memory_resource>
#include <mutex>
#endif
#include <type_traits>
#include <utility>

namespace tn::engine { class Mesh; }

namespace tn::binding::detail {

#if defined(__EMSCRIPTEN__) || !defined(__APPLE__)
// Native Apple builds do not use the pool and need no dependency on newer system PMR symbols.
// Keep allocator identity alive through VM/static teardown; return chunks at the last pooled
// allocation. allocate_shared blocks include weak owners. Object destruction runs outside the lock.
class SharedObjectPool final : public std::pmr::memory_resource {
  public:
    explicit SharedObjectPool(std::pmr::memory_resource* upstream = std::pmr::get_default_resource())
        : pool_({}, upstream) {}

  private:
    void* do_allocate(std::size_t bytes, std::size_t alignment) override {
        const std::lock_guard lock(mutex_);
        try {
            void* result = pool_.allocate(bytes, alignment);
            ++live_;
            return result;
        } catch (...) {
            if (live_ == 0)
                pool_.release();
            throw;
        }
    }
    void do_deallocate(void* pointer, std::size_t bytes, std::size_t alignment) override {
        const std::lock_guard lock(mutex_);
        pool_.deallocate(pointer, bytes, alignment);
        if (--live_ == 0)
            pool_.release();
    }
    bool do_is_equal(const std::pmr::memory_resource& other) const noexcept override { return this == &other; }

    std::mutex mutex_;
    std::pmr::synchronized_pool_resource pool_;
    std::size_t live_ = 0;
};

template <class T> std::pmr::memory_resource* sharedObjectPool() {
    static auto* resource = new SharedObjectPool(std::pmr::new_delete_resource());
    return resource;
}
#endif

template <class T, class... Args> std::shared_ptr<T> makeShared(Args&&... args) {
#if defined(__EMSCRIPTEN__)
    // Wasm's general heap interleaves these hot objects with ABI bookkeeping. Pool by type.
    std::pmr::polymorphic_allocator<T> allocator(sharedObjectPool<T>());
    if constexpr (std::is_same_v<T, tn::engine::Mesh>) {
        // A Wasm Mesh fits a 256-byte pool block; its shared control block would round it to 512.
        // Keep the control block separate, including when weak owners outlive the object.
        auto* object = allocator.template new_object<T>(std::forward<Args>(args)...);
        return std::shared_ptr<T>(object, [allocator](T* value) mutable { allocator.delete_object(value); });
    } else {
        return std::allocate_shared<T>(allocator, std::forward<Args>(args)...);
    }
#else
    return std::make_shared<T>(std::forward<Args>(args)...);
#endif
}

} // namespace tn::binding::detail
