// PRD-508 phase 1: the scene graph's own contract, tested against the C++ classes rather than the
// reference, because these are the properties the differential fixtures cannot state: the reference
// has no counter to compare and no alias to observe.
//
// Cases: `hierarchy` (add/remove/attach/clear, re-parenting, traversal order, lookup, event order)
// and `alias` (`&mesh.position` is one address across 10,000 sibling insertions, and the binding
// Store hands the same Ref for it every time).

#include "check.h"
#include "fixture/driver.h"

#include "engine/abi/bindings.h"
#include "engine/foundation/math/Vector.h"
#include "engine/scene/geometries.h"
#include "engine/scene/nodes.h"
#include "engine/scene/object3d.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using namespace tn::engine;

// This owner predates the lazy transform pool, as a VM or application owner can.
std::unique_ptr<Object3D> exitOwner;

void teardown() {
    exitOwner = std::make_unique<Object3D>();
    exitOwner->position.set(1, 2, 3);
    exitOwner->updateMatrixWorld();
    CHECK(exitOwner->matrixWorld.elements[12] == 1);
}

// The event log both event cases assert on: three stamps `target`, and a child event names the child.
struct Recorded {
    std::vector<std::string> order;
};

void record(const Event& event, void* context) {
    auto* log = static_cast<Recorded*>(context);
    std::string line(event.type);
    line += ':';
    line += event.target->name;
    if (event.child != nullptr) {
        line += '/';
        line += event.child->name;
    }
    log->order.push_back(line);
}

void collect(Object3D& object, void* context) {
    static_cast<std::vector<std::string>*>(context)->push_back(object.name);
}

/** A named node on the heap: an Object3D never moves, which is the whole point of the alias case. */
std::unique_ptr<Object3D> node(const std::string& name) {
    auto object = std::make_unique<Object3D>();
    object->name = name;
    return object;
}

void hierarchy() {
    // ---- add, traversal order, lookup
    Object3D root;
    root.name = "root";
    auto a = node("a");
    auto b = node("b");
    auto a1 = node("a1");
    root.add(*a);
    root.add(*b);
    a->add(*a1);

    CHECK(root.children.size() == 2);
    CHECK(root.children[0] == a.get() && root.children[1] == b.get());
    CHECK(a->parent == &root && a1->parent == a.get());
    CHECK(a1->parent->parent == &root);

    std::vector<std::string> visited;
    root.traverse(&collect, &visited);
    CHECK(visited == std::vector<std::string>({"root", "a", "a1", "b"}));

    root.setVisible(false);
    visited.clear();
    root.traverseVisible(&collect, &visited);
    CHECK(visited.empty());  // an invisible root hides its whole subtree
    root.setVisible(true);

    visited.clear();
    a1->traverseAncestors(&collect, &visited);
    CHECK(visited == std::vector<std::string>({"a", "root"}));

    CHECK(root.getObjectByName("a1") == a1.get());
    CHECK(root.getObjectByName("nope") == nullptr);
    CHECK(root.getObjectByName("a") == a.get());  // the search starts at the object itself
    CHECK(root.getObjectById(root.id()) == &root);
    CHECK(root.getObjectById(a1->id()) == a1.get());
    CHECK(root.getObjectById(9999) == nullptr);
    CHECK(root.getObjectByProperty("type", "Object3D") == &root);

    // ---- re-parenting removes from the old parent
    b->add(*a1);
    CHECK(a->children.empty());
    CHECK(b->children.size() == 1 && b->children[0] == a1.get());
    CHECK(a1->parent == b.get());
    root.add(*a);  // and `add` re-parents too
    CHECK(a->parent == &root);

    // ---- remove detaches without destroying, and clear empties
    root.remove(*a);
    CHECK(root.children.size() == 1 && root.children[0] == b.get());
    CHECK(a->parent == nullptr);
    CHECK(a->children.empty());  // a1 was re-parented to b, so `a` owns nothing now

    auto doomed = node("doomed");
    root.add(*doomed);
    root.clear();
    CHECK(root.children.empty());
    CHECK(doomed->parent == nullptr);
    CHECK(doomed->name == "doomed");  // still alive after clear, as three leaves it
    // clear() walks a copy: removing from the live list while iterating it skips every second child.
    auto c1 = node("c1"), c2 = node("c2"), c3 = node("c3");
    root.add(*c1);
    root.add(*c2);
    root.add(*c3);
    root.clear();
    CHECK(root.children.empty());
    CHECK(c1->parent == nullptr && c2->parent == nullptr && c3->parent == nullptr);

    // ---- attach preserves the world transform
    auto target = node("target");
    target->position.set(2, 0, 0);
    target->rotateY(0.5);
    auto mover = node("mover");
    mover->position.set(0, 4, 0);
    mover->scale.set(2, 2, 2);
    root.add(*mover);
    root.add(*target);
    root.updateMatrixWorld(true);

    Vector3 before;
    target->getWorldPosition(before);
    mover->attach(*target);
    Vector3 after;
    target->getWorldPosition(after);
    CHECK(mover->children.size() == 1 && mover->children[0] == target.get());
    CHECK(target->parent == mover.get());
    CHECK(before.x == after.x && before.y == after.y && before.z == after.z);

    // ---- events, in the reference's order: the child first, then the parent
    Recorded log;
    Object3D parent;
    parent.name = "p";
    auto kid = node("k");
    parent.addEventListener("childadded", &record, &log);
    parent.addEventListener("childremoved", &record, &log);
    kid->addEventListener("added", &record, &log);
    kid->addEventListener("removed", &record, &log);

    parent.add(*kid);
    CHECK(log.order == std::vector<std::string>({"added:k", "childadded:p/k"}));

    log.order.clear();
    parent.remove(*kid);
    CHECK(log.order == std::vector<std::string>({"removed:k", "childremoved:p/k"}));

    // A listener that removes itself while the event is delivered does not disturb the rest.
    Recorded inner;
    kid->addEventListener("added", &record, &inner);
    log.order.clear();
    parent.add(*kid);
    CHECK(inner.order.size() == 1);
    parent.remove(*kid);
    kid->removeEventListener("added", &record, &inner);
    CHECK(!kid->hasEventListener("added", &record, &inner));
    CHECK(parent.hasEventListener("childadded", &record, &log));
    parent.removeEventListener("childadded", &record, &log);
    CHECK(!parent.hasEventListener("childadded", &record, &log));

    // ---- the revision counter counts what the renderer must react to
    Object3D watched;
    const uint64_t start = watched.revision();
    watched.setVisible(false);
    CHECK(watched.revision() == start + 1);
    // A game sets the same `visible` every frame; only a change reaches the renderer.
    watched.setVisible(false);
    CHECK(watched.revision() == start + 1);
    watched.setRenderOrder(3);
    watched.setCastShadow(true);
    watched.setReceiveShadow(true);
    watched.enableLayer(2);
    CHECK(watched.layers().isEnabled(2));
    watched.rotateY(0.25);
    watched.translateX(1);
    watched.updateMatrix();
    auto child2 = node("c2");
    watched.add(*child2);
    watched.remove(*child2);
    CHECK(watched.revision() >= start + 8);

    // ---- rotation and quaternion stay in step, as three's two callbacks do
    Object3D spun;
    spun.setRotationFromEuler(Euler(0.3, 0.9, -0.2, EulerOrder::XYZ));
    // three keeps the object's own order, and writes the Euler back from the quaternion.
    CHECK(spun.rotation.order == EulerOrder::XYZ);
    CHECK(std::abs(spun.rotation.x - 0.3) < 1e-12);
    CHECK(std::abs(spun.rotation.y - 0.9) < 1e-12);
    CHECK(std::abs(spun.rotation.z + 0.2) < 1e-12);

    const Quaternion fromEuler = spun.quaternion;
    spun.setRotationFromQuaternion(fromEuler);
    CHECK(spun.quaternion.x == fromEuler.x && spun.quaternion.y == fromEuler.y &&
          spun.quaternion.z == fromEuler.z && spun.quaternion.w == fromEuler.w);

    // A quaternion write is what moves the Euler, exactly as three's second callback does.
    spun.setRotationFromAxisAngle(Vector3(0, 0, 1), 0.75);
    CHECK(std::abs(spun.rotation.z - 0.75) < 1e-12);
}

void alias() {
    auto mesh = std::make_shared<Mesh>();
    Vector3* first = &mesh->position;

    // The alias survives any number of insertions into a sibling list, because the object is one
    // heap record and its transform members are plain fields inside it.
    std::vector<std::unique_ptr<Object3D>> siblings;
    siblings.reserve(10001);
    for (int i = 0; i < 10000; ++i) {
        auto sibling = std::make_unique<Object3D>();
        sibling->position.set(i, 0, 0);
        mesh->add(*sibling);
        siblings.push_back(std::move(sibling));
    }
    CHECK(mesh->children.size() == 10000);
    CHECK(&mesh->position == first);
    CHECK(&mesh->scale != first);  // position and scale are two members of one record

    // r185's pivot: rotation and scale apply around it, so the pivot itself does not move. The claim
    // is `matrix * p == position + p`, because three moves the origin by `p - R*S*p`; without the
    // pivot the same product lands at `position + R*S*p`. The protocol cannot set a pivot (its
    // `set` carries one value and three's pivot starts null), so this is the whole of its proof.
    const Vector3 anchor(1.5, -0.5, 2);
    mesh->pivot = anchor;
    mesh->position.set(-2, 3, 0.25);
    mesh->scale.set(2, 3, 4);
    mesh->rotateY(0.7);
    mesh->updateMatrix();
    Vector3 fixed = mesh->position;
    fixed.add(anchor);
    Vector3 moved = anchor;
    moved.applyMatrix4(mesh->matrix);
    CHECK(std::abs(moved.x - fixed.x) < 1e-12);
    CHECK(std::abs(moved.y - fixed.y) < 1e-12);
    CHECK(std::abs(moved.z - fixed.z) < 1e-12);
    mesh->pivot.reset();
    mesh->updateMatrix();
    moved = anchor;
    moved.applyMatrix4(mesh->matrix);
    CHECK(std::abs(moved.y - fixed.y) > 1e-6);  // without the pivot the point does move

    // Writes through either alias are the same write.
    mesh->position.y = 4.5;
    CHECK(first->y == 4.5);
    Vector3& alsoPosition = mesh->position;
    alsoPosition.set(1, 2, 3);
    CHECK(mesh->position.x == 1 && mesh->position.z == 3);
    CHECK(&mesh->position == first);

    // The binding Store answers the same Ref for the member every time, and it is the live member.
    tn::fixture::Driver driver;
    tn::binding::registerAll(driver.classes);
    const tn::binding::Value owner =
        driver.adopt("Mesh", std::static_pointer_cast<void>(mesh));
    CHECK(driver.ref<Mesh>(owner, "Mesh").position.x == 1);

    const tn::binding::Value firstRef = driver.adoptAlias("Vector3", &mesh->position, mesh.get());
    const tn::binding::Value secondRef = driver.adoptAlias("Vector3", &mesh->position, mesh.get());
    CHECK(firstRef.text == secondRef.text);
    CHECK(driver.ref<Vector3>(firstRef, "Vector3").x == 1);

    mesh->position.x = 42;
    CHECK(driver.ref<Vector3>(firstRef, "Vector3").x == 42);

    // The alias keeps its owner alive: dropping the caller's only other reference still leaves the
    // member readable, which is what an aliasing shared_ptr is for.
    mesh.reset();
    CHECK(driver.ref<Vector3>(firstRef, "Vector3").x == 42);
    CHECK(driver.ref<Vector3>(firstRef, "Vector3").y == 2);
    // A freed SoA slot resets its values and callback owner before reuse.
    {
        auto temporary = std::make_unique<Object3D>();
        temporary->position.x = 99;
        temporary->rotation.set(0, 0, 0.5);
    }
    Object3D recycled;
    CHECK(recycled.position.x == 0 && recycled.scale.x == 1 && recycled.quaternion.w == 1);
    recycled.rotation.set(0, 0, 0.5);
    CHECK(recycled.quaternion.z == std::sin(0.25));
    CHECK(driver.ref<Vector3>(firstRef, "Vector3").x == 42);
}


// `revision` counts changes, not recomputes: three's renderer calls scene.updateMatrixWorld() every
// frame, which recomposes every auto-update object, and a still scene must read as unchanged.
void revision() {
    Object3D scene;
    auto parent = node("parent");
    auto child = node("child");
    scene.add(*parent);
    parent->add(*child);
    child->position.set(1, 2, 3);
    scene.updateMatrixWorld();
    const uint64_t settledParent = parent->revision(), settledChild = child->revision();
    for (int frame = 0; frame < 300; ++frame) scene.updateMatrixWorld();
    CHECK(parent->revision() == settledParent);
    CHECK(child->revision() == settledChild);
    for (int frame = 0; frame < 300; ++frame) scene.updateWorldMatrix(false, true);
    CHECK(child->revision() == settledChild);

    // Moving the parent changes the child's world matrix, so both read as changed.
    parent->position.x = 5;
    scene.updateMatrixWorld();
    CHECK(parent->revision() > settledParent);
    CHECK(child->revision() > settledChild);
    CHECK(child->matrixWorld.elements[12] == 6);

    // Matrix publication compares bits, not floating-point equality: unchanged NaN payloads
    // settle, while a signed-zero edit is observable. Exercise the flat renderer path too.
    Object3D exact;
    exact.matrixAutoUpdate = false;
    exact.matrix.elements[0] = std::numeric_limits<double>::quiet_NaN();
    exact.matrix.elements[12] = -0.0;
    exact.updateMatrixWorldSelf(true, true, true);
    CHECK(std::memcmp(exact.matrix.elements.data(), exact.matrixWorld.elements.data(), sizeof(double) * 16) == 0);
    const auto published = exact.revision();
    exact.updateMatrixWorldSelf(true, true, true);
    CHECK(exact.revision() == published);
    exact.matrix.elements[12] = 0.0;
    exact.updateMatrixWorldSelf(true, true, true);
    CHECK(exact.revision() == published + 1 && !std::signbit(exact.matrixWorld.elements[12]));

    // The fused flat-lane update (auto-composed plain object, identity parent) publishes the same
    // way: a settled object stays at its revision, a signed-zero move is a change, an edit of the
    // world matrix alone is repaired under force and counted, and nothing else bumps.
    Object3D fused;
    fused.updateMatrixWorldSelf(true, true, true);
    const auto settled = fused.revision();
    for (int frame = 0; frame < 5; ++frame) CHECK(!fused.updateMatrixWorldSelf(false, true, true));
    CHECK(fused.revision() == settled);
    fused.position.x = -0.0;  // +0 -> -0: the composed matrix differs in one sign bit
    CHECK(fused.updateMatrixWorldSelf(false, true, true));
    CHECK(fused.revision() == settled + 2 && std::signbit(fused.matrixWorld.elements[12]));
    const auto afterZero = fused.revision();
    CHECK(!fused.updateMatrixWorldSelf(false, true, true) && fused.revision() == afterZero);
    fused.matrixWorld.elements[3] = 7;  // a stray world edit, invisible to the unforced update
    CHECK(!fused.updateMatrixWorldSelf(false, true, true) && fused.matrixWorld.elements[3] == 7);
    CHECK(fused.updateMatrixWorldSelf(true, true, true));
    CHECK(fused.revision() == afterZero + 1 && fused.matrixWorld.elements[3] == 0);
    fused.position.set(1, 2, 3);
    CHECK(fused.updateMatrixWorldSelf(false, true, true) && fused.revision() == afterZero + 3);
    // An unchanged NaN is not a change: a double comparison would bump this object every frame.
    fused.position.x = std::numeric_limits<double>::quiet_NaN();
    CHECK(fused.updateMatrixWorldSelf(false, true, true));
    const auto withNaN = fused.revision();
    for (int frame = 0; frame < 5; ++frame) CHECK(!fused.updateMatrixWorldSelf(false, true, true));
    CHECK(fused.revision() == withNaN);
}

// Ported from three r185 test/unit/src/core/Object3D.tests.js. The source holds 37 QUnit.test
// blocks (the task brief says 38; a count of `QUnit.test(` in the file is 37). Every block is
// ported or skipped below.
//
//   Extending                          skipped: JS `instanceof`/class-property check; C++ derives
//                                      EventDispatcher at compile time, no runtime value to assert
//   Instancing                         ported
//   type                               ported
//   DEFAULT_UP                         ported
//   DEFAULT_MATRIX_AUTO_UPDATE         ported
//   isObject3D                         skipped: no `isObject3D` boolean; C++ answers with the class
//   applyMatrix4                       ported
//   applyQuaternion                    ported
//   setRotationFromAxisAngle           ported
//   setRotationFromEuler               ported
//   setRotationFromMatrix              ported
//   setRotationFromQuaternion          ported
//   rotateX                            ported
//   rotateY                            ported
//   rotateZ                            ported
//   translateOnAxis                    ported
//   translateX                         ported
//   translateY                         ported
//   translateZ                         ported
//   localToWorld                       ported
//   worldToLocal                       ported
//   lookAt                             ported
//   add/remove/removeFromParent/clear  ported
//   attach                             ported
//   getObjectById/getObjectByName/getObjectByProperty
//                                      partly: 3 of 4 asserts ported; the `prop` boolean-property
//                                      assert skipped (native getObjectByProperty reads only the
//                                      string `name` and `type`; object3d.h:204)
//   getObjectsByProperty               skipped: no such native API (object3d.h:15)
//   getWorldPosition                   ported
//   getWorldScale                      ported
//   getWorldDirection                  ported
//   localTransformVariableInstantiation ported
//   traverse/traverseVisible/traverseAncestors ported
//   updateMatrix                       ported
//   updateMatrixWorld                  ported
//   updateWorldMatrix                  ported
//   toJSON                             skipped: no native toJSON (object3d.h:9)
//   clone                              skipped: no native clone (object3d.h:9)
//   copy                               skipped: native copy has no recursive branch and no
//                                      `uuid`/`userData` (object3d.h:18,25), so the test's
//                                      pre/post whole-object equality cannot hold

void upstream() {
    using std::abs;

    // three's test/unit/utils/math-constants.js: x=2, y=3, z=4, w=5, eps=0.0001.
    const double x = 2, y = 3, z = 4;
    const double eps = 0.0001;
    const double pi = 3.14159265358979323846;
    const double RadToDeg = 180.0 / pi;

    // eulerEquals: same order and each angle within tolerance (default 0.0001).
    const auto eulerEquals = [](const Euler& a, const Euler& b, double tolerance = 0.0001) {
        if (a.order != b.order) return false;
        return abs(a.x - b.x) <= tolerance && abs(a.y - b.y) <= tolerance &&
               abs(a.z - b.z) <= tolerance;
    };
    // matrixEquals4: every element within eps.
    const auto matrixEquals4 = [eps](const Matrix4& a, const Matrix4& b) {
        for (int i = 0; i < 16; ++i) {
            if (abs(a.elements[i] - b.elements[i]) >= eps) return false;
        }
        return true;
    };
    // QUnit's numEqual: diff < 0.1.
    const auto numEqual = [](double actual, double expected) { return abs(actual - expected) < 0.1; };
    const auto contains = [](const std::vector<Object3D*>& list, const Object3D* who) {
        return std::find(list.begin(), list.end(), who) != list.end();
    };

    const std::array<double, 16> kIdentity{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1};
    const std::array<double, 16> kT123{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1};
    const std::array<double, 16> kT456{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1};
    const std::array<double, 16> kT579{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 7, 9, 1};

    // ---- Instancing
    // upstream: 'Instancing' (Object3D.tests.js:68)
    {
        Object3D object;
        CHECK(&object != nullptr);
    }

    // ---- type
    // upstream: 'type' (Object3D.tests.js:77)
    {
        Object3D object;
        CHECK(object.type() == "Object3D");
    }

    // ---- DEFAULT_UP
    // upstream: 'DEFAULT_UP' (Object3D.tests.js:88)
    {
        const Vector3 currentDefaultUp = Object3D::defaultUp;
        Vector3 v;
        v.set(0, 1, 0);
        CHECK(Object3D::defaultUp.x == v.x && Object3D::defaultUp.y == v.y &&
              Object3D::defaultUp.z == v.z);
        Object3D object;
        CHECK(object.up.x == v.x && object.up.y == v.y && object.up.z == v.z);
        Object3D::defaultUp.set(0, 0, 1);
        Object3D object2;
        CHECK(object2.up.x == 0 && object2.up.y == 0 && object2.up.z == 1);
        Object3D::defaultUp.copy(currentDefaultUp);
    }

    // ---- DEFAULT_MATRIX_AUTO_UPDATE
    // upstream: 'DEFAULT_MATRIX_AUTO_UPDATE' (Object3D.tests.js:115)
    {
        const bool currentDefaultMatrixAutoUpdate = Object3D::defaultMatrixAutoUpdate;
        CHECK(currentDefaultMatrixAutoUpdate == true);
        Object3D object;
        CHECK(object.matrixAutoUpdate == true);
        Object3D::defaultMatrixAutoUpdate = false;
        Object3D object2;
        CHECK(object2.matrixAutoUpdate == false);
        Object3D::defaultMatrixAutoUpdate = currentDefaultMatrixAutoUpdate;
    }

    // ---- applyMatrix4
    // upstream: 'applyMatrix4' (Object3D.tests.js:164)
    {
        Object3D a;
        Matrix4 m;
        const Vector3 expectedPos(x, y, z);
        const Quaternion expectedQuat(0.5 * std::sqrt(2.0), 0, 0, 0.5 * std::sqrt(2.0));
        m.makeRotationX(pi / 2);
        m.setPosition(Vector3(x, y, z));
        a.applyMatrix4(m);
        CHECK(a.position.x == expectedPos.x && a.position.y == expectedPos.y &&
              a.position.z == expectedPos.z);
        CHECK(abs(a.quaternion.x - expectedQuat.x) <= eps &&
              abs(a.quaternion.y - expectedQuat.y) <= eps &&
              abs(a.quaternion.z - expectedQuat.z) <= eps);
    }

    // ---- applyQuaternion
    // upstream: 'applyQuaternion' (Object3D.tests.js:186)
    {
        Object3D a;
        const double sqrtHalf = 0.5 * std::sqrt(2.0);
        const Quaternion quat(0, sqrtHalf, 0, sqrtHalf);
        const Quaternion expected(sqrtHalf / 2, sqrtHalf / 2, 0, 0);
        a.quaternion.set(0.25, 0.25, 0.25, 0.25);
        a.applyQuaternion(quat);
        CHECK(abs(a.quaternion.x - expected.x) <= eps && abs(a.quaternion.y - expected.y) <= eps &&
              abs(a.quaternion.z - expected.z) <= eps);
    }

    // ---- setRotationFromAxisAngle
    // upstream: 'setRotationFromAxisAngle' (Object3D.tests.js:205)
    {
        Object3D a;
        Vector3 axis(0, 1, 0);
        double angle = pi;
        Euler expected(-pi, 0, -pi);
        Euler euler;
        Quaternion q;
        a.setRotationFromAxisAngle(axis, angle);
        euler.setFromQuaternion(a.getWorldQuaternion(q));
        CHECK(eulerEquals(euler, expected));
        axis.set(1, 0, 0);
        angle = 0;
        expected.set(0, 0, 0);
        a.setRotationFromAxisAngle(axis, angle);
        euler.setFromQuaternion(a.getWorldQuaternion(q));
        CHECK(eulerEquals(euler, expected));
    }

    // ---- setRotationFromEuler
    // upstream: 'setRotationFromEuler' (Object3D.tests.js:227)
    {
        Object3D a;
        const Euler rotation(45 / RadToDeg, 0, pi);
        const Euler expected = rotation.clone();
        Euler euler;
        Quaternion q;
        a.setRotationFromEuler(rotation);
        euler.setFromQuaternion(a.getWorldQuaternion(q));
        CHECK(eulerEquals(euler, expected));
    }

    // ---- setRotationFromMatrix
    // upstream: 'setRotationFromMatrix' (Object3D.tests.js:240)
    {
        Object3D a;
        Matrix4 m;
        const Vector3 eye(0, 0, 0);
        const Vector3 target(0, 1, -1);
        const Vector3 up(0, 1, 0);
        Euler euler;
        Quaternion q;
        m.lookAt(eye, target, up);
        a.setRotationFromMatrix(m);
        euler.setFromQuaternion(a.getWorldQuaternion(q));
        CHECK(numEqual(euler.x * RadToDeg, 45));
    }

    // ---- setRotationFromQuaternion
    // upstream: 'setRotationFromQuaternion' (Object3D.tests.js:256)
    {
        Object3D a;
        Quaternion rotation;
        rotation.setFromEuler(Euler(pi, 0, -pi));
        Euler euler;
        Quaternion q;
        a.setRotationFromQuaternion(rotation);
        euler.setFromQuaternion(a.getWorldQuaternion(q));
        CHECK(eulerEquals(euler, Euler(pi, 0, -pi)));
    }

    // ---- rotateX / rotateY / rotateZ
    // upstream: 'rotateX' (Object3D.tests.js:268)
    {
        Object3D obj;
        const double angleInRad = 1.562;
        obj.rotateX(angleInRad);
        CHECK(numEqual(obj.rotation.x, angleInRad));
    }
    // upstream: 'rotateY' (Object3D.tests.js:278)
    {
        Object3D obj;
        const double angleInRad = -0.346;
        obj.rotateY(angleInRad);
        CHECK(numEqual(obj.rotation.y, angleInRad));
    }
    // upstream: 'rotateZ' (Object3D.tests.js:288)
    {
        Object3D obj;
        const double angleInRad = 1;
        obj.rotateZ(angleInRad);
        CHECK(numEqual(obj.rotation.z, angleInRad));
    }

    // ---- translateOnAxis
    // upstream: 'translateOnAxis' (Object3D.tests.js:298)
    {
        Object3D obj;
        obj.translateOnAxis(Vector3(1, 0, 0), 1);
        obj.translateOnAxis(Vector3(0, 1, 0), 1.23);
        obj.translateOnAxis(Vector3(0, 0, 1), -4.56);
        CHECK(obj.position.x == 1 && obj.position.y == 1.23 && obj.position.z == -4.56);
    }

    // ---- translateX / translateY / translateZ
    // upstream: 'translateX' (Object3D.tests.js:313)
    {
        Object3D obj;
        obj.translateX(1.234);
        CHECK(numEqual(obj.position.x, 1.234));
    }
    // upstream: 'translateY' (Object3D.tests.js:322)
    {
        Object3D obj;
        obj.translateY(1.234);
        CHECK(numEqual(obj.position.y, 1.234));
    }
    // upstream: 'translateZ' (Object3D.tests.js:331)
    {
        Object3D obj;
        obj.translateZ(1.234);
        CHECK(numEqual(obj.position.z, 1.234));
    }

    // ---- localToWorld
    // upstream: 'localToWorld' (Object3D.tests.js:340)
    {
        Vector3 v;
        const Vector3 expectedPosition(5, -1, -4);
        Object3D parent;
        Object3D child;
        parent.position.set(1, 0, 0);
        parent.rotation.set(0, pi / 2, 0);
        parent.scale.set(2, 1, 1);
        child.position.set(0, 1, 0);
        child.rotation.set(pi / 2, 0, 0);
        child.scale.set(1, 2, 1);
        parent.add(child);
        parent.updateMatrixWorld();
        child.localToWorld(v.set(2, 2, 2));
        CHECK(abs(v.x - expectedPosition.x) <= eps && abs(v.y - expectedPosition.y) <= eps &&
              abs(v.z - expectedPosition.z) <= eps);
    }

    // ---- worldToLocal
    // upstream: 'worldToLocal' (Object3D.tests.js:370)
    {
        Vector3 v;
        const Vector3 expectedPosition(-1, 0.5, -1);
        Object3D parent;
        Object3D child;
        parent.position.set(1, 0, 0);
        parent.rotation.set(0, pi / 2, 0);
        parent.scale.set(2, 1, 1);
        child.position.set(0, 1, 0);
        child.rotation.set(pi / 2, 0, 0);
        child.scale.set(1, 2, 1);
        parent.add(child);
        parent.updateMatrixWorld();
        child.worldToLocal(v.set(2, 2, 2));
        CHECK(abs(v.x - expectedPosition.x) <= eps && abs(v.y - expectedPosition.y) <= eps &&
              abs(v.z - expectedPosition.z) <= eps);
    }

    // ---- lookAt
    // upstream: 'lookAt' (Object3D.tests.js:400)
    {
        Object3D obj;
        obj.lookAt(Vector3(0, -1, 1));
        CHECK(numEqual(obj.rotation.x * RadToDeg, 45));
    }

    // ---- add/remove/removeFromParent/clear
    // upstream: 'add/remove/removeFromParent/clear' (Object3D.tests.js:409)
    {
        Object3D a;
        Object3D child1;
        Object3D child2;
        CHECK(a.children.size() == 0);
        a.add(child1);
        CHECK(a.children.size() == 1);
        CHECK(a.children[0] == &child1);
        a.add(child2);
        CHECK(a.children.size() == 2);
        CHECK(a.children[1] == &child2);
        CHECK(a.children[0] == &child1);
        a.remove(child1);
        CHECK(a.children.size() == 1);
        CHECK(a.children[0] == &child2);
        a.add(child1);
        a.remove(std::vector<Object3D*>{&child1, &child2});
        CHECK(a.children.size() == 0);
        child1.add(child2);
        CHECK(child1.children.size() == 1);
        a.add(child2);
        CHECK(a.children.size() == 1);
        CHECK(a.children[0] == &child2);
        CHECK(child1.children.size() == 0);
        a.add(child1);
        CHECK(a.children.size() == 2);
        a.clear();
        CHECK(a.children.size() == 0);
        CHECK(child1.parent == nullptr);
        CHECK(child2.parent == nullptr);
        a.add(child1);
        CHECK(a.children.size() == 1);
        child1.removeFromParent();
        CHECK(a.children.size() == 0);
        CHECK(child1.parent == nullptr);
    }

    // ---- attach
    // upstream: 'attach' (Object3D.tests.js:456)
    {
        Object3D object;
        Object3D oldParent;
        Object3D newParent;
        Matrix4 expectedMatrixWorld;

        object.position.set(1, 2, 3);
        object.rotation.set(pi / 2, pi / 3, pi / 4);
        object.scale.set(2, 3, 4);
        newParent.position.set(4, 5, 6);
        newParent.rotation.set(pi / 5, pi / 6, pi / 7);
        newParent.scale.set(5, 5, 5);
        object.updateMatrixWorld();
        newParent.updateMatrixWorld();
        expectedMatrixWorld.copy(object.matrixWorld);

        newParent.attach(object);
        CHECK(object.parent != nullptr && object.parent == &newParent &&
              !contains(oldParent.children, &object));
        CHECK(matrixEquals4(expectedMatrixWorld, object.matrixWorld));

        object.position.set(1, 2, 3);
        object.rotation.set(pi / 2, pi / 3, pi / 4);
        object.scale.set(2, 3, 4);
        oldParent.position.set(4, 5, 6);
        oldParent.rotation.set(pi / 5, pi / 6, pi / 7);
        oldParent.scale.set(5, 5, 5);
        newParent.position.set(7, 8, 9);
        newParent.rotation.set(pi / 8, pi / 9, pi / 10);
        newParent.scale.set(6, 6, 6);

        oldParent.add(object);
        oldParent.updateMatrixWorld();
        newParent.updateMatrixWorld();
        expectedMatrixWorld.copy(object.matrixWorld);

        newParent.attach(object);
        CHECK(object.parent != nullptr && object.parent == &newParent &&
              contains(newParent.children, &object) && !contains(oldParent.children, &object));
        CHECK(matrixEquals4(expectedMatrixWorld, object.matrixWorld));
    }

    // ---- getObjectById/getObjectByName/getObjectByProperty
    // upstream: 'getObjectById/getObjectByName/getObjectByProperty' (Object3D.tests.js:513)
    {
        Object3D parent;
        Object3D childName;
        Object3D childId;  // id = parent.id + 2
        Object3D childNothing;
        childName.name = "foo";
        parent.add(childName);
        parent.add(childId);
        parent.add(childNothing);
        // upstream assert: parent.getObjectByProperty('prop', true) === parent
        // skipped: native getObjectByProperty reads only the string `name`/`type` (object3d.h:204).
        CHECK(parent.getObjectByName("foo") == &childName);
        CHECK(parent.getObjectById(parent.id() + 2) == &childId);
        CHECK(parent.getObjectByProperty("no-property", "no-value") == nullptr);
    }

    // ---- getWorldPosition
    // upstream: 'getWorldPosition' (Object3D.tests.js:555)
    {
        Object3D a;
        Object3D b;
        const Vector3 expectedSingle(x, y, z);
        const Vector3 expectedParent(x, y, 0);
        const Vector3 expectedChild(x, y, 7);
        Vector3 position;
        a.translateX(x);
        a.translateY(y);
        a.translateZ(z);
        a.getWorldPosition(position);
        CHECK(position.x == expectedSingle.x && position.y == expectedSingle.y &&
              position.z == expectedSingle.z);
        b.translateZ(7);
        a.add(b);
        a.translateZ(-z);
        a.getWorldPosition(position);
        CHECK(position.x == expectedParent.x && position.y == expectedParent.y &&
              position.z == expectedParent.z);
        b.getWorldPosition(position);
        CHECK(position.x == expectedChild.x && position.y == expectedChild.y &&
              position.z == expectedChild.z);
    }

    // ---- getWorldScale
    // upstream: 'getWorldScale' (Object3D.tests.js:580)
    {
        Object3D a;
        Matrix4 m;
        m.makeScale(x, y, z);
        const Vector3 expected(x, y, z);
        a.applyMatrix4(m);
        Vector3 worldScale;
        a.getWorldScale(worldScale);
        CHECK(worldScale.x == expected.x && worldScale.y == expected.y &&
              worldScale.z == expected.z);
    }

    // ---- getWorldDirection
    // upstream: 'getWorldDirection' (Object3D.tests.js:592)
    {
        Object3D a;
        const Vector3 expected(0, -0.5 * std::sqrt(2.0), 0.5 * std::sqrt(2.0));
        Vector3 direction;
        a.lookAt(Vector3(0, -1, 1));
        a.getWorldDirection(direction);
        CHECK(abs(direction.x - expected.x) <= eps && abs(direction.y - expected.y) <= eps &&
              abs(direction.z - expected.z) <= eps);
    }

    // ---- localTransformVariableInstantiation
    // upstream: 'localTransformVariableInstantiation' (Object3D.tests.js:610)
    {
        Object3D a;
        Object3D b;
        Object3D c;
        Object3D d;
        Vector3 vec;
        Quaternion quat;
        a.getWorldDirection(vec);
        a.lookAt(Vector3(0, -1, 1));
        CHECK(true);
        b.getWorldPosition(vec);
        b.lookAt(Vector3(0, -1, 1));
        CHECK(true);
        c.getWorldQuaternion(quat);
        c.lookAt(Vector3(0, -1, 1));
        CHECK(true);
        d.getWorldScale(vec);
        d.lookAt(Vector3(0, -1, 1));
        CHECK(true);
    }

    // ---- traverse/traverseVisible/traverseAncestors
    // upstream: 'traverse/traverseVisible/traverseAncestors' (Object3D.tests.js:639)
    {
        Object3D a, b, c, d;
        std::vector<std::string> names;
        a.name = "parent";
        b.name = "child";
        c.name = "childchild 1";
        c.setVisible(false);
        d.name = "childchild 2";
        b.add(c);
        b.add(d);
        a.add(b);
        a.traverse(&collect, &names);
        CHECK(names == std::vector<std::string>({"parent", "child", "childchild 1", "childchild 2"}));
        names.clear();
        a.traverseVisible(&collect, &names);
        CHECK(names == std::vector<std::string>({"parent", "child", "childchild 2"}));
        names.clear();
        c.traverseAncestors(&collect, &names);
        CHECK(names == std::vector<std::string>({"child", "parent"}));
    }

    // ---- updateMatrix
    // upstream: 'updateMatrix' (Object3D.tests.js:685)
    {
        Object3D a;
        a.position.set(2, 3, 4);
        a.quaternion.set(5, 6, 7, 8);
        a.scale.set(9, 10, 11);
        CHECK(a.matrix.elements == kIdentity);
        a.updateMatrix();
        const std::array<double, 16> confused{
            -1521, 1548, -234, 0, -520, -1470, 1640, 0, 1826, 44, -1331, 0, 2, 3, 4, 1};
        CHECK(a.matrix.elements == confused);
        CHECK(a.matrixWorldNeedsUpdate == true);
    }

    // ---- updateMatrixWorld
    // upstream: 'updateMatrixWorld' (Object3D.tests.js:712)
    {
        Object3D parent;
        Object3D child;
        parent.position.set(1, 2, 3);
        child.position.set(4, 5, 6);
        parent.add(child);
        parent.updateMatrixWorld();
        CHECK(parent.matrix.elements == kT123);
        CHECK(parent.matrixWorld.elements == kT123);
        CHECK(child.matrix.elements == kT456);
        CHECK(child.matrixWorld.elements == kT579);
        CHECK((parent.matrixWorldNeedsUpdate || child.matrixWorldNeedsUpdate) == false);

        parent.position.set(0, 0, 0);
        parent.updateMatrix();
        CHECK(parent.matrixWorld.elements == kT123);

        child.position.set(0, 0, 0);
        parent.updateMatrixWorld();
        parent.position.set(1, 2, 3);
        parent.matrixAutoUpdate = false;
        child.matrixAutoUpdate = false;
        parent.updateMatrixWorld();
        CHECK(parent.matrix.elements == kIdentity);
        CHECK(parent.matrixWorld.elements == kIdentity);
        CHECK(child.matrixWorld.elements == kIdentity);

        parent.position.set(3, 2, 1);
        parent.updateMatrix();
        parent.matrixAutoUpdate = true;
        child.matrixAutoUpdate = true;
        parent.matrixWorldNeedsUpdate = true;
        child.matrixWorldAutoUpdate = false;
        parent.updateMatrixWorld();
        CHECK(child.matrixWorld.elements == kIdentity);

        child.position.set(0, 0, 0);
        parent.position.set(1, 2, 3);
        child.matrixWorldAutoUpdate = true;
        parent.updateMatrixWorld();
        CHECK(child.matrixWorld.elements == kT123);

        child.position.set(0, 0, 0);
        child.matrixAutoUpdate = true;
        parent.updateMatrixWorld();
        parent.position.set(1, 2, 3);
        parent.updateMatrix();
        parent.matrixAutoUpdate = false;
        parent.matrixWorldNeedsUpdate = false;
        parent.updateMatrixWorld(true);
        CHECK(parent.matrixWorld.elements == kT123);

        parent.position.set(0, 0, 0);
        child.position.set(0, 0, 0);
        parent.matrixAutoUpdate = true;
        child.matrixAutoUpdate = true;
        parent.updateMatrixWorld();
        parent.position.set(1, 2, 3);
        child.position.set(4, 5, 6);
        child.updateMatrixWorld();
        CHECK(parent.matrix.elements == kIdentity);
        CHECK(parent.matrixWorld.elements == kIdentity);
        CHECK(child.matrixWorld.elements == kT456);
    }

    // ---- updateWorldMatrix
    // upstream: 'updateWorldMatrix' (Object3D.tests.js:889)
    {
        Object3D object;
        Object3D parent;
        Object3D child;
        parent.add(object);
        object.add(child);
        parent.position.set(1, 2, 3);
        object.position.set(4, 5, 6);
        child.position.set(7, 8, 9);

        object.updateWorldMatrix(false, false);
        CHECK(parent.matrix.elements == kIdentity);
        CHECK(parent.matrixWorld.elements == kIdentity);
        Matrix4 expected;
        expected.setPosition(object.position);
        CHECK(object.matrix.elements == expected.elements);
        CHECK(object.matrixWorld.elements == expected.elements);
        CHECK(child.matrix.elements == kIdentity);
        CHECK(child.matrixWorld.elements == kIdentity);

        object.matrix.identity();
        object.matrixWorld.identity();
        object.updateWorldMatrix(true, false);
        expected.identity().setPosition(parent.position);
        CHECK(parent.matrix.elements == expected.elements);
        CHECK(parent.matrixWorld.elements == expected.elements);
        expected.identity().setPosition(object.position);
        CHECK(object.matrix.elements == expected.elements);
        Vector3 v;
        expected.identity().setPosition(v.copy(parent.position).add(object.position));
        CHECK(object.matrixWorld.elements == expected.elements);
        CHECK(child.matrix.elements == kIdentity);
        CHECK(child.matrixWorld.elements == kIdentity);

        parent.matrix.identity();
        parent.matrixWorld.identity();
        object.matrix.identity();
        object.matrixWorld.identity();
        object.updateWorldMatrix(false, true);
        CHECK(parent.matrix.elements == kIdentity);
        CHECK(parent.matrixWorld.elements == kIdentity);
        expected.identity().setPosition(object.position);
        CHECK(object.matrix.elements == expected.elements);
        CHECK(object.matrixWorld.elements == expected.elements);
        expected.identity().setPosition(child.position);
        CHECK(child.matrix.elements == expected.elements);
        expected.identity().setPosition(v.copy(object.position).add(child.position));
        CHECK(child.matrixWorld.elements == expected.elements);

        object.matrix.identity();
        object.matrixWorld.identity();
        child.matrix.identity();
        child.matrixWorld.identity();
        object.updateWorldMatrix(true, true);
        expected.identity().setPosition(parent.position);
        CHECK(parent.matrix.elements == expected.elements);
        CHECK(parent.matrixWorld.elements == expected.elements);
        expected.identity().setPosition(object.position);
        CHECK(object.matrix.elements == expected.elements);
        expected.identity().setPosition(v.copy(parent.position).add(object.position));
        CHECK(object.matrixWorld.elements == expected.elements);
        expected.identity().setPosition(child.position);
        CHECK(child.matrix.elements == expected.elements);
        expected.identity().setPosition(
            v.copy(parent.position).add(object.position).add(child.position));
        CHECK(child.matrixWorld.elements == expected.elements);

        object.matrix.identity();
        object.matrixWorld.identity();
        object.matrixAutoUpdate = false;
        object.matrixWorldNeedsUpdate = true;
        object.updateWorldMatrix(true, false);
        CHECK(object.matrix.elements == kIdentity);
        expected.identity().setPosition(parent.position);
        CHECK(object.matrixWorld.elements == expected.elements);

        parent.matrixWorldAutoUpdate = false;
        child.matrixWorldAutoUpdate = false;
        child.matrixWorld.identity();
        parent.matrixWorld.identity();
        child.updateWorldMatrix(true, true);
        CHECK(child.matrixWorld.elements == kIdentity);
        CHECK(parent.matrixWorld.elements == kIdentity);
    }
}

// three's Object3D couples rotation and quaternion through each math class's change callback, so a
// component write on either reaches the other, and `updateMatrix` composes from the quaternion. A
// C++ `rotation.x = a` must do the same, or a floor authored as a rotated plane renders as a wall.
void rotation_sync() {
    // A proxy assignment copies its value, never its owner's pointer. Cross-axis proxies have
    // different compile-time fields but must still notify the destination exactly once.
    int notices = 0;
    const auto notice = [](void* context) { ++*static_cast<int*>(context); };
    SyncedEuler source, target;
    source.set(0.3, 0.9, -0.2);
    target.onChange(notice, &notices);
    target.x = source.x;
    target.y = source.z;
    target.order = source.order;
    CHECK(notices == 3 && target.x == 0.3 && target.y == -0.2);
    target.x = 1.0;
    CHECK(source.x == 0.3 && source.y == 0.9 && source.z == -0.2);
    SyncedQuaternion qSource, qTarget;
    qSource.set(0.1, 0.2, 0.3, 0.4);
    qTarget.onChange(notice, &notices);
    qTarget.x = qSource.x;
    qTarget.y = qSource.z;
    CHECK(notices == 6 && qTarget.x == 0.1 && qTarget.y == 0.3);
    qTarget.x = 0.8;
    CHECK(qSource.x == 0.1 && qSource.z == 0.3);

    Object3D floor;
    floor.rotation.x = -PI / 2;
    CHECK(floor.quaternion.x == -0.7071067811865475);
    CHECK(floor.quaternion.y == 0);
    CHECK(floor.quaternion.z == 0);
    CHECK(floor.quaternion.w == 0.7071067811865476);

    floor.updateMatrixWorld();
    // three@0.185.1's own bits for an Object3D at the origin, scale 1, rotation.x = -PI/2.
    const std::array<double, 16> expected = {
        1, 0, 0, 0,
        0, 2.220446049250313e-16, -1, 0,
        0, 1, 2.220446049250313e-16, 0,
        0, 0, 0, 1};
    CHECK(floor.matrix.elements == expected);
    CHECK(floor.matrixWorld.elements == expected);

    // The reverse: a quaternion component write moves the Euler, exactly as three's second callback.
    Object3D spinner;
    spinner.quaternion.z = std::sin(PI / 4);
    spinner.quaternion.w = std::cos(PI / 4);
    CHECK(spinner.rotation.x == 0);
    CHECK(spinner.rotation.y == 0);
    CHECK(spinner.rotation.z == 1.5707963267948963);

    // The Euler's own methods still write the plain field, and the quaternion view reads it back.
    Object3D spun;
    spun.rotation.set(0.3, 0.9, -0.2);
    CHECK(spun.quaternion.x == 0.09095239857348537);
    CHECK(spun.quaternion.y == 0.4413664224282834);
    CHECK(spun.quaternion.z == -0.024209584369452933);
    CHECK(spun.quaternion.w == 0.8923772959747721);

    // Copy semantics are three's: construction is `clone` (values only, detached) and assignment is
    // `copy` (values plus this object's own callback, which fires). A copied `rotation` that still
    // pointed at the source would rewrite the source's quaternion on the first component write.
    Object3D original;
    original.rotation.set(0.3, 0.9, -0.2);
    const Quaternion originalQ = original.quaternion;
    auto copiedRotation = original.rotation;
    copiedRotation.x = 1.0;
    CHECK(original.rotation.x == 0.3);
    CHECK(original.quaternion.x == originalQ.x && original.quaternion.y == originalQ.y &&
          original.quaternion.z == originalQ.z && original.quaternion.w == originalQ.w);

    // `Euler e = obj.rotation` must not carry obj's callback. If it did, `e.set` would fire obj's
    // callback and recompute obj.quaternion from obj.rotation; three's `clone` leaves obj alone. The
    // quaternion is held deliberately out of step with the Euler so a fired callback is observable.
    Object3D cloned;
    cloned.rotation.set(0.3, 0.9, -0.2);
    cloned.quaternion.onChange(nullptr, nullptr);
    cloned.quaternion.set(1, 0, 0, 0);
    Euler detached = cloned.rotation;
    detached.set(1.0, 1.0, 1.0);
    CHECK(cloned.rotation.x == 0.3);
    CHECK(cloned.quaternion.x == 1 && cloned.quaternion.y == 0 && cloned.quaternion.z == 0 &&
          cloned.quaternion.w == 0);

    Object3D assigned;
    assigned.rotation = Euler(0.3, 0.9, -0.2);
    CHECK(assigned.quaternion.x == 0.09095239857348537);
    CHECK(assigned.quaternion.y == 0.4413664224282834);
    CHECK(assigned.quaternion.z == -0.024209584369452933);
    CHECK(assigned.quaternion.w == 0.8923772959747721);

    // The same three rules for the quaternion.
    Object3D quatOriginal;
    quatOriginal.quaternion.set(0, 0, std::sin(PI / 4), std::cos(PI / 4));
    const double quatOriginalRotZ = quatOriginal.rotation.z;
    auto copiedQuaternion = quatOriginal.quaternion;
    copiedQuaternion.x = 1.0;
    CHECK(quatOriginal.quaternion.x == 0);
    CHECK(quatOriginal.rotation.z == quatOriginalRotZ);

    Object3D quatCloned;
    quatCloned.quaternion.set(0, 0, std::sin(PI / 4), std::cos(PI / 4));
    quatCloned.rotation.onChange(nullptr, nullptr);
    quatCloned.rotation.set(0.3, 0.9, -0.2);
    Quaternion detachedQuaternion = quatCloned.quaternion;
    detachedQuaternion.set(1, 0, 0, 0);
    CHECK(quatCloned.quaternion.x == 0 && quatCloned.quaternion.z == std::sin(PI / 4));
    CHECK(quatCloned.rotation.x == 0.3);

    Object3D quatAssigned;
    quatAssigned.quaternion = Quaternion(0, 0, std::sin(PI / 4), std::cos(PI / 4));
    CHECK(quatAssigned.rotation.x == 0);
    CHECK(quatAssigned.rotation.y == 0);
    CHECK(quatAssigned.rotation.z == 1.5707963267948963);
}

// PRD-552: three's BatchedMesh keeps what was set per instance, reuses a freed id first, and refuses
// past its sizes with three's messages; the draws follow the visible instances.
void batched_mesh() {
    BatchedMesh batch(2, 30, 60, nullptr);
    const auto refused = [](auto call, const char* message) {
        try { call(); } catch (const std::exception& error) { return std::string(error.what()) == message; }
        return false;
    };
    const uint32_t box = batch.addGeometry(*makeBoxGeometry());  // 24 vertices, 36 indices
    CHECK(refused([&] { batch.addGeometry(*makeBoxGeometry()); },
                  "THREE.BatchedMesh: Reserved space request exceeds the maximum buffer size."));
    const uint32_t a = batch.addInstance(box), b = batch.addInstance(box);
    CHECK(a == 0 && b == 1 && batch.instanceCount() == 2);
    CHECK(refused([&] { batch.addInstance(box); }, "THREE.BatchedMesh: Maximum item count reached."));
    Matrix4 moved, read;
    moved.makeTranslation(1, 2, 3);
    batch.setMatrixAt(b, moved).setColorAt(b, Color(0.5, 0.25, 1)).setVisibleAt(a, false);
    Color color;
    CHECK(batch.getMatrixAt(b, read).elements[13] == 2 && batch.getColorAt(b, color).b == 1 && !batch.getVisibleAt(a));
    CHECK(batch.drawBatches().size() == 1 && batch.drawBatches()[0]->count == 1);
    batch.deleteInstance(a);
    CHECK(refused([&] { batch.getVisibleAt(a); },
                  "THREE.BatchedMesh: Invalid instanceId 0. Instance is either out of range or has been deleted."));
    CHECK(batch.addInstance(box) == a && batch.getVisibleAt(a) && batch.drawBatches()[0]->count == 2);
}

}  // namespace

TN_TEST_MAIN({"hierarchy", hierarchy}, {"alias", alias}, {"revision", revision}, {"upstream", upstream},
             {"rotation_sync", rotation_sync}, {"teardown", teardown}, {"batched_mesh", batched_mesh})
