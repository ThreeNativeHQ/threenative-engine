#pragma once

#include <array>
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <v8.h>

#include "threenative/abi/tn_abi.h"

namespace tn::abi {
struct ViewClaim;
}

namespace tn::adapters::v8adapter {

/** The engine value classes JS runs as three's own classes (PRD-573 v1.11 step 4a). */
enum class MathKind : uint8_t { Vector2, Vector3, Vector4, Quaternion, Euler, Matrix3, Matrix4, Color, Box3, Sphere };
constexpr std::size_t kMathKinds = 10;

/**
 * The bridge between three's math classes, run as JS, and the engine's native ones. What a native object
 * owns (an Object3D's `position`, a material's `color`) is handed to JS as a *view*: three's class over a
 * typed array on the engine's own memory (math/entry.js), held by a claim so the memory outlives the view.
 * What JS passes into a native call is copied into a pooled native stand-in for the call, and copied back
 * when the call changed it. Nothing here crosses the C ABI.
 */
class MathBridge {
public:
    /** The native stand-ins one call made for its JS math arguments; given back when it goes out of scope. */
    class Stand {
    public:
        explicit Stand(MathBridge* bridge) : bridge_(bridge) {}
        ~Stand();
        Stand(const Stand&) = delete;
        Stand& operator=(const Stand&) = delete;
        /** The JS value a stand-in handle stands for, or empty: a method that answers its argument answers the JS object. */
        v8::Local<v8::Value> jsFor(tn_handle_t handle) const;
        /** Writes each stand-in the call changed back into its JS object. */
        void copyBack();

    private:
        friend class MathBridge;
        struct Use {
            MathKind kind;
            std::size_t index;  // into the kind's pool
            v8::Local<v8::Object> js;
            std::array<double, 16> before;
        };
        MathBridge* bridge_;
        std::vector<Use> uses_;
    };

    MathBridge(v8::Isolate* isolate, tn_context_t* context);
    ~MathBridge();
    MathBridge(const MathBridge&) = delete;
    MathBridge& operator=(const MathBridge&) = delete;

    /** Runs the embedded script into `context`, defining the math classes on `target`. False with `error` set when it cannot. */
    bool install(v8::Local<v8::Context> context, v8::Local<v8::Object> target, std::string& error);

    /** The math kind a JS value is an instance of (three's own class or a view of it), or false. */
    bool kindOf(v8::Local<v8::Value> value, MathKind& kind);
    /** A stand-in for a JS math argument, as a handle value for the ABI. False when the value cannot be read. */
    bool standIn(v8::Local<v8::Value> value, Stand& stand, tn_value_t& out);

    /**
     * The JS view of a handle that names a math class (one view per object, while it lives), or empty
     * when it names anything else. The handle is dropped: a view needs the object, not the handle.
     */
    v8::MaybeLocal<v8::Value> view(tn_handle_t handle);

    /** Gives back the claims of views JS has collected. The collector may free a view on any thread, so this is the one place. */
    void drain();
    uint64_t liveViews() const { return cache_.size(); }

private:
    friend class Stand;
    struct Key {
        const void* address;
        MathKind kind;
        bool operator==(const Key& o) const { return address == o.address && kind == o.kind; }
    };
    struct KeyHash {
        std::size_t operator()(const Key& k) const { return std::hash<const void*>{}(k.address) * 31 + std::size_t(k.kind); }
    };
    struct Entry;
    struct Slot {
        tn_handle_t handle;
        std::shared_ptr<void> object;  // null once retired
        long baseline = 0;             // object.use_count() while only the pool and the context hold it
    };

    v8::Local<v8::Value> build(MathKind kind, const void* address, tn::abi::ViewClaim* claim);
    v8::Local<v8::Value> cached(MathKind kind, const void* address);
    void remember(MathKind kind, const void* address, v8::Local<v8::Value> view);
    void pair(v8::Local<v8::Value> view, int column, const void* address);
    Slot& acquire(MathKind kind, Stand& stand, v8::Local<v8::Object> js);
    bool isStandIn(tn_handle_t handle) const;
    bool fill(MathKind kind, void* object, v8::Local<v8::Object> js, std::array<double, 16>& flat);
    void flatten(MathKind kind, const void* object, std::array<double, 16>& flat) const;
    void write(MathKind kind, const std::array<double, 16>& flat, v8::Local<v8::Object> js);
    double read(v8::Local<v8::Object> object, int key);
    v8::Local<v8::String> key(int which) const;

    v8::Isolate* isolate_;
    tn_context_t* context_;
    v8::Global<v8::Context> jsContext_;
    std::array<v8::Global<v8::Function>, kMathKinds> makers_;
    v8::Global<v8::Function> link_;
    std::vector<v8::Global<v8::String>> keys_;
    std::array<int, 16> tags_{};  // JS tag -> MathKind, as the script numbers its kinds
    std::array<std::vector<Slot>, kMathKinds> pools_;
    std::array<std::size_t, kMathKinds> used_{};
    std::array<uint32_t, kMathKinds> bytes_{};
    std::array<uint16_t, kMathKinds> types_{};
    std::unordered_map<Key, Entry*, KeyHash> cache_;
    bool installed_ = false;
};

}  // namespace tn::adapters::v8adapter
