// PRD-517 phase 1: non-skeletal property tracks against the pinned three. The generated timeline
// drives a Standard material's colour, opacity and roughness, a Phong material's shininess and
// emissive, a directional light's intensity and colour, a camera's fov and zoom and a boolean
// visibility track, through a weighted clip, a cross-fade, an additive clip and stopAll's restore.
// Every fifth frame each value, each material's version and each node's matrixWorldNeedsUpdate must
// be three's, bit for bit; two paths three cannot bind (a Standard material's sheen, a light's fov)
// must stay unwritten here too.
#include "check.h"
#include "engine/scene/camera.h"
#include "engine/scene/geometries.h"
#include "engine/scene/lights.h"
#include "engine/scene/nodes.h"
#include "scenario.h"

using namespace tn::engine;
using namespace tn::engine::animation;
using namespace tn::engine::animation::scenario;

namespace {

#include "property_tracks_reference.inc"

std::string color(const Color& c) { return join(std::array<double, 3>{c.r, c.g, c.b}); }

void propertyTracks() {
    auto stage = std::make_shared<Object3D>();
    stage->name = "stage";
    auto cubeMaterial = std::make_shared<Material>(MaterialType::Standard);
    cubeMaterial->color.setHex(0x3366cc);
    cubeMaterial->roughness = 0.5;
    cubeMaterial->transparent = true;
    auto cube = std::make_shared<Mesh>(makeBoxGeometry(), cubeMaterial);
    cube->name = "cube";
    auto ballMaterial = std::make_shared<Material>(MaterialType::Phong);
    ballMaterial->color.setHex(0xffffff);
    ballMaterial->shininess = 30;
    auto ball = std::make_shared<Mesh>(makeSphereGeometry(), ballMaterial);
    ball->name = "ball";
    auto sun = std::make_shared<DirectionalLight>(Color().setHex(0xffeedd), 2);
    sun->name = "sun";
    auto cam = std::make_shared<PerspectiveCamera>(50, 1.5, 0.1, 100);
    cam->name = "cam";
    auto empty = std::make_shared<Object3D>();
    empty->name = "empty";
    // Two morph targets, bound by an entire-array track and an element track.
    auto blobGeometry = makeBoxGeometry();
    blobGeometry->morphPositions = {blobGeometry->attributes.at("position"), blobGeometry->attributes.at("position")};
    auto blob = std::make_shared<Mesh>(blobGeometry, std::make_shared<Material>(MaterialType::Standard));
    blob->name = "blob";
    for (Object3D* child :
         std::initializer_list<Object3D*>{cube.get(), ball.get(), sun.get(), cam.get(), empty.get(), blob.get()})
        stage->add(*child);

    const auto flag = [](bool x) { return x ? "1" : "0"; };
    const Replay r = replay(kTracks, kClips, kOps, kDeltas, stage, [&] {
        return "cube:c=" + color(cubeMaterial->color) + ";o=" + bits(cubeMaterial->opacity) +
               ";r=" + bits(cubeMaterial->roughness) + ";v=" + std::to_string(cubeMaterial->version()) +
               "|ball:sh=" + bits(ballMaterial->shininess) + ";em=" + color(ballMaterial->emissive) +
               ";v=" + std::to_string(ballMaterial->version()) + "|sun:i=" + bits(sun->intensity) +
               ";c=" + color(sun->color) + ";m=" + flag(sun->matrixWorldNeedsUpdate) + "|cam:fov=" + bits(cam->fov) +
               ";zoom=" + bits(cam->zoom) + ";m=" + flag(cam->matrixWorldNeedsUpdate) +
               "|empty:v=" + flag(empty->visible()) + ";m=" + flag(empty->matrixWorldNeedsUpdate) +
               "|blob:mi=" + bits(blob->morphTargetInfluences.at(0)) + "," + bits(blob->morphTargetInfluences.at(1)) +
               ";m=" + flag(blob->matrixWorldNeedsUpdate);
    });
    const std::size_t diffs = differences(r.samples, kSamples, "sample");
    std::printf("property tracks: %zu samples, %zu differ\n", r.samples.size(), diffs);
    CHECK(diffs == 0);
    CHECK(cubeMaterial->sheen == 0); // never bound, as in three
}

} // namespace

TN_TEST_MAIN({"property_tracks", propertyTracks})
