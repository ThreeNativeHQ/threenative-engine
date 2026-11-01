#include "mystral/js/engine.h"

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>

namespace {

bool checkBridgePropertySemantics(mystral::js::Engine& engine) {
    const auto object = engine.newObject();
    const auto initialValue = engine.newNumber(41);
    if (!object.ptr || !initialValue.ptr ||
        !engine.setGlobalProperty("__tnBridgeObject", object) ||
        !engine.evalScript(R"JS((() => {
            globalThis.__tnInheritedSetterCalls = 0;
            Object.setPrototypeOf(__tnBridgeObject, {
                set bridgeValue(value) {
                    globalThis.__tnInheritedSetterCalls += 1;
                },
            });
        })())JS", "js-property-contract-setup.js") ||
        !engine.setProperty(object, "bridgeValue", initialValue)) {
        engine.freeHandle(initialValue);
        engine.freeHandle(object);
        return false;
    }

    const bool passed = engine.evalScript(R"JS((() => {
        const descriptor = Object.getOwnPropertyDescriptor(__tnBridgeObject, "bridgeValue");
        if (!descriptor || descriptor.value !== 41)
            throw new Error("bridge write did not create an own data property");
        if (!descriptor.writable || !descriptor.enumerable || !descriptor.configurable)
            throw new Error("bridge property flags differ from an ordinary assignment");
        if (__tnInheritedSetterCalls !== 0)
            throw new Error("bridge write invoked an inherited setter");
        __tnBridgeObject.bridgeValue = 42;
        if (__tnBridgeObject.bridgeValue !== 42)
            throw new Error("bridge property is not writable");
        if (!Object.keys(__tnBridgeObject).includes("bridgeValue"))
            throw new Error("bridge property is not enumerable");
        if (!delete __tnBridgeObject.bridgeValue ||
            Object.hasOwn(__tnBridgeObject, "bridgeValue"))
            throw new Error("bridge property is not configurable");
    })())JS", "js-property-contract.js");

    const auto global = engine.getGlobal();
    engine.deleteProperty(global, "__tnBridgeObject");
    engine.deleteProperty(global, "__tnInheritedSetterCalls");
    engine.freeHandle(global);
    engine.freeHandle(initialValue);
    engine.freeHandle(object);
    engine.clearFrameHandles();
    return passed;
}

bool checkGlobalPropertyAssignmentSemantics(mystral::js::Engine& engine) {
    if (!engine.evalScript(R"JS((() => {
            globalThis.__tnGlobalSetterCalls = 0;
            Object.defineProperty(globalThis, "__tnGlobalAssignmentProbe", {
                configurable: true,
                set(value) {
                    globalThis.__tnGlobalSetterCalls += value;
                },
            });
        })())JS", "global-property-assignment-contract-setup.js")) {
        return false;
    }

    const auto value = engine.newNumber(1);
    const bool written = value.ptr &&
        engine.setGlobalProperty("__tnGlobalAssignmentProbe", value);
    engine.freeHandle(value);
    const bool passed = written && engine.evalScript(R"JS((() => {
            if (__tnGlobalSetterCalls !== 1)
                throw new Error("global write did not preserve assignment semantics");
            const descriptor = Object.getOwnPropertyDescriptor(
                globalThis, "__tnGlobalAssignmentProbe");
            if (!descriptor || typeof descriptor.set !== "function" || "value" in descriptor)
                throw new Error("global write replaced the accessor with a data property");
            delete globalThis.__tnGlobalAssignmentProbe;
            delete globalThis.__tnGlobalSetterCalls;
        })())JS", "global-property-assignment-contract.js");
    engine.clearFrameHandles();
    return passed;
}

bool checkNestedNativeCallbacks(mystral::js::Engine& engine) {
    int outerCalls = 0;
    int innerCalls = 0;
    int throwingOuterCalls = 0;
    int throwingInnerCalls = 0;

    const auto inner = engine.newFunction(
        "nestedInner",
        [&engine, &innerCalls](void*, const std::vector<mystral::js::JSValueHandle>& args) {
            innerCalls += 1;
            const double value = args.empty() ? 0 : engine.toNumber(args[0]);
            return engine.newNumber(value + 1);
        });
    const auto throwingInner = engine.newFunction(
        "nestedThrowingInner",
        [&engine, &throwingInnerCalls](
            void*, const std::vector<mystral::js::JSValueHandle>&) {
            throwingInnerCalls += 1;
            engine.throwException("nested native failure");
            return mystral::js::JSValueHandle{};
        });
    const auto outer = engine.newFunction(
        "nestedOuter",
        [&engine, inner, &outerCalls](
            void*, const std::vector<mystral::js::JSValueHandle>& args) {
            outerCalls += 1;
            const auto receiver = engine.newUndefined();
            const auto result = engine.call(inner, receiver, args);
            engine.freeHandle(receiver);
            return result;
        });
    const auto throwingOuter = engine.newFunction(
        "nestedThrowingOuter",
        [&engine, throwingInner, &throwingOuterCalls](
            void*, const std::vector<mystral::js::JSValueHandle>& args) {
            throwingOuterCalls += 1;
            const auto receiver = engine.newUndefined();
            const auto result = engine.call(throwingInner, receiver, args);
            engine.freeHandle(receiver);
            return result;
        });

    if (!inner.ptr || !throwingInner.ptr || !outer.ptr || !throwingOuter.ptr ||
        !engine.setGlobalProperty("__tnNestedOuter", outer) ||
        !engine.setGlobalProperty("__tnNestedThrowingOuter", throwingOuter)) {
        return false;
    }

    const bool passed = engine.evalScript(R"JS((() => {
        if (__tnNestedOuter(41) !== 42)
            throw new Error("nested native callback lost its return value");
        let caught = false;
        try {
            __tnNestedThrowingOuter();
        } catch (error) {
            caught = String(error).includes("nested native failure");
        }
        if (!caught)
            throw new Error("nested native callback lost its exception");
        if (__tnNestedOuter(1) !== 2)
            throw new Error("caught nested exception poisoned later reentrancy");
    })())JS", "v8-nested-native-callback-contract.js");

    const auto global = engine.getGlobal();
    engine.deleteProperty(global, "__tnNestedOuter");
    engine.deleteProperty(global, "__tnNestedThrowingOuter");
    engine.freeHandle(global);
    engine.freeHandle(throwingOuter);
    engine.freeHandle(outer);
    engine.freeHandle(throwingInner);
    engine.freeHandle(inner);
    engine.clearFrameHandles();

    return passed && !engine.hasException() && outerCalls == 2 && innerCalls == 2 &&
        throwingOuterCalls == 1 && throwingInnerCalls == 1 &&
        engine.outstandingHandleCount() == 0;
}

}  // namespace

// PR #595, macOS desktop core: a worker's loop pumps microtasks between its queue check and its
// blocking wait. A wake posted in that gap was consumed by the pump, the wait then had no task,
// and terminate() joined that worker forever on the main thread. The rescue thread keeps a
// regression a failure with a message, not a hung test.
bool checkConsumedWakeReleasesWait(mystral::js::Engine& engine) {
    if (!engine.supportsBlockingTaskWait()) return true;
    std::atomic<bool> returned{false};
    std::atomic<bool> rescued{false};
    std::thread rescue([&] {
        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        while (!returned.load() && std::chrono::steady_clock::now() < deadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
        if (returned.load()) return;
        rescued.store(true);
        engine.wakeTaskWait();
    });
    engine.wakeTaskWait();
    engine.processMicrotasks();
    engine.waitForTask();
    returned.store(true);
    rescue.join();
    return !rescued.load();
}

int main() {
    struct EngineCase {
        mystral::js::EngineType type;
        const char* name;
        bool checkNestedCallbacks;
    };
    const EngineCase engineCases[] = {
        {mystral::js::EngineType::V8, "V8", true},
        {mystral::js::EngineType::QuickJS, "QuickJS", false},
        {mystral::js::EngineType::JavaScriptCore, "JavaScriptCore", false},
    };

    size_t availableEngines = 0;
    for (const auto& engineCase : engineCases) {
        auto engine = mystral::js::createEngine(engineCase.type);
        if (!engine) {
            std::cout << "SKIP: " << engineCase.name << " is not compiled in" << std::endl;
            continue;
        }
        availableEngines += 1;
        if (!checkBridgePropertySemantics(*engine)) {
            std::cerr << "js-engine-contract: " << engineCase.name
                      << " bridge property semantics failed" << std::endl;
            return EXIT_FAILURE;
        }
        if (!checkGlobalPropertyAssignmentSemantics(*engine)) {
            std::cerr << "js-engine-contract: " << engineCase.name
                      << " global property semantics failed" << std::endl;
            return EXIT_FAILURE;
        }
        if (engineCase.checkNestedCallbacks && !checkNestedNativeCallbacks(*engine)) {
            std::cerr << "js-engine-contract: " << engineCase.name
                      << " nested callback semantics failed" << std::endl;
            return EXIT_FAILURE;
        }
        if (!checkConsumedWakeReleasesWait(*engine)) {
            std::cerr << "js-engine-contract: " << engineCase.name
                      << " a wake consumed before the wait stranded the wait" << std::endl;
            return EXIT_FAILURE;
        }
        std::cout << "js-engine-contract: engine=" << engineCase.name
                  << " property=own-data global=assignment";
        if (engineCase.checkNestedCallbacks) {
            std::cout << " nested=return+exception+cleanup+reentrant";
        }
        std::cout << std::endl;
    }
    if (availableEngines == 0) {
        std::cerr << "js-engine-contract: no JavaScript engine is available" << std::endl;
        return EXIT_FAILURE;
    }
    return EXIT_SUCCESS;
}
