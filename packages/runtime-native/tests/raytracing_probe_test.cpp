// Capability probe and trace check for the hardware ray tracing backend.
//
// It reports what the host can do (`TN_RAYTRACING_PROBE:{json}`) and, when the backend can trace
// ray batches, it checks every hit against a double precision CPU reference on a closed scene.
//
// A host without hardware ray tracing skips with its reason, so the report stays honest on CI
// hosts. Set TN_RAYTRACING_REQUIRE=1 on a host that has the hardware: a skip then fails the test.

#include "raytracing/rt_common.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <vector>

namespace {

using mystral::rt::IRTBackend;
using mystral::rt::RTBLASHandle;
using mystral::rt::RTCapabilities;
using mystral::rt::RTGeometryDesc;
using mystral::rt::RTGeometryHandle;
using mystral::rt::RTTLASHandle;
using mystral::rt::RTTLASInstance;
using mystral::rt::TraceRayBatchOptions;
using mystral::rt::TraceRayBatchResult;

constexpr double kDistanceTolerance = 1e-4;  // metres; the PRD asks for 1 mm, this is ten times tighter
constexpr uint32_t kRayCount = 8192;

struct Vec3 {
    double x, y, z;
};
Vec3 operator-(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
double dot(Vec3 a, Vec3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
Vec3 cross(Vec3 a, Vec3 b) {
    return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}

struct Scene {
    std::vector<float> vertices;      // xyz per vertex
    std::vector<uint32_t> indices;    // three per triangle
};

void addBox(Scene& scene, float x0, float y0, float z0, float x1, float y1, float z1) {
    const uint32_t base = static_cast<uint32_t>(scene.vertices.size() / 3);
    const float corners[8][3] = {
        {x0, y0, z0}, {x1, y0, z0}, {x1, y1, z0}, {x0, y1, z0},
        {x0, y0, z1}, {x1, y0, z1}, {x1, y1, z1}, {x0, y1, z1},
    };
    for (const auto& corner : corners) {
        scene.vertices.insert(scene.vertices.end(), {corner[0], corner[1], corner[2]});
    }
    const uint32_t faces[12][3] = {
        {0, 1, 2}, {0, 2, 3}, {4, 6, 5}, {4, 7, 6}, {0, 4, 5}, {0, 5, 1},
        {3, 2, 6}, {3, 6, 7}, {0, 3, 7}, {0, 7, 4}, {1, 5, 6}, {1, 6, 2},
    };
    for (const auto& face : faces) {
        scene.indices.insert(scene.indices.end(), {base + face[0], base + face[1], base + face[2]});
    }
}

Vec3 vertexAt(const Scene& scene, uint32_t index) {
    return {scene.vertices[index * 3], scene.vertices[index * 3 + 1], scene.vertices[index * 3 + 2]};
}

struct Reference {
    bool hit = false;
    double t = -1;
    uint32_t primitive = mystral::rt::kHitMissPrimitive;
    double edge = 1;  // smallest barycentric weight of the hit, to excuse a coin toss on an edge
};

// Moller-Trumbore, double sided, closest hit inside [tMin, tMax].
Reference traceReference(const Scene& scene, Vec3 origin, Vec3 direction, double tMin, double tMax) {
    Reference best;
    const uint32_t triangles = static_cast<uint32_t>(scene.indices.size() / 3);
    for (uint32_t triangle = 0; triangle < triangles; ++triangle) {
        const Vec3 a = vertexAt(scene, scene.indices[triangle * 3]);
        const Vec3 b = vertexAt(scene, scene.indices[triangle * 3 + 1]);
        const Vec3 c = vertexAt(scene, scene.indices[triangle * 3 + 2]);
        const Vec3 e1 = b - a;
        const Vec3 e2 = c - a;
        const Vec3 p = cross(direction, e2);
        const double det = dot(e1, p);
        if (std::fabs(det) < 1e-14) continue;
        const double inverse = 1.0 / det;
        const Vec3 s = origin - a;
        const double u = dot(s, p) * inverse;
        if (u < 0 || u > 1) continue;
        const Vec3 q = cross(s, e1);
        const double v = dot(direction, q) * inverse;
        if (v < 0 || u + v > 1) continue;
        const double t = dot(e2, q) * inverse;
        if (t < tMin || t > tMax) continue;
        if (!best.hit || t < best.t) {
            best.hit = true;
            best.t = t;
            best.primitive = triangle;
            best.edge = std::min({u, v, 1 - u - v});
        }
    }
    return best;
}

struct Rng {
    uint64_t state = 0x9E3779B97F4A7C15ull;
    double next() {  // splitmix64 -> [0, 1)
        state += 0x9E3779B97F4A7C15ull;
        uint64_t z = state;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ull;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBull;
        z ^= z >> 31;
        return static_cast<double>(z >> 11) * (1.0 / 9007199254740992.0);
    }
};

int fail(const std::string& message) {
    std::cerr << "raytracing probe failed: " << message << std::endl;
    return 1;
}

std::string jsonEscape(const std::string& text) {
    std::string out;
    for (const char c : text) {
        if (c == '"' || c == '\\') out.push_back('\\');
        out.push_back(c == '\n' ? ' ' : c);
    }
    return out;
}

void printCapabilities(const RTCapabilities& caps, const char* verdict) {
    std::printf(
        "TN_RAYTRACING_PROBE:{\"verdict\":\"%s\",\"backend\":\"%s\",\"device\":\"%s\","
        "\"vendorId\":%u,\"deviceId\":%u,\"apiVersion\":\"%u.%u.%u\",\"driverVersion\":%u,"
        "\"accelerationStructure\":%s,\"rayQuery\":%s,\"rayTracingPipeline\":%s,"
        "\"maxRayRecursionDepth\":%u,\"timestampPeriodNs\":%.4f,\"rayBatch\":%s,"
        "\"imageOutput\":%s,\"reason\":\"%s\"}\n",
        verdict, jsonEscape(caps.backend).c_str(), jsonEscape(caps.deviceName).c_str(),
        caps.vendorId, caps.deviceId, caps.apiVersion >> 22, (caps.apiVersion >> 12) & 0x3FF,
        caps.apiVersion & 0xFFF, caps.driverVersion,
        caps.accelerationStructure ? "true" : "false", caps.rayQuery ? "true" : "false",
        caps.rayTracingPipeline ? "true" : "false", caps.maxRayRecursionDepth,
        caps.timestampPeriodNs, caps.rayBatch ? "true" : "false",
        caps.imageOutput ? "true" : "false", jsonEscape(caps.reason).c_str());
    std::fflush(stdout);
}

}  // namespace

int main() {
    const bool required = std::getenv("TN_RAYTRACING_REQUIRE") != nullptr;
    std::unique_ptr<IRTBackend> backend = mystral::rt::createRTBackend();
    const RTCapabilities caps = backend->capabilities();

    if (!caps.rayBatch) {
        printCapabilities(caps, required ? "fail-required" : "skip");
        if (required) {
            return fail("TN_RAYTRACING_REQUIRE is set and the backend cannot trace ray batches: " +
                        caps.reason);
        }
        std::cout << "raytracing probe passed (skipped: " << caps.reason << ")" << std::endl;
        return 0;
    }

    // Closed room with a box floating in it: 24 triangles, 16 vertices. The box touches no wall, so
    // no two triangles are coplanar and overlapping: such a tie has no single right primitive.
    Scene scene;
    addBox(scene, -6.0f, 0.0f, -6.0f, 6.0f, 4.0f, 6.0f);
    addBox(scene, -1.0f, 0.5f, -1.0f, 1.0f, 2.5f, 1.0f);

    RTGeometryDesc desc = {};
    desc.vertices = scene.vertices.data();
    desc.vertexCount = scene.vertices.size() / 3;
    desc.vertexStride = 12;
    desc.indices = scene.indices.data();
    desc.indexCount = scene.indices.size();
    RTGeometryHandle geometry = backend->createGeometry(desc);
    if (!geometry._handle) return fail("createGeometry returned no handle");
    RTBLASHandle blas = backend->createBLAS(&geometry, 1);
    if (!blas._handle) return fail("createBLAS returned no handle");

    RTTLASInstance instance = {};
    instance.blas = blas;
    instance.transform[0] = instance.transform[5] = instance.transform[10] = instance.transform[15] = 1.0f;
    instance.mask = 0xFF;
    RTTLASHandle tlas = backend->createTLAS(&instance, 1);
    if (!tlas._handle) return fail("createTLAS returned no handle");

    // Rays: origins inside the room and outside the box, directions uniform on the sphere.
    Rng rng;
    std::vector<float> rays(static_cast<size_t>(kRayCount) * mystral::rt::kRayWords);
    for (uint32_t i = 0; i < kRayCount; ++i) {
        double ox, oy, oz;
        do {
            ox = -5.9 + 11.8 * rng.next();
            oy = 0.1 + 3.8 * rng.next();
            oz = -5.9 + 11.8 * rng.next();
        } while (std::fabs(ox) < 1.05 && oy > 0.45 && oy < 2.55 && std::fabs(oz) < 1.05);
        const double z = 2.0 * rng.next() - 1.0;
        const double phi = 6.283185307179586 * rng.next();
        const double r = std::sqrt(1.0 - z * z);
        const double tMin = rng.next() < 0.7 ? 0.001 : 6.0 * rng.next();
        const double tMax = rng.next() < 0.7 ? 1000.0 : 12.0 * rng.next();
        float* ray = &rays[static_cast<size_t>(i) * mystral::rt::kRayWords];
        ray[0] = static_cast<float>(ox);
        ray[1] = static_cast<float>(oy);
        ray[2] = static_cast<float>(oz);
        ray[3] = static_cast<float>(tMin);
        ray[4] = static_cast<float>(r * std::cos(phi));
        ray[5] = static_cast<float>(r * std::sin(phi));
        ray[6] = static_cast<float>(z);
        ray[7] = static_cast<float>(tMax);
    }

    std::vector<Reference> reference(kRayCount);
    for (uint32_t i = 0; i < kRayCount; ++i) {
        const float* ray = &rays[static_cast<size_t>(i) * mystral::rt::kRayWords];
        reference[i] = traceReference(scene, {ray[0], ray[1], ray[2]}, {ray[4], ray[5], ray[6]},
                                      ray[3], ray[7]);
    }

    // The same rays at several batch sizes, so buffer growth and shrink run too.
    const uint32_t sizes[] = {1, 100, kRayCount, 64, kRayCount};
    double maxDistanceError = 0;
    uint32_t hits = 0, misses = 0, primitiveMismatches = 0, hitMissMismatches = 0;
    double gpuMs = 0, totalMs = 0;
    for (const uint32_t size : sizes) {
        std::vector<float> out(static_cast<size_t>(size) * mystral::rt::kHitWords, 0.0f);
        TraceRayBatchOptions options = {};
        options.tlas = tlas;
        options.rays = rays.data();
        options.rayCount = size;
        options.hits = out.data();
        const TraceRayBatchResult result = backend->traceRayBatch(options);
        if (!result.ok) return fail("traceRayBatch failed at " + std::to_string(size) + " rays: " + result.error);
        gpuMs = result.gpuMs;
        totalMs = result.totalMs;
        for (uint32_t i = 0; i < size; ++i) {
            const float* hit = &out[static_cast<size_t>(i) * mystral::rt::kHitWords];
            uint32_t primitive;
            std::memcpy(&primitive, &hit[1], sizeof(primitive));
            const bool gpuHit = primitive != mystral::rt::kHitMissPrimitive;
            const Reference& ref = reference[i];
            if (gpuHit != ref.hit) {
                ++hitMissMismatches;
                continue;
            }
            if (!gpuHit) {
                ++misses;
                if (hit[0] != -1.0f) return fail("a miss must report t = -1");
                continue;
            }
            ++hits;
            maxDistanceError = std::max(maxDistanceError, std::fabs(static_cast<double>(hit[0]) - ref.t));
            if (primitive != ref.primitive && ref.edge > 1e-4) ++primitiveMismatches;
        }
    }

    // A TLAS that cannot name one triangle list is refused by name.
    RTTLASInstance two[2] = {instance, instance};
    two[1].transform[12] = 20.0f;
    RTTLASHandle twoInstances = backend->createTLAS(two, 2);
    bool refusedTwoInstances = false;
    std::string refusal;
    if (twoInstances._handle) {
        std::vector<float> out(mystral::rt::kHitWords);
        TraceRayBatchOptions options = {};
        options.tlas = twoInstances;
        options.rays = rays.data();
        options.rayCount = 1;
        options.hits = out.data();
        const TraceRayBatchResult result = backend->traceRayBatch(options);
        refusedTwoInstances = !result.ok && result.error.find("one instance") != std::string::npos;
        refusal = result.error;
        backend->destroyTLAS(twoInstances);
    }

    // Zero rays is a valid empty batch. A missing TLAS is a named failure.
    TraceRayBatchOptions empty = {};
    empty.tlas = tlas;
    const bool emptyOk = backend->traceRayBatch(empty).ok;
    TraceRayBatchOptions missingTlas = {};
    missingTlas.rays = rays.data();
    missingTlas.rayCount = 1;
    std::vector<float> scratch(mystral::rt::kHitWords);
    missingTlas.hits = scratch.data();
    const TraceRayBatchResult missing = backend->traceRayBatch(missingTlas);

    backend->destroyTLAS(tlas);
    backend->destroyBLAS(blas);
    backend->destroyGeometry(geometry);

    printCapabilities(caps, "pass");
    std::printf(
        "TN_RAYTRACING_PROBE_TRACE:{\"rays\":%u,\"hits\":%u,\"misses\":%u,"
        "\"maxDistanceErrorMetres\":%.8f,\"primitiveMismatches\":%u,\"hitMissMismatches\":%u,"
        "\"gpuMs\":%.4f,\"totalMs\":%.4f,\"refusedTwoInstances\":%s}\n",
        kRayCount, hits, misses, maxDistanceError, primitiveMismatches, hitMissMismatches, gpuMs,
        totalMs, refusedTwoInstances ? "true" : "false");

    if (hits == 0 || misses == 0) return fail("the scene must produce both hits and misses");
    if (hitMissMismatches != 0) return fail("hit/miss disagrees with the CPU reference");
    if (primitiveMismatches != 0) return fail("primitive index disagrees with the CPU reference");
    if (maxDistanceError > kDistanceTolerance) {
        return fail("hit distance error " + std::to_string(maxDistanceError) + " m exceeds " +
                    std::to_string(kDistanceTolerance) + " m");
    }
    if (!refusedTwoInstances) return fail("a two instance TLAS was not refused by name: '" + refusal + "'");
    if (!emptyOk) return fail("an empty batch must succeed");
    if (missing.ok || missing.error.find("TLAS") == std::string::npos) {
        return fail("a missing TLAS must fail and name the TLAS");
    }
    std::cout << "raytracing probe passed" << std::endl;
    return 0;
}
