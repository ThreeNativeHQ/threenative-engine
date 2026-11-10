// PRD-867: a compressed texture uploads in its block format and draws. The KTX2 fixture (ktx2-textured.glb,
// solid red ETC1S base colour) loads on a device with texture-compression-bc: the loader transcodes it to BC7
// levels, the renderer uploads them, and a mapped plane reads back red. A device created without the feature
// refuses the same texture by name instead of drawing it blank.
#include "check.h"
#include "engine/assets/gltf/loader.h"
#include "engine/foundation/buffers.h"
#include "engine/renderer/renderer.h"
#include "engine/scene/nodes.h"
#include "engine/scene/texture.h"
#include "mystral/webgpu/context.h"
#include "mystral/webgpu_compat.h"

#include <chrono>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <thread>

using namespace tn::engine;

namespace {

std::shared_ptr<const Texture> loadedMap() {
    std::ifstream in(TN_GLTF_KTX2_FIXTURE, std::ios::binary);
    const std::string bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
    const gltf::LoadResult loaded =
        gltf::load(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size()));
    if (!loaded.error.empty()) std::printf("ktx2 fixture: %s\n", loaded.error.c_str());
    const auto* mesh = loaded.scene ? dynamic_cast<Mesh*>(loaded.scene->getObjectByName("quad")) : nullptr;
    if (!mesh || !mesh->material) return nullptr;
    const auto found = mesh->material->maps.find("map");
    return found == mesh->material->maps.end() ? nullptr : found->second;
}

struct Plane {
    BufferStore positions{Scalar::F32, 12};
    BufferStore uvs{Scalar::F32, 8};
    BufferStore indices{Scalar::U16, 6};
    Plane() {
        const float v[12] = {-1, 1, 0, 1, 1, 0, -1, -1, 0, 1, -1, 0};
        const float uv[8] = {0, 0, 1, 0, 0, 1, 1, 1};
        const uint16_t i[6] = {0, 2, 1, 2, 3, 1};
        positions.write(0, v, sizeof v);
        uvs.write(0, uv, sizeof uv);
        indices.write(0, i, sizeof i);
    }
};

CameraState ortho() {
    CameraState camera;
    camera.matrixWorldInverse = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1};
    camera.projectionMatrix = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1 / 9.9, 0, 0, 0, -0.1 / 9.9, 1};
    return camera;
}

std::vector<uint8_t> drawn(Renderer& renderer, EventQueue& events, const std::shared_ptr<const Texture>& map) {
    renderer.setSize(8, 8);
    const Plane plane;
    shader::StandardMaterial material;
    DrawItem item;
    item.key = item.id = 1;
    item.kind = MaterialKind::Basic;
    item.positions = const_cast<BufferStore*>(&plane.positions);
    item.uvs = const_cast<BufferStore*>(&plane.uvs);
    item.indices = const_cast<BufferStore*>(&plane.indices);
    item.material = &material;
    item.map = map.get();  // DrawItem holds a const Texture*
    item.matrixWorld = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    const std::vector<DrawItem> items{item};
    renderer.render(items, ortho(), LightState{}, {0, 0, 1, 1});
    std::vector<uint8_t> out;
    bool done = false;
    renderer.readPixels([&](GpuStatus status, std::vector<uint8_t> px) {
        if (status == GpuStatus::Ok) out = std::move(px);
        done = true;
    });
    for (int i = 0; i < 4000 && !done; ++i) {
        renderer.poll();
        events.drain();
        if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return out;
}

bool rendersPixels(mystral::webgpu::Context& context) {
    WGPUAdapterInfo info{};
    wgpuAdapterGetInfo(context.getAdapter(), &info);
    const bool pixels = info.backendType != WGPUBackendType_Null;
    wgpuAdapterInfoFreeMembers(info);
    return pixels;
}

void bc7Draws() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    const bool pixels = rendersPixels(context);
    if (!pixels) std::fprintf(stderr, "TN_BC7_REQUIRES_RENDERING_BACKEND\n");
    CHECK(pixels);
    const bool bc = wgpuDeviceHasFeature(context.getDevice(), WGPUFeatureName_TextureCompressionBC);
    if (!bc) std::fprintf(stderr, "TN_BC7_REQUIRES_TEXTURE_COMPRESSION_BC on this adapter\n");
    CHECK(bc);
    if (!pixels || !bc) return;
    EventQueue events;
    Renderer renderer(context.getInstance(), context.getDevice(), context.getQueue(), events);
    CHECK(compressedTextureTarget().load() == kTextureBC7Format);
    const auto map = loadedMap();
    CHECK(map && map->compressed());
    if (!map || !map->compressed()) return;
    std::printf("bc7 map: %ux%u, %zu levels, level 0 %zu bytes\n", map->width, map->height, map->mipmaps.size(),
                map->mipmaps[0].data.size());
    CHECK(map->imageSource->mipmapFormat == kTextureBC7Format);
    CHECK(map->mipmaps[0].data.size() == 2 * 2 * 16);  // 8x8: 2x2 blocks of 16 bytes
    CHECK(map->data.empty());
    // The control: the same plane under an RGBA red texture, so a blank draw is told from a blank texture.
    auto control = std::make_shared<Texture>();
    control->width = control->height = 8;
    for (int i = 0; i < 64; ++i) control->data.insert(control->data.end(), {255, 0, 0, 255});
    control->flipY = false;
    control->needsUpdate();
    const auto rgba = drawn(renderer, events, control);
    CHECK(rgba.size() == 8 * 8 * 4);
    if (rgba.size() == 8 * 8 * 4) std::printf("rgba control centre pixel: %u %u %u\n", rgba[144], rgba[145], rgba[146]);
    const auto px = drawn(renderer, events, map);
    CHECK(px.size() == 8 * 8 * 4);
    if (px.size() != 8 * 8 * 4) return;
    const uint8_t* centre = &px[(4 * 8 + 4) * 4];
    std::printf("bc7 centre pixel: %u %u %u %u\n", centre[0], centre[1], centre[2], centre[3]);
    CHECK(centre[0] > 230 && centre[1] < 25 && centre[2] < 25);  // the fixture's red, not the blue clear
}

// A device created without texture-compression-bc: the same BC7 texture is refused by name.
void bc7RefusedWithoutFeature() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    // An adapter hands out one device, so the featureless device comes from a fresh adapter.
    WGPUAdapter adapter = nullptr;
    WGPURequestAdapterCallbackInfo adapterCallback{};
    adapterCallback.mode = WGPUCallbackMode_AllowProcessEvents;
    adapterCallback.userdata1 = &adapter;
    adapterCallback.callback = [](WGPURequestAdapterStatus, WGPUAdapter a, WGPUStringView, void* user, void*) {
        *static_cast<WGPUAdapter*>(user) = a;
    };
    wgpuInstanceRequestAdapter(context.getInstance(), nullptr, adapterCallback);
    wgpuInstanceProcessEvents(context.getInstance());
    CHECK(adapter != nullptr);
    if (!adapter) return;
    WGPUDevice device = nullptr;
    WGPURequestDeviceCallbackInfo callback{};
    callback.mode = WGPUCallbackMode_AllowProcessEvents;
    callback.userdata1 = &device;
    callback.callback = [](WGPURequestDeviceStatus, WGPUDevice d, WGPUStringView, void* user, void*) {
        *static_cast<WGPUDevice*>(user) = d;
    };
    wgpuAdapterRequestDevice(adapter, nullptr, callback);
    wgpuInstanceProcessEvents(context.getInstance());
    CHECK(device != nullptr);
    if (!device) return static_cast<void>(wgpuAdapterRelease(adapter));
    CHECK(!wgpuDeviceHasFeature(device, WGPUFeatureName_TextureCompressionBC));
    auto map = std::make_shared<Texture>();
    map->width = map->height = 8;
    map->mipmaps.push_back({std::vector<uint8_t>(2 * 2 * 16, 0), 8, 8});
    map->imageSource->mipmapFormat = kTextureBC7Format;
    map->needsUpdate();
    std::string error;
    {
        EventQueue events;
        WGPUQueue queue = wgpuDeviceGetQueue(device);
        Renderer renderer(context.getInstance(), device, queue, events);
        CHECK(compressedTextureTarget().load() != kTextureBC7Format);  // the loader keeps KTX2 off BC7 here
        try {
            drawn(renderer, events, map);
        } catch (const std::runtime_error& refused) {
            error = refused.what();
        }
        wgpuQueueRelease(queue);
    }
    wgpuDeviceRelease(device);
    wgpuAdapterRelease(adapter);
    std::printf("refused: %s\n", error.c_str());
    CHECK(error == "TN_NATIVE_TEXTURE_UNSUPPORTED: BC7 needs the device feature texture-compression-bc");
}

}  // namespace

TN_TEST_MAIN({"bc7_draws", bc7Draws}, {"bc7_refused_without_feature", bc7RefusedWithoutFeature})
