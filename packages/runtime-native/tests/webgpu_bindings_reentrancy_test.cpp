#include <chrono>
#include <iostream>
#include <cstdint>
#include <fstream>
#include <limits>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#include "mystral/runtime.h"
#include "mystral/webgpu/bindings.h"
#include "mystral/webgpu/registration_table.h"
#include "../src/webgpu/bindings_state.h"
#include "../src/webgpu/surface_texture_transaction.h"
#if defined(MYSTRAL_HAS_SKIA)
#include "include/core/SkGraphics.h"
#endif

namespace {

mystral::webgpu::BindingDestination atomicSecondDestination;
bool atomicProbePassed = false;
int teardownProbeCalls = 0;

mystral::js::JSValueHandle tableProbe(
    mystral::webgpu::BindingsState* state,
    mystral::webgpu::BindingDestination,
    const std::vector<mystral::js::JSValueHandle>&) {
    return state->engine->newUndefined();
}

mystral::js::JSValueHandle teardownProbe(
    mystral::webgpu::BindingsState*,
    mystral::webgpu::BindingDestination,
    const std::vector<mystral::js::JSValueHandle>&) {
    // installBindingTable's dispatch closure still captures the BindingsState. Avoid dereferencing
    // it here so the regression reports a deterministic call count instead of relying on a UAF
    // crash after Runtime has deleted that state.
    ++teardownProbeCalls;
    return {};
}

mystral::js::JSValueHandle atomicTableProbe(
    mystral::webgpu::BindingsState* state,
    mystral::webgpu::BindingDestination firstDestination,
    const std::vector<mystral::js::JSValueHandle>&) {
    auto* engine = state->engine;
    const auto mixedSurfaces = mystral::webgpu::bindingTable({
        {"TestSurface", "mixedFirst", 0, nullptr, &tableProbe, firstDestination},
        {"OtherSurface", "mixedSecond", 0, nullptr, &tableProbe, atomicSecondDestination},
    });
    if (mixedSurfaces.valid ||
        mystral::webgpu::installBindingTable(engine, state, mixedSurfaces) ||
        !engine->hasException()) {
        return engine->newUndefined();
    }
    engine->getException();
    if (!engine->isUndefined(engine->getProperty(firstDestination, "mixedFirst")) ||
        !engine->isUndefined(engine->getProperty(atomicSecondDestination, "mixedSecond"))) {
        return engine->newUndefined();
    }

    const auto invalidDestination = mystral::webgpu::bindingTable({
        {"TestSurface", "invalidFirst", 0, nullptr, &tableProbe, firstDestination},
        {"TestSurface", "invalidSecond", 0, nullptr, &tableProbe, {}},
    });
    if (invalidDestination.valid ||
        mystral::webgpu::installBindingTable(engine, state, invalidDestination) ||
        !engine->hasException()) {
        return engine->newUndefined();
    }
    engine->getException();
    atomicProbePassed =
        engine->isUndefined(engine->getProperty(firstDestination, "invalidFirst"));
    return engine->newUndefined();
}

bool checkRowOwnedAndAtomicInstall(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    struct FrameTrackingGuard {
        mystral::js::Engine* engine;
        ~FrameTrackingGuard() { engine->resumeFrameTracking(); }
    } frameTrackingGuard{engine};
    engine->suspendFrameTracking();
    const auto firstDestination = engine->newObject();
    const auto secondDestination = engine->newObject();
    if (!engine->setGlobalProperty("__tnTableFirst", firstDestination) ||
        !engine->setGlobalProperty("__tnTableSecond", secondDestination)) {
        return false;
    }
    atomicSecondDestination = secondDestination;
    atomicProbePassed = false;

    const auto separateRows = mystral::webgpu::bindingTable({
        {"TestSurface", "first", 0, nullptr, &tableProbe, firstDestination},
        {"TestSurface", "second", 0, nullptr, &tableProbe, secondDestination},
        {"TestSurface", "trigger", 0, nullptr, &atomicTableProbe, firstDestination},
    });
    if (!separateRows.valid ||
        !mystral::webgpu::installBindingTable(engine, state, separateRows)) {
        return false;
    }
    if (!runtime.evalScript(
            "if (typeof __tnTableFirst.first !== 'function' || "
            "typeof __tnTableFirst.second !== 'undefined' || "
            "typeof __tnTableSecond.second !== 'function' || "
            "typeof __tnTableSecond.first !== 'undefined' || "
            "typeof __tnTableFirst.trigger !== 'function') "
            "throw new Error('binding row destination was copied'); "
            "__tnTableFirst.trigger();",
            "webgpu-binding-row-ownership.js")) {
        return false;
    }
    return atomicProbePassed;
}

bool checkCaughtNativeExceptionDoesNotPoisonLaterInstall(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    if (engine->getType() != mystral::js::EngineType::V8) return true;

    struct HandleGuard {
        mystral::js::Engine* engine;
        std::vector<mystral::js::JSValueHandle> handles;
        ~HandleGuard() {
            for (auto it = handles.rbegin(); it != handles.rend(); ++it) engine->unprotect(*it);
        }
    } guard{engine, {}};

    const auto destination = engine->newObject();
    const auto thrower = engine->newFunction(
        "throwExpectedNativeError",
        [engine](void*, const std::vector<mystral::js::JSValueHandle>&) {
            engine->throwException("expected caught native error");
            return mystral::js::JSValueHandle{};
        });
    const auto installer = engine->newFunction(
        "installAfterCaughtNativeError",
        [engine, state, destination](void*, const std::vector<mystral::js::JSValueHandle>&) {
            const auto table = mystral::webgpu::bindingTable({
                {"TestSurface", "afterCaught", 0, nullptr, &tableProbe, destination},
            });
            const bool installed = table.valid &&
                mystral::webgpu::installBindingTable(engine, state, table);
            if (!installed) {
                if (engine->hasException()) engine->getException();
                return engine->newBoolean(false);
            }
            return engine->newBoolean(
                engine->isFunction(engine->getProperty(destination, "afterCaught")));
        });
    if (!destination.ptr || !thrower.ptr || !installer.ptr) return false;

    for (const auto handle : {destination, thrower, installer}) {
        engine->protect(handle);
        guard.handles.push_back(handle);
    }
    if (!engine->setGlobalProperty("__tnThrowExpectedNativeError", thrower) ||
        !engine->setGlobalProperty("__tnInstallAfterCaughtNativeError", installer)) {
        return false;
    }

    const bool passed = runtime.evalScript(R"JS((() => {
        try {
            __tnThrowExpectedNativeError();
        } catch (error) {
            if (String(error).includes("expected caught native error") === false)
                throw new Error("the expected native exception was not caught");
        }
        if (__tnInstallAfterCaughtNativeError() !== true)
            throw new Error("a caught native exception poisoned the next binding install");
    })())JS", "webgpu-binding-caught-exception-recovery.js");

    engine->deleteProperty(engine->getGlobal(), "__tnThrowExpectedNativeError");
    engine->deleteProperty(engine->getGlobal(), "__tnInstallAfterCaughtNativeError");
    return passed;
}

bool checkAtomicRollbackAndDestinationValidation(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    const auto failed = [](const char* message) {
        std::cerr << "atomic binding proof failed: " << message << std::endl;
        return false;
    };
    struct FrameTrackingGuard {
        mystral::js::Engine* engine;
        ~FrameTrackingGuard() { engine->resumeFrameTracking(); }
    } frameTrackingGuard{engine};
    engine->suspendFrameTracking();

    const auto objectDestination = engine->newObject();
    const auto blockedDestination = engine->newObject();
    if (!engine->setGlobalProperty("__tnAtomicObject", objectDestination) ||
        !engine->setGlobalProperty("__tnAtomicBlocked", blockedDestination) ||
        !runtime.evalScript(
            "Object.defineProperty(__tnAtomicBlocked, 'blocked', "
            "{value: 'original', writable: false, configurable: false});",
            "webgpu-binding-atomic-rollback-setup.js")) {
        return failed("setup");
    }

    const auto nonObjectDestination = engine->newNumber(7);

    if (!engine->setProperty(
            objectDestination, "existing", engine->newString("before"))) {
        return failed("initial property write");
    }

    const auto nonWritableTable = mystral::webgpu::bindingTable({
        {"TestSurface", "existing", 0, nullptr, &tableProbe, objectDestination},
        {"TestSurface", "newRow", 0, nullptr, &tableProbe, objectDestination},
        {"TestSurface", "blocked", 0, nullptr, &tableProbe, blockedDestination},
    });
    if (!nonWritableTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, nonWritableTable) ||
        !engine->hasException()) {
        return failed("non-writable install did not fail");
    }
    engine->getException();
    if (!engine->hasProperty(objectDestination, "existing") ||
        engine->toString(engine->getProperty(objectDestination, "existing")) != "before" ||
        engine->hasProperty(objectDestination, "newRow") ||
        !engine->hasProperty(blockedDestination, "blocked") ||
        engine->toString(engine->getProperty(blockedDestination, "blocked")) != "original" ||
        engine->isFunction(engine->getProperty(blockedDestination, "blocked"))) {
        return failed("non-writable rollback state");
    }

    const auto nonObjectTable = mystral::webgpu::bindingTable({
        {"TestSurface", "nonObjectEarlier", 0, nullptr, &tableProbe, objectDestination},
        {"TestSurface", "nonObjectFailure", 0, nullptr, &tableProbe, nonObjectDestination},
    });
    if (!nonObjectTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, nonObjectTable) ||
        !engine->hasException()) {
        return failed("non-object install did not fail");
    }
    engine->getException();

    const auto globalTable = mystral::webgpu::bindingTable({
        {"TestSurface", "globalEarlier", 0, nullptr, &tableProbe, objectDestination},
        {"TestSurface", "globalExotic", 0, nullptr, &tableProbe, engine->getGlobal()},
    });
    if (!globalTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, globalTable) ||
        !engine->hasException()) {
        return failed("global exotic destination did not fail");
    }
    engine->getException();
    return !engine->hasProperty(objectDestination, "nonObjectEarlier") &&
           !engine->hasProperty(objectDestination, "nonObjectFailure") &&
           !engine->hasProperty(objectDestination, "globalEarlier") &&
           !engine->hasProperty(engine->getGlobal(), "globalExotic");
}

bool verifyWholeTableTransactionBehavior(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(
        runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    const auto failed = [](const char* message) {
        std::cerr << "whole-table binding proof failed: " << message << std::endl;
        return false;
    };
    struct FrameTrackingGuard {
        mystral::js::Engine* engine;
        ~FrameTrackingGuard() { engine->resumeFrameTracking(); }
    } frameTrackingGuard{engine};
    engine->suspendFrameTracking();

    const auto first = engine->newObject();
    if (!engine->setProperty(first, "first", engine->newString("first-original")) ||
        !engine->setGlobalProperty("__tnCrossRowFirst", first)) {
        return failed("owned destination setup");
    }
    if (!runtime.evalScript(R"JS((() => {
        globalThis.__tnCrossRowSecondTarget = {};
        globalThis.__tnCrossRowSetTrapCalls = 0;
        globalThis.__tnCrossRowSecondProxy = new Proxy(__tnCrossRowSecondTarget, {
            set(target, property, value) {
                __tnCrossRowSetTrapCalls += 1;
                Reflect.set(target, property, value);
                delete __tnCrossRowFirst.first;
                return true;
            },
        });
        globalThis.__tnCrossRowDescriptorTrapCalls = 0;
        globalThis.__tnCrossRowPreflightProxy = new Proxy({}, {
            getOwnPropertyDescriptor() {
                __tnCrossRowDescriptorTrapCalls += 1;
                delete __tnCrossRowFirst.first;
                return undefined;
            },
        });

        globalThis.__tnRollbackOrderFirstTarget = { first: "rollback-first-original" };
        globalThis.__tnRollbackOrderSecondTarget = {};
        globalThis.__tnRollbackOrderFirstProxy = new Proxy(__tnRollbackOrderFirstTarget, {
            set(target, property, value) {
                Reflect.set(target, property, value);
                if (typeof value !== "function") {
                    __tnRollbackOrderSecondTarget.second = "rollback-order-corruption";
                }
                return true;
            },
        });
        globalThis.__tnRollbackOrderSecondProxy = new Proxy(__tnRollbackOrderSecondTarget, {
            set(target, property, value) {
                Reflect.set(target, property, value);
                throw new Error("controlled cross-row rollback failure");
            },
        });
    })())JS", "webgpu-binding-whole-table-setup.js")) {
        return failed("setup");
    }

    const auto second = engine->getGlobalProperty("__tnCrossRowSecondProxy");
    const auto table = mystral::webgpu::bindingTable({
        {"TestSurface", "first", 0, nullptr, &tableProbe, first},
        {"TestSurface", "second", 0, nullptr, &tableProbe, second},
    });
    if (!table.valid || mystral::webgpu::installBindingTable(engine, state, table) ||
        !engine->hasException()) {
        return failed("a later row deleted an earlier verified row without failing");
    }
    const auto crossRowMessage = engine->getException();
    if (crossRowMessage.find("ordinary") == std::string::npos) {
        return failed("proxy destination rejection did not identify the invariant");
    }
    if (!runtime.evalScript(R"JS((() => {
        const firstDescriptor = Object.getOwnPropertyDescriptor(__tnCrossRowFirst, "first");
        if (firstDescriptor === undefined || firstDescriptor.value !== "first-original") {
            throw new Error("the earlier row snapshot was not restored");
        }
        if (Object.prototype.hasOwnProperty.call(__tnCrossRowSecondTarget, "second")) {
            throw new Error("the later row survived rollback");
        }
        if (__tnCrossRowSetTrapCalls !== 0) {
            throw new Error("a rejected proxy set trap ran");
        }
    })())JS", "webgpu-binding-whole-table-check.js")) {
        return failed("whole-table rollback state");
    }

    const auto preflightProxy = engine->getGlobalProperty("__tnCrossRowPreflightProxy");
    const auto preflightTable = mystral::webgpu::bindingTable({
        {"TestSurface", "first", 0, nullptr, &tableProbe, first},
        {"TestSurface", "descriptor", 0, nullptr, &tableProbe, preflightProxy},
    });
    if (!preflightTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, preflightTable) ||
        !engine->hasException()) {
        return failed("a descriptor proxy was not rejected before preflight");
    }
    engine->getException();
    if (!runtime.evalScript(
            "if (__tnCrossRowDescriptorTrapCalls !== 0) "
            "throw new Error('a rejected proxy descriptor trap ran'); "
            "if (__tnCrossRowFirst.first !== 'first-original') "
            "throw new Error('descriptor preflight tainted an unsnapshotted row');",
            "webgpu-binding-preflight-proxy-check.js")) {
        return failed("preflight proxy rejection state");
    }

    const auto rollbackFirst = engine->getGlobalProperty("__tnRollbackOrderFirstProxy");
    const auto rollbackSecond = engine->getGlobalProperty("__tnRollbackOrderSecondProxy");
    const auto rollbackOrderTable = mystral::webgpu::bindingTable({
        {"TestSurface", "first", 0, nullptr, &tableProbe, rollbackFirst},
        {"TestSurface", "second", 0, nullptr, &tableProbe, rollbackSecond},
    });
    if (!rollbackOrderTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, rollbackOrderTable) ||
        !engine->hasException()) {
        return failed("cross-row rollback corruption was not rejected");
    }
    const auto rollbackMessage = engine->getException();
    if (rollbackMessage.find("ordinary") == std::string::npos ||
        !runtime.evalScript(R"JS((() => {
            if (__tnRollbackOrderFirstTarget.first !== "rollback-first-original") {
                throw new Error("a rejected proxy mutated its target");
            }
            if (Object.prototype.hasOwnProperty.call(__tnRollbackOrderSecondTarget, "second")) {
                throw new Error("a rejected proxy write reached its target");
            }
        })())JS", "webgpu-binding-rollback-order-check.js")) {
        return failed("proxy rollback rejection state");
    }

    const auto rollbackDestination = engine->newObject();
    const auto blockedDestination = engine->newObject();
    const auto negativeZero = engine->newNumber(-0.0);
    const auto positiveZero = engine->newNumber(0.0);
    const auto notANumber = engine->newNumber(std::numeric_limits<double>::quiet_NaN());
    if (!engine->setProperty(rollbackDestination, "negativeZero", negativeZero) ||
        !engine->setProperty(rollbackDestination, "notANumber", notANumber) ||
        !engine->setGlobalProperty("__tnRollbackDestination", rollbackDestination) ||
        !engine->setGlobalProperty("__tnRollbackBlocked", blockedDestination) ||
        !runtime.evalScript(
            "Object.preventExtensions(__tnRollbackBlocked);",
            "webgpu-binding-ordinary-rollback-setup.js")) {
        return failed("ordinary rollback setup");
    }
    const auto ordinaryRollbackTable = mystral::webgpu::bindingTable({
        {"TestSurface", "negativeZero", 0, nullptr, &tableProbe, rollbackDestination},
        {"TestSurface", "notANumber", 0, nullptr, &tableProbe, rollbackDestination},
        {"TestSurface", "blocked", 0, nullptr, &tableProbe, blockedDestination},
    });
    if (!ordinaryRollbackTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, ordinaryRollbackTable) ||
        !engine->hasException()) {
        return failed("ordinary mid-table write did not trigger rollback");
    }
    const auto ordinaryRollbackMessage = engine->getException();
    const auto restoredNegativeZero = engine->getProperty(
        rollbackDestination, "negativeZero");
    const auto restoredNaN = engine->getProperty(rollbackDestination, "notANumber");
    if (ordinaryRollbackMessage.find("binding-table rollback was incomplete") !=
            std::string::npos ||
        !engine->isSameValue(restoredNegativeZero, negativeZero) ||
        engine->isSameValue(restoredNegativeZero, positiveZero) ||
        !engine->isSameValue(restoredNaN, notANumber) ||
        engine->hasProperty(blockedDestination, "blocked")) {
        return failed("SameValue rollback verification");
    }
    return true;
}

bool checkPropertyDescriptorAndExceptionControls(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    const auto failed = [](const char* message) {
        std::cerr << "property binding proof failed: " << message << std::endl;
        return false;
    };
    struct FrameTrackingGuard {
        mystral::js::Engine* engine;
        ~FrameTrackingGuard() { engine->resumeFrameTracking(); }
    } frameTrackingGuard{engine};
    engine->suspendFrameTracking();

    if (!runtime.evalScript(R"JS((() => {
        const prototype = { inheritedData: "inherited-original" };
        globalThis.__tnInheritedRollbackTarget = Object.create(prototype);
        globalThis.__tnRollbackProxy = new Proxy({}, {
            set(target, property, value) {
                if (property === "fail") throw new Error("controlled set failure");
                return Reflect.set(target, property, value);
            },
        });
        const silentPrototype = { silent: "inherited-silent" };
        globalThis.__tnSilentProxy = new Proxy(Object.create(silentPrototype), {
            set() {
                return true;
            },
        });
        globalThis.__tnFalseSetTarget = {};
        globalThis.__tnFalseSetProxy = new Proxy(__tnFalseSetTarget, {
            set(target, property, value) {
                Reflect.set(target, property, value);
                return false;
            },
        });
        globalThis.__tnAttributeTarget = {};
        Object.defineProperty(__tnAttributeTarget, "attributes", {
            configurable: true,
            enumerable: false,
            value: "attribute-original",
            writable: true,
        });
        globalThis.__tnAttributeProxy = new Proxy(__tnAttributeTarget, {
            set(target, property, value) {
                Object.defineProperty(target, property, {
                    configurable: false,
                    enumerable: true,
                    value,
                    writable: true,
                });
                return true;
            },
        });

        globalThis.__tnPartialWriteTarget = {};
        globalThis.__tnPartialWriteProxy = new Proxy(__tnPartialWriteTarget, {
            set(target, property, value) {
                Object.defineProperty(target, property, {
                    configurable: true,
                    enumerable: true,
                    value,
                    writable: true,
                });
                throw new Error("controlled partial write failure");
            },
        });
        globalThis.__tnDishonestDeleteTarget = {};
        globalThis.__tnDishonestDeleteProxy = new Proxy(__tnDishonestDeleteTarget, {
            set(target, property, value) {
                Object.defineProperty(target, property, {
                    configurable: true,
                    enumerable: true,
                    value,
                    writable: true,
                });
                if (property === "partial") {
                    throw new Error("controlled dishonest partial write failure");
                }
                return true;
            },
            deleteProperty() {
                return true;
            },
        });
        globalThis.__tnDishonestRestoreTarget = { restore: "restore-original" };
        globalThis.__tnDishonestRestoreProxy = new Proxy(__tnDishonestRestoreTarget, {
            set(target, property, value) {
                if (typeof value === "function") {
                    target[property] = value;
                }
                return true;
            },
        });

        globalThis.__tnAccessorSetterCalls = 0;
        globalThis.__tnAccessorGetterCalls = 0;
        globalThis.__tnAccessorTarget = {};
        Object.defineProperty(__tnAccessorTarget, "ownAccessor", {
            configurable: true,
            get() {
                __tnAccessorGetterCalls += 1;
                return "accessor-value";
            },
            set() {
                __tnAccessorSetterCalls += 1;
            },
        });
        const setterPrototype = {};
        Object.defineProperty(setterPrototype, "inheritedSetter", {
            configurable: true,
            set() {
                __tnAccessorSetterCalls += 1;
            },
        });
        globalThis.__tnPrototypeTrapCalls = 0;
        globalThis.__tnInheritedSetterTarget = new Proxy({}, {
            getPrototypeOf() {
                __tnPrototypeTrapCalls += 1;
                return setterPrototype;
            },
        });
        const readonlyPrototype = {};
        Object.defineProperty(readonlyPrototype, "inheritedReadonly", {
            configurable: true,
            value: "readonly-original",
            writable: false,
        });
        globalThis.__tnInheritedReadonlyTarget = new Proxy({}, {
            getPrototypeOf() {
                __tnPrototypeTrapCalls += 1;
                return readonlyPrototype;
            },
        });
        globalThis.__tnThrowingPrototypeTarget = new Proxy({}, {
            getPrototypeOf() {
                throw new Error("controlled getPrototypeOf failure");
            },
        });
        globalThis.__tnSelfPrototypeTrapCalls = 0;
        let selfPrototypeCycle;
        selfPrototypeCycle = new Proxy({}, {
            getPrototypeOf() {
                __tnSelfPrototypeTrapCalls += 1;
                if (__tnSelfPrototypeTrapCalls > 64) {
                    throw new Error("controlled self traversal exhaustion");
                }
                return selfPrototypeCycle;
            },
        });
        globalThis.__tnSelfPrototypeCycle = selfPrototypeCycle;
        globalThis.__tnMultiPrototypeTrapCalls = 0;
        let firstPrototypeCycle;
        let secondPrototypeCycle;
        firstPrototypeCycle = new Proxy({}, {
            getPrototypeOf() {
                __tnMultiPrototypeTrapCalls += 1;
                if (__tnMultiPrototypeTrapCalls > 64) {
                    throw new Error("controlled multi traversal exhaustion");
                }
                return secondPrototypeCycle;
            },
        });
        secondPrototypeCycle = new Proxy({}, {
            getPrototypeOf() {
                __tnMultiPrototypeTrapCalls += 1;
                if (__tnMultiPrototypeTrapCalls > 64) {
                    throw new Error("controlled multi traversal exhaustion");
                }
                return firstPrototypeCycle;
            },
        });
        globalThis.__tnMultiPrototypeCycle = firstPrototypeCycle;
        globalThis.__tnAccessorEarlier = {};
        globalThis.__tnReadonlyEarlier = {};
    })())JS", "webgpu-binding-property-controls-setup.js")) {
        return failed("setup");
    }

    const auto inheritedTarget = engine->getGlobalProperty("__tnInheritedRollbackTarget");
    const auto rollbackProxy = engine->getGlobalProperty("__tnRollbackProxy");
    const auto silentProxy = engine->getGlobalProperty("__tnSilentProxy");
    const auto falseSetProxy = engine->getGlobalProperty("__tnFalseSetProxy");
    const auto attributeProxy = engine->getGlobalProperty("__tnAttributeProxy");
    const auto partialWriteProxy = engine->getGlobalProperty("__tnPartialWriteProxy");
    const auto dishonestDeleteProxy = engine->getGlobalProperty("__tnDishonestDeleteProxy");
    const auto dishonestRestoreProxy = engine->getGlobalProperty("__tnDishonestRestoreProxy");
    const auto accessorTarget = engine->getGlobalProperty("__tnAccessorTarget");
    const auto inheritedSetterTarget = engine->getGlobalProperty("__tnInheritedSetterTarget");
    const auto inheritedReadonlyTarget =
        engine->getGlobalProperty("__tnInheritedReadonlyTarget");
    const auto throwingPrototypeTarget =
        engine->getGlobalProperty("__tnThrowingPrototypeTarget");
    const auto selfPrototypeCycle = engine->getGlobalProperty("__tnSelfPrototypeCycle");
    const auto multiPrototypeCycle = engine->getGlobalProperty("__tnMultiPrototypeCycle");
    const auto accessorEarlier = engine->getGlobalProperty("__tnAccessorEarlier");
    const auto readonlyEarlier = engine->getGlobalProperty("__tnReadonlyEarlier");

    const auto rollbackTable = mystral::webgpu::bindingTable({
        {"TestSurface", "inheritedData", 0, nullptr, &tableProbe, inheritedTarget},
        {"TestSurface", "fail", 0, nullptr, &tableProbe, rollbackProxy},
    });
    if (!rollbackTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, rollbackTable) ||
        !engine->hasException()) {
        return failed("inherited-data rollback did not fail closed");
    }
    engine->getException();
    if (!runtime.evalScript(
            "if (Object.prototype.hasOwnProperty.call(__tnInheritedRollbackTarget, 'inheritedData')) "
            "throw new Error('inherited data became an own property after rollback'); "
            "if (__tnInheritedRollbackTarget.inheritedData !== 'inherited-original') "
            "throw new Error('inherited data lookup changed after rollback');",
            "webgpu-binding-inherited-rollback-check.js")) {
        return failed("inherited-data rollback state");
    }

    const auto silentTable = mystral::webgpu::bindingTable({
        {"TestSurface", "silent", 0, nullptr, &tableProbe, silentProxy},
    });
    if (!silentTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, silentTable) ||
        !engine->hasException()) {
        return failed("silent proxy setter was accepted without an own binding");
    }
    engine->getException();
    if (!runtime.evalScript(
            "if (Object.prototype.hasOwnProperty.call(__tnSilentProxy, 'silent')) "
            "throw new Error('silent proxy acquired an own binding'); "
            "if (__tnSilentProxy.silent !== 'inherited-silent') "
            "throw new Error('silent proxy inherited lookup changed');",
            "webgpu-binding-silent-setter-check.js")) {
        return failed("silent proxy rollback state");
    }

    const auto falseSetTable = mystral::webgpu::bindingTable({
        {"TestSurface", "falseWrite", 0, nullptr, &tableProbe, falseSetProxy},
    });
    if (!falseSetTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, falseSetTable) ||
        !engine->hasException()) {
        return failed("false-returning mutating proxy setter was accepted");
    }
    engine->getException();
    if (!runtime.evalScript(
            "if (Object.prototype.hasOwnProperty.call(__tnFalseSetTarget, 'falseWrite')) "
            "throw new Error('false-returning proxy mutation survived rollback');",
            "webgpu-binding-false-set-check.js")) {
        return failed("false-returning proxy rollback state");
    }

    const auto attributeTable = mystral::webgpu::bindingTable({
        {"TestSurface", "attributes", 0, nullptr, &tableProbe, attributeProxy},
    });
    if (!attributeTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, attributeTable) ||
        !engine->hasException()) {
        return failed("attribute-corrupting proxy setter was accepted");
    }
    engine->getException();
    if (!runtime.evalScript(R"JS((() => {
            const descriptor = Object.getOwnPropertyDescriptor(
                __tnAttributeTarget, "attributes");
            if (descriptor.value !== "attribute-original" || descriptor.enumerable !== false ||
                descriptor.configurable !== true || descriptor.writable !== true) {
                throw new Error("a rejected attribute proxy mutated its target");
            }
        })())JS", "webgpu-binding-attribute-corruption-check.js")) {
        return failed("attribute proxy rejection state");
    }

    const auto partialWriteTable = mystral::webgpu::bindingTable({
        {"TestSurface", "partial", 0, nullptr, &tableProbe, partialWriteProxy},
    });
    if (!partialWriteTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, partialWriteTable) ||
        !engine->hasException()) {
        return failed("partial proxy write did not fail closed");
    }
    engine->getException();
    if (!runtime.evalScript(
            "if (Object.prototype.hasOwnProperty.call(__tnPartialWriteTarget, 'partial')) "
            "throw new Error('partial proxy write survived rollback');",
            "webgpu-binding-partial-write-check.js")) {
        return failed("partial proxy write rollback state");
    }

    const auto dishonestDeleteTable = mystral::webgpu::bindingTable({
        {"TestSurface", "partial", 0, nullptr, &tableProbe, dishonestDeleteProxy},
    });
    if (!dishonestDeleteTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, dishonestDeleteTable) ||
        !engine->hasException()) {
        return failed("dishonest delete proxy did not fail closed");
    }
    engine->getException();
    if (!runtime.evalScript(
            "if (Object.prototype.hasOwnProperty.call(__tnDishonestDeleteTarget, 'partial')) "
            "throw new Error('a rejected dishonest delete proxy mutated its target');",
            "webgpu-binding-dishonest-delete-check.js")) {
        return failed("dishonest delete proxy rejection state");
    }

    const auto dishonestRestoreTable = mystral::webgpu::bindingTable({
        {"TestSurface", "restore", 0, nullptr, &tableProbe, dishonestRestoreProxy},
        {"TestSurface", "fail", 0, nullptr, &tableProbe, rollbackProxy},
    });
    if (!dishonestRestoreTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, dishonestRestoreTable) ||
        !engine->hasException()) {
        return failed("dishonest restore proxy did not fail closed");
    }
    engine->getException();
    if (!runtime.evalScript(
            "if (__tnDishonestRestoreTarget.restore !== 'restore-original') "
            "throw new Error('a rejected dishonest restore proxy mutated its target');",
            "webgpu-binding-dishonest-restore-check.js")) {
        return failed("dishonest restore proxy rejection state");
    }

    const auto accessorTable = mystral::webgpu::bindingTable({
        {"TestSurface", "earlier", 0, nullptr, &tableProbe, accessorEarlier},
        {"TestSurface", "ownAccessor", 0, nullptr, &tableProbe, accessorTarget},
        {"TestSurface", "inheritedSetter", 0, nullptr, &tableProbe, inheritedSetterTarget},
    });
    if (!accessorTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, accessorTable) ||
        !engine->hasException()) {
        return failed("accessor preflight did not fail closed");
    }
    engine->getException();
    if (!runtime.evalScript(R"JS((() => {
        const own = Object.getOwnPropertyDescriptor(__tnAccessorTarget, "ownAccessor");
        const inherited = Object.getOwnPropertyDescriptor(
            Object.getPrototypeOf(__tnInheritedSetterTarget), "inheritedSetter");
        if (own === undefined || typeof own.get !== "function" || typeof own.set !== "function") {
            throw new Error("own accessor descriptor changed");
        }
        if (inherited === undefined || typeof inherited.set !== "function") {
            throw new Error("inherited setter descriptor changed");
        }
        if (__tnAccessorSetterCalls !== 0 || __tnAccessorGetterCalls !== 0) {
            throw new Error("accessor getter or setter ran during preflight");
        }
        if (Object.prototype.hasOwnProperty.call(__tnAccessorEarlier, "earlier")) {
            throw new Error("an earlier row survived accessor rejection");
        }
        __tnPrototypeTrapCalls = 0;
    })())JS", "webgpu-binding-accessor-check.js")) {
        return failed("accessor rollback state");
    }

    const auto inheritedAccessorTable = mystral::webgpu::bindingTable({
        {"TestSurface", "earlier", 0, nullptr, &tableProbe, accessorEarlier},
        {"TestSurface", "inheritedSetter", 0, nullptr, &tableProbe, inheritedSetterTarget},
    });
    if (!inheritedAccessorTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, inheritedAccessorTable) ||
        !engine->hasException()) {
        return failed("proxied inherited accessor preflight did not fail closed");
    }
    engine->getException();

    const auto inheritedReadonlyTable = mystral::webgpu::bindingTable({
        {"TestSurface", "earlier", 0, nullptr, &tableProbe, readonlyEarlier},
        {"TestSurface", "inheritedReadonly", 0, nullptr, &tableProbe, inheritedReadonlyTarget},
    });
    if (!inheritedReadonlyTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, inheritedReadonlyTable) ||
        !engine->hasException()) {
        return failed("proxied inherited non-writable preflight did not fail closed");
    }
    engine->getException();
    if (!runtime.evalScript(
            "if (__tnPrototypeTrapCalls !== 0) "
            "throw new Error('a rejected proxy prototype trap ran'); "
            "if (Object.prototype.hasOwnProperty.call(__tnAccessorEarlier, 'earlier') || "
            "Object.prototype.hasOwnProperty.call(__tnReadonlyEarlier, 'earlier')) "
            "throw new Error('proxied prototype preflight wrote an earlier row');",
            "webgpu-binding-prototype-trap-check.js")) {
        return failed("proxied prototype preflight state");
    }

    const auto throwingPrototypeTable = mystral::webgpu::bindingTable({
        {"TestSurface", "missing", 0, nullptr, &tableProbe, throwingPrototypeTarget},
    });
    if (!throwingPrototypeTable.valid ||
        mystral::webgpu::installBindingTable(engine, state, throwingPrototypeTable) ||
        !engine->hasException()) {
        return failed("throwing getPrototypeOf trap was not latched");
    }
    if (engine->getException().find("ordinary") == std::string::npos) {
        return failed("throwing proxy was not rejected as a destination");
    }

    const auto expectPrototypeCycleFailure = [&](const char* label,
                                                 mystral::js::JSValueHandle destination) {
        const auto table = mystral::webgpu::bindingTable({
            {"TestSurface", "missing", 0, nullptr, &tableProbe, destination},
        });
        if (!table.valid || mystral::webgpu::installBindingTable(engine, state, table) ||
            !engine->hasException()) {
            return failed(label);
        }
        const auto message = engine->getException();
        if (message.find("ordinary") == std::string::npos) {
            return failed(label);
        }
        return true;
    };
    if (!expectPrototypeCycleFailure(
            "self prototype cycle was not detected", selfPrototypeCycle) ||
        !expectPrototypeCycleFailure(
            "multi-proxy prototype cycle was not detected", multiPrototypeCycle) ||
        !runtime.evalScript(
            "if (__tnSelfPrototypeTrapCalls !== 0 || __tnMultiPrototypeTrapCalls !== 0) "
            "throw new Error('a rejected prototype-cycle trap ran');",
            "webgpu-binding-prototype-cycle-check.js")) {
        return failed("prototype cycle controls");
    }

    if (!runtime.evalScript(
            "const __tnRevoked = Proxy.revocable({}, {}); "
            "globalThis.__tnRevokedProperty = __tnRevoked.proxy; "
            "__tnRevoked.revoke();",
            "webgpu-binding-exception-controls-setup.js")) {
        return failed("exception-control setup");
    }
    const auto revoked = engine->getGlobalProperty("__tnRevokedProperty");
    const auto getResult = engine->getProperty(revoked, "missing");
    if ((getResult.ptr != nullptr && !engine->isUndefined(getResult)) ||
        !engine->hasException()) {
        return failed("getProperty did not return safely and latch a revoked-proxy exception");
    }
    const auto getMessage = engine->getException();
    if (getMessage.empty()) return failed("getProperty exception was empty");
    if (engine->hasProperty(revoked, "missing") || !engine->hasException()) {
        return failed("hasProperty did not latch a revoked-proxy exception");
    }
    const auto hasMessage = engine->getException();
    if (hasMessage.empty()) return failed("hasProperty exception was empty");
    if (engine->deleteProperty(revoked, "missing") || !engine->hasException()) {
        return failed("deleteProperty did not latch a revoked-proxy exception");
    }
    const auto deleteMessage = engine->getException();
    if (deleteMessage.empty()) return failed("deleteProperty exception was empty");
    if (engine->setProperty(revoked, "missing", engine->newNumber(1)) ||
        !engine->hasException()) {
        return failed("setProperty did not latch a revoked-proxy exception");
    }
    engine->gc();
    engine->gc();
    return !engine->getException().empty();
}

bool queueQuickJSTeardownProbe(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(
        runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    if (engine->getType() != mystral::js::EngineType::QuickJS) return true;

    const auto destination = engine->newObject();
    engine->freezeHandle(destination);
    if (!engine->setGlobalProperty("__tnTeardownDestination", destination) ||
        !runtime.evalScript(R"JS(Object.defineProperty(
            __tnTeardownDestination,
            'queuedTrigger',
            {configurable: true, set(value) {
                Promise.resolve().then(() => value());
            }}
        );)JS", "webgpu-binding-teardown-queue-setup.js")) {
        engine->freeHandle(destination);
        return false;
    }
    const auto table = mystral::webgpu::bindingTable({
        {"TestSurface", "queuedAtTeardown", 0, nullptr, &teardownProbe, destination},
    });
    teardownProbeCalls = 0;
    if (!table.valid || !mystral::webgpu::installBindingTable(engine, state, table)) {
        engine->freeHandle(destination);
        return false;
    }
    const auto callback = engine->getProperty(destination, "queuedAtTeardown");
    engine->freezeHandle(callback);
    const bool queued = engine->setProperty(destination, "queuedTrigger", callback);
    engine->freeHandle(callback);
    engine->freeHandle(destination);
    return queued && teardownProbeCalls == 0;
}

bool checkQuickJSExceptionReplacement(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(
        runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    if (engine->getType() != mystral::js::EngineType::QuickJS) return true;

    if (engine->evalWithResult(
            "const =",
            "quickjs-first-unconsumed.js").ptr != nullptr ||
        !engine->hasException()) {
        std::cerr << "QuickJS did not retain the first exception" << std::endl;
        return false;
    }
    if (engine->evalScriptWithResult(
            "throw new Error('quickjs-second-unconsumed')",
            "quickjs-second-unconsumed.js").ptr != nullptr ||
        !engine->hasException()) {
        std::cerr << "QuickJS did not replace the first exception" << std::endl;
        return false;
    }
    const auto secondMessage = engine->getException();
    if (secondMessage.find("quickjs-second-unconsumed") == std::string::npos) {
        std::cerr << "QuickJS returned the wrong replacement exception" << std::endl;
        return false;
    }

    const auto thrower = engine->evalScriptWithResult(
        "(() => { throw new Error('quickjs-call-unconsumed'); })",
        "quickjs-call-unconsumed-setup.js");
    if (!thrower.ptr) return false;
    engine->freezeHandle(thrower);
    engine->throwException("quickjs-prior-unconsumed");
    const auto callResult = engine->call(thrower, {}, {});
    engine->freeHandle(thrower);
    if (callResult.ptr != nullptr || !engine->hasException() ||
        engine->getException().find("quickjs-call-unconsumed") == std::string::npos) {
        std::cerr << "QuickJS call did not replace an unconsumed exception" << std::endl;
        return false;
    }
    return true;
}

bool leaveQuickJSOutstandingException(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(
        runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    if (engine->getType() != mystral::js::EngineType::QuickJS) return true;

    if (engine->evalWithResult(
            "const =",
            "quickjs-outstanding-at-teardown.js").ptr != nullptr ||
        !engine->hasException()) {
        std::cerr << "QuickJS teardown exception was not left outstanding" << std::endl;
        return false;
    }
    return true;
}

bool checkDynamicCanvasOwnership(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime.getWebGPUBindingsState());
    const size_t protectedBefore = state->registries.protectedHandles.size();
    const size_t nativeContextsBefore = state->canvas2D.canvas2DContexts.size();
    if (!runtime.evalScript(R"JS((() => {
        const first = document.createElement("canvas");
        const second = document.createElement("canvas");
        first.id = "dynamic-first";
        second.id = "dynamic-second";
        const firstContext = first.getContext("2d");
        const secondContext = second.getContext("2d");
        if (!firstContext || !secondContext || firstContext === secondContext) {
            throw new Error("dynamic canvases did not get distinct native contexts");
        }

        // Both the public DOM id and the exposed native-id diagnostic are mutable. The binding
        // must retain the native id captured when each row was installed.
        first.id = second.id;
        first._offscreenCanvasId = second._offscreenCanvasId;
        const firstAfterMutation = first.getContext("2d");
        const secondAfterMutation = second.getContext("2d");
        if (firstAfterMutation !== firstContext || secondAfterMutation !== secondContext ||
            firstAfterMutation === secondAfterMutation) {
            throw new Error("dynamic canvas getContext followed a mutable public id");
        }
    })())JS", "webgpu-binding-dynamic-canvas.js")) {
        return false;
    }
    if (state->registries.protectedHandles.size() != protectedBefore + 4) {
        std::cerr << "binding protection proof failed: each dynamic canvas and context must be "
                     "state-owned exactly once"
                  << std::endl;
        return false;
    }
    if (state->canvas2D.canvas2DContexts.size() != nativeContextsBefore + 2) {
        std::cerr << "binding protection proof failed: native Canvas2D contexts were not "
                     "state-owned"
                  << std::endl;
        return false;
    }
    return true;
}

bool checkBindingProtectionOwnership(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime.getWebGPUBindingsState());
    if (state->registries.protectedHandles.size() < 4) {
        std::cerr << "binding protection proof failed: dynamic handles were not state-owned"
                  << std::endl;
        return false;
    }
    return true;
}

bool checkDynamicInstallUnwind(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    const size_t buffersBefore = state->registries.bufferRegistry.size();
    const size_t texturesBefore = state->registries.textureRegistry.size();
    const uint64_t bufferBytesBefore = state->profiling.bufferBytesLive;
    const uint64_t textureBytesBefore = state->profiling.textureBytesLive;
    const uint64_t bufferCountBefore = state->profiling.bufferCountLive;
    const uint64_t textureCountBefore = state->profiling.textureCountLive;
    const uint64_t textureBytesCreatedBefore = state->profiling.textureBytesCreated;
    const uint64_t nextBufferIdBefore = state->registries.nextBufferId;
    const uint64_t nextTextureIdBefore = state->registries.nextTextureId;
    const size_t computePipelinesBefore = state->registries.computePipelineRegistry.size();
    const uint64_t nextComputePipelineIdBefore = state->registries.nextComputePipelineId;
    const size_t renderPipelinesBefore = state->registries.renderPipelineRegistry.size();
    const uint64_t nextRenderPipelineIdBefore = state->registries.nextRenderPipelineId;
    const size_t blendStatesBefore = state->registries.blendStates.size();
    const size_t commandEncodersBefore = state->registries.commandEncoderRegistry.size();
    const auto currentCommandEncoderBefore = state->registries.jsCommandEncoder;
    const size_t renderPassesBefore = state->registries.encoderRenderPassMap.size();
    const size_t computePassesBefore = state->registries.encoderComputePassMap.size();
    const auto currentComputePassBefore = state->registries.jsComputePass;
    const bool frameRecorderActive = state->profiling.frameOpStreamDrain.ptr != nullptr;
    if (!runtime.evalScript(R"JS((() => {
        globalThis.__tnDynamicInstallDevice = navigator.gpu.requestAdapter().requestDevice();
        globalThis.__tnDynamicInstallWorkingEncoder =
            __tnDynamicInstallDevice.createCommandEncoder();
        globalThis.__tnDynamicInstallShader = __tnDynamicInstallDevice.createShaderModule({
            code: "@compute @workgroup_size(1) fn main() {}",
        });
        globalThis.__tnDynamicInstallBuffer = undefined;
        globalThis.__tnDynamicInstallTexture = undefined;
        globalThis.__tnDynamicInstallPipeline = undefined;
        globalThis.__tnDynamicInstallRenderPipeline = undefined;
        globalThis.__tnDynamicInstallPass = undefined;
        globalThis.__tnDynamicInstallEncoder = undefined;
        globalThis.__tnDynamicInstallBufferGetterCalls = 0;
        globalThis.__tnDynamicInstallTextureGetterCalls = 0;
        globalThis.__tnDynamicInstallBuffer = __tnDynamicInstallDevice.createBuffer({
            size: 4,
            usage: 8,
            get mappedAtCreation() {
                __tnDynamicInstallBufferGetterCalls += 1;
                throw new Error("dynamic buffer getter failure");
            },
        });
        globalThis.__tnDynamicInstallTexture = __tnDynamicInstallDevice.createTexture({
            size: [1, 1, 1],
            format: "rgba8unorm",
            usage: 16,
            get mipLevelCount() {
                __tnDynamicInstallTextureGetterCalls += 1;
                throw new Error("dynamic texture getter failure");
            },
        });
        globalThis.__tnDynamicInstallPipeline = __tnDynamicInstallDevice.createComputePipeline({
            layout: "auto",
            compute: {module: __tnDynamicInstallShader, entryPoint: "main"},
        });
        globalThis.__tnDynamicInstallRenderShader = __tnDynamicInstallDevice.createShaderModule({
            code: "@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {\n"
                + "  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));\n"
                + "  return vec4f(p[i], 0.0, 1.0);\n"
                + "}\n"
                + "@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }",
        });
        globalThis.__tnDynamicInstallRenderPipeline = __tnDynamicInstallDevice.createRenderPipeline({
            layout: "auto",
            vertex: {module: __tnDynamicInstallRenderShader, entryPoint: "vs_main"},
            fragment: {
                module: __tnDynamicInstallRenderShader,
                entryPoint: "fs_main",
                targets: [{
                    format: navigator.gpu.getPreferredCanvasFormat(),
                    blend: {
                        color: {srcFactor: "one", dstFactor: "zero", operation: "add"},
                        alpha: {srcFactor: "one", dstFactor: "zero", operation: "add"},
                    },
                }],
            },
            get multisample() {
                throw new Error("dynamic render pipeline getter failure");
            },
        });
        globalThis.__tnDynamicInstallPass = __tnDynamicInstallWorkingEncoder.beginComputePass();
        globalThis.__tnDynamicInstallEncoder = __tnDynamicInstallDevice.createCommandEncoder();
    })())JS", "webgpu-binding-dynamic-install-unwind.js")) {
        return false;
    }
    if (!engine->hasException()) {
        std::cerr << "dynamic install unwind lost the getter exception" << std::endl;
        return false;
    }
    const std::string exception = engine->getException();
    if (exception.find("dynamic") == std::string::npos) {
        std::cerr << "dynamic install unwind retained the wrong exception: " << exception
                  << std::endl;
        return false;
    }
    if (state->registries.bufferRegistry.size() != buffersBefore ||
        state->registries.textureRegistry.size() != texturesBefore ||
        state->profiling.bufferBytesLive != bufferBytesBefore ||
        state->profiling.textureBytesLive != textureBytesBefore ||
        state->profiling.bufferCountLive != bufferCountBefore ||
        state->profiling.textureCountLive != textureCountBefore ||
        state->profiling.textureBytesCreated != textureBytesCreatedBefore ||
        state->registries.nextBufferId != nextBufferIdBefore ||
        state->registries.nextTextureId != nextTextureIdBefore ||
        state->registries.computePipelineRegistry.size() != computePipelinesBefore ||
        state->registries.nextComputePipelineId != nextComputePipelineIdBefore ||
        state->registries.renderPipelineRegistry.size() != renderPipelinesBefore ||
        state->registries.nextRenderPipelineId != nextRenderPipelineIdBefore ||
        state->registries.blendStates.size() != blendStatesBefore ||
        state->registries.commandEncoderRegistry.size() != commandEncodersBefore + (frameRecorderActive ? 0 : 1) ||
        state->registries.encoderRenderPassMap.size() != renderPassesBefore ||
        state->registries.encoderComputePassMap.size() != computePassesBefore ||
        state->registries.jsComputePass != currentComputePassBefore ||
        !runtime.evalScript((std::string("if (__tnDynamicInstallBuffer !== undefined || "
                                         "__tnDynamicInstallTexture !== undefined || "
                                         "__tnDynamicInstallPipeline !== undefined || "
                                         "__tnDynamicInstallRenderPipeline !== undefined || "
                                         "__tnDynamicInstallBufferGetterCalls !== 1 || "
                                         "__tnDynamicInstallTextureGetterCalls !== 1 || ") +
                             (frameRecorderActive ? "typeof __tnDynamicInstallPass !== 'object' || "
                                                    "typeof __tnDynamicInstallEncoder !== 'object' || "
                                                  : "__tnDynamicInstallPass !== undefined || "
                                                    "__tnDynamicInstallEncoder !== undefined || ") +
                             "typeof __tnDynamicInstallWorkingEncoder.finish !== 'function') "
                             "throw new Error('dynamic install did not fail closed'); " +
                             (frameRecorderActive ? "__tnDynamicInstallPass.end(); " : "") +
                             "__tnDynamicInstallWorkingEncoder.finish(); " +
                             (frameRecorderActive ? "__tnDynamicInstallEncoder.finish();" : ""))
                                .c_str(),
                            "webgpu-binding-dynamic-install-unwind-check.js")) {
        std::cerr << "dynamic install unwind retained native state" << std::endl;
        return false;
    }
    if (state->registries.commandEncoderRegistry.size() != commandEncodersBefore ||
        state->registries.jsCommandEncoder != currentCommandEncoderBefore ||
        state->registries.encoderRenderPassMap.size() != renderPassesBefore ||
        state->registries.encoderComputePassMap.size() != computePassesBefore) {
        std::cerr << "dynamic install encoder unwind retained native state" << std::endl;
        return false;
    }
    if (!runtime.evalScript(R"JS((() => {
        globalThis.__tnDynamicOlderEncoder = __tnDynamicInstallDevice.createCommandEncoder();
        globalThis.__tnDynamicNewerEncoder = __tnDynamicInstallDevice.createCommandEncoder();
        globalThis.__tnDynamicOlderBuffer = __tnDynamicOlderEncoder.finish();
        if (!__tnDynamicOlderBuffer || typeof __tnDynamicOlderBuffer !== "object") {
            throw new Error("an older command encoder was not independently finished");
        }
    })())JS", "webgpu-binding-multiple-encoder-finish.js")) {
        std::cerr << "dynamic install encoder control did not finish the older encoder" << std::endl;
        return false;
    }
    if (state->registries.commandEncoderRegistry.size() != commandEncodersBefore + (frameRecorderActive ? 0 : 1) ||
        (frameRecorderActive ? state->registries.jsCommandEncoder != currentCommandEncoderBefore
                             : state->registries.jsCommandEncoder == currentCommandEncoderBefore)) {
        std::cerr << "dynamic install encoder control retained the wrong current encoder" << std::endl;
        return false;
    }
    if (!runtime.evalScript(
            "__tnDynamicNewerEncoder.finish();",
            "webgpu-binding-multiple-encoder-cleanup.js")) {
        return false;
    }
    if (state->registries.commandEncoderRegistry.size() != commandEncodersBefore ||
        state->registries.jsCommandEncoder != currentCommandEncoderBefore) {
        std::cerr << "dynamic install encoder control retained a finished encoder" << std::endl;
        return false;
    }
    return true;
}

bool verifyActiveWrapperRollbackBehavior(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(
        runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    const auto failed = [](const char* message) {
        std::cerr << "wrapper rollback proof failed: " << message << std::endl;
        return false;
    };

    if (!runtime.evalScript(R"JS((() => {
        const adapter = navigator.gpu.requestAdapter();
        const device = adapter.requestDevice();
        globalThis.__tnRollbackDevice = device;
        globalThis.__tnRollbackComputeEncoder = device.createCommandEncoder();
        globalThis.__tnRollbackComputePass = __tnRollbackComputeEncoder.beginComputePass();
        globalThis.__tnRollbackRenderEncoder = device.createCommandEncoder();
        globalThis.__tnRollbackTexture = device.createTexture({
            size: [1, 1, 1],
            format: navigator.gpu.getPreferredCanvasFormat(),
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        globalThis.__tnRollbackView = __tnRollbackTexture.createView();
        globalThis.__tnRollbackRenderPass = __tnRollbackRenderEncoder.beginRenderPass({
            colorAttachments: [{
                view: __tnRollbackView,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: {r: 0, g: 0, b: 0, a: 1},
            }],
        });
        globalThis.__tnRollbackRenderFailureEncoder = device.createCommandEncoder();
        globalThis.__tnRollbackComputeFailureEncoder = device.createCommandEncoder();
    })())JS", "webgpu-binding-wrapper-rollback-setup.js")) {
        return failed("active multi-encoder setup");
    }

    const auto computePassBefore = state->registries.jsComputePass;
    const auto renderPassBefore = state->registries.jsRenderPass;
    const auto commandEncoderBefore = state->registries.jsCommandEncoder;
    const auto computeMapBefore = state->registries.encoderComputePassMap;
    const auto renderMapBefore = state->registries.encoderRenderPassMap;
    const auto encoderRegistryBefore = state->registries.commandEncoderRegistry;
    const auto surfaceEncoderBefore = state->presentation.surfaceRenderEncoder;
    const auto surfaceEndedBefore = state->presentation.surfaceRenderPassEnded;

    const auto forceWrapperFailure = [&](const char* script, const char* filename,
                                         const char* marker) {
        engine->throwException("forced wrapper install failure");
        (void)runtime.evalScript(script, filename);
        if (!runtime.evalScript(
                (std::string("if (!") + marker + ") throw new Error('wrapper call did not run');")
                    .c_str(),
                "webgpu-binding-wrapper-rollback-marker.js")) {
            return false;
        }
        if (!engine->hasException()) return false;
        const std::string exception = engine->getException();
        return exception.find("forced wrapper install failure") != std::string::npos;
    };

    if (!forceWrapperFailure("globalThis.__tnRollbackComputeCall = true; "
                             "globalThis.__tnRollbackFailedCompute = "
                             "__tnRollbackComputeFailureEncoder.beginComputePass();",
                             "webgpu-binding-wrapper-rollback-compute.js", "__tnRollbackComputeCall") ||
        state->registries.jsComputePass != computePassBefore ||
        state->registries.encoderComputePassMap != computeMapBefore ||
        state->registries.jsCommandEncoder != commandEncoderBefore ||
        state->registries.jsRenderPass != renderPassBefore ||
        state->registries.encoderRenderPassMap != renderMapBefore) {
        return failed("compute pass pointer or map state was not restored");
    }

    if (!forceWrapperFailure("globalThis.__tnRollbackRenderCall = true; "
                             "globalThis.__tnRollbackFailedRender = "
                             "__tnRollbackRenderFailureEncoder.beginRenderPass({colorAttachments: [{"
                             "view: __tnRollbackView, loadOp: 'clear', storeOp: 'store', "
                             "clearValue: {r: 0, g: 0, b: 0, a: 1}}]});",
                             "webgpu-binding-wrapper-rollback-render.js", "__tnRollbackRenderCall") ||
        state->registries.jsRenderPass != renderPassBefore ||
        state->registries.encoderRenderPassMap != renderMapBefore ||
        state->registries.jsCommandEncoder != commandEncoderBefore ||
        state->registries.jsComputePass != computePassBefore ||
        state->registries.encoderComputePassMap != computeMapBefore ||
        state->presentation.surfaceRenderEncoder != surfaceEncoderBefore ||
        state->presentation.surfaceRenderPassEnded != surfaceEndedBefore) {
        return failed("render pass pointer, map, or surface state was not restored");
    }

    const auto cleanup = [&]() {
        return runtime.evalScript(R"JS((() => {
            __tnRollbackComputePass.end();
            __tnRollbackRenderPass.end();
            __tnRollbackComputeEncoder.finish();
            __tnRollbackRenderEncoder.finish();
            __tnRollbackComputeFailureEncoder.finish();
            __tnRollbackRenderFailureEncoder.finish();
            __tnRollbackTexture.destroy();
        })())JS", "webgpu-binding-wrapper-rollback-cleanup.js");
    };

    // The production frame recorder replaces createCommandEncoder on the device. Its encoder and
    // pass objects are JS records, so they must leave the legacy native registry untouched. Keep
    // the native rollback proof below for engines without the recorder capability.
    if (state->profiling.frameOpStreamDrain.ptr) {
        if (state->registries.commandEncoderRegistry != encoderRegistryBefore ||
            state->registries.jsCommandEncoder != commandEncoderBefore ||
            state->registries.jsComputePass != computePassBefore ||
            state->registries.encoderComputePassMap != computeMapBefore ||
            state->registries.jsRenderPass != renderPassBefore ||
            state->registries.encoderRenderPassMap != renderMapBefore) {
            return failed("frame recorder mutated legacy native encoder state");
        }
        return cleanup() || failed("frame recorder control cleanup");
    }

    if (state->registries.commandEncoderRegistry.size() < 2) {
        return failed("multi-encoder control did not create enough encoders");
    }
    const auto firstRegistryEncoder = *state->registries.commandEncoderRegistry.begin();
    for (const auto encoder : state->registries.commandEncoderRegistry) {
        if (encoder != firstRegistryEncoder) {
            state->registries.jsCommandEncoder = encoder;
            break;
        }
    }
    const auto selectedCommandEncoderBefore = state->registries.jsCommandEncoder;
    if (!forceWrapperFailure("globalThis.__tnRollbackEncoderCall = true; "
                             "globalThis.__tnRollbackFailedEncoder = __tnRollbackDevice.createCommandEncoder();",
                             "webgpu-binding-wrapper-rollback-encoder.js", "__tnRollbackEncoderCall") ||
        state->registries.jsCommandEncoder != selectedCommandEncoderBefore ||
        state->registries.commandEncoderRegistry != encoderRegistryBefore ||
        state->registries.jsComputePass != computePassBefore ||
        state->registries.encoderComputePassMap != computeMapBefore ||
        state->registries.jsRenderPass != renderPassBefore ||
        state->registries.encoderRenderPassMap != renderMapBefore) {
        return failed("command encoder or pass state was not restored");
    }

    if (!cleanup()) {
        return failed("control cleanup");
    }
    return true;
}

bool checkQuickJSCallbackResultOwnership(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(
        runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    if (engine->getType() != mystral::js::EngineType::QuickJS) return true;

    const auto host = engine->newObject();
    engine->freezeHandle(host);
    mystral::js::JSValueHandle protectedResult;
    int unprotectedCalls = 0;
    int protectedCalls = 0;
    const auto unprotectedCallback = engine->newFunction(
        "unprotectedResult",
        [engine, &unprotectedCalls](
            void*, const std::vector<mystral::js::JSValueHandle>&) {
            ++unprotectedCalls;
            return engine->newString("unprotected-result");
        });
    const auto protectedCallback = engine->newFunction(
        "protectedResult",
        [engine, &protectedResult, &protectedCalls](
            void*, const std::vector<mystral::js::JSValueHandle>&) {
            ++protectedCalls;
            protectedResult = engine->newString("protected-result");
            engine->freezeHandle(protectedResult);
            return protectedResult;
        });
    if (!unprotectedCallback.ptr || !protectedCallback.ptr ||
        !engine->setGlobalProperty("__tnCallbackOwnershipHost", host)) {
        if (protectedResult.ptr) engine->freeHandle(protectedResult);
        engine->freeHandle(host);
        return false;
    }
    engine->freezeHandle(unprotectedCallback);
    engine->freezeHandle(protectedCallback);
    const bool installed =
        engine->setProperty(host, "unprotected", unprotectedCallback) &&
        engine->setProperty(host, "protected", protectedCallback);
    engine->freeHandle(protectedCallback);
    engine->freeHandle(unprotectedCallback);
    if (!installed || !runtime.evalScript(R"JS((() => {
        const unprotected = __tnCallbackOwnershipHost.unprotected();
        const protectedValue = __tnCallbackOwnershipHost.protected();
        if (unprotected !== 'unprotected-result' || protectedValue !== 'protected-result') {
            throw new Error('QuickJS callback result handle was empty or corrupted');
        }
    })())JS", "quickjs-callback-result-ownership.js")) {
        if (protectedResult.ptr) engine->freeHandle(protectedResult);
        engine->freeHandle(host);
        return false;
    }
    const bool complete = unprotectedCalls == 1 && protectedCalls == 1 && protectedResult.ptr;
    if (protectedResult.ptr) engine->freeHandle(protectedResult);
    const auto global = engine->getGlobal();
    engine->deleteProperty(global, "__tnCallbackOwnershipHost");
    engine->freeHandle(host);
    if (!complete) {
        std::cerr << "QuickJS callback result ownership proof failed" << std::endl;
    }
    return complete;
}

bool checkControllableSurfaceTextureTransaction(mystral::Runtime& runtime) {
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
    auto* engine = static_cast<mystral::webgpu::BindingsState*>(
                       runtime.getWebGPUBindingsState())
                       ->engine;
    mystral::webgpu::BindingsState controlledState;
    controlledState.engine = engine;
    const auto failed = [](const char* message) {
        std::cerr << "surface texture transaction proof failed: " << message << std::endl;
        return false;
    };

    const auto firstTexture = reinterpret_cast<WGPUTexture>(static_cast<uintptr_t>(0x101));
    const auto failingTexture = reinterpret_cast<WGPUTexture>(static_cast<uintptr_t>(0x202));
    int acquireCalls = 0;
    int releaseCalls = 0;
    std::vector<bool> createdSurfaceTexture;
    const auto acquire = [&](mystral::webgpu::BindingsState*) {
        ++acquireCalls;
        return acquireCalls == 1 ? firstTexture : failingTexture;
    };
    const auto wrap = [&](mystral::webgpu::BindingsState*, WGPUTexture, uint64_t,
                          uint32_t, uint32_t, const char*, bool created) {
        createdSurfaceTexture.push_back(created);
        return engine->newObject();
    };
    const auto release = [&](mystral::webgpu::BindingsState*, WGPUTexture,
                             WGPUTexture) { ++releaseCalls; };

    controlledState.profiling.frameCount = 10;
    controlledState.registries.nextTextureId = 7;
    const auto firstResult = mystral::webgpu::acquireSurfaceTexture(
        &controlledState, acquire, wrap, release);
    if (!firstResult.ptr || engine->isUndefined(firstResult) || acquireCalls != 1 ||
        createdSurfaceTexture.size() != 1 || !createdSurfaceTexture.front() ||
        controlledState.presentation.currentTexture != firstTexture ||
        controlledState.presentation.currentSurfaceTextureId != 7 || controlledState.registries.nextTextureId != 8 ||
        controlledState.profiling.frameCount != 11 || controlledState.registries.textureRegistry.size() != 1) {
        return failed("new-entry success branch");
    }

    const auto existingFrameCount = controlledState.profiling.frameCount;
    const auto existingId = controlledState.presentation.currentSurfaceTextureId;
    const auto existingResult = mystral::webgpu::acquireSurfaceTexture(
        &controlledState, acquire, wrap, release);
    if (!existingResult.ptr || engine->isUndefined(existingResult) || acquireCalls != 1 ||
        createdSurfaceTexture.size() != 2 || createdSurfaceTexture.back() ||
        controlledState.presentation.currentSurfaceTextureId != existingId ||
        controlledState.profiling.frameCount != existingFrameCount ||
        controlledState.registries.textureRegistry.size() != 1) {
        return failed("existing-entry wrapper branch");
    }

    controlledState.presentation.currentTexture = nullptr;
    controlledState.presentation.currentSurfaceTextureId = 0;
    controlledState.registries.nextTextureId = 19;
    controlledState.profiling.frameCount = 31;
    controlledState.registries.textureRegistry.clear();
    const auto previousFrameCount = controlledState.profiling.frameCount;
    const auto previousNextTextureId = controlledState.registries.nextTextureId;
    const auto failedWrap = [&](mystral::webgpu::BindingsState*, WGPUTexture, uint64_t,
                                uint32_t, uint32_t, const char*, bool created) {
        if (!created) return engine->newObject();
        engine->throwException("surface wrapper failure");
        return engine->newUndefined();
    };
    const auto failedResult = mystral::webgpu::acquireSurfaceTexture(
        &controlledState, acquire, failedWrap, release);
    const bool failureObserved = engine->hasException();
    if (failureObserved) engine->getException();
    if (!engine->isUndefined(failedResult) || !failureObserved || acquireCalls != 2 ||
        controlledState.presentation.currentTexture != nullptr ||
        controlledState.presentation.currentSurfaceTextureId != 0 ||
        controlledState.registries.nextTextureId != previousNextTextureId ||
        controlledState.profiling.frameCount != previousFrameCount ||
        !controlledState.registries.textureRegistry.empty() || releaseCalls != 1) {
        return failed("new-entry failure cleanup");
    }
    return true;
#else
    (void)runtime;
    return true;
#endif
}

bool checkRepeatedBindingsStateDestroy() {
    auto* state = mystral::webgpu::createBindingsState();
    mystral::webgpu::destroyBindingsState(state);
    if (state != nullptr) {
        std::cerr << "bindings-state destruction did not clear the owner pointer" << std::endl;
        return false;
    }
    mystral::webgpu::destroyBindingsState(state);
    return true;
}

bool checkQuickJSCallbackLifetime(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    if (engine->getType() != mystral::js::EngineType::QuickJS) return true;

    const auto destination = engine->newObject();
    engine->freezeHandle(destination);
    std::weak_ptr<int> weakLifetime;
    {
        auto lifetime = std::make_shared<int>(1);
        weakLifetime = lifetime;
        for (int index = 0; index < 64; ++index) {
            const std::string name = "callback" + std::to_string(index);
            const auto callback = engine->newFunction(
                name.c_str(),
                [lifetime](void*, const std::vector<mystral::js::JSValueHandle>&) {
                    return mystral::js::JSValueHandle{};
                });
            if (!callback.ptr) {
                std::cerr << "QuickJS callback creation failed at " << index << std::endl;
                engine->freeHandle(destination);
                return false;
            }
            engine->freezeHandle(callback);
            if (!engine->setProperty(destination, name.c_str(), callback)) {
                std::cerr << "QuickJS callback property install failed at " << index << std::endl;
                engine->freeHandle(callback);
                engine->freeHandle(destination);
                return false;
            }
            engine->freeHandle(callback);
        }
    }

    for (int index = 0; index < 64; ++index) {
        const std::string name = "callback" + std::to_string(index);
        if (!engine->deleteProperty(destination, name.c_str())) {
            std::cerr << "QuickJS callback property delete failed at " << index << std::endl;
            engine->freeHandle(destination);
            return false;
        }
    }
    engine->gc();
    engine->gc();
    const bool released = weakLifetime.expired();
    engine->freeHandle(destination);
    if (!released) {
        std::cerr << "QuickJS retained callback allocations after wrapper GC" << std::endl;
    }
    return released;
}

bool createEngineLocalCanvasContext(mystral::Runtime& runtime, const char* filename) {
    return runtime.evalScript(R"JS((() => {
        const canvas = document.createElement("canvas");
        globalThis.__tnEngineLocalCanvasContext = canvas.getContext("2d");
        if (!__tnEngineLocalCanvasContext) {
            throw new Error("engine-local Canvas2D context was not created");
        }
    })())JS", filename);
}

bool runProbe(mystral::Runtime& runtime, const char* marker) {
    const std::string script = std::string(R"JS((() => {
        const adapter = navigator.gpu.requestAdapter();
        if (!adapter || typeof adapter.requestDevice !== "function") {
            throw new Error("WebGPU adapter registration missing");
        }
        const device = adapter.requestDevice();
        if (!device || typeof device.createBuffer !== "function") {
            throw new Error("WebGPU device registration missing");
        }
        globalThis.__tnReentrancyMarker = ")JS") + marker + R"JS(";
        globalThis.__tnReentrancyFormat = navigator.gpu.getPreferredCanvasFormat();
        globalThis.__tnReentrancyBuffer = device.createBuffer({
            size: 4,
            usage: GPUBufferUsage.COPY_DST,
        });
    })())JS";
    if (!runtime.evalScript(script, "webgpu-bindings-reentrancy.js")) return false;
    return runtime.evalScript(
        "if (__tnReentrancyMarker !== '" + std::string(marker) +
            "' || typeof __tnReentrancyFormat !== 'string' || !__tnReentrancyBuffer) "
            "throw new Error('binding state was aliased');",
        "webgpu-bindings-reentrancy-check.js");
}

bool verifyPerRuntimeBlendDescriptors(mystral::Runtime& first, mystral::Runtime& second) {
    auto* firstState = static_cast<mystral::webgpu::BindingsState*>(
        first.getWebGPUBindingsState());
    auto* secondState = static_cast<mystral::webgpu::BindingsState*>(
        second.getWebGPUBindingsState());
    const size_t firstBefore = firstState->registries.blendStates.size();
    const size_t secondBefore = secondState->registries.blendStates.size();
    constexpr auto createPipelineWrappers = R"JS((() => {
        const device = navigator.gpu.requestAdapter().requestDevice();
        const shader = device.createShaderModule({code:
            "@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { " +
            "var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0)); " +
            "return vec4f(p[i], 0.0, 1.0); } " +
            "@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); } " +
            "@compute @workgroup_size(1) fn compute_main() {}"});
        globalThis.__tnOwnedBlendPipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: {module: shader, entryPoint: "vs_main"},
            fragment: {module: shader, entryPoint: "fs_main", targets: [{
                format: "rgba8unorm",
                blend: {
                    color: {srcFactor: "one", dstFactor: "zero", operation: "add"},
                    alpha: {srcFactor: "one", dstFactor: "zero", operation: "add"},
                },
            }]},
        });
        globalThis.__tnOwnedComputePipeline = device.createComputePipeline({
            layout: "auto",
            compute: {module: shader, entryPoint: "compute_main"},
        });
        for (const [label, pipeline] of [
            ["render", __tnOwnedBlendPipeline],
            ["compute", __tnOwnedComputePipeline],
        ]) {
            if (!pipeline || typeof pipeline.getBindGroupLayout !== "function") {
                throw new Error(label + " pipeline wrapper binding missing");
            }
            if (!pipeline.getBindGroupLayout(0)) {
                throw new Error(label + " pipeline bind-group layout missing");
            }
        }
    })())JS";

    if (!first.evalScript(createPipelineWrappers, "webgpu-first-pipeline-owner.js") ||
        firstState->registries.blendStates.size() <= firstBefore ||
        secondState->registries.blendStates.size() != secondBefore) {
        std::cerr << "first runtime blend descriptors were not independently owned" << std::endl;
        return false;
    }
    const size_t firstAfter = firstState->registries.blendStates.size();
    if (!second.evalScript(createPipelineWrappers, "webgpu-second-pipeline-owner.js") ||
        secondState->registries.blendStates.size() <= secondBefore ||
        firstState->registries.blendStates.size() != firstAfter) {
        std::cerr << "second runtime blend descriptors were not independently owned" << std::endl;
        return false;
    }
    return true;
}

bool exercisePublishedWebGPUObjects(mystral::Runtime& runtime) {
    return runtime.evalScript(R"JS((() => {
        const requireMethods = (label, value, names) => {
            if (!value) throw new Error(label + " binding object missing");
            for (const name of names) {
                if (typeof value[name] !== "function") {
                    throw new Error(label + "." + name + " binding missing");
                }
            }
        };
        const requireFeatures = (label, value) => {
            requireMethods(label, value, ["has"]);
            if (typeof value[Symbol.iterator] !== "function") {
                throw new Error(label + " iterator binding missing");
            }
            for (const feature of value) {
                if (typeof feature !== "string") {
                    throw new Error(label + " yielded a non-string feature");
                }
            }
        };
        const adapter = navigator.gpu.requestAdapter();
        const device = adapter.requestDevice();
        const buffer = device.createBuffer({size: 4, usage: GPUBufferUsage.COPY_DST});
        const encoder = device.createCommandEncoder();
        const computePass = encoder.beginComputePass();
        const texture = device.createTexture({
            size: {width: 1, height: 1, depthOrArrayLayers: 1},
            format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT,
        });
        const bundle = device.createRenderBundleEncoder({colorFormats: ["rgba8unorm"]});
        const element = document.createElement("div");
        const canvas = document.createElement("canvas");
        const canvasContext = canvas.getContext("webgpu");
        const mainCanvasContext = globalThis.canvas.getContext("webgpu");

        requireMethods("Document", document, ["querySelector", "createElement"]);
        requireMethods("HTMLElement", element, [
            "appendChild", "removeChild", "remove", "addEventListener", "removeEventListener",
        ]);
        requireMethods("HTMLCanvasElement", canvas, [
            "getContext", "addEventListener", "removeEventListener", "dispatchEvent",
            "requestPointerLock", "toDataURL", "getBoundingClientRect",
        ]);
        requireMethods("GPU", navigator.gpu, ["requestAdapter", "getPreferredCanvasFormat"]);
        requireMethods("GPUAdapter", adapter, ["requestDevice"]);
        requireFeatures("GPUAdapter.features", adapter.features);
        requireFeatures("GPUDevice.features", device.features);
        requireMethods("GPUDevice", device, [
            "destroy", "createBuffer", "createShaderModule", "createRenderPipeline",
            "createRenderPipelineAsync", "createComputePipeline", "createComputePipelineAsync",
            "createCommandEncoder", "createTexture", "createSampler",
            "createBindGroupLayout", "createBindGroup", "createPipelineLayout",
            "createTextureView", "createRenderBundleEncoder", "pushErrorScope", "popErrorScope",
        ]);
        requireMethods("GPUQueue", device.queue, [
            "submit", "writeBuffer", "writeTexture", "copyExternalImageToTexture",
            "onSubmittedWorkDone",
        ]);
        requireMethods("GPUBuffer", buffer, ["mapAsync", "getMappedRange", "unmap", "destroy"]);
        requireMethods("GPUCommandEncoder", encoder, [
            "beginRenderPass", "beginComputePass", "copyBufferToBuffer", "copyBufferToTexture",
            "copyTextureToBuffer", "copyTextureToTexture", "clearBuffer", "finish",
        ]);
        requireMethods("GPUComputePassEncoder", computePass, [
            "setPipeline", "setBindGroup", "dispatchWorkgroups", "end",
        ]);
        requireMethods("GPURenderBundleEncoder", bundle, [
            "setPipeline", "setVertexBuffer", "setIndexBuffer", "setBindGroup", "draw",
            "drawIndexed", "drawIndirect", "drawIndexedIndirect", "finish",
        ]);
        requireMethods("GPUCanvasContext", canvasContext, [
            "configure", "unconfigure", "getCurrentTexture",
        ]);
        const requireSurfaceTexture = (label, context) => {
            context.configure({device, format: navigator.gpu.getPreferredCanvasFormat()});
            const surfaceTexture = context.getCurrentTexture();
            requireMethods(label, surfaceTexture, ["createView", "destroy"]);
            if (!surfaceTexture.createView()) {
                throw new Error(label + ".createView returned no wrapper");
            }
        };
        requireSurfaceTexture("main surface texture", mainCanvasContext);
        requireSurfaceTexture("offscreen surface texture", canvasContext);
        requireMethods("GPUTexture", texture, ["createView", "destroy"]);
        requireMethods("WebGPU", globalThis, [
            "__decodeImageDataAsync", "__nativeGetContext2D", "createOffscreenCanvas2D",
            "createImageBitmap",
        ]);
        if (globalThis.Mystral && typeof globalThis.Mystral.loadGLTF !== "undefined") {
            throw new Error("deprecated native GLTF binding is still published");
        }
        computePass.end();
    })())JS", "webgpu-public-binding-surface.js");
}

bool exercisePreservedCallTrace(mystral::Runtime& runtime) {
    std::ifstream fixture("tests/fixtures/webgpu-bindings-call-trace.js");
    if (!fixture) {
        std::cerr << "could not open the preserved WebGPU call trace" << std::endl;
        return false;
    }
    std::ostringstream source;
    source << fixture.rdbuf();
    std::string script = source.str();
    const std::string traceLog =
        "console.log(`TN_WEBGPU_CALL_TRACE:${JSON.stringify(trace)}`);";
    const size_t traceLogAt = script.find(traceLog);
    if (traceLogAt == std::string::npos) {
        std::cerr << "preserved WebGPU call trace lost its result marker" << std::endl;
        return false;
    }
    script.replace(
        traceLogAt,
        traceLog.size(),
        "globalThis.__tnWebGpuCallTrace = JSON.stringify(trace);");
    const std::string exitCall = "process.exit(0);";
    const size_t exitAt = script.find(exitCall);
    if (exitAt == std::string::npos) {
        std::cerr << "preserved WebGPU call trace lost its completion sentinel" << std::endl;
        return false;
    }
    script.erase(exitAt, exitCall.size());
    script += R"JS(
        {
            const actual = JSON.parse(__tnWebGpuCallTrace);
            if (!Array.isArray(actual) || actual.length < 60)
                throw new Error("live WebGPU call trace is incomplete");
            for (const entry of actual) {
                if (typeof entry.surface !== "string" || typeof entry.name !== "string" ||
                    !Array.isArray(entry.args) ||
                    (Object.hasOwn(entry, "result") === Object.hasOwn(entry, "error")))
                    throw new Error("live WebGPU call trace contains a malformed entry");
            }
            const calls = new Set(actual.map((entry) => `${entry.surface}.${entry.name}`));
            const required = [
                "Document.querySelector", "Document.createElement",
                "HTMLElement.appendChild", "HTMLElement.addEventListener",
                "HTMLCanvasElement.getContext", "HTMLCanvasElement.addEventListener",
                "GPUCanvasContext.configure", "GPUCanvasContext.unconfigure",
                "GPUCanvasContext.getCurrentTexture", "GPU.getPreferredCanvasFormat",
                "GPUAdapter.features.has", "GPUDevice.createBuffer",
                "GPUDevice.createShaderModule", "GPUQueue.submit", "GPUQueue.writeBuffer",
                "GPUBuffer.getMappedRange", "GPUBuffer.destroy", "GPUTexture.createView",
                "GPUTexture.destroy", "GPUCommandEncoder.beginRenderPass",
                "GPUCommandEncoder.beginComputePass", "GPUCommandEncoder.finish",
                "GPURenderPipeline.getBindGroupLayout", "GPUComputePipeline.getBindGroupLayout",
                "GPURenderPassEncoder.setPipeline", "GPURenderPassEncoder.setBindGroup",
                "GPURenderPassEncoder.draw", "GPURenderPassEncoder.end",
                "GPUComputePassEncoder.setPipeline", "GPUComputePassEncoder.setBindGroup",
                "GPUComputePassEncoder.dispatchWorkgroups", "GPUComputePassEncoder.end",
                "GPURenderBundleEncoder.setPipeline", "GPURenderBundleEncoder.setVertexBuffer",
                "GPURenderBundleEncoder.setBindGroup", "GPURenderBundleEncoder.draw",
                "GPURenderBundleEncoder.finish", "WebGPU.__decodeImageDataAsync",
                "WebGPU.createOffscreenCanvas2D",
            ];
            for (const key of required)
                if (!calls.has(key)) throw new Error(`live WebGPU call trace is missing ${key}`);
            const dynamicCreates = actual.filter(
                (entry) => entry.surface === "Document" && entry.name === "createElement");
            const dynamicContexts = actual.filter(
                (entry) => entry.surface === "HTMLCanvasElement" && entry.name === "getContext");
            if (dynamicCreates.length < 2 || dynamicContexts.length < 5 ||
                dynamicContexts.some((entry) => !Object.hasOwn(entry, "result")))
                throw new Error("live dynamic canvas trace controls failed");
        }
    )JS";
    return runtime.evalScript(script, "webgpu-bindings-call-trace.js");
}

bool checkDetachedRenderBundleEncoderMethodAfterGc(mystral::Runtime& runtime) {
    if (!runtime.evalScript(R"JS((() => {
        const device = navigator.gpu.requestAdapter().requestDevice();
        let encoder = device.createRenderBundleEncoder({colorFormats: ["rgba8unorm"]});
        globalThis.__tnDetachedRenderBundleFinish = encoder.finish;
        encoder = null;
    })())JS", "webgpu-detached-bundle-method-setup.js")) {
        return false;
    }
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime.getWebGPUBindingsState());
    state->engine->clearFrameHandles();
    state->engine->gc();
    state->engine->gc();
    return runtime.evalScript(R"JS((() => {
        try {
            __tnDetachedRenderBundleFinish();
            throw new Error("detached render bundle method unexpectedly succeeded");
        } catch (error) {
            if (!String(error).includes("encoder is no longer valid")) throw error;
        }
    })())JS", "webgpu-detached-bundle-method-after-gc.js");
}

bool checkRenderBundleEncoderPinDuringReentrantGc(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    const auto collectGarbage = engine->newFunction(
        "collectWebGpuWrapperGarbage",
        [engine](void*, const std::vector<mystral::js::JSValueHandle>&) {
            engine->gc();
            engine->gc();
            return engine->newUndefined();
        });
    if (!collectGarbage.ptr ||
        !engine->setGlobalProperty("__tnCollectWebGpuWrapperGarbage", collectGarbage)) {
        if (collectGarbage.ptr) engine->freeHandle(collectGarbage);
        return false;
    }
    engine->freeHandle(collectGarbage);
    if (!runtime.evalScript(R"JS((() => {
        const device = navigator.gpu.requestAdapter().requestDevice();
        const encoder = device.createRenderBundleEncoder({colorFormats: ["rgba8unorm"]});
        globalThis.__tnReentrantBundleEncoder = encoder;
        globalThis.__tnReentrantBundleDraw = encoder.draw;
        globalThis.__tnReentrantBundleFinish = encoder.finish;
    })())JS", "webgpu-reentrant-bundle-gc-setup.js")) {
        return false;
    }
    engine->clearFrameHandles();
    const bool called = runtime.evalScript(R"JS((() => {
        __tnReentrantBundleDraw({
            valueOf() {
                globalThis.__tnReentrantBundleEncoder = null;
                __tnCollectWebGpuWrapperGarbage();
                return 1;
            },
        });
        try {
            __tnReentrantBundleFinish();
            throw new Error("collected render bundle encoder unexpectedly remained live");
        } catch (error) {
            if (!String(error).includes("encoder is no longer valid")) throw error;
        }
        delete globalThis.__tnCollectWebGpuWrapperGarbage;
        delete globalThis.__tnReentrantBundleDraw;
        delete globalThis.__tnReentrantBundleFinish;
    })())JS", "webgpu-reentrant-bundle-gc-dispatch.js");
    return called;
}

bool exerciseAsyncWebGPUObservation(mystral::Runtime& runtime) {
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime.getWebGPUBindingsState());
    auto* engine = state->engine;
    std::string report;
    if (!engine->setGlobalProperty(
            "__tnReportAsyncObservation",
            engine->newFunction(
                "__tnReportAsyncObservation",
                [engine, &report](
                    void*, const std::vector<mystral::js::JSValueHandle>& args) {
                    if (!args.empty()) report = engine->toString(args[0]);
                    return engine->newUndefined();
                }))) {
        return false;
    }

    if (!runtime.evalScript(R"JS((() => {
        const adapter = navigator.gpu.requestAdapter();
        const device = adapter.requestDevice();
        device.pushErrorScope("validation");
        const invalidBuffer = device.createBuffer({
            label: "tn-deliberately-invalid-zero-usage-buffer",
            size: 16,
            usage: 0,
        });
        const errorScope = device.popErrorScope();
        const submittedWork = device.queue.onSubmittedWorkDone();
        const renderShader = device.createShaderModule({
            code: "@vertex fn vertexMain() -> @builtin(position) vec4f { return vec4f(0.0); } " +
                "@fragment fn fragmentMain() -> @location(0) vec4f { return vec4f(1.0); }",
        });
        const computeShader = device.createShaderModule({
            code: "@compute @workgroup_size(1) fn computeMain() {}",
        });
        let renderPipeline;
        let computePipeline;
        try {
            renderPipeline = device.createRenderPipelineAsync({
                layout: "auto",
                vertex: { module: renderShader, entryPoint: "vertexMain" },
                fragment: {
                    module: renderShader,
                    entryPoint: "fragmentMain",
                    targets: [{ format: "rgba8unorm" }],
                },
            });
            computePipeline = device.createComputePipelineAsync({
                layout: "auto",
                compute: { module: computeShader, entryPoint: "computeMain" },
            });
        } catch (error) {
            throw new Error(`async pipeline creation threw synchronously: ${String(error)}`);
        }
        if (!(errorScope instanceof Promise) || !(submittedWork instanceof Promise) ||
            !(renderPipeline instanceof Promise) || !(computePipeline instanceof Promise)) {
            throw new Error("async WebGPU observation did not return native Promises");
        }
        Promise.all([
            errorScope,
            submittedWork,
            renderPipeline.then(() => "resolved", () => "rejected"),
            computePipeline.then(() => "resolved", () => "rejected"),
        ]).then(
            ([error, _submitted, renderResult, computeResult]) => {
                invalidBuffer?.destroy?.();
                if (!error || typeof error.message !== "string" || error.message.length === 0) {
                    __tnReportAsyncObservation("validation error was not observed");
                    return;
                }
                if (renderResult !== "resolved" || computeResult !== "resolved") {
                    __tnReportAsyncObservation("valid async pipelines did not resolve");
                    return;
                }
                __tnReportAsyncObservation("ok");
            },
            (error) => __tnReportAsyncObservation(`async observation rejected: ${String(error)}`),
        );
    })())JS", "webgpu-async-observation.js")) {
        return false;
    }

    // Microtasks alone can no longer settle these. Since PRD-327 `createRenderPipelineAsync` hands
    // the compile to a host pool, and the promise is settled by `drainAsyncPipelineCompiles` —
    // which production calls from `pollEvents()`'s `kIo` segment. Before that change the promise
    // was already resolved when it was handed over, so eight microtask passes were enough.
    //
    // The drain is called directly rather than through `pollEvents()`, which is the narrower and
    // more honest thing for a bindings test to drive: a full loop turn also acquires and presents
    // a swapchain image, and doing that here left `Context::~Context` releasing a surface texture
    // twice —
    //   Thread 1 received signal SIGSEGV
    //   #0 dawn::native::NativeTextureRelease(WGPUTextureImpl*)
    //   #1 mystral::webgpu::Context::~Context()
    // — a presentation-teardown fault this test has no business exercising. It is the same
    // function production calls, reached without the rest of the frame.
    //
    // Wall-clock bounded rather than pass-counted, because the thing being waited on is a real
    // pipeline compile: eight passes were enough on an optimised build and not on an instrumented
    // one, which is how this surfaced — as a coverage-lane failure on a test that passed in
    // `build/tn-linux`. A bound that depends on how fast the build is is not a bound.
    auto* bindingsState =
        static_cast<mystral::webgpu::BindingsState*>(runtime.getWebGPUBindingsState());
    const auto asyncDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    while (report.empty() && std::chrono::steady_clock::now() < asyncDeadline) {
        mystral::webgpu::drainAsyncPipelineCompiles(bindingsState);
        engine->processMicrotasks();
        if (!engine->evalScript("undefined", "webgpu-async-observation-drain.js")) return false;
    }
    if (report != "ok") {
        std::cerr << "WebGPU async observation proof failed: "
                  << (report.empty() ? "Promise did not settle" : report) << std::endl;
        return false;
    }
    return true;
}

}  // namespace

int main() {
    mystral::RuntimeConfig config;
    config.width = 1;
    config.height = 1;
    config.noSdl = true;

    auto first = mystral::Runtime::create(config);
    auto second = mystral::Runtime::create(config);
    if (!first || !second || !first->getWebGPUBindingsState() || !second->getWebGPUBindingsState() ||
        first->getWebGPUBindingsState() == second->getWebGPUBindingsState()) {
        return 1;
    }

    if (!exercisePublishedWebGPUObjects(*first)) return 1;
    std::cout << "proof: public-binding-surface" << std::endl;
    if (!checkDetachedRenderBundleEncoderMethodAfterGc(*first)) return 1;
    std::cout << "proof: detached-bundle-method-after-gc" << std::endl;
    if (!checkRenderBundleEncoderPinDuringReentrantGc(*first)) return 1;
    std::cout << "proof: bundle-method-pinned-during-reentrant-gc" << std::endl;
    if (!exercisePreservedCallTrace(*first)) return 1;
    std::cout << "proof: call-trace" << std::endl;
    if (!exerciseAsyncWebGPUObservation(*first)) return 1;
    std::cout << "proof: async-observation" << std::endl;

    if (!checkRowOwnedAndAtomicInstall(*first)) return 1;
    if (!checkCaughtNativeExceptionDoesNotPoisonLaterInstall(*first)) return 1;
    if (!checkAtomicRollbackAndDestinationValidation(*first)) return 1;
    if (!verifyWholeTableTransactionBehavior(*first)) return 1;
    std::cout << "proof: whole-table-verification" << std::endl;
    if (!checkPropertyDescriptorAndExceptionControls(*first)) return 1;
    if (!checkDynamicCanvasOwnership(*first)) return 1;
    if (!checkBindingProtectionOwnership(*first)) return 1;
    if (!verifyActiveWrapperRollbackBehavior(*first)) return 1;
    std::cout << "proof: wrapper-rollback" << std::endl;
    if (!checkControllableSurfaceTextureTransaction(*first)) return 1;
    if (!checkDynamicInstallUnwind(*first)) return 1;
    if (!checkQuickJSCallbackLifetime(*first)) return 1;
    if (!checkQuickJSCallbackResultOwnership(*first) ||
        !checkQuickJSCallbackResultOwnership(*second) ||
        !checkQuickJSCallbackLifetime(*second)) {
        return 1;
    }

    // Create the second engine's context first so the first engine is the last creator. A
    // process-global callback engine would dangle when the first runtime is destroyed below.
    if (!createEngineLocalCanvasContext(*second, "webgpu-binding-second-canvas.js") ||
        !createEngineLocalCanvasContext(*first, "webgpu-binding-first-canvas.js")) {
        return 1;
    }

    if (!runProbe(*first, "first") || !runProbe(*second, "second") ||
        !first->evalScript(
            "if (__tnReentrancyMarker !== 'first') throw new Error('first binding state changed');",
            "webgpu-bindings-reentrancy-first-check.js") ||
        !second->evalScript(
            "if (__tnReentrancyMarker !== 'second') throw new Error('second binding state changed');",
            "webgpu-bindings-reentrancy-second-check.js")) {
        return 1;
    }
    if (!verifyPerRuntimeBlendDescriptors(*first, *second)) return 1;

    if (!checkQuickJSExceptionReplacement(*first) ||
        !queueQuickJSTeardownProbe(*first) ||
        !leaveQuickJSOutstandingException(*first)) {
        return 1;
    }

    first.reset();
    if (teardownProbeCalls != 0) {
        std::cerr << "queued QuickJS callback executed during runtime teardown" << std::endl;
        return 1;
    }
    if (!second->evalScript(
            "if (__tnReentrancyMarker !== 'second') throw new Error('second engine lost state'); "
            "if (!(performance.now() > 0)) "
            "throw new Error('second engine performance.now lost its context owner'); "
            "__tnEngineLocalCanvasContext.fillRect(0, 0, 1, 1); "
            "if (typeof __tnEngineLocalCanvasContext.measureText('x').width !== 'number') "
            "throw new Error('second engine Canvas2D callback lost its owning engine');",
            "webgpu-bindings-reentrancy-after-first-destroy.js")) {
        return 1;
    }

    auto replacement = mystral::Runtime::create(config);
    if (!replacement || !replacement->getWebGPUBindingsState() ||
        !createEngineLocalCanvasContext(
            *replacement, "webgpu-binding-replacement-canvas.js") ||
        !runProbe(*replacement, "replacement") ||
        !replacement->evalScript(
            "__tnEngineLocalCanvasContext.fillRect(0, 0, 1, 1);",
            "webgpu-binding-replacement-callback.js")) {
        return 1;
    }
    replacement.reset();
    if (!second->evalScript(
            "__tnEngineLocalCanvasContext.fillRect(0, 0, 1, 1); "
            "if (__tnReentrancyMarker !== 'second') "
            "throw new Error('surviving engine callback changed after replacement teardown');",
            "webgpu-bindings-reentrancy-after-replacement-destroy.js")) {
        return 1;
    }

    if (!checkRepeatedBindingsStateDestroy()) return 1;

    second.reset();
#if defined(MYSTRAL_HAS_SKIA)
    // Skia keeps process-wide typeface references after the last canvas owner dies.
    SkGraphics::PurgeFontCache();
#endif
    std::cout << "native WebGPU bindings reentrancy passed" << std::endl;
    return 0;
}
