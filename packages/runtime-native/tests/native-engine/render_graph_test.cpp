#include "check.h"
#include "engine/renderer/graph/history.h"
#include "engine/renderer/graph/render_graph.h"

#include <set>
#include <iostream>
#include <iomanip>
#include <string>

using namespace tn::engine::graph;

namespace {

const TextureDesc kHdr{1280, 720, 1, 0x10};
const TextureDesc kDepth{1280, 720, 2, 0x10};
const TextureDesc kHalf{640, 360, 1, 0x10};

std::string names(const RenderGraph& g, const std::vector<PassId>& order) {
    std::string out;
    for (PassId p : order) out += (out.empty() ? "" : ",") + g.passName(p);
    return out;
}

void order() {
    RenderGraph g;
    const ResourceId swap = g.external("swapchain", kHdr);
    const ResourceId particles = g.transient("particles", kHalf);
    const ResourceId color = g.transient("color", kHdr);
    const ResourceId depth = g.transient("depth", kDepth);
    // Declared backwards: the present pass first, the compute that feeds the draw last.
    g.pass("tonemap", PassKind::Render, {{color}}, {swap});
    g.pass("opaque", PassKind::Render, {{particles}}, {color, depth});
    g.pass("simulate", PassKind::Compute, {}, {particles});
    const auto compiled = g.compile();
    CHECK(compiled.ok());
    CHECK(names(g, compiled.order) == "simulate,opaque,tonemap");

    // Independent passes keep declaration order: the build is deterministic.
    RenderGraph h;
    const ResourceId a = h.transient("a", kHdr), b = h.transient("b", kHdr);
    h.pass("second", PassKind::Render, {}, {b});
    h.pass("first", PassKind::Render, {}, {a});
    h.pass("join", PassKind::Render, {{a}, {b}}, {h.external("out", kHdr)});
    CHECK(names(h, h.compile().order) == "second,first,join");
}

void aliasing() {
    RenderGraph g;
    const ResourceId out = g.external("swapchain", kHdr);
    const ResourceId a = g.transient("bloom-a", kHalf);
    const ResourceId b = g.transient("bloom-b", kHalf);
    const ResourceId c = g.transient("bloom-c", kHalf);
    const ResourceId color = g.transient("color", kHdr);
    g.pass("draw", PassKind::Render, {}, {color});
    g.pass("down", PassKind::Render, {{color}}, {a});
    g.pass("blur", PassKind::Render, {{a}}, {b});     // a and b overlap at this pass
    g.pass("blur2", PassKind::Render, {{b}}, {c});    // a is dead here: c may take a's memory
    g.pass("compose", PassKind::Render, {{color}, {c}}, {out});
    const auto compiled = g.compile();
    CHECK(compiled.ok());
    CHECK(compiled.physicalOf[a] != compiled.physicalOf[b]);     // overlapping never share
    CHECK(compiled.physicalOf[b] != compiled.physicalOf[c]);
    CHECK(compiled.physicalOf[c] == compiled.physicalOf[a]);     // disjoint lifetimes share one
    CHECK(compiled.physicalOf[color] != compiled.physicalOf[a]); // another descriptor never does
    CHECK(compiled.physicalOf[out] == -1);
    CHECK(compiled.physicalCount == 3);

    // Disjoint lifetimes but different descriptors: never one allocation.
    RenderGraph d;
    const ResourceId early = d.transient("depth-prepass", kDepth);
    const ResourceId late = d.transient("half", kHalf);
    const ResourceId mid = d.transient("mid", kHdr);
    d.pass("prepass", PassKind::Render, {}, {early});
    d.pass("consume", PassKind::Render, {{early}}, {mid});
    d.pass("after", PassKind::Render, {{mid}}, {late});
    d.pass("out", PassKind::Render, {{late}}, {d.external("o", kHdr)});
    const auto dc = d.compile();
    CHECK(dc.ok());
    CHECK(dc.physicalOf[early] != dc.physicalOf[late]);
}

void diagnostics() {
    RenderGraph cycle;
    const ResourceId x = cycle.transient("x", kHdr), y = cycle.transient("y", kHdr);
    cycle.pass("p", PassKind::Render, {{y}}, {x});
    cycle.pass("q", PassKind::Render, {{x}}, {y});
    const auto c = cycle.compile();
    CHECK(!c.ok() && c.errors[0].code == "TN_GRAPH_CYCLE");
    CHECK(c.errors[0].detail.find("p") != std::string::npos && c.errors[0].detail.find("q") != std::string::npos);

    RenderGraph missing;
    const ResourceId ghost = missing.transient("ghost", kHdr);
    missing.pass("reader", PassKind::Render, {{ghost}}, {missing.external("out", kHdr)});
    const auto m = missing.compile();
    CHECK(!m.ok() && m.errors[0].code == "TN_GRAPH_MISSING_PRODUCER");
    CHECK(m.errors[0].detail.find("ghost") != std::string::npos);

    RenderGraph format;
    const ResourceId hdr = format.transient("hdr", kHdr);
    format.pass("write", PassKind::Render, {}, {hdr});
    format.pass("read", PassKind::Render, {{hdr, 99}}, {format.external("out", kHdr)});
    const auto f = format.compile();
    CHECK(!f.ok() && f.errors[0].code == "TN_GRAPH_FORMAT");
}

void jitterDump() {
    std::cout << std::setprecision(17) << "[";
    for (int i = 0; i < 96; ++i) {
        const auto j = traaJitter(i);
        if (i) std::cout << ",";
        std::cout << "[" << j[0] << "," << j[1] << "]";
    }
    std::cout << "]\n";
}

void cutResize() {
    HistoryTracker h;
    CHECK(!h.historyValid(1));          // nothing presented yet: the reset input
    h.beginRender(1, true);
    h.endFrame();
    CHECK(h.historyValid(1));
    h.cameraCut(1);
    CHECK(!h.historyValid(1));          // a cut reads the seed, not the frame before it
    const uint32_t afterCut = h.generation(1);
    h.beginRender(1, true);
    h.endFrame();
    CHECK(h.historyValid(1));
    h.resize(1, 800, 600);
    CHECK(!h.historyValid(1));
    CHECK(h.generation(1) == afterCut + 1);
    h.resize(1, 800, 600);              // the same size again is not a resize
    CHECK(h.generation(1) == afterCut + 1);
}

void objects() {
    HistoryTracker h;
    HistoryTracker::Matrix m0{}, m1{}, m2{};
    m0[12] = 0; m1[12] = 1; m2[12] = 2;
    CHECK(h.objectFrame(7, m1, 0, 0) == m1);   // new object: seeded with its own current matrix
    h.endFrame();
    CHECK(h.objectFrame(7, m2, 0, 0) == m1);   // then the real previous frame
    h.endFrame();
    CHECK(h.objectFrame(7, m0, 0, 1) == m0);   // LOD transition: seeded, not the other LOD's matrix
    // A skeleton object 7 drove now drives object 9: 9 must not read 7's motion.
    HistoryTracker s;
    s.objectFrame(7, m1, 42, 0);
    s.endFrame();
    s.objectFrame(9, m2, 0, 0);
    s.endFrame();
    CHECK(s.objectFrame(9, m0, 42, 0) == m0);  // skeleton reuse seeds
    s.endFrame();
    CHECK(s.objectFrame(9, m1, 42, 0) == m0);  // and is ordinary history afterwards
    s.endFrame();
    // Object 9 keeps skeleton 42, but object 7 drove it in between: 9 must seed, not resume.
    s.objectFrame(7, m2, 42, 0);
    s.endFrame();
    CHECK(s.objectFrame(9, m2, 42, 0) == m2);
}

void multiRender() {
    HistoryTracker h;
    std::set<uint64_t> ids;
    ids.insert(h.beginRender(1, false));   // a shadow or reflection render for view 1
    ids.insert(h.beginRender(1, true));    // the presented render
    ids.insert(h.beginRender(2, false));   // an offscreen view never presented
    CHECK(ids.size() == 3);
    h.endFrame();
    CHECK(h.historyValid(1));              // advanced once for the presented view
    CHECK(!h.historyValid(2));             // an unpresented view does not advance
    CHECK(h.frame() == 1);
}

}  // namespace

TN_TEST_MAIN({"order", order}, {"aliasing", aliasing}, {"diagnostics", diagnostics}, {"cut_resize", cutResize},
             {"objects", objects}, {"multi_render", multiRender}, {"jitter_dump", jitterDump})
