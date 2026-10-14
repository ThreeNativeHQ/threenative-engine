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
  const NativeBox3 = target.Box3;
  // Scene queries stay native: borrowing a live matrix view would permanently escape tracked transforms.
  for (const name of ["setFromObject", "expandByObject"]) {
    const fallback = Box3.prototype[name];
    Box3.prototype[name] = function (object, precise = false) {
      if (typeof object?.__tnCopyMatrixWorld !== "function") return fallback.call(this, object, precise);
      const bounds = new NativeBox3(this.min, this.max);
      return this.copy(bounds[name](object, precise));
    };
  }

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

  const orders = layout.eulerOrders;
  const orderIndex = Object.fromEntries(orders.map((order, index) => [order, index]));
  // Literal private accessors keep the JIT write path local; only explicit raw aliases escape.
  const trackedView = (name, prefix = "") => {
    const info = layout[name];
    const Base = CLASSES[name];
    const fields = Object.entries(info.fields).map(([key, byte]) => [prefix + key, byte / 8]);
    const dirty = "if (this.#dirty) this.#dirty[1] = 1;";
    const escapeMark = "if (this.#dirty) this.#dirty[2] = 1;";
    const View = new Function("orders", "orderIndex", `return class {
      #a; #o; #dirty;
      constructor(a, o, dirty) {
        this.#a = a; this.#o = o; this.#dirty = dirty;
        ${name === "Quaternion" || name === "Euler" ? `this.is${name} = true;` : ""}
        for (const key of ${JSON.stringify(name === "Euler" ? ["_a", "_o"] : ["_a"])}) {
          const descriptor = Object.getOwnPropertyDescriptor(new.target.prototype, key);
          // Raw aliases allow assignment, but reflection cannot detach them from tracked private storage.
          Object.defineProperty(this, key, { ...descriptor, enumerable: true, configurable: false });
        }
      }
      get _a() { ${escapeMark} return this.#a; }
      set _a(value) { ${escapeMark} this.#a = value; }
      ${name === "Euler" ? `get _o() { ${escapeMark} return this.#o; }
        set _o(value) { ${escapeMark} this.#o = value; }` : ""}
      ${fields.map(([key, index]) => `get ${key}() { return this.#a[${index}]; }
        set ${key}(v) { this.#a[${index}] = v; ${dirty} }`).join("\n")}
      ${name === "Euler" ? `get _order() { return orders[this.#o[0]]; }
        set _order(value) {
          const index = orderIndex[value];
          if (index === undefined) throw new TypeError('TN_NATIVE_EULER_ORDER: ' + value + ' is not one of ' + orders.join(', '));
          this.#o[0] = index; ${dirty}
        }` : ""}
    }`)(orders, orderIndex);
    Object.setPrototypeOf(View.prototype, Base.prototype);
    Object.defineProperty(View.prototype, "constructor", { value: Base, writable: true, configurable: true });
    return View;
  };
  const metadata = (buffer) => buffer === undefined ? undefined : new Uint8Array(buffer);
  for (const name of ["Vector2", "Vector3", "Vector4"]) {
    const info = layout[name];
    const View = trackedView(name);
    views[name] = (buffer, offset, dirty) => new View(doubles(buffer, offset, info.bytes), undefined, metadata(dirty));
  }
  const vector3 = (buffer, offset) => views.Vector3(buffer, offset);

  // Three's public setters retain their quaternion/Euler onChange coupling.
  const quaternionInfo = layout.Quaternion;
  const QuaternionView = trackedView("Quaternion", "_");
  QuaternionView.prototype._onChangeCallback = function () {
    const e = this._e;
    if (e !== undefined) e.setFromQuaternion(this, e._order, false);
  };
  views.Quaternion = (buffer, offset, dirty) => {
    const view = new QuaternionView(doubles(buffer, offset, quaternionInfo.bytes), undefined, metadata(dirty));
    view._e = undefined;
    return view;
  };
  const eulerInfo = layout.Euler;
  const EulerView = trackedView("Euler", "_");
  EulerView.prototype._onChangeCallback = function () {
    const q = this._q;
    if (q !== undefined) q.setFromEuler(this, false);
  };
  views.Euler = (buffer, offset, dirty) => {
    const view = new EulerView(new Float64Array(buffer, offset, 3),
      new Int32Array(buffer, offset + eulerInfo.order, 1), metadata(dirty));
    view._q = undefined;
    return view;
  };

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
