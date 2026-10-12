// three@0.185.1's own math classes for the V8 adapter (PRD-573 v1.11 step 4a), bundled by esbuild into
// one script that Adapter::install runs when JS math is on. The classes are three's own, so every
// value operation is JIT-inlined JS and crosses nothing. What a native object owns (an Object3D's
// `position`, a material's `color`, a geometry's `boundingBox`) is a *view*: a subclass of the same
// class whose storage is a typed array over the engine's own memory, built from the layout C++
// publishes (`viewLayoutJson`), so a write is a write to the object.
import { Box3 } from "three/src/math/Box3.js";
import { Color } from "three/src/math/Color.js";
import { Euler } from "three/src/math/Euler.js";
import * as MathUtils from "three/src/math/MathUtils.js";
import { Matrix3 } from "three/src/math/Matrix3.js";
import { Matrix4 } from "three/src/math/Matrix4.js";
import { Quaternion } from "three/src/math/Quaternion.js";
import { Sphere } from "three/src/math/Sphere.js";
import { Vector2 } from "three/src/math/Vector2.js";
import { Vector3 } from "three/src/math/Vector3.js";
import { Vector4 } from "three/src/math/Vector4.js";

const CLASSES = { Vector2, Vector3, Vector4, Quaternion, Euler, Matrix3, Matrix4, Color, Box3, Sphere };
const KINDS = Object.keys(CLASSES);

globalThis.__tnMathInstall = function install(target, layoutText) {
  const layout = JSON.parse(layoutText);
  // The native side finds a JS math value by this tag (the index into KINDS), on the prototype.
  KINDS.forEach((name, tag) => Object.defineProperty(CLASSES[name].prototype, "$tn", { value: tag }));

  // A subclass that is never constructed: `new.target.prototype` carries the accessors, and
  // `constructor` names the plain class so three's `clone()` (`new this.constructor()`) answers one.
  const subclass = (Base) => {
    const View = class extends Base {};
    Object.defineProperty(View.prototype, "constructor", { value: Base, writable: true, configurable: true });
    return View;
  };
  // Accessors with the element index as a literal: `fields` are byte offsets from the layout.
  const accessors = (proto, fields, store, prefix = "") => {
    for (const [name, byte] of Object.entries(fields)) {
      const index = byte / Float64Array.BYTES_PER_ELEMENT;
      Object.defineProperty(proto, prefix + name, {
        configurable: true,
        get: new Function(`return this.${store}[${index}]`),
        set: new Function("v", `this.${store}[${index}] = v`),
      });
    }
  };
  const doubles = (buffer, offset, bytes) => new Float64Array(buffer, offset, bytes / Float64Array.BYTES_PER_ELEMENT);
  const views = {};

  for (const name of ["Vector2", "Vector3", "Vector4"]) {
    const info = layout[name];
    const View = subclass(CLASSES[name]);
    accessors(View.prototype, info.fields, "_a");
    const Make = function (a) { this._a = a; };
    Make.prototype = View.prototype;
    views[name] = (buffer, offset) => new Make(doubles(buffer, offset, info.bytes));
  }
  const vector3 = (buffer, offset) => views.Vector3(buffer, offset);

  // Euler and Quaternion: three keeps `_x` etc. and fires `_onChangeCallback` from the public setters, so
  // the accessors are named `_x`. An Object3D's pair is linked (see link): a write to one writes the other.
  const quaternionInfo = layout.Quaternion;
  const QuaternionView = subclass(Quaternion);
  accessors(QuaternionView.prototype, quaternionInfo.fields, "_a", "_");
  QuaternionView.prototype._onChangeCallback = function () {
    const e = this._e;
    if (e !== undefined) e.setFromQuaternion(this, e._order, false);
  };
  const MakeQuaternion = function (a) { this.isQuaternion = true; this._a = a; this._e = undefined; };
  MakeQuaternion.prototype = QuaternionView.prototype;
  views.Quaternion = (buffer, offset) => new MakeQuaternion(doubles(buffer, offset, quaternionInfo.bytes));

  const eulerInfo = layout.Euler;
  const EulerView = subclass(Euler);
  accessors(EulerView.prototype, eulerInfo.fields, "_a", "_");
  const orders = layout.eulerOrders;
  const orderIndex = Object.fromEntries(orders.map((order, index) => [order, index]));
  Object.defineProperty(EulerView.prototype, "_order", {
    configurable: true,
    get() { return orders[this._o[0]]; },
    set(value) {
      const index = orderIndex[value];
      if (index === undefined) throw new TypeError(`TN_NATIVE_EULER_ORDER: ${value} is not one of ${orders.join(", ")}`);
      this._o[0] = index;
    },
  });
  EulerView.prototype._onChangeCallback = function () {
    const q = this._q;
    if (q !== undefined) q.setFromEuler(this, false);
  };
  const MakeEuler = function (a, o) { this.isEuler = true; this._a = a; this._o = o; this._q = undefined; };
  MakeEuler.prototype = EulerView.prototype;
  views.Euler = (buffer, offset) => new MakeEuler(
    new Float64Array(buffer, offset, 3), new Int32Array(buffer, offset + eulerInfo.order, 1));

  const colorInfo = layout.Color;
  const ColorView = subclass(Color);
  accessors(ColorView.prototype, colorInfo.fields, "_a");
  const MakeColor = function (a) { this.isColor = true; this._a = a; };
  MakeColor.prototype = ColorView.prototype;
  views.Color = (buffer, offset) => new MakeColor(doubles(buffer, offset, colorInfo.bytes));

  for (const name of ["Matrix3", "Matrix4"]) {
    const info = layout[name];
    const View = subclass(CLASSES[name]);
    const Make = function (elements) { this.elements = elements; };
    Make.prototype = View.prototype;
    views[name] = (buffer, offset) => new Make(new Float64Array(buffer, offset + info.fields.elements, info.count));
  }

  // A box or sphere reaches its vectors through accessors that copy on assignment, so `box.min = v`
  // cannot detach the view from the object.
  const BoxView = subclass(Box3);
  for (const part of ["min", "max"]) {
    Object.defineProperty(BoxView.prototype, part, {
      configurable: true,
      get() { return this["_" + part]; },
      set(value) { this["_" + part].copy(value); },
    });
  }
  const MakeBox = function (min, max) { this.isBox3 = true; this._min = min; this._max = max; };
  MakeBox.prototype = BoxView.prototype;
  const boxInfo = layout.Box3;
  views.Box3 = (buffer, offset) => new MakeBox(
    vector3(buffer, offset + boxInfo.fields.min), vector3(buffer, offset + boxInfo.fields.max));

  const SphereView = subclass(Sphere);
  Object.defineProperty(SphereView.prototype, "center", {
    configurable: true,
    get() { return this._center; },
    set(value) { this._center.copy(value); },
  });
  accessors(SphereView.prototype, { radius: layout.Sphere.fields.radius }, "_a");
  const MakeSphere = function (center, a) { this.isSphere = true; this._center = center; this._a = a; };
  MakeSphere.prototype = SphereView.prototype;
  const sphereInfo = layout.Sphere;
  views.Sphere = (buffer, offset) => new MakeSphere(
    vector3(buffer, offset + sphereInfo.fields.center), doubles(buffer, offset, sphereInfo.bytes));

  for (const name of KINDS) target[name] = CLASSES[name];
  target.MathUtils = { ...MathUtils };

  return {
    kinds: KINDS,
    bytes: Object.fromEntries(KINDS.map((name) => [name, layout[name].bytes])),
    views,
    // An Object3D's rotation and quaternion are two forms of one orientation, as in three.
    link(euler, quaternion) { euler._q = quaternion; quaternion._e = euler; },
  };
};
