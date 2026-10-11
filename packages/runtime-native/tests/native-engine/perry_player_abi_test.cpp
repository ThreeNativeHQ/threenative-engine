#include "check.h"
#include "engine/abi/abi_internal.h"
#include "engine/player/run.h"
#include "mystral/platform/ui_overlay.h"
#include "engine/scene/camera.h"
#include "engine/scene/geometries.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"
#include <cmath>
#include <cstdlib>
#include <stdexcept>

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
#if TN_ENABLE_CSS_UI
    CHECK(attachDesktopCssUi(""));
    CHECK(js_tnp_player_ui_attached() == 1);
    const std::string batch = R"({"ops":[
      {"op":"create","id":1,"tag":"button"},
      {"op":"attr","id":1,"name":"style","value":"position:fixed;left:0;top:0;width:100px;height:100px"},
      {"op":"append","parent":0,"child":1},
      {"op":"listen","id":1,"event":"click"}
    ]})";
    CHECK(js_tnp_player_ui_post(reinterpret_cast<int64_t>(batch.c_str())) == 1);
    UiOverlayFrame frame;
    CHECK(uiOverlayFrame(frame));
    CHECK(frame.isRgba && frame.length > 0);
    CHECK(uiOverlayRoutePointer("pointerdown", 0.01f, 0.01f, 1, 1));
    CHECK(uiOverlayRoutePointer("pointerup", 0.01f, 0.01f, 0, 1));
    pumpUiOverlay();
    const auto click = js_tnp_player_ui_take();
    CHECK(click != 0);
    if (click) CHECK(std::string(reinterpret_cast<const char*>(click)).find("\"type\":\"click\"") != std::string::npos);
    detachDesktopUiOverlay();
    CHECK(js_tnp_player_ui_attached() == 0);
#endif
}
void frameMetrics() {
    using tn::engine::player::gameSpan;
    using tn::engine::player::gameSpanTiming;
    const char* priorFlag = std::getenv("TN_GAME_SPANS");
    const std::string savedFlag = priorFlag ? priorFlag : "";
    for (const char* flag : {"", "0", "false", "yes", "1"}) {
        setenv("TN_GAME_SPANS", flag, 1);
        CHECK(gameSpan(-1, 0) == (std::string(flag) == "1" ? 1 : 0));
    }
    if (priorFlag) setenv("TN_GAME_SPANS", savedFlag.c_str(), 1);
    else unsetenv("TN_GAME_SPANS");
    const double started = gameSpan(-2, 0);
    CHECK(gameSpan(26, 0) == 0);
    CHECK(gameSpan(14, 0) == 0);
    CHECK(gameSpan(-3, 0) == 0);
    CHECK(gameSpan(14, 1) == 0);
    CHECK(gameSpan(26, 1) == 0);
    const double elapsed = gameSpan(-2, 0) - started;
    const auto spans = gameSpanTiming(elapsed);
    const auto* root = spans.find("spans")->find("hostUpdate");
    const auto* input = spans.find("spans")->find("input");
    CHECK(root->find("calls")->number() == 1);
    CHECK(input->find("calls")->number() == 1);
    CHECK(root->find("ms")->number() >= input->find("ms")->number());
    CHECK(std::abs(root->find("selfMs")->number() + input->find("selfMs")->number()
        + spans.find("residualMs")->number() - elapsed) < 1e-9);
    CHECK(gameSpanTiming(0).find("spans")->find("input")->find("calls")->number() == 0);
    // Mailbox observations after render must not leak into the next game-JS window.
    CHECK(gameSpan(42, 0) == 0);
    CHECK(gameSpan(42, 1) == 0);
    CHECK(gameSpanTiming(0).find("spans")->find("graphVisit")->find("calls")->number() == 0);
    CHECK(gameSpan(26, 0) == 0);
    CHECK(gameSpan(14, 1) == -1);
    bool refused = false;
    try { gameSpanTiming(0); } catch (const std::runtime_error&) { refused = true; }
    CHECK(refused);
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
