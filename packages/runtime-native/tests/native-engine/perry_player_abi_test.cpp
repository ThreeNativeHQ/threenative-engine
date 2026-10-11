#include "check.h"
#include "engine/abi/abi_internal.h"
#include "engine/player/run.h"
#include "mystral/platform/ui_overlay.h"
#include "engine/scene/camera.h"
#include "engine/scene/geometries.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"
#include <cmath>

extern "C" int32_t js_tnp_player_open();
extern "C" int32_t js_tnp_player_step();
extern "C" void js_tnp_player_close();
extern "C" double js_tnp_player_render_info(int32_t);
extern "C" int32_t js_tnp_player_ui_attached();
extern "C" int64_t js_tnp_player_ui_take();
extern "C" int32_t js_tnp_player_ui_post(int64_t);
extern "C" int64_t js_tnp_player_adapter_info();
extern "C" int64_t js_tnp_player_publish(int64_t, int64_t, double, double, int32_t, int64_t);
extern "C" void tnp_player_update(double) {}
extern "C" void tnp_player_frame(double) {}
extern "C" double tnp_player_observe(double, double) { return 0; }

namespace {
using namespace tn::engine;
void uiMessages() {
    using namespace mystral::platform;
    setUiOverlayAttached(false);
    CHECK(js_tnp_player_ui_attached() == 0);
    CHECK(js_tnp_player_ui_post(0) == 0);
    CHECK(js_tnp_player_ui_take() == 0);
    queueUiMessage(R"({"type":"tn:hit-regions","regions":[]})");
    queueUiMessage(R"({"type":"tn:intent","intent":"start"})");
    const auto pointer = js_tnp_player_ui_take();
    CHECK(pointer != 0);
    if (pointer) CHECK(std::string(reinterpret_cast<const char*>(pointer)) == R"({"type":"tn:intent","intent":"start"})");
    CHECK(js_tnp_player_ui_take() == 0);
}
void frameMetrics() {
    const auto sample = tn::engine::player::frameTiming(0.5, 0.6, 1.1, 28.5, 42);
    CHECK(sample.find("gameJsMs")->number() == 0.5);
    CHECK(sample.find("renderMs")->number() == 0.6);
    CHECK(sample.find("cpuFrameMs")->number() == 1.1);
    CHECK(sample.find("frameMs")->number() == 28.5);
    CHECK(sample.find("bridgeCalls")->number() == 42);
    json::Value parsed;
    json::Error error;
    CHECK(json::parse(json::stringify(sample), parsed, error));
    CHECK(parsed.find("cpuFrameMs")->number() < parsed.find("frameMs")->number());
}
void renderInfo() {
    CHECK(js_tnp_player_render_info(0) == 0);
    CHECK(js_tnp_player_render_info(1) == 0);
    CHECK(std::isnan(js_tnp_player_render_info(2)));
    json::Value info;
    json::Error error;
    CHECK(json::parse(reinterpret_cast<const char*>(js_tnp_player_adapter_info()), info, error));
    const auto expected = tn::engine::player::adapterIdentity();
    CHECK(!expected.empty());
    CHECK(info.members().size() == expected.size());
    for (const auto& [name, value] : expected) {
        const auto* field = info.find(name);
        CHECK(field && field->isString() && field->string() == value);
    }

    tn_context_t* context = nullptr;
    const auto version = tn_engine_version();
    tn_diagnostic_t diagnostic{};
    CHECK(tn_context_create(&context, &version, &diagnostic) == TN_OK);
    tn_diagnostic_release(&diagnostic);
    auto world = std::make_shared<Scene>();
    auto view = std::make_shared<PerspectiveCamera>(50, 1280.0 / 720, 0.1, 100);
    view->position.z = 5;
    auto mesh = std::make_shared<Mesh>(makeBoxGeometry(), std::make_shared<Material>(MaterialType::Basic));
    world->add(*mesh);
    auto scene = tn::abi::shareObject(context, "Scene", world);
    auto camera = tn::abi::shareObject(context, "PerspectiveCamera", view);
    const double clear[] = {0, 0, 0, 1};
    CHECK(js_tnp_player_publish(reinterpret_cast<int64_t>(&scene), reinterpret_cast<int64_t>(&camera),
        0, 1, 1, reinterpret_cast<int64_t>(clear)) == 0);
    const int status = js_tnp_player_open();
    CHECK(status == 0);
    if (status == 0) {
        CHECK(js_tnp_player_step() == 1);
        // The renderer also counts its output triangle, exactly as the V8 host reports it.
        CHECK(js_tnp_player_render_info(0) == 2);
        CHECK(js_tnp_player_render_info(1) == 13);
        mesh->setVisible(false);
        CHECK(js_tnp_player_step() == 1);
        CHECK(js_tnp_player_render_info(0) == 1);
        CHECK(js_tnp_player_render_info(1) == 1);
    }
    js_tnp_player_close();
    CHECK(js_tnp_player_render_info(0) == 0);
    CHECK(js_tnp_player_render_info(1) == 0);
    CHECK(tn_context_destroy(context, nullptr) == TN_OK);
}
}
TN_TEST_MAIN({"render_info", renderInfo}, {"frame_metrics", frameMetrics}, {"ui_messages", uiMessages})
