import { Crowd, type CrowdAgent, type Vector3 as NavigationVector3, Raw } from "recast-navigation";
import { type Object3D, Vector3 } from "three";
import type { INavigationContext } from "./index.js";

export type NavigationAgentEvent = "targetReached" | "navigationFinished" | "pathChanged";
export type NavigationAgentHandler = () => void;

export interface INavigationAgent3DOptions {
  readonly navigation: INavigationContext;
  readonly object: Object3D;
  readonly radius?: number;
  readonly height?: number;
  readonly maxSpeed?: number;
  readonly pathDesiredDistance?: number;
  readonly targetDesiredDistance?: number;
  readonly avoidanceEnabled?: boolean;
}

const MAX_CROWD_AGENTS = 64;
const MAX_CROWD_AGENT_RADIUS = 2;
type NavigationArray = [number, number, number];

function finitePositive(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`NavigationAgent3D ${name} must be finite and positive.`);
  return value;
}

function finitePositionComponents(x: number, y: number, z: number): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}

function toNavigationVector(
  value: Pick<Vector3, "x" | "y" | "z">,
  target: NavigationVector3,
): NavigationVector3 {
  target.x = value.x;
  target.y = value.y;
  target.z = value.z;
  return target;
}

function toNavigationArray(
  value: Pick<Vector3, "x" | "y" | "z">,
  target: NavigationArray,
): NavigationArray {
  target[0] = value.x;
  target[1] = value.y;
  target[2] = value.z;
  return target;
}

function distanceSquared(
  a: Pick<Vector3, "x" | "y" | "z">,
  b: Pick<Vector3, "x" | "y" | "z">,
): number {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;
}

function horizontalDistanceSquared(
  a: Pick<Vector3, "x" | "z">,
  b: Pick<Vector3, "x" | "z">,
): number {
  return (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
}

function navigationPointMatchesTarget(
  point: Pick<Vector3, "x" | "y" | "z">,
  target: Pick<Vector3, "x" | "y" | "z">,
  horizontalLimit: number,
  verticalLimit: number,
): boolean {
  return (
    horizontalDistanceSquared(point, target) <= horizontalLimit ** 2 &&
    Math.abs(point.y - target.y) <= verticalLimit
  );
}

function crowdFor(navigation: INavigationContext, radius: number): Crowd {
  if (navigation.crowd !== undefined) return navigation.crowd;
  const crowd = new Crowd(navigation.navMesh, {
    maxAgents: MAX_CROWD_AGENTS,
    maxAgentRadius: Math.max(MAX_CROWD_AGENT_RADIUS, radius),
  });
  navigation.crowd = crowd;
  return crowd;
}

export class NavigationAgent3D {
  readonly navigation: INavigationContext;
  readonly object: Object3D;
  readonly radius: number;
  readonly height: number;
  readonly maxSpeed: number;
  readonly pathDesiredDistance: number;
  readonly targetDesiredDistance: number;
  #avoidanceEnabled: boolean;
  #target: Vector3 | undefined;
  #targetRevision = 0;
  #path: Vector3[] = [];
  #pathIndex = 0;
  #finished = false;
  #disposed = false;
  #listeners: Record<NavigationAgentEvent, Set<NavigationAgentHandler>> = {
    navigationFinished: new Set(),
    pathChanged: new Set(),
    targetReached: new Set(),
  };
  #crowdAgent: CrowdAgent | undefined;
  readonly #objectRecord: NavigationVector3 = { x: 0, y: 0, z: 0 };
  readonly #targetRecord: NavigationVector3 = { x: 0, y: 0, z: 0 };
  readonly #avoidanceRecord: NavigationVector3 = { x: 0, y: 0, z: 0 };
  readonly #crowdPositionArray: NavigationArray = [0, 0, 0];
  readonly #crowdTargetArray: NavigationArray = [0, 0, 0];
  readonly #crowdHalfExtentsArray: NavigationArray = [0, 0, 0];
  readonly #crowdNearestPointArray: NavigationArray = [0, 0, 0];
  readonly #crowdNearestRef: InstanceType<typeof Raw.UnsignedIntRef>;
  readonly #crowdNearestPoint: InstanceType<typeof Raw.Vec3>;
  readonly #crowdPointOverPoly: InstanceType<typeof Raw.BoolRef>;

  constructor(options: INavigationAgent3DOptions) {
    if (options.navigation === undefined)
      throw new Error("NavigationAgent3D requires a navigation context.");
    if (options.navigation.regions.size === 0)
      throw new Error("NavigationAgent3D requires a baked navigation region.");
    this.navigation = options.navigation;
    this.object = options.object;
    this.radius = finitePositive("radius", options.radius ?? 0.35);
    this.height = finitePositive("height", options.height ?? 1.4);
    this.maxSpeed = finitePositive("maxSpeed", options.maxSpeed ?? 4);
    this.pathDesiredDistance = finitePositive(
      "pathDesiredDistance",
      options.pathDesiredDistance ?? 0.35,
    );
    this.targetDesiredDistance = finitePositive(
      "targetDesiredDistance",
      options.targetDesiredDistance ?? 0.45,
    );
    this.#crowdNearestRef = new Raw.UnsignedIntRef();
    this.#crowdNearestPoint = new Raw.Vec3();
    this.#crowdPointOverPoly = new Raw.BoolRef();
    this.#avoidanceEnabled = options.avoidanceEnabled ?? true;
    this.#crowdAgent = undefined;
    if (this.#avoidanceEnabled) this.#enableAvoidance();
    this.navigation.agents.add(this);
  }

  get crowdAgent(): CrowdAgent | undefined {
    return this.#crowdAgent;
  }

  get avoidanceEnabled(): boolean {
    return this.#avoidanceEnabled;
  }

  set avoidanceEnabled(value: boolean) {
    if (this.#disposed || value === this.#avoidanceEnabled) return;
    this.#avoidanceEnabled = value;
    if (value) this.#enableAvoidance();
    else this.#disableAvoidance();
  }

  on(event: NavigationAgentEvent, handler: NavigationAgentHandler): () => void {
    this.#listeners[event].add(handler);
    return () => this.#listeners[event].delete(handler);
  }

  setTargetPosition(position: Pick<Vector3, "x" | "y" | "z">): void {
    if (this.#disposed) throw new Error("NavigationAgent3D cannot target after dispose.");
    const x = position.x;
    const y = position.y;
    const z = position.z;
    if (!finitePositionComponents(x, y, z))
      throw new Error("NavigationAgent3D target position must be finite.");
    this.#target ??= new Vector3();
    this.#target.set(x, y, z);
    this.#targetRevision += 1;
    this.#pathIndex = 0;
    this.#finished = false;
    // One path computation serves both storage and reachability: retargeting used to run
    // computePath twice — once inside isTargetReachable and once to store #path — which doubled
    // the most expensive navigation call for chase AI that retargets every frame.
    const target = this.#target;
    const start = this.navigation.query.findClosestPoint(
      toNavigationVector(this.object.position, this.#objectRecord),
    );
    const end = this.navigation.query.findClosestPoint(
      toNavigationVector(target, this.#targetRecord),
    );
    if (!this.#hasEnabledRegion() || !start.success || !end.success) {
      this.#path = [];
      this.#crowdAgent?.resetMoveTarget();
    } else if (start.polyRef === end.polyRef) {
      // Same polygon as today: judged from the closest point, with one computation for storage.
      this.#storeComputedPath(target, end.point);
      if (
        !navigationPointMatchesTarget(end.point, target, this.targetDesiredDistance, this.height)
      ) {
        this.#crowdAgent?.resetMoveTarget();
      } else if (this.#path.length > 0) {
        this.#requestCrowdMoveTarget(target);
      }
    } else {
      const reachable = this.#storeComputedPath(target, end.point);
      if (!reachable) {
        this.#crowdAgent?.resetMoveTarget();
      } else if (this.#path.length > 0) {
        this.#requestCrowdMoveTarget(target);
      }
    }
    for (const handler of this.#listeners.pathChanged) handler();
  }

  getNextPathPosition(target = new Vector3()): Vector3 {
    if (this.#target === undefined)
      throw new Error("NavigationAgent3D.getNextPathPosition requires a target position.");
    if (!this.#hasEnabledRegion()) return target.copy(this.object.position);
    const avoidance = this.#readAvoidance();
    if (this.#path.length === 0) return target.copy(this.object.position);
    if (avoidance !== undefined && Math.hypot(avoidance.x, avoidance.z) > 0.001) {
      target.copy(this.object.position);
      target.x += avoidance.x;
      target.z += avoidance.z;
      return target;
    }
    return target.copy(this.#path[this.#pathIndex] ?? this.object.position);
  }

  isNavigationFinished(): boolean {
    return this.#target !== undefined && this.#finished;
  }

  /**
   * Computes the path from the current object position to `target` once, stores it, and reports
   * whether its final waypoint lands within tolerance. The one place both `setTargetPosition`
   * and reachability judgments get their path from.
   */
  #storeComputedPath(target: Vector3, projectedTarget: Pick<Vector3, "x" | "y" | "z">): boolean {
    const result = this.navigation.query.computePath(
      toNavigationVector(this.object.position, this.#objectRecord),
      toNavigationVector(target, this.#targetRecord),
    );
    this.#path = result.success
      ? result.path.map((point) => new Vector3(point.x, point.y, point.z))
      : [];
    // Both ends must agree. Recast may return the raw requested height on an off-mesh point, so
    // the path endpoint alone calls an elevated target reachable; the projected endpoint alone
    // calls a disconnected island reachable because it projects onto the requested floor. The
    // path endpoint proves connectivity, the projected endpoint proves an on-mesh arrival.
    const final = this.#path.at(-1);
    return (
      result.success &&
      final !== undefined &&
      navigationPointMatchesTarget(final, target, this.targetDesiredDistance, this.height) &&
      navigationPointMatchesTarget(projectedTarget, target, this.targetDesiredDistance, this.height)
    );
  }

  isTargetReachable(position?: Pick<Vector3, "x" | "y" | "z">): boolean {
    const target = position ?? this.#target;
    if (target === undefined) return false;
    const start = this.navigation.query.findClosestPoint(
      toNavigationVector(this.object.position, this.#objectRecord),
    );
    const end = this.navigation.query.findClosestPoint(
      toNavigationVector(target, this.#targetRecord),
    );
    if (!this.#hasEnabledRegion() || !start.success || !end.success) return false;
    if (start.polyRef === end.polyRef)
      return navigationPointMatchesTarget(
        end.point,
        target,
        this.targetDesiredDistance,
        this.height,
      );
    const path = this.navigation.query.computePath(
      toNavigationVector(this.object.position, this.#objectRecord),
      toNavigationVector(target, this.#targetRecord),
    );
    // Same rule as #storeComputedPath: the path endpoint proves the route connects, and the
    // projected endpoint proves the arrival is on the navmesh at the requested height.
    const final = path.path.at(-1);
    return (
      path.success &&
      final !== undefined &&
      navigationPointMatchesTarget(final, target, this.targetDesiredDistance, this.height) &&
      navigationPointMatchesTarget(end.point, target, this.targetDesiredDistance, this.height)
    );
  }

  getFinalPosition(): Vector3 {
    return this.#path.at(-1)?.clone() ?? this.object.position.clone();
  }

  distanceToTarget(): number {
    return this.#target === undefined
      ? Number.POSITIVE_INFINITY
      : Math.sqrt(distanceSquared(this.object.position, this.#target));
  }

  // Teleport forces Recast to re-localise the agent on the navmesh, so it is paid only when the
  // object actually moved since the last sync; NaN starts make the first sync always localise.
  #lastSyncX = Number.NaN;
  #lastSyncY = Number.NaN;
  #lastSyncZ = Number.NaN;
  #lastRequestedTargetRevision = -1;

  syncCrowd(): void {
    if (this.#disposed || this.#crowdAgent === undefined) return;
    const { x, y, z } = this.object.position;
    const moved = x !== this.#lastSyncX || y !== this.#lastSyncY || z !== this.#lastSyncZ;
    const retargeted =
      this.#target !== undefined &&
      this.#targetRevision !== this.#lastRequestedTargetRevision &&
      this.#path.length > 0;
    if (!moved && !retargeted) return;
    this.#lastSyncX = x;
    this.#lastSyncY = y;
    this.#lastSyncZ = z;
    if (moved) {
      // Teleport re-localises the agent and drops its move state, so the target is re-sent in
      // the same sync — the pair is atomic, which the every-frame version got by doing both.
      this.#teleportCrowdAgent();
    }
    if (this.#target !== undefined && this.#path.length > 0) {
      this.#lastRequestedTargetRevision = this.#targetRevision;
      this.#requestCrowdMoveTarget(this.#target);
    }
  }

  advance(): void {
    if (
      this.#disposed ||
      this.#target === undefined ||
      this.#path.length === 0 ||
      !this.#hasEnabledRegion()
    )
      return;
    while (this.#pathIndex < this.#path.length - 1) {
      const waypoint = this.#path[this.#pathIndex];
      if (
        waypoint === undefined ||
        horizontalDistanceSquared(this.object.position, waypoint) > this.pathDesiredDistance ** 2
      )
        break;
      this.#pathIndex += 1;
    }
    // Arrival is three-dimensional: a partial path that stops underneath an elevated target
    // must not report `targetReached`.
    const reached =
      this.#pathIndex === this.#path.length - 1 &&
      navigationPointMatchesTarget(
        this.object.position,
        this.#target,
        this.targetDesiredDistance,
        this.height,
      );
    if (!reached || this.#finished) return;
    this.#finished = true;
    for (const handler of this.#listeners.targetReached) handler();
    for (const handler of this.#listeners.navigationFinished) handler();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.navigation.agents.delete(this);
    this.#disableAvoidance();
    for (const listeners of Object.values(this.#listeners)) listeners.clear();
    this.#path = [];
    this.#target = undefined;
    Raw.destroy(this.#crowdNearestRef);
    Raw.destroy(this.#crowdNearestPoint);
    Raw.destroy(this.#crowdPointOverPoly);
  }

  #enableAvoidance(): void {
    if (this.#crowdAgent !== undefined) return;
    const crowd = crowdFor(this.navigation, this.radius);
    this.#crowdAgent = crowd.addAgent(
      toNavigationVector(this.object.position, this.#objectRecord),
      {
        collisionQueryRange: 2.5,
        height: this.height,
        maxAcceleration: 20,
        maxSpeed: this.maxSpeed,
        obstacleAvoidanceType: 0,
        pathOptimizationRange: 0,
        radius: this.radius,
        separationWeight: 2,
        updateFlags: 7,
        userData: this,
      },
    );
  }

  #disableAvoidance(): void {
    if (this.#crowdAgent === undefined) return;
    this.navigation.crowd?.removeAgent(this.#crowdAgent);
    this.#crowdAgent = undefined;
  }

  #teleportCrowdAgent(): void {
    const crowdAgent = this.#crowdAgent;
    if (crowdAgent === undefined) return;
    const { crowd } = crowdAgent;
    const query = crowd.navMeshQuery;
    Raw.CrowdUtils.agentTeleport(
      crowd.raw,
      crowdAgent.agentIndex,
      toNavigationArray(this.object.position, this.#crowdPositionArray),
      toNavigationArray(query.defaultQueryHalfExtents, this.#crowdHalfExtentsArray),
      query.defaultFilter.raw,
    );
    crowdAgent.interpolatedPosition.x = this.object.position.x;
    crowdAgent.interpolatedPosition.y = this.object.position.y;
    crowdAgent.interpolatedPosition.z = this.object.position.z;
  }

  #requestCrowdMoveTarget(target: Pick<Vector3, "x" | "y" | "z">): void {
    const crowdAgent = this.#crowdAgent;
    if (crowdAgent === undefined) return;
    const { crowd } = crowdAgent;
    const query = crowd.navMeshQuery;
    const targetArray = toNavigationArray(target, this.#crowdTargetArray);
    const halfExtentsArray = toNavigationArray(
      query.defaultQueryHalfExtents,
      this.#crowdHalfExtentsArray,
    );
    this.#crowdNearestRef.value = 0;
    this.#crowdNearestPoint.x = 0;
    this.#crowdNearestPoint.y = 0;
    this.#crowdNearestPoint.z = 0;
    this.#crowdPointOverPoly.value = false;
    query.raw.findNearestPoly(
      targetArray,
      halfExtentsArray,
      query.defaultFilter.raw,
      this.#crowdNearestRef,
      this.#crowdNearestPoint,
      this.#crowdPointOverPoly,
    );
    this.#crowdNearestPointArray[0] = this.#crowdNearestPoint.x;
    this.#crowdNearestPointArray[1] = this.#crowdNearestPoint.y;
    this.#crowdNearestPointArray[2] = this.#crowdNearestPoint.z;
    crowd.raw.requestMoveTarget(
      crowdAgent.agentIndex,
      this.#crowdNearestRef.value,
      this.#crowdNearestPointArray,
    );
  }

  #hasEnabledRegion(): boolean {
    for (const region of this.navigation.regions) if (region.enabled) return true;
    return false;
  }

  #readAvoidance(): NavigationVector3 | undefined {
    const raw = this.#crowdAgent?.raw;
    if (raw === undefined) return undefined;
    this.#avoidanceRecord.x = raw.get_nvel(0);
    this.#avoidanceRecord.y = raw.get_nvel(1);
    this.#avoidanceRecord.z = raw.get_nvel(2);
    return this.#avoidanceRecord;
  }
}
