// The renderer: shader programs: layouts, the material, depth and auxiliary programs, and their reuse. PRD-840 split renderer.cpp by concern; renderer_internal.h holds what they share.
#include "engine/renderer/renderer_internal.h"

namespace tn::engine {

// FM3: the four probes above are pure functions of a program's stage modules, which never change once it
// is built, so a draw reads the answer instead of scanning the bindings again every pass of every frame.
// TN_PROGRAM_PROBES=per-draw resolves them on every call again (diagnostic): a test renders both arms and
// compares the pixels.
bool& perDrawProbes() {
    static bool perDraw = [] {
        const char* flag = flags::once<flags::ProgramProbes>();
        return flag && std::strcmp(flag, "per-draw") == 0;
    }();
    return perDraw;
}

// FS9: a page selects its casters from a per-page index of the casters whose bounds can reach it, built once per
// granted level, instead of scanning the whole draw list once per page. TN_SHADOW_PAGE_SCAN=flat scans the whole
// list again (diagnostic): a test renders both arms and compares the shadow plans draw for draw.
bool& flatShadowSelection() {
    static bool flat = [] {
        const char* flag = flags::once<flags::ShadowPageScan>();
        return flag && std::strcmp(flag, "flat") == 0;
    }();
    return flat;
}

Renderer::DrawProbes Renderer::probesOf(const Program& program) {
    if (!perDrawProbes()) return program.probes;
    return {perDrawFragment(program.fragment), perDrawVertex(program.vertex), readsViewport(program.fragment),
            readsPostTexture(program.fragment)};
}

// Each stage's layout from the bindings its package declares, the uniform block with a dynamic
// offset; the uniform slots resolved to fields once, so a draw never looks a name up. A layout is keyed by its own
// entries, not by its program: programs with one binding structure (two materials that differ only in their maps)
// intern one layout, so the WGSL text they share also shares one pipeline (PipelineCache keys the layout handle).
void Renderer::buildLayouts(Program& program) {
    const shader::StageModule* stages[2] = {&program.vertex, &program.fragment};
    std::string keys[2];
    for (int g = 0; g < 2; ++g) {
        std::vector<WGPUBindGroupLayoutEntry> entries;
        for (const shader::Binding& b : stages[g]->bindings) {
            WGPUBindGroupLayoutEntry e = {};
            e.binding = b.binding;
            e.visibility = g == 0 ? WGPUShaderStage_Vertex : WGPUShaderStage_Fragment;
            if (b.kind == shader::BindingKind::Uniform) {
                e.buffer.type = WGPUBufferBindingType_Uniform;
                e.buffer.hasDynamicOffset = true;
                e.buffer.minBindingSize = stages[g]->uniformBlockSize;
            } else if (b.kind == shader::BindingKind::Storage) {
                e.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
                e.buffer.minBindingSize = b.minSize;
            } else if (b.kind == shader::BindingKind::Texture) {
                e.texture.sampleType = b.depth ? WGPUTextureSampleType_Depth : WGPUTextureSampleType_Float;
                e.texture.viewDimension = b.volume ? WGPUTextureViewDimension_3D
                                          : b.array ? WGPUTextureViewDimension_2DArray
                                          : b.cube ? WGPUTextureViewDimension_Cube : WGPUTextureViewDimension_2D;
            } else if (b.kind == shader::BindingKind::Sampler) {
                e.sampler.type = b.values ? WGPUSamplerBindingType_NonFiltering
                                 : b.depth ? WGPUSamplerBindingType_Comparison : WGPUSamplerBindingType_Filtering;
            } else {
                throw std::runtime_error("TN_NATIVE_BINDING_UNSUPPORTED: " + b.name);
            }
            entries.push_back(e);
        }
        keys[g] = g == 0 ? "vs" : "fs";
        for (const WGPUBindGroupLayoutEntry& e : entries)
            keys[g] += ";" + std::to_string(e.binding) + "," + std::to_string(int(e.buffer.type)) + "," +
                       std::to_string(int(e.buffer.hasDynamicOffset)) + "," + std::to_string(e.buffer.minBindingSize) + "," +
                       std::to_string(int(e.texture.sampleType)) + "," + std::to_string(int(e.texture.viewDimension)) + "," +
                       std::to_string(int(e.sampler.type));
        program.layouts[g] = layouts_->bindGroup(keys[g], entries);
    }
    program.pipelineLayout = layouts_->pipeline(keys[0] + "\x1e" + keys[1], program.layouts[0], program.layouts[1]);
    for (int s = 0; s < kSlotCount; ++s) {
        for (const shader::UniformField& f : program.vertex.uniforms)
            if (f.name == kSlotNames[s]) program.vertexSlots[s] = &f;
        for (const shader::UniformField& f : program.fragment.uniforms)
            if (f.name == kSlotNames[s]) program.fragmentSlots[s] = &f;
    }
    for (const shader::UniformField& f : program.fragment.uniforms) {
        if (f.name.rfind("light", 0) != 0) continue;
        std::size_t end = 5;
        while (end < f.name.size() && std::isdigit(static_cast<unsigned char>(f.name[end]))) ++end;
        if (end == 5) continue;
        const std::size_t index = std::stoul(f.name.substr(5, end - 5));
        if (program.lightSlots.size() <= index) program.lightSlots.resize(index + 1);
        for (int field = 0; field < kLightFieldCount; ++field)
            if (f.name.compare(end, std::string::npos, kLightFieldNames[field]) == 0) program.lightSlots[index][field] = &f;
    }
    // FM3: what the stage modules alone decide about a draw of this program, resolved once here beside the
    // slots above. A program is immutable once built, so every draw of every pass of every frame reads these
    // instead of scanning the bindings again (perDrawFragment and its siblings).
    program.probes = {perDrawFragment(program.fragment), perDrawVertex(program.vertex), readsViewport(program.fragment),
                      readsPostTexture(program.fragment)};
}

Renderer::Program* Renderer::program(MaterialKind kind, const shader::VertexVariant& vv, const std::string& lights) {
    ++programKeyBuilds_;
    ++programLookups_;
    const std::string key = std::to_string(static_cast<int>(kind)) + "|" + vv.key() + "|" + lights;
    const auto refuse = [&](const std::string& reason) -> Program* {
        if (std::find(diagnostics_.begin(), diagnostics_.end(), reason) == diagnostics_.end()) diagnostics_.push_back(reason);
        return nullptr;
    };
    if (const auto found = programs_.find(key); found != programs_.end()) {
        if (!found->second && vv.background && vv.nodes.colorNode)
            throw std::runtime_error(refusedPrograms_.at(key));
        return found->second ? found->second.get() : refuse(refusedPrograms_.at(key));
    }
    const auto refuseBuild = [&](const std::string& why) -> Program* {
        programs_[key] = nullptr;
        const bool backgroundNode = vv.background && vv.nodes.colorNode;
        const auto message = refusedPrograms_[key] =
            (backgroundNode ? "TN_NATIVE_BACKGROUND_NODE_UNSUPPORTED: backgroundNode " : "TN_NATIVE_SHADER_INVALID: material program ") +
            key.substr(0, 120) + (key.size() > 120 ? "...: " : ": ") + why;
        if (backgroundNode) throw std::runtime_error(message);
        return refuse(message);
    };
    const std::size_t selection = lights.find('#');  // a lightsNode program: kinds, then `#` and the listed ids
    const shader::LightLayout layout{lights.substr(0, selection)};
    // The program's light fields, on a built program and on one whose stages equal an earlier program's alike.
    const auto lit = [&](Program& built) {
        built.kind = kind; built.variant = vv; built.lightKinds = layout.kinds;
        if (selection != std::string::npos) {
            built.selective = true;
            for (std::size_t at = selection + 1; at < lights.size(); at = lights.find(',', at) + 1)
                built.lightSelection.push_back(std::stoull(lights.substr(at)));
        }
    };
    std::string canonical;
    std::vector<std::string> serials;
    if (auto stages = equalStages(key, vv.nodes, canonical, serials)) {
        Program& built = add(key, std::move(stages->first), std::move(stages->second));
        lit(built);
        return &built;
    }
    shader::StandardPrograms source;
    try {
        switch (kind) {
        case MaterialKind::Standard: source = shader::buildStandard(shader::StandardMaterial{}, vv, layout); break;
        case MaterialKind::Basic: source = vv.sprite ? shader::buildSprite(vv) : shader::buildBasic(vv); break;
        case MaterialKind::Lambert: source = shader::buildLambert(vv, layout); break;
        case MaterialKind::Phong: source = shader::buildPhong(vv, layout); break;
        case MaterialKind::Physical: source = shader::buildPhysical(shader::StandardMaterial{}, vv, layout); break;
        }
    } catch (const std::exception& error) {
        return refuseBuild(error.what());  // a graph the builder refuses (TN_TSL_VARYING_CONFLICT, ...)
    }
    // The first construction diagnostic names the node; the WGSL error only says there was one.
    for (const shader::Program* stage : {&source.vertex, &source.fragment})
        if (!stage->diagnostics().empty()) {
            const auto& d = stage->diagnostics().front();
            return refuseBuild(d.code + ": " + d.node + ": " + d.reason);
        }
    source.vertex.setInvariantPosition(vv.invariantPosition);
    shader::StageModule vertex = shader::buildStage(source.vertex, 0);
    shader::StageModule fragment = shader::buildStage(source.fragment, 1);
    if (!vertex.wgsl.ok() || !fragment.wgsl.ok()) {
        const auto& errors = vertex.wgsl.ok() ? fragment.wgsl.errors : vertex.wgsl.errors;
        return refuseBuild(errors.empty() ? "no reason" : errors.front());
    }
    Program& built = add(key, std::move(vertex), std::move(fragment));
    lit(built);
    rememberEqual(built, std::move(canonical), std::move(serials));
    return &built;
}

// The same builder run again with one output per target. Every uniform, texture and varying is created in the same
// order, so the layout equals the program's own and the draw's bind groups are valid for it; checked, not assumed.
// `slots` are the frame's custom MRT slots: every aux draw writes each of them in that order, its own node where it
// names the slot and zero elsewhere, so all pipelines of the pass carry the same colour targets.
const shader::StageModule* Renderer::auxFragment(Program& program, uint8_t mask, const std::vector<std::string>& slots,
                                                 bool zeroNamed) {
    std::string slotKey;
    if (slots.empty()) {
        if (program.auxBuilt >> mask & 1u) return program.aux[mask].get();
        program.auxBuilt |= uint32_t(1u << mask);
    } else {
        slotKey = (zeroNamed ? "z" : "n") + std::to_string(mask) + "|";
        for (const auto& name : slots) slotKey += std::to_string(name.size()) + ":" + name + ";";
        const auto cached = program.auxMrt.find(slotKey);
        if (cached != program.auxMrt.end()) return cached->second.get();
    }
    // A full lit MRT program per (program, mask), which `aux_routes_written_normals` bounds: only a material kind
    // whose lit fragment exports `out.normal` may leave the shared geometry-normal pass.
    waste::count(waste::counters().auxFragments);
    const shader::VertexVariant& variant = program.variant;
    const shader::LightLayout layout{program.lightKinds};
    const auto store = [&](std::unique_ptr<shader::StageModule> module) -> const shader::StageModule* {
        const auto* result = module.get();
        if (slots.empty()) program.aux[mask] = std::move(module);
        else program.auxMrt.emplace(slotKey, std::move(module));
        return result;
    };
    try {
        shader::StandardPrograms source;
        switch (program.kind) {
        case MaterialKind::Standard: source = shader::buildStandard(shader::StandardMaterial{}, variant, layout); break;
        case MaterialKind::Lambert: source = shader::buildLambert(variant, layout); break;
        case MaterialKind::Phong: source = shader::buildPhong(variant, layout); break;
        case MaterialKind::Physical: source = shader::buildPhysical(shader::StandardMaterial{}, variant, layout); break;
        case MaterialKind::Basic: source = shader::buildBasic(variant); break;  // unlit: only a custom MRT slot is written
        }
        auto& f = source.fragment;
        if (!f.diagnostics().empty()) return store(nullptr);
        const std::size_t varyings = f.varyings().size();
        const bool surface = (program.kind == MaterialKind::Standard || program.kind == MaterialKind::Physical) &&
                             !variant.nodes.metalnessNode && !variant.nodes.roughnessNode;
        std::vector<shader::ExprId> outputs;
        const auto zero = [&] { return f.construct(shader::Type::vec(4), {f.constant(0.f), f.constant(0.f), f.constant(0.f), f.constant(0.f)}); };
        // A normalNode draw writes the normal it shades with, as three's MRT normalView does; a program that does not
        // read the node (Lambert, Phong) has none, and writes the geometric one it shades with. A transparent draw
        // writes no named target at all: its pipeline masks them, so a zero keeps every pipeline's targets equal.
        if (mask & kAuxNormal)
            outputs.push_back(zeroNamed ? zero()
                : normalTarget(f, variant.flatShading, variant.doubleSide, surface,
                               variant.nodes.normalNode ? source.normal : shader::kInvalid));
        if (mask & kAuxMaterial)
            outputs.push_back(zeroNamed ? zero() : source.materialProperties != shader::kInvalid ? source.materialProperties :
                f.construct(shader::Type::vec(4), {f.constant(0.f), f.constant(1.f), f.constant(0.f), f.constant(1.f)}));
        if (mask & kAuxAlbedo) outputs.push_back(zeroNamed ? zero() : f.construct(shader::Type::vec(4), {source.albedo, f.constant(1.f)}));
        if (mask & kAuxEmissive) outputs.push_back(zeroNamed ? zero() : f.construct(shader::Type::vec(4), {source.emissive, f.constant(1.f)}));
        // An unlit program (Basic) has no light, so it adds no indirect light either: zero there.
        if (mask & kAuxIndirect)
            outputs.push_back(zeroNamed || source.indirectDiffuse == shader::kInvalid ? zero()
                : f.construct(shader::Type::vec(4), {source.indirectDiffuse, f.constant(1.f)}));
        for (const auto& name : slots) {
            const auto found = std::find_if(variant.nodes.mrt.begin(), variant.nodes.mrt.end(),
                                            [&](const shader::MrtOutput& slot) { return slot.name == name; });
            shader::ExprId value = shader::kInvalid;
            if (found != variant.nodes.mrt.end()) {
                const auto index = std::size_t(found - variant.nodes.mrt.begin());
                if (index < source.mrt.size()) value = source.mrt[index];
                // A draw that names the slot must write its value: a pipeline that quietly wrote zero here is
                // how a proof's attachment read back empty while every draw looked healthy.
                if (value == shader::kInvalid)
                    throw std::runtime_error("TN_NATIVE_MRT_UNSUPPORTED: slot '" + name +
                                             "' names a node this program lowered no value for");
            }
            outputs.push_back(value == shader::kInvalid
                ? f.construct(shader::Type::vec(4), {f.constant(0.f), f.constant(0.f), f.constant(0.f), f.constant(0.f)})
                : mrtColour(f, value));
        }
        // The first target takes the colour output's location 0 (its last write wins), the rest 1, 2 and 3 in order;
        // a custom MRT slot takes the locations after the named targets, in the frame's list order.
        static constexpr const char* kOutputs[] = {"color", "aux1", "aux2", "aux3"};
        for (std::size_t i = 0; i < outputs.size(); ++i) {
            const std::string name = i < std::size(kOutputs) ? std::string(kOutputs[i])
                                                             : "mrt" + std::to_string(i - std::size(kOutputs) + 1);
            f.output(name, outputs[i]);
        }
        // The lit colour these outputs replace is dead: without the prune the aux draw shades the whole program again,
        // shadow reads included, to write one normal (a splatted ground paid that twice a frame).
        f.pruneDeadStatements();
        if (!f.diagnostics().empty() || f.varyings().size() != varyings) return store(nullptr);
        auto module = std::make_unique<shader::StageModule>(shader::buildStage(f, 1));
        shader::positionalGraphTextures(*module);
        shader::positionalSerialNames(*module);
        const auto& own = program.fragment;
        bool same = module->wgsl.ok() && module->uniforms.size() == own.uniforms.size() &&
                    module->bindings.size() == own.bindings.size() && module->uniformBlockSize == own.uniformBlockSize;
        for (std::size_t i = 0; same && i < own.uniforms.size(); ++i)
            same = module->uniforms[i].name == own.uniforms[i].name && module->uniforms[i].offset == own.uniforms[i].offset;
        if (!same) return store(nullptr);
        return store(std::move(module));
    } catch (const std::exception& error) {
        // Named once a frame: a draw the post pass skipped says why, instead of leaving a target that reads empty.
        const std::string note = std::string("TN_POST_AUX_REFUSED: ") + error.what();
        if (std::find(diagnostics_.begin(), diagnostics_.end(), note) == diagnostics_.end()) diagnostics_.push_back(note);
        return store(nullptr);
    }
}

Renderer::Program& Renderer::depthProgram(const shader::VertexVariant& variant, bool masked) {
    ++programKeyBuilds_;
    ++programLookups_;
    shader::VertexVariant kind = variant;
    kind.instanceColor = false;
    kind.vertexColors = 0;
    kind.invariantPosition = false;  // the shadow depth pass shares its vertex stage with nothing
    kind.leafReceiver = false;       // a depth pass receives no shadow
    kind.twoSidedFoliage = false;    // ...and no light
    kind.roughDiffuse = false;       // ...and shades no diffuse
    const auto positionGraph = kind.nodes.shadowPositionNode();  // three's castShadowPositionNode, else positionNode
    kind.nodes = {};
    kind.nodes.positionNode = positionGraph; // a depth pass reads no colour
    kind.nodes.vertexNode = variant.nodes.vertexNode;  // ...but casts where the vertexNode puts it
    if (masked) kind.nodes.alphaTestNode = variant.nodes.alphaTestNode;  // ...and cuts where its alphaTestNode says
    // ...nor a diffuse map, unless the caster is alpha-tested (three's shadow pass copies alphaTest and
    // the map, so a leaf card casts its cut, PRD-651) or hashed (alphaHash reads the map's alpha too).
    // An opaque caster keeps no fragment stage.
    kind.map = (kind.alphaHash || masked) && variant.map;
    kind.normalMap = false;
    kind.pbrMaps = 0;
    const std::string key = (masked ? "depth-masked|" : "depth|") + kind.key();
    if (const auto found = programs_.find(key); found != programs_.end()) return *found->second;
    std::string canonical;
    std::vector<std::string> serials;
    if (auto stages = equalStages(key, kind.nodes, canonical, serials)) return add(key, std::move(stages->first), std::move(stages->second));
    const auto built = [&](shader::StageModule vertex, shader::StageModule fragment) -> Program& {
        Program& program = add(key, std::move(vertex), std::move(fragment));
        rememberEqual(program, std::move(canonical), std::move(serials));
        return program;
    };
    if (masked) {
        const auto source = shader::buildMaskedDepth(kind);
        shader::StageModule vertex = shader::buildStage(source.vertex, 0), fragment = shader::buildStage(source.fragment, 1);
        if (!vertex.wgsl.ok() || !fragment.wgsl.ok()) {
            const auto& errors = vertex.wgsl.ok() ? fragment.wgsl.errors : vertex.wgsl.errors;
            throw std::runtime_error("TN_NATIVE_SHADER_INVALID: masked shadow depth program: " + (errors.empty() ? std::string("no reason") : errors.front()));
        }
        // The depth fragment binds the diffuse map and the node's uniforms only: a texture, storage or sampler an
        // alphaTestNode reads would stay unbound and cut against zero, so the caster fails closed.
        for (const auto& binding : fragment.bindings)
            if (binding.kind != shader::BindingKind::Uniform && binding.name != "t_map" && binding.name != "smp_map")
                throw std::runtime_error("TN_NATIVE_SHADOW_ALPHA_UNSUPPORTED: alphaTestNode reads " + binding.name + "; a shadow caster's cutoff supports uniforms, uv and the diffuse map only");
        return built(std::move(vertex), std::move(fragment));
    }
    // three's shadow pass draws with the default positionNode, the same transform as a basic material.
    const auto source = kind.alphaHash ? shader::buildDepth(kind) : shader::buildBasic(kind);
    shader::StageModule vertex = shader::buildStage(source.vertex, 0);
    if (!vertex.wgsl.ok()) throw std::runtime_error("TN_NATIVE_SHADER_INVALID: shadow depth program: " +
        (vertex.wgsl.errors.empty() ? std::string("no reason") : vertex.wgsl.errors.front()));
    shader::StageModule fragment;
    fragment.stage = shader::Stage::Fragment;
    if (kind.alphaHash) {
        fragment = shader::buildStage(source.fragment, 1);
        if (!fragment.wgsl.ok()) throw std::runtime_error("TN_NATIVE_SHADER_INVALID: shadow alpha coverage");
    }
    return built(std::move(vertex), std::move(fragment));
}

std::optional<std::pair<shader::StageModule, shader::StageModule>> Renderer::equalStages(
    const std::string& key, const shader::MaterialNodes& nodes, std::string& canonical, std::vector<std::string>& serials) const {
    canonical.clear();
    serials.clear();
    const std::string own = "nodes:" + nodes.key();
    const size_t at = key.rfind(own);
    if (at == std::string::npos) return std::nullopt;
    const std::string canonicalNodes = nodes.canonicalKey(serials);
    if (serials.empty()) return std::nullopt;  // no serial name: the own key is already the structure
    canonical = key.substr(0, at) + "nodes:" + canonicalNodes + key.substr(at + own.size());
    const auto found = equalPrograms_.find(canonical);
    if (found == equalPrograms_.end() || found->second.serials.size() != serials.size()) return std::nullopt;
    const auto& theirs = found->second.serials;
    ++equalProgramReuses_;
    auto stages = std::make_pair(found->second.program->vertex, found->second.program->fragment);
    for (shader::StageModule* stage : {&stages.first, &stages.second}) {
        for (auto& field : stage->uniforms)
            if (const auto name = std::find(theirs.begin(), theirs.end(), field.name); name != theirs.end())
                field = shader::UniformField{serials[size_t(name - theirs.begin())], field.type, field.offset, field.size, field.schedule};
        // A positional map binds this material's own texture (bindGroup's graph()), not the first material's.
        for (auto& label : stage->graphTextureLabels)
            if (const auto name = std::find(theirs.begin(), theirs.end(), label.second); name != theirs.end())
                label.second = serials[size_t(name - theirs.begin())];
    }
    return stages;
}

void Renderer::rememberEqual(const Program& built, std::string canonical, std::vector<std::string> serials) {
    if (!canonical.empty()) equalPrograms_.try_emplace(std::move(canonical), EqualProgram{&built, std::move(serials)});
}

Renderer::Program& Renderer::add(const std::string& key, shader::StageModule vertex, shader::StageModule fragment) {
    // Materials that differ only in their maps share one text, so one module parse and one pipeline (see bindGroup's graph()).
    shader::positionalGraphTextures(vertex);
    shader::positionalGraphTextures(fragment);
    shader::positionalSerialNames(vertex);
    shader::positionalSerialNames(fragment);
    auto built = std::make_unique<Program>();
    built->vertex = std::move(vertex);
    built->fragment = std::move(fragment);
    {
        // WebGPU refuses a bind group layout with more than 16 samplers in a stage, which loses the whole device:
        // name the program's samplers once, before its pipeline does.
        std::string names;
        uint32_t samplers = 0;
        for (const auto& b : built->fragment.bindings)
            if (b.kind == shader::BindingKind::Sampler) { ++samplers; names += " " + b.name; }
        if (samplers > shader::Program::kMaxSamplers) {
            const std::string note = "TN_PROGRAM_SAMPLERS: a fragment program binds " + std::to_string(samplers) +
                                     " samplers, over " + std::to_string(shader::Program::kMaxSamplers) + ":" + names;
            if (std::find(diagnostics_.begin(), diagnostics_.end(), note) == diagnostics_.end()) {
                diagnostics_.push_back(note);
                std::fprintf(stderr, "%s\n", note.c_str());
            }
        }
    }
    // A program first built after the startup reveal is a precache miss (Unreal's PSO precache validation): its
    // shader build and GPU compile land mid-play as a hitch. Debug runs name it so prewarm can cover it.
    if (deferUncompiled_ && waste::debugEnabled().load(std::memory_order_relaxed))
        std::fprintf(stderr, "TN_PROGRAM_LATE %s\n", key.substr(0, 240).c_str());
    buildLayouts(*built);
    if (uniformCapacity_ != 0) {
        const DrawProbes probes = probesOf(*built);
        for (int g = 0; g < 2; ++g) {
            if (g == 1 && probes.fragmentPerDraw) continue;  // per-draw groups instead
            if (g == 0 && probes.vertexPerDraw) continue;
            built->groups[g] = bindGroup(built->layouts[g], g == 0 ? built->vertex : built->fragment, uniformBuffer_,
                                         lutView_, lutSampler_);
        }
    }
    return *programs_.emplace(key, std::move(built)).first->second;
}

void Renderer::rebuildGroups() {
    dropBundles(); // Emdawn may recycle a released bind-group handle immediately
    for (auto& [key, group] : mapGroups_)  // they bind the old uniform buffer
        if (group) wgpuBindGroupRelease(group);
    mapGroups_.clear();
    ++groupEpoch_;
    for (auto& [key, program] : programs_) {
        if (!program) continue;  // a refused program
        const DrawProbes probes = probesOf(*program);
        for (int g = 0; g < 2; ++g) {
            if (program->groups[g]) wgpuBindGroupRelease(program->groups[g]);
            program->groups[g] = (g == 1 && probes.fragmentPerDraw) || (g == 0 && probes.vertexPerDraw)
                                     ? nullptr
                                     : bindGroup(program->layouts[g], g == 0 ? program->vertex : program->fragment,
                                                 uniformBuffer_, lutView_, lutSampler_);
        }
    }
}

}  // namespace tn::engine
