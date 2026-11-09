// three's Box2 over the engine's Vector2, ported from three r187 src/math/Box2.js (MIT).
// Box2 is pure math over two Vector2s, so it is plain JS here: no engine class of its own.

interface IVector2 {
  x: number;
  y: number;
  set(x: number, y: number): IVector2;
  copy(v: IVector2): IVector2;
  add(v: IVector2): IVector2;
  sub(v: IVector2): IVector2;
  addScalar(s: number): IVector2;
  addVectors(a: IVector2, b: IVector2): IVector2;
  subVectors(a: IVector2, b: IVector2): IVector2;
  multiplyScalar(s: number): IVector2;
  min(v: IVector2): IVector2;
  max(v: IVector2): IVector2;
  clamp(min: IVector2, max: IVector2): IVector2;
  distanceTo(v: IVector2): number;
  equals(v: IVector2): boolean;
}

export function defineBox2(
  classes: Readonly<Record<"Vector2", new (x?: number, y?: number) => object>>,
) {
  const Vector2 = classes.Vector2 as new (x?: number, y?: number) => IVector2;
  const scratch = new Vector2();
  return class Box2 {
    readonly isBox2 = true;
    min: IVector2;
    max: IVector2;

    constructor(
      min: IVector2 = new Vector2(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY),
      max: IVector2 = new Vector2(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY),
    ) {
      this.min = min;
      this.max = max;
    }

    set(min: IVector2, max: IVector2): this {
      this.min.copy(min);
      this.max.copy(max);
      return this;
    }

    setFromPoints(points: readonly IVector2[]): this {
      this.makeEmpty();
      for (const point of points) this.expandByPoint(point);
      return this;
    }

    setFromCenterAndSize(center: IVector2, size: IVector2): this {
      const halfSize = scratch.copy(size).multiplyScalar(0.5);
      this.min.copy(center).sub(halfSize);
      this.max.copy(center).add(halfSize);
      return this;
    }

    clone(): Box2 {
      return new Box2().copy(this);
    }

    copy(box: Box2): this {
      this.min.copy(box.min);
      this.max.copy(box.max);
      return this;
    }

    makeEmpty(): this {
      this.min.x = this.min.y = Number.POSITIVE_INFINITY;
      this.max.x = this.max.y = Number.NEGATIVE_INFINITY;
      return this;
    }

    isEmpty(): boolean {
      return this.max.x < this.min.x || this.max.y < this.min.y;
    }

    getCenter(target: IVector2): IVector2 {
      return this.isEmpty()
        ? target.set(0, 0)
        : target.addVectors(this.min, this.max).multiplyScalar(0.5);
    }

    getSize(target: IVector2): IVector2 {
      return this.isEmpty() ? target.set(0, 0) : target.subVectors(this.max, this.min);
    }

    expandByPoint(point: IVector2): this {
      this.min.min(point);
      this.max.max(point);
      return this;
    }

    expandByVector(vector: IVector2): this {
      this.min.sub(vector);
      this.max.add(vector);
      return this;
    }

    expandByScalar(scalar: number): this {
      this.min.addScalar(-scalar);
      this.max.addScalar(scalar);
      return this;
    }

    containsPoint(point: IVector2): boolean {
      return (
        point.x >= this.min.x &&
        point.x <= this.max.x &&
        point.y >= this.min.y &&
        point.y <= this.max.y
      );
    }

    containsBox(box: Box2): boolean {
      return (
        this.min.x <= box.min.x &&
        box.max.x <= this.max.x &&
        this.min.y <= box.min.y &&
        box.max.y <= this.max.y
      );
    }

    getParameter(point: IVector2, target: IVector2): IVector2 {
      return target.set(
        (point.x - this.min.x) / (this.max.x - this.min.x),
        (point.y - this.min.y) / (this.max.y - this.min.y),
      );
    }

    intersectsBox(box: Box2): boolean {
      return (
        box.max.x >= this.min.x &&
        box.min.x <= this.max.x &&
        box.max.y >= this.min.y &&
        box.min.y <= this.max.y
      );
    }

    clampPoint(point: IVector2, target: IVector2): IVector2 {
      return target.copy(point).clamp(this.min, this.max);
    }

    distanceToPoint(point: IVector2): number {
      return this.clampPoint(point, scratch).distanceTo(point);
    }

    intersect(box: Box2): this {
      this.min.max(box.min);
      this.max.min(box.max);
      if (this.isEmpty()) this.makeEmpty();
      return this;
    }

    union(box: Box2): this {
      this.min.min(box.min);
      this.max.max(box.max);
      return this;
    }

    translate(offset: IVector2): this {
      this.min.add(offset);
      this.max.add(offset);
      return this;
    }

    equals(box: Box2): boolean {
      return box.min.equals(this.min) && box.max.equals(this.max);
    }
  };
}
