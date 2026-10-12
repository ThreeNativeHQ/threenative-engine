// Real three oracle replay; every observed float (including signed zero) is compared as uint64 bits.
#include "engine/foundation/json.h"
#include "engine/scene/raycaster.h"
#include "engine/scene/nodes.h"
#include "engine/scene/material.h"
#include <bit>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <stdexcept>
using namespace tn::engine;
using J = json::Value;
namespace {
const J& field(const J& v, const char* name) {
    const auto* f = v.find(name); if (!f) throw std::runtime_error(std::string("missing ") + name); return *f;
}
double number(const J& v, const char* name, double fallback) { const auto* f = v.find(name); return f ? f->number() : fallback; }
bool flag(const J& v, const char* name, bool fallback) { const auto* f = v.find(name); return f ? f->boolean() : fallback; }
Vector3 vector(const J& v) { return {v.items().at(0).number(), v.items().at(1).number(), v.items().at(2).number()}; }
std::shared_ptr<BufferGeometry> geometry(const J& s) {
    auto g = std::make_shared<BufferGeometry>();
    g->setAttribute("position", BufferAttribute::fromFloats({-1,-1,0, 1,-1,0, 1,1,0, -1,1,0}, 3));
    g->setIndexFromArray({0,1,2,0,2,3});
    if (flag(s, "channels", true)) {
        g->setAttribute("uv", BufferAttribute::fromFloats({0,0,1,0,1,1,0,1}, 2));
        g->setAttribute("uv1", BufferAttribute::fromFloats({0.1,0.2,0.8,0.3,0.7,0.9,0.2,0.8}, 2));
        g->setAttribute("normal", BufferAttribute::fromFloats({0,0,1,0.2,0,0.8,0,0.3,1,-0.2,0,0.9}, 3));
    }
    if (!flag(s, "indexed", true)) g = g->toNonIndexed();
    if (flag(s, "morph", false)) {
        const auto pos = g->getAttribute("position");
        std::vector<double> m;
        for (uint64_t i = 0; i < pos->count(); ++i) { m.push_back(pos->getX(i)); m.push_back(pos->getY(i)); m.push_back(0.5); }
        g->morphPositions.push_back(BufferAttribute::fromFloats(m, 3));
    }
    if (flag(s, "box", false)) g->computeBoundingBox();
    if (flag(s, "clippedBox", false)) { g->boundingBox = std::make_shared<Box3>(); g->boundingBox->set({-1,-1,-1},{-0.5,1,1}); }
    if (const auto* f = s.find("sphere")) g->boundingSphere = std::make_shared<Sphere>(Vector3{}, f->number());
    if (const auto* f = s.find("draw")) g->setDrawRange(f->items().at(0).number(), f->items().at(1).number());
    return g;
}
std::shared_ptr<Object3D> build(const J& s) {
    const auto kind = field(s,"kind").string();
    std::shared_ptr<Object3D> o;
    if (kind == "group") o = std::make_shared<Group>();
    else {
        auto g = geometry(s); auto m = std::make_shared<Material>(MaterialType::Basic);
        m->side = Side(int(number(s,"side",0)));
        if (kind == "line" || kind == "segments") {
            m->lineMaterial = true;
            if (kind == "line") o = std::make_shared<Line>(g, m);
            else o = std::make_shared<LineSegments>(g, m);
        } else if (kind == "instanced") {
            auto mesh = std::make_shared<InstancedMesh>(g,m,3);
            for (int i = 0; i < 3; ++i) {
                Matrix4 matrix; matrix.makeRotationY(i * 0.2); matrix.setPosition(Vector3{double(i * 3), 0, double(-i)}); mesh->setMatrixAt(i, matrix);
            }
            o = mesh;
        } else {
            auto mesh = std::make_shared<Mesh>(g,m);
            if (flag(s,"morph",false)) mesh->morphTargetInfluences[0] = 0.4;
            o = mesh;
        }
    }
    o->name = field(s,"name").string();
    if (const auto* f = s.find("position")) o->position = vector(*f);
    if (const auto* f = s.find("scale")) o->scale = vector(*f);
    if (const auto* f = s.find("rotation")) { auto v = vector(*f); o->rotation.set(v.x,v.y,v.z); }
    o->setLayerMask(uint32_t(1) << int(number(s,"layer",0)));
    o->setVisible(flag(s,"visible",true));
    if (const auto* f = s.find("children")) for (const auto& child : f->items()) o->add(*build(child));
    return o;
}
int differ = 0;
void check(bool okay, const std::string& where) { if (!okay) { ++differ; std::printf("  differs: %s\n", where.c_str()); } }
void floating(double got, const J& expected, const std::string& where) {
    const auto bits = std::stoull(expected.string(), nullptr, 16);
    const auto actual = std::bit_cast<uint64_t>(got);
    if (bits != actual) { ++differ; std::printf("  %s expected %016llx got %016llx\n", where.c_str(), (unsigned long long)bits, (unsigned long long)actual); }
}
template<class V> void vec(const V& got, const J& expected, const std::string& where) {
    floating(got.x, expected.items().at(0), where+".x"); floating(got.y, expected.items().at(1), where+".y");
    if constexpr (std::is_same_v<V, Vector3>) floating(got.z, expected.items().at(2), where+".z");
}
template<class V> void optional(const std::optional<V>& got, const J& expected, const std::string& where) {
    check(got.has_value() == !expected.isNull(), where+" presence");
    if (got && !expected.isNull()) vec(*got, expected, where);
}
void hits(const std::vector<Intersection>& got, const J& expected, const std::string& where) {
    check(got.size() == expected.items().size(), where+" hit count");
    for (size_t i=0; i<got.size() && i<expected.items().size(); ++i) {
        const auto& h=got[i]; const auto& e=expected.items()[i]; const auto at=where+"["+std::to_string(i)+"]";
        floating(h.distance,field(e,"distance"),at+" distance"); vec(h.point,field(e,"point"),at+" point");
        check(h.object && h.object->name == field(e,"object").string(),at+" object");
        // A Line hit: its segment index; face, faceIndex and barycoord are null.
        check(h.index.has_value() == !field(e,"index").isNull(),at+" index presence");
        if (h.index) {
            check(*h.index == field(e,"index").number(),at+" index");
            check(field(e,"face").isNull() && field(e,"faceIndex").isNull() && field(e,"barycoord").isNull(),at+" line nulls");
            continue;
        }
        check(h.faceIndex == field(e,"faceIndex").number(),at+" faceIndex");
        const auto& f=field(e,"face");
        check(h.face.a==field(f,"a").number() && h.face.b==field(f,"b").number() && h.face.c==field(f,"c").number(),at+" face vertices");
        check(h.face.materialIndex == field(f,"materialIndex").number(),at+" materialIndex");
        vec(h.face.normal,field(f,"normal"),at+" face.normal");
        optional(h.uv,field(e,"uv"),at+" uv"); optional(h.uv1,field(e,"uv1"),at+" uv1"); optional(h.normal,field(e,"normal"),at+" normal");
        vec(h.barycoord,field(e,"barycoord"),at+" barycoord");
        check(h.instanceId.has_value() == !field(e,"instanceId").isNull(),at+" instanceId presence");
        if(h.instanceId) check(*h.instanceId == field(e,"instanceId").number(),at+" instanceId");
    }
}
J read(const char* path) {
    std::ifstream in(path); const std::string text((std::istreambuf_iterator<char>(in)), {});
    J value; json::Error error;
    if (!json::parse(text,value,error)) throw std::runtime_error(std::string("cannot parse ")+path);
    return value;
}
int raycaster() {
    const auto table=read(TN_RAYCASTER_REFERENCE); auto scene=build(field(table,"scene")); scene->updateMatrixWorld(true);
    int count=0, observations=0;
    for(const auto& test:field(table,"rays").items()) {
        Raycaster r(vector(field(test,"origin")),vector(field(test,"direction")),field(test,"near").number(),field(test,"far").number());
        r.layers.set(int(field(test,"layer").number()));
        auto* target=scene->getObjectByName(field(test,"target").string());
        if (!target) throw std::runtime_error("missing ray target");
        const auto got=field(test,"multiple").boolean() ? r.intersectObjects(scene->children,field(test,"recursive").boolean()) : r.intersectObject(*target,field(test,"recursive").boolean());
        observations += int(got.size()); hits(got,field(test,"hits"),field(test,"name").string()); ++count;
    }
    for (const auto& test : field(table,"cameraCases").items()) {
        std::shared_ptr<Camera> camera;
        if (field(test,"kind").string() == "perspective") {
            auto p = std::make_shared<PerspectiveCamera>(53,1.7,0.3,200); p->zoom = 1.8; p->updateProjectionMatrix(); camera = p;
        } else {
            auto p = std::make_shared<OrthographicCamera>(-3,5,4,-2,0.3,200); p->zoom = 1.8; p->updateProjectionMatrix(); camera = p;
        }
        camera->position.set(1,2,3); camera->rotation.set(0.1,0.2,0.3); camera->updateMatrixWorld(true);
        Raycaster caster;
        const auto& coords = field(test,"coords").items();
        check(caster.setFromCamera({coords.at(0).number(), coords.at(1).number()}, *camera),"setFromCamera success");
        check(caster.camera == camera.get(), "camera identity");
        vec(caster.ray.origin,field(test,"origin"),"camera ray origin"); vec(caster.ray.direction,field(test,"direction"),"camera ray direction");
    }
    for (const auto& test : field(table,"layerCases").items()) {
        Layers layers, other; layers.mask = std::bit_cast<double>(std::stoull(field(test,"mask").string(),nullptr,16));
        const int layer = int(field(test,"layer").number()); const auto op = field(test,"operation").string();
        if (op == "set") layers.set(layer); else if (op == "enable") layers.enable(layer);
        else if (op == "enableAll") layers.enableAll(); else if (op == "disable") layers.disable(layer);
        else if (op == "toggle") layers.toggle(layer);
        other.set(layer); floating(layers.mask,field(test,"expected"),"layer mask");
        check(layers.test(other)==field(test,"test").boolean(),"layer test");
        check(layers.isEnabled(layer)==field(test,"enabled").boolean(),"layer enabled");
    }
    check(count>=30 && observations>0,"ray table not vacuous");
    std::printf("raycaster: %d rays, %d hits, %d differ\n",count,observations,differ); return differ ? 1 : 0;
}
int lod() {
    const auto table=read(TN_LOD_REFERENCE); int count=0;
    for(const auto& scene:field(table,"scenes").items()) {
        LOD lod; lod.position.set(0,0,-2); std::vector<std::shared_ptr<Mesh>> keep;
        for(const auto& level:field(scene,"levels").items()) {
            J spec=J::makeObject({{"name",field(level,"name")},{"kind",J::makeString("mesh")},{"side",J::makeNumber(2)}});
            auto mesh=std::dynamic_pointer_cast<Mesh>(build(spec)); keep.push_back(mesh);
            lod.addLevel(*mesh,field(level,"distance").number(),field(level,"hysteresis").number());
        }
        lod.updateMatrixWorld(true);
        const auto& sorted=field(scene,"sorted").items(); check(lod.levels.size()==sorted.size(),"sorted count");
        for(size_t i=0;i<sorted.size();++i) {
            check(lod.levels[i].object->name==field(sorted[i],"name").string(),"level order");
            floating(lod.levels[i].distance,field(sorted[i],"distance"),"level distance"); floating(lod.levels[i].hysteresis,field(sorted[i],"hysteresis"),"level hysteresis");
        }
        PerspectiveCamera camera;
        for(const auto& test:field(scene,"cases").items()) {
            const double distance=field(test,"distance").number(); camera.zoom=field(test,"zoom").number();
            camera.position.set(0,0,distance-2); camera.updateMatrixWorld(true);
            lod.autoUpdate=field(test,"autoUpdate").boolean();
            if(lod.autoUpdate || field(test,"explicit").boolean()) lod.update(camera);
            const auto where="lod-"+std::to_string(int(field(scene,"count").number()))+"-"+std::to_string(count);
            check(lod.getCurrentLevel()==field(test,"current").number(),where+" current");
            auto* selected=lod.getObjectForDistance(distance);
            check(selected ? selected->name==field(test,"selected").string() : field(test,"selected").isNull(),where+" selected");
            for(size_t i=0;i<lod.levels.size();++i) check(lod.levels[i].object->visible()==field(test,"visible").items().at(i).boolean(),where+" visibility");
            Raycaster r({0.2,-0.3,distance-2},{0,0,-1});
            hits(r.intersectObject(lod,false),field(test,"hits"),where); hits(r.intersectObject(lod,true),field(test,"recursiveHits"),where+" recursive"); ++count;
        }
    }
    check(count>=12,"lod table not vacuous"); std::printf("lod: %d cases, %d differ\n",count,differ); return differ ? 1 : 0;
}
}
int main(int argc,char** argv) {
    try { return argc>1 && std::string(argv[1])=="lod" ? lod() : raycaster(); }
    catch(const std::exception& e) { std::printf("FAIL: %s\n",e.what()); return 1; }
}
