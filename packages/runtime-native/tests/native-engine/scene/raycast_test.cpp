// Real three oracle replay; every observed float (including signed zero) is compared as uint64 bits.
#include "engine/foundation/json.h"
#include "engine/scene/raycaster.h"
#include "engine/scene/nodes.h"
#include "engine/scene/material.h"
#include <bit>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <limits>
#include <stdexcept>
using namespace tn::engine;
using J = json::Value;
// CPU-test diagnostics beside raycastTrianglesTested, declared by raycaster.cpp for this suite.
namespace tn::engine { uint64_t raycastMeshesTested(); void resetRaycastMeshesTested();
void raycastNextAfterForTesting(double x, double& up, double& down); }
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

bool sameFloat(double a, double b) { return std::bit_cast<uint64_t>(a) == std::bit_cast<uint64_t>(b); }
template<class V> bool sameVector(const V& a, const V& b) {
    bool same = sameFloat(a.x,b.x) && sameFloat(a.y,b.y);
    if constexpr (std::is_same_v<V,Vector3>) same = same && sameFloat(a.z,b.z);
    return same;
}
template<class V> bool sameOptional(const std::optional<V>& a, const std::optional<V>& b) {
    return a.has_value() == b.has_value() && (!a || sameVector(*a,*b));
}
void sameHits(const std::vector<Intersection>& a, const std::vector<Intersection>& b, const std::string& where) {
    check(a.size() == b.size(),where+" count");
    for (size_t i=0;i<a.size() && i<b.size();++i) {
        const auto& x=a[i]; const auto& y=b[i];
        check(sameFloat(x.distance,y.distance) && sameVector(x.point,y.point) && x.faceIndex==y.faceIndex &&
              x.face.a==y.face.a && x.face.b==y.face.b && x.face.c==y.face.c &&
              sameFloat(x.face.materialIndex,y.face.materialIndex) && sameVector(x.face.normal,y.face.normal) &&
              sameOptional(x.normal,y.normal) && sameOptional(x.uv,y.uv) && sameOptional(x.uv1,y.uv1) &&
              sameVector(x.barycoord,y.barycoord) && x.object==y.object && x.instanceId==y.instanceId && x.index==y.index,
              where+" ordered hit "+std::to_string(i));
    }
}
std::shared_ptr<BufferGeometry> gridGeometry() {
    auto g=std::make_shared<BufferGeometry>();
    std::vector<double> positions, uvs, normals;
    std::vector<uint32_t> indices;
    for (int y=0;y<=100;++y) for (int x=0;x<=100;++x) {
        positions.insert(positions.end(),{double(x),double(y),0});
        uvs.insert(uvs.end(),{x/100.0,y/100.0});
        normals.insert(normals.end(),{x/1000.0,y/1000.0,1});
    }
    for (uint32_t y=0;y<100;++y) for (uint32_t x=0;x<100;++x) {
        const auto a=y*101+x;
        indices.insert(indices.end(),{a,a+1,a+102,a,a+102,a+101});
    }
    g->setAttribute("position",BufferAttribute::fromFloats(positions,3));
    g->setAttribute("uv",BufferAttribute::fromFloats(uvs,2));
    g->setAttribute("uv1",BufferAttribute::fromFloats(uvs,2));
    g->setAttribute("normal",BufferAttribute::fromFloats(normals,3));
    g->setIndexFromArray(indices);
    return g;
}
std::vector<Raycaster> seededRays(size_t count) {
    uint32_t seed=0x573b00;
    const auto random=[&]() { seed=1664525*seed+1013904223; return double(seed)/4294967296.0; };
    std::vector<Raycaster> rays;
    for (size_t i=0;i<count;++i) {
        const double x=random()*120-10, y=random()*120-10;
        const bool back=i%3==0;
        Vector3 direction{i%5==0 ? 0.15 : 0,i%7==0 ? -0.1 : 0,back ? 1.0 : -1.0};
        direction.normalize();
        rays.emplace_back(Vector3{x,y,back ? -10.0 : 10.0},direction,i%11==0 ? 11 : 0,i%13==0 ? 9 : 100);
        if (i%17==0) rays.back().set({50,50,10},{0,0,-1}); // Shared edges and equal-distance hits.
    }
    return rays;
}
void bvhInvalidation() {
    auto g=std::make_shared<BufferGeometry>();
    std::vector<double> positions;
    std::vector<uint32_t> indices;
    for (uint32_t i=0;i<20;++i) {
        const double x=i*10;
        positions.insert(positions.end(),{x,0,0,x+1,0,0,x,1,0});
        indices.insert(indices.end(),{i*3,i*3+1,i*3+2});
    }
    g->setAttribute("position",BufferAttribute::fromFloats(positions,3)); g->setIndexFromArray(indices);
    auto material=std::make_shared<Material>(MaterialType::Basic); material->side=Side::Double;
    Mesh mesh(g,material); mesh.updateMatrixWorld(true);
    Raycaster ray({0.25,0.125,10},{0,0,-1});
    const auto compare=[&](const char* name, size_t count) {
        auto brute=ray; brute.meshBruteForceForTesting=true;
        const auto actual=ray.intersectObject(mesh,false), expected=brute.intersectObject(mesh,false);
        sameHits(actual,expected,name); check(expected.size()==count,std::string(name)+" expected hits");
    };
    compare("BVH initial",1); auto cached=g->raycastBVH;
    compare("BVH reuse",1); check(g->raycastBVH==cached,"BVH reused across rays");
    auto p=g->getAttribute("position");
    p->setXYZ(57,0,0,0); p->setXYZ(58,1,0,0); p->setXYZ(59,0,1,0);
    compare("BVH position write",2); check(g->raycastBVH!=cached,"BVH position writes invalidate"); cached=g->raycastBVH;
    p->setNeedsUpdate(); compare("BVH position version",2);
    check(g->raycastBVH!=cached,"BVH position version invalidates"); cached=g->raycastBVH;
    p=p->clone(); p->setXYZ(57,190,0,0); p->setXYZ(58,191,0,0); p->setXYZ(59,190,1,0);
    g->setAttribute("position",p); compare("BVH position replacement",1);
    check(g->raycastBVH!=cached,"BVH position identity invalidates"); cached=g->raycastBVH;
    p->store=p->clone()->store; compare("BVH store replacement",1);
    check(g->raycastBVH!=cached,"BVH store identity invalidates"); cached=g->raycastBVH;
    g->index->setX(0,57); g->index->setX(1,58); g->index->setX(2,59);
    compare("BVH index write",0); check(g->raycastBVH!=cached,"BVH index writes invalidate"); cached=g->raycastBVH;
    g->index->setNeedsUpdate(); compare("BVH index version",0);
    check(g->raycastBVH!=cached,"BVH index version invalidates"); cached=g->raycastBVH;
    g->setIndexFromArray(indices); compare("BVH index replacement",1);
    check(g->raycastBVH!=cached,"BVH index identity invalidates"); cached=g->raycastBVH;
    g->setDrawRange(3,57); compare("BVH draw start",0);
    check(g->raycastBVH!=cached,"BVH draw start invalidates"); cached=g->raycastBVH;
    g->setDrawRange(0,0); compare("BVH empty draw",0);
    check(g->raycastBVH!=cached,"BVH draw count invalidates");
    g->setDrawRange(0,60); compare("BVH restored draw",1);
    auto morph=p->clone(); morph->setXYZ(3,0,0,0); morph->setXYZ(4,1,0,0); morph->setXYZ(5,0,1,0);
    g->morphPositions.push_back(morph); mesh.morphTargetInfluences={1}; cached=g->raycastBVH;
    compare("BVH morph fallback",2); resetRaycastTrianglesTested(); ray.intersectObject(mesh,false);
    check(raycastTrianglesTested()==20 && g->raycastBVH==cached,"BVH morph scans original triangles");
    mesh.morphTargetInfluences={0}; compare("BVH zero morph reuses cache",1);
    check(g->raycastBVH==cached,"BVH zero morph cache retained");
    g->index=nullptr; compare("BVH index removed",1);
    p->store->resize(57*3); compare("BVH position count",1);
    g->deleteAttribute("position"); compare("BVH missing position",0);
}
void subtreeBvh() {
    auto material=std::make_shared<Material>(MaterialType::Basic); material->side=Side::Double;
    const auto quad=[&]() {
        auto g=std::make_shared<BufferGeometry>();
        g->setAttribute("position",BufferAttribute::fromFloats({-0.5,-0.5,0, 0.5,-0.5,0, 0.5,0.5,0, -0.5,0.5,0},3));
        g->setAttribute("uv",BufferAttribute::fromFloats({0,0,1,0,1,1,0,1},2));
        g->setAttribute("normal",BufferAttribute::fromFloats({0,0,1,0,0,1,0,0,1,0,0,1},3));
        g->setIndexFromArray({0,1,2,0,2,3});
        return g;
    };
    auto root=std::make_shared<Group>();
    std::vector<std::shared_ptr<Object3D>> keep;
    std::vector<Mesh*> meshes;
    uint32_t seed=0x51b7ee;
    const auto random=[&]() { seed=1664525*seed+1013904223; return double(seed)/4294967296.0; };
    // 150 house-like meshes under 10 groups: 8 shadow-free picks a frame walk this subtree every time.
    for(int group=0;group<10;++group) {
        auto holder=std::make_shared<Group>();
        holder->position.set(group*13.0-58.5,(group%3)*3.0-3.0,(group%2)*4.0);
        holder->rotation.set(0,0.15*(group%4),0.05*group);
        holder->scale.set(group%5==0 ? -1 : 1,-1,1);
        for(int m=0;m<15;++m) {
            auto mesh=std::make_shared<Mesh>(quad(),material);
            mesh->name="house-"+std::to_string(group)+"-"+std::to_string(m);
            mesh->position.set((m%5)*2.6-5.2,(m/5)*3.1-3.1,0.6*(m%3));
            mesh->rotation.set(-0.2+0.1*(m%4),0.25*((m+group)%5),0.3*(m%6-3));
            mesh->scale.set(0.8+0.2*(m%3),1.1-0.1*(m%4),1);
            holder->add(*mesh);
            keep.push_back(mesh); meshes.push_back(mesh.get());
        }
        root->add(*holder); keep.push_back(holder);
    }
    // A hidden-layer mesh: the mask is a query-time test, the structure still holds it.
    auto hidden=std::make_shared<Mesh>(quad(),material);
    hidden->name="hidden"; hidden->position.set(-58.5,-3,0.6); hidden->setLayerMask(1u<<1);
    root->add(*hidden); keep.push_back(hidden);
    // An LOD: its own raycast picks a level and still propagates, so it must never be flattened.
    auto lod=std::make_shared<LOD>(); lod->name="lod"; lod->position.set(60,0,0);
    auto nearLevel=std::make_shared<Mesh>(quad(),material); nearLevel->name="lod-near";
    auto farLevel=std::make_shared<Mesh>(quad(),material); farLevel->name="lod-far"; farLevel->position.set(0,1,0);
    keep.push_back(lod); keep.push_back(nearLevel); keep.push_back(farLevel);
    lod->addLevel(*nearLevel,0); lod->addLevel(*farLevel,50);
    root->add(*lod);
    // Two coincident meshes: equal distances make `sort`'s stability, hence visit order, observable.
    auto ties=std::make_shared<Group>(); ties->position.set(0,12,0);
    auto tieA=std::make_shared<Mesh>(quad(),material); tieA->name="tie-a";
    auto tieB=std::make_shared<Mesh>(quad(),material); tieB->name="tie-b";
    ties->add(*tieA); ties->add(*tieB);
    root->add(*ties); keep.push_back(ties); keep.push_back(tieA); keep.push_back(tieB);
    root->updateMatrixWorld(true);
    check(meshes.size()==150,"subtree BVH mesh count");
    std::vector<Raycaster> rays;
    Vector3 hiddenCenter; hiddenCenter.setFromMatrixPosition(hidden->matrixWorld);
    Vector3 tieCenter; tieCenter.setFromMatrixPosition(tieA->matrixWorld);
    for(int i=0;i<128;++i) {
        const bool otherLayer=i%4==3;
        const bool aimed=i%8!=0;
        Vector3 center=hiddenCenter;
        if (!otherLayer) {
            if (i%5==2) center=tieCenter;
            else {
                const auto index=size_t(random()*double(meshes.size()));
                center.setFromMatrixPosition(meshes[index<meshes.size() ? index : 0]->matrixWorld);
            }
        }
        const bool back=i%3==0;
        const Vector3 origin{aimed ? center.x+random()*0.3-0.15 : random()*140-70,
                             aimed ? center.y+random()*0.3-0.15 : random()*20-10,
                             back ? -40.0 : 40.0};
        rays.emplace_back(origin,Vector3{0,0,back ? 1.0 : -1.0});
        if (otherLayer) rays.back().layers.set(1);
        if (i%9==0) { rays.back().near=35; rays.back().far=41; }  // A sliced interval culls by distance too.
    }
    const auto compare=[&](const char* where) {
        size_t observed=0;
        for(size_t i=0;i<rays.size();++i) {
            auto ray=rays[i]; std::vector<Intersection> actual, expected;
            ray.intersectObject(*root,true,actual);
            ray.meshBruteForceForTesting=true; ray.intersectObject(*root,true,expected);
            sameHits(actual,expected,std::string(where)+" ray "+std::to_string(i));
            observed+=expected.size();
        }
        return observed;
    };
    const auto initialHits=compare("subtree BVH initial");
    check(initialHits>80,"subtree BVH initial hits");
    {
        Raycaster tied({tieCenter.x,tieCenter.y,tieCenter.z+40},{0,0,-1});
        auto tiedBrute=tied; tiedBrute.meshBruteForceForTesting=true;
        const auto tiedActual=tied.intersectObject(*root,true), tiedExpected=tiedBrute.intersectObject(*root,true);
        sameHits(tiedActual,tiedExpected,"subtree BVH tie order");
        size_t tieHits=0;
        for(const auto& hit:tiedExpected) if (hit.object==tieA.get() || hit.object==tieB.get()) ++tieHits;
        check(tieHits>=2,"subtree BVH tie hits: "+std::to_string(tieHits));
        std::printf("Subtree BVH tie: %zu hits, tie meshes %zu\n",tiedExpected.size(),tieHits);
    }
    meshes[7]->position.set(meshes[7]->position.x+4.0,meshes[7]->position.y-1.5,meshes[7]->position.z);
    root->updateMatrixWorld(true);
    compare("subtree BVH transform");
    // A raw matrix write with no revision bump: only the stored world matrix can reveal it.
    meshes[23]->matrixWorld.elements[12]+=0.75;
    meshes[23]->matrixWorld.elements[13]-=0.5;
    compare("subtree BVH raw matrix write");
    meshes[40]->geometry=quad();
    compare("subtree BVH geometry replacement");
    auto added=std::make_shared<Group>(); added->position.set(3,9,0);
    auto extra=std::make_shared<Mesh>(quad(),material); extra->name="extra"; extra->position.set(0,0,1.5);
    added->add(*extra); root->add(*added); keep.push_back(added); keep.push_back(extra);
    root->updateMatrixWorld(true);
    compare("subtree BVH add");
    root->remove(*added); root->updateMatrixWorld(true);
    compare("subtree BVH remove");
    // One mesh out of 150: the subtree tree must reject the other branches before their meshes run.
    Vector3 center; center.setFromMatrixPosition(meshes[0]->matrixWorld);
    Raycaster focused({center.x,center.y,center.z+40},{0,0,-1});
    resetRaycastTrianglesTested(); resetRaycastMeshesTested();
    const auto cachedHits=focused.intersectObject(*root,true);
    const auto cachedTriangles=raycastTrianglesTested(), cachedMeshes=raycastMeshesTested();
    auto brute=focused; brute.meshBruteForceForTesting=true;
    resetRaycastTrianglesTested(); resetRaycastMeshesTested();
    const auto bruteHits=brute.intersectObject(*root,true);
    const auto bruteTriangles=raycastTrianglesTested(), bruteMeshes=raycastMeshesTested();
    sameHits(cachedHits,bruteHits,"subtree BVH cost");
    check(cachedHits.size()==1,"subtree BVH cost ray hits one mesh");
    check(cachedMeshes*10<bruteMeshes,"subtree BVH cost: "+std::to_string(cachedMeshes)+" of "+
        std::to_string(bruteMeshes)+" meshes");
    check(cachedTriangles<=bruteTriangles,"subtree BVH cost triangles");
    std::printf("Subtree BVH cost: %llu / %llu meshes, %llu / %llu triangles (%zu hits)\n",
        (unsigned long long)cachedMeshes,(unsigned long long)bruteMeshes,
        (unsigned long long)cachedTriangles,(unsigned long long)bruteTriangles,cachedHits.size());
}
std::string hexBits(uint64_t bits) {
    char text[17]; std::snprintf(text,sizeof(text),"%016llx",(unsigned long long)bits); return text;
}
// The slab test's one-ulp steps, which used to be std::nextafter: every IEEE-754 class, as raw bits.
void nextAfterBits() {
    struct Case { uint64_t bits, up, down; };
    const Case pinned[] = {
        {0x0000000000000000ull, 0x0000000000000001ull, 0x8000000000000001ull},  // +0
        {0x8000000000000000ull, 0x0000000000000001ull, 0x8000000000000001ull},  // -0 is +0's neighbour too
        {0x0000000000000001ull, 0x0000000000000002ull, 0x0000000000000000ull},  // smallest subnormal
        {0x8000000000000001ull, 0x8000000000000000ull, 0x8000000000000002ull},
        {0x000fffffffffffffull, 0x0010000000000000ull, 0x000ffffffffffffeull},  // largest subnormal
        {0x0010000000000000ull, 0x0010000000000001ull, 0x000fffffffffffffull},  // DBL_MIN
        {0x7fefffffffffffffull, 0x7ff0000000000000ull, 0x7feffffffffffffeull},  // DBL_MAX -> +inf
        {0xffefffffffffffffull, 0xffeffffffffffffeull, 0xfff0000000000000ull},  // -DBL_MAX -> -inf
        {0x7ff0000000000000ull, 0x7ff0000000000000ull, 0x7fefffffffffffffull},  // +inf stays on nextUp
        {0xfff0000000000000ull, 0xffefffffffffffffull, 0xfff0000000000000ull},  // -inf stays on nextDown
        {0x7ff8000000000000ull, 0x7ff8000000000000ull, 0x7ff8000000000000ull},  // NaN keeps its payload
        {0xfff8000000000000ull, 0xfff8000000000000ull, 0xfff8000000000000ull},
        {0x3ff0000000000000ull, 0x3ff0000000000001ull, 0x3fefffffffffffffull},  // 1
        {0xbff0000000000000ull, 0xbfefffffffffffffull, 0xbff0000000000001ull},  // -1
    };
    std::vector<uint64_t> patterns;
    for (const auto& c : pinned) {
        patterns.push_back(c.bits);
        double up = 0, down = 0;
        tn::engine::raycastNextAfterForTesting(std::bit_cast<double>(c.bits),up,down);
        check(std::bit_cast<uint64_t>(up) == c.up, "nextUp pinned "+hexBits(c.bits));
        check(std::bit_cast<uint64_t>(down) == c.down, "nextDown pinned "+hexBits(c.bits));
    }
    uint32_t seed = 0x6e7fa7e5u;
    for (int i = 0; i < 512; ++i) {
        seed = 1664525u * seed + 1013904223u;
        const uint64_t high = seed;
        seed = 1664525u * seed + 1013904223u;
        patterns.push_back(high << 32 | seed);
    }
    size_t compared = 0;
    for (const uint64_t bits : patterns) {
        const double x = std::bit_cast<double>(bits);
        if (std::isnan(x)) continue;  // nextafter only promises a NaN for a NaN; the pinned rows pin that.
        double up = 0, down = 0;
        tn::engine::raycastNextAfterForTesting(x,up,down);
        const double next = std::nextafter(x,std::numeric_limits<double>::infinity());
        const double previous = std::nextafter(x,-std::numeric_limits<double>::infinity());
        check(std::bit_cast<uint64_t>(up) == std::bit_cast<uint64_t>(next), "nextUp nextafter "+hexBits(bits));
        check(std::bit_cast<uint64_t>(down) == std::bit_cast<uint64_t>(previous), "nextDown nextafter "+hexBits(bits));
        ++compared;
    }
    check(compared > 512, "nextUp/nextDown oracle not vacuous");
    std::printf("nextUp/nextDown: %zu patterns, %zu oracle comparisons\n",patterns.size(),compared);
}
// Two zero-thickness walls plus a collinear triangle: every triangle box is empty on at least one axis.
std::shared_ptr<BufferGeometry> plates() {
    auto g = std::make_shared<BufferGeometry>();
    g->setAttribute("position",BufferAttribute::fromFloats({0,0,0, 1,0,0, 1,1,0, 0,1,0,          // z = 0
        0,0,-5, 1,0,-5, 1,1,-5, 0,1,-5,                                                      // z = -5
        0,2,0, 1,2,0, 2,2,0},3));                                                            // collinear
    g->setIndexFromArray({0,1,2, 0,2,3, 4,5,6, 4,6,7, 8,9,10});
    return g;
}
void edgeRayBounds() {
    auto material=std::make_shared<Material>(MaterialType::Basic); material->side=Side::Double;
    Mesh mesh(plates(),material); mesh.updateMatrixWorld(true);
    std::vector<Raycaster> rays;
    // Corners, shared edges and interior of a wall with no thickness: the slab test decides before the
    // triangle code ever sees these.
    for (const Vector3& at : {Vector3{0,0,0},Vector3{1,0,0},Vector3{0,1,0},Vector3{1,1,0},Vector3{0,0.5,0},
                              Vector3{0.5,0,0},Vector3{1,0.5,0},Vector3{0.5,1,0},Vector3{0.5,0.5,0},
                              Vector3{0.25,0.75,0}})
        rays.emplace_back(Vector3{at.x,at.y,10},Vector3{0,0,-1});
    rays.emplace_back(Vector3{0.5,0.5,-20},Vector3{0,0,1});              // up through both walls
    rays.emplace_back(Vector3{0.5,0.5,0},Vector3{1,0,0});                // grazing inside the plane
    rays.emplace_back(Vector3{0,0.5,0},Vector3{1,0,0});                  // along a zero-thickness edge
    rays.emplace_back(Vector3{0.75,2,10},Vector3{0,0,-1});               // the collinear triangle's line
    rays.emplace_back(Vector3{1.5,0.5,10},Vector3{-0.0,0.0,-1});         // signed-zero direction, outside x
    rays.emplace_back(Vector3{-0.5,0.5,10},Vector3{-0.0,-0.0,-1});
    rays.emplace_back(Vector3{std::numeric_limits<double>::quiet_NaN(),0.5,10},Vector3{0,0,-1});
    rays.emplace_back(Vector3{std::numeric_limits<double>::infinity(),0.5,10},Vector3{0,0,-1});
    rays.emplace_back(Vector3{-std::numeric_limits<double>::infinity(),0.5,10},Vector3{0,0,-1});
    for (const double d : {5.0,10.0,15.0}) {                             // intervals pinned to the hit planes
        rays.emplace_back(Vector3{0.5,0.5,10},Vector3{0,0,-1},d,d);
        rays.emplace_back(Vector3{0.5,0.5,10},Vector3{0,0,-1},0.0,d);
        rays.emplace_back(Vector3{0.5,0.5,10},Vector3{0,0,-1},d,std::numeric_limits<double>::infinity());
    }
    size_t observed=0;
    for (size_t i=0;i<rays.size();++i) {
        auto ray=rays[i]; std::vector<Intersection> actual, expected;
        ray.intersectObject(mesh,false,actual);
        ray.meshBruteForceForTesting=true; ray.intersectObject(mesh,false,expected);
        sameHits(actual,expected,"edge bounds ray "+std::to_string(i));
        observed+=expected.size();
    }
    check(observed>20,"edge bounds rays hit: "+std::to_string(observed));
    // The interval must bite at its own boundaries: a hit exactly at near and far survives, a hair past
    // either drops. This is what the padded slab and its one-ulp steps exist to keep true.
    const auto count=[&](Vector3 origin,double near,double far) {
        Raycaster probe(origin,Vector3{0,0,-1},near,far); return probe.intersectObject(mesh,false).size();
    };
    const Vector3 offDiagonal{0.25,0.5,10};  // Off the shared diagonal: one triangle per wall.
    check(count({0.5,0.5,10},0,std::numeric_limits<double>::infinity())==4,"edge bounds: both walls, both triangles");
    check(count(offDiagonal,0,std::numeric_limits<double>::infinity())==2,"edge bounds: both walls hit");
    check(count(offDiagonal,10,10)==1,"edge bounds: near == far == the hit distance keeps it");
    check(count(offDiagonal,0,10)==1,"edge bounds: far == the hit distance keeps it");
    check(count(offDiagonal,10+1e-9,std::numeric_limits<double>::infinity())==1,"edge bounds: near past the hit drops it");
    check(count(offDiagonal,0,10-1e-9)==0,"edge bounds: far before the hit drops it");
    std::printf("Edge ray bounds: %zu rays, %zu hits\n",rays.size(),observed);
}
std::shared_ptr<BufferGeometry> unitQuad() {
    auto g=std::make_shared<BufferGeometry>();
    g->setAttribute("position",BufferAttribute::fromFloats({-0.5,-0.5,0, 0.5,-0.5,0, 0.5,0.5,0, -0.5,0.5,0},3));
    g->setAttribute("normal",BufferAttribute::fromFloats({0,0,1,0,0,1,0,0,1,0,0,1},3));
    g->setIndexFromArray({0,1,2,0,2,3});
    return g;
}
// The object-level cache must drop when a leaf moves (through the hierarchy or through a raw world matrix)
// or when a leaf is freed from the group that owned it.
void subtreeInvalidation() {
    auto material=std::make_shared<Material>(MaterialType::Basic); material->side=Side::Double;
    auto root=std::make_shared<Group>();
    std::vector<std::shared_ptr<Group>> holders;
    std::vector<std::shared_ptr<Mesh>> meshes;
    for (int holder=0;holder<4;++holder) {  // 20 bounded leaves: over the 16-mesh threshold, so the tree runs
        auto group=std::make_shared<Group>();
        group->position.set(holder*10.0,0,0);
        for (int m=0;m<5;++m) {
            auto mesh=std::make_shared<Mesh>(unitQuad(),material);
            mesh->name="leaf-"+std::to_string(holder)+"-"+std::to_string(m);
            mesh->position.set(m*2.0,0,0);
            group->add(*mesh);
            meshes.push_back(mesh);
        }
        root->add(*group); holders.push_back(group);
    }
    check(meshes.size()>=16,"subtree invalidation: leaf count "+std::to_string(meshes.size()));
    root->updateMatrixWorld(true);
    // One ray per live leaf, aimed at its current world centre: a stale box turns into a missing hit.
    const auto compare=[&](const char* where) {
        size_t observed=0, index=0;
        for (const auto& mesh : meshes) {
            if (!mesh) continue;
            Vector3 center; center.setFromMatrixPosition(mesh->matrixWorld);
            Raycaster ray({center.x,center.y,center.z+20},{0,0,-1});
            std::vector<Intersection> actual, expected;
            ray.intersectObject(*root,true,actual);
            ray.meshBruteForceForTesting=true; ray.intersectObject(*root,true,expected);
            sameHits(actual,expected,std::string(where)+" leaf "+std::to_string(index++));
            observed+=expected.size();
        }
        return observed;
    };
    // A cached walk that visited every mesh would pass the comparisons above while proving nothing.
    const auto cost=[&](const char* where) {
        Vector3 center; center.setFromMatrixPosition(meshes[0]->matrixWorld);
        Raycaster probe({center.x,center.y,center.z+20},{0,0,-1});
        resetRaycastMeshesTested(); const auto cachedHits=probe.intersectObject(*root,true);
        const auto cachedMeshes=raycastMeshesTested();
        probe.meshBruteForceForTesting=true;
        resetRaycastMeshesTested(); const auto bruteHits=probe.intersectObject(*root,true);
        const auto bruteMeshes=raycastMeshesTested();
        sameHits(cachedHits,bruteHits,where);
        bool oneLeaf=!cachedHits.empty();
        for (const auto& hit : cachedHits) oneLeaf=oneLeaf && hit.object==cachedHits.front().object;
        check(oneLeaf,std::string(where)+" hits one leaf");
        check(cachedMeshes*2<bruteMeshes,std::string(where)+": "+std::to_string(cachedMeshes)+" of "+
            std::to_string(bruteMeshes)+" meshes");
    };
    check(compare("subtree invalidation initial")>0,"subtree invalidation initial hits");
    cost("subtree invalidation tree engaged");
    meshes[6]->matrixWorld.elements[12]+=3.0;  // A raw world write: no revision, no hierarchy version.
    check(compare("subtree invalidation raw matrix move")>0,"subtree invalidation raw move hits");
    cost("subtree invalidation tree after raw move");
    meshes[11]->position.set(meshes[11]->position.x+1.25,meshes[11]->position.y+0.75,meshes[11]->position.z);
    root->updateMatrixWorld(true);
    check(compare("subtree invalidation position move")>0,"subtree invalidation position move hits");
    std::weak_ptr<Object3D> freed=meshes[13];
    holders[2]->remove(*meshes[13]);
    meshes[13].reset();
    check(freed.expired(),"subtree invalidation: freed leaf destroyed");
    check(compare("subtree invalidation freed leaf")>0,"subtree invalidation freed leaf hits");
    cost("subtree invalidation tree after free");
    meshes[17]->matrixWorld.elements[12]-=2.5;  // The rebuilt tree must still notice a later move.
    check(compare("subtree invalidation move after free")>0,"subtree invalidation rebuilt move hits");
    cost("subtree invalidation tree after rebuild");
    std::printf("Subtree BVH invalidation: %zu leaves, 3 moves, 1 free\n",meshes.size());
}
int nextAfterBounds() {
    const int start=differ; nextAfterBits(); edgeRayBounds();
    std::printf("nextUp/nextDown and edge ray bounds: %d differ\n",differ-start); return differ ? 1 : 0;
}
int subtreeBvhInvalidation() {
    const int start=differ; subtreeInvalidation();
    std::printf("Subtree BVH invalidation: %d differ\n",differ-start); return differ ? 1 : 0;
}
int bvh() {
    const int oracleStart=differ;
    const auto rays=seededRays(256);
    size_t hitRays=0,missRays=0;
    for (int variant=0;variant<8;++variant) {
        auto g=gridGeometry();
        if (variant==1) g=g->toNonIndexed();
        if (variant==2) g->setDrawRange(15003,30000);
        auto material=std::make_shared<Material>(MaterialType::Basic);
        material->side=variant==3 ? Side::Back : variant>=4 ? Side::Double : Side::Front;
        Mesh mesh(g,material);
        if (variant>=5) {
            mesh.scale.set(variant==6 ? -2 : 2,0.25,3);
            mesh.rotation.set(0.3,-0.6,0.2); mesh.position.set(1e6,-2e6,3e6);
        }
        mesh.updateMatrixWorld(true);
        if (variant==7) mesh.matrixWorld.elements[4]+=0.4; // Shear, not just TRS.
        for (size_t i=0;i<rays.size();++i) {
            auto r=rays[i]; std::vector<Intersection> actual, expected;
            if (variant>=5) {
                r.ray.origin.applyMatrix4(mesh.matrixWorld);
                r.ray.direction.transformDirection(mesh.matrixWorld);
            }
            r.intersectObject(mesh,false,actual);
            r.meshBruteForceForTesting=true; r.intersectObject(mesh,false,expected);
            sameHits(actual,expected,"bvh variant "+std::to_string(variant)+" ray "+std::to_string(i));
            if (expected.empty()) ++missRays; else ++hitRays;
        }
    }
    check(hitRays>0 && missRays>0,"BVH oracle hits and misses");
    std::printf("BVH oracle: 2048 rays, %zu hit rays, %zu miss rays, %d differ\n",hitRays,missRays,differ-oracleStart);
    const int invalidationStart=differ; bvhInvalidation();
    std::printf("BVH invalidation and morph fallback: %d differ\n",differ-invalidationStart);
    const int subtreeStart=differ; subtreeBvh();
    std::printf("Subtree BVH oracle: %d differ\n",differ-subtreeStart);
    auto g=gridGeometry(); auto material=std::make_shared<Material>(MaterialType::Basic);
    material->side=Side::Double; Mesh mesh(g,material); mesh.updateMatrixWorld(true);
    Raycaster focused({50.25,50.125,10},{0,0,-1});
    resetRaycastTrianglesTested(); const auto focusHits=focused.intersectObject(mesh,false);
    const auto tested=raycastTrianglesTested();
    check(!focusHits.empty(),"BVH cost ray hits");
    check(tested<400,"BVH cost: triangles tested < 400 (2% of 20000)");
    std::printf("BVH cost: %llu / 20000 triangles (%.4f%%)\n",(unsigned long long)tested,100.0*tested/20000);
    const auto benchmark=seededRays(1000);
    const auto measure=[&](bool brute) {
        resetRaycastTrianglesTested();
        const auto start=std::chrono::steady_clock::now(); size_t hits=0;
        for (auto r:benchmark) { r.meshBruteForceForTesting=brute; hits+=r.intersectObject(mesh,false).size(); }
        const double ms=std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now()-start).count();
        std::printf("BVH benchmark %s: 1000 rays, %.3f ms, %llu triangles, %zu hits\n",brute ? "brute" : "cached",ms,(unsigned long long)raycastTrianglesTested(),hits);
    };
    measure(true); measure(false);
    return differ ? 1 : 0;
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
    try {
        if (argc>1 && std::string(argv[1])=="lod") return lod();
        if (argc>1 && std::string(argv[1])=="nextafter_bounds") return nextAfterBounds();
        if (argc>1 && std::string(argv[1])=="subtree_bvh_invalidation") return subtreeBvhInvalidation();
        const int reference=raycaster(); return bvh() || reference;
    }
    catch(const std::exception& e) { std::printf("FAIL: %s\n",e.what()); return 1; }
}
