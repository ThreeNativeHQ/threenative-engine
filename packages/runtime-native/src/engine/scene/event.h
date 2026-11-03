/**
 * three's EventDispatcher, on its own so every object three gives one gets it from here: the scene
 * graph (Object3D), the geometry and attribute resources, materials, textures and render targets.
 */
#pragma once

#include <map>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

namespace tn::engine {

/**
 * A dispatched event, three's shape: the type, the dispatcher as `target`, and `child` for the two
 * child-lifecycle events. `type` names a static string; it never owns one.
 */
class EventDispatcher;
class Object3D;
struct Event {
    std::string_view type;
    EventDispatcher* target = nullptr;
    Object3D* child = nullptr;
};

/**
 * three's EventDispatcher: one listener list per event type, and a dispatch that copies the list
 * before calling it, so a listener may remove itself while the event is being delivered. A listener
 * is a function pointer plus a context, so registering one costs no allocation.
 *
 * The target is the dispatcher itself, including attributes and scene objects.
 */
class EventDispatcher {
public:
    using Listener = void (*)(const Event& event, void* context);

    /** Adds the listener for `type`, unless that exact listener is already registered for it. */
    void addEventListener(std::string_view type, Listener listener, void* context);
    [[nodiscard]] bool hasEventListener(std::string_view type, Listener listener, void* context) const;
    void removeEventListener(std::string_view type, Listener listener, void* context);
    void dispatchEvent(Event& event);
    /** Owned by the language event bridge; dies with the dispatcher. */
    std::shared_ptr<void> languageListeners;

private:
    struct Entry {
        Listener listener;
        void* context;
    };
    // std::less<> keeps the lookup by string_view from allocating a temporary std::string.
    std::map<std::string, std::vector<Entry>, std::less<>> listeners_;
};


}  // namespace tn::engine
