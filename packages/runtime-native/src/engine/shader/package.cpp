#include "package.h"

#include <algorithm>
#include <array>
#include <cctype>
#include <functional>
#include <string_view>
#include <bit>
#include <cstring>
#include <stdexcept>

namespace tn::engine::shader {

namespace {

uint32_t roundUp(uint32_t value, uint32_t align) { return (value + align - 1) / align * align; }

// Known sources the engine refreshes natively; anything else is material data.
UpdateSchedule scheduleFor(std::string_view name) {
    for (std::string_view object : {"modelMatrix", "modelViewMatrix", "modelViewProjection", "normalMatrix"}) {
        if (name == object) return UpdateSchedule::Object;
    }
    for (std::string_view camera : {"viewMatrix", "projectionMatrix", "viewProjection", "cameraPosition"}) {
        if (name == camera) return UpdateSchedule::Camera;
    }
    for (std::string_view frame : {"time", "deltaTime", "dt", "frame"}) {
        if (name == frame) return UpdateSchedule::Frame;
    }
    if (name == "resolution") return UpdateSchedule::Render;
    return UpdateSchedule::Material;
}

}  // namespace

void writeUniform(std::span<uint8_t> block, const UniformField& field, std::span<const double> values) {
    const auto& type = field.type;
    if (values.size() != size_t(type.rows) * type.cols)
        throw std::runtime_error("TN_POST_UNIFORM_SIZE: " + field.name);
    const size_t stride = type.isMatrix() ? uniformLayout(Type::vec(type.rows)).align : type.rows * 4;
    for (size_t col = 0; col < type.cols; ++col)
        for (size_t row = 0; row < type.rows; ++row) {
            const double value = values[col * type.rows + row];
            const uint32_t word = type.scalar == Type::Scalar::U32 ? static_cast<uint32_t>(value)
                : type.scalar == Type::Scalar::I32 ? static_cast<uint32_t>(static_cast<int32_t>(value))
                : std::bit_cast<uint32_t>(static_cast<float>(value));
            std::memcpy(block.data() + field.offset + col * stride + row * 4, &word, 4);
        }
}

Layout uniformLayout(const Type& type) {
    // WGSL host-shareable layout: scalars 4/4; vec2 8/8; vec3 16/12; vec4 16/16; a matrix is
    // `cols` columns of vecR, each padded to the column's alignment.
    auto vector = [](uint32_t rows) -> Layout {
        if (rows == 1) return {4, 4};
        if (rows == 2) return {8, 8};
        return {16, rows * 4u};
    };
    if (type.isMatrix()) {
        const Layout column = vector(type.rows);
        return {column.align, type.cols * roundUp(column.size, column.align)};
    }
    return vector(type.rows);
}

const Variant* ShaderPackage::variant(uint32_t key) const {
    for (const Variant& v : variants) {
        if (v.key == key) return &v;
    }
    return nullptr;
}

StageModule buildStage(const Program& program, uint32_t group) {
    StageModule module{program.stage()};
    module.wgsl = WgslEmitter::emit(program, group);

    // Mirrors the emitter's first-use order, so every offset and binding names what WGSL declares.
    uint32_t offset = 0;
    uint32_t structAlign = 1;
    uint32_t location = 0;
    for (ExprId id = 1; id < program.exprs_.size(); ++id) {
        const Expr& e = program.exprs_[id];
        if (e.op == Op::Uniform) {
            const Layout layout = uniformLayout(e.type);
            offset = roundUp(offset, layout.align);
            const std::string& name = program.names_[e.immediate];
            module.uniforms.push_back(UniformField{name, e.type, offset, layout.size, scheduleFor(name)});
            offset += layout.size;
            structAlign = std::max(structAlign, layout.align);
        } else if (e.op == Op::Attribute) {
            module.attributes.push_back(VertexAttribute{program.names_[e.immediate], location++, e.type});
        }
    }
    uint32_t binding = 0;
    if (!module.uniforms.empty()) {
        module.uniformBlockSize = roundUp(offset, structAlign);
        module.bindings.push_back(Binding{group, binding++, BindingKind::Uniform, "u", module.uniformBlockSize});
    }
    for (const auto& storage : program.storage_) {
        const Layout element = uniformLayout(storage.element);
        module.bindings.push_back(
            Binding{group, binding++, BindingKind::Storage, "s_" + storage.name, roundUp(element.size, element.align)});
    }
    for (const auto& texture : program.storageTextures_)
        module.bindings.push_back(Binding{group, binding++, BindingKind::StorageTexture, "st_" + texture.name, 0, false, false, texture.volume});
    for (std::size_t i = 0; i < program.textures_.size(); ++i) {
        const std::string& name = program.textures_[i];
        const bool values = program.textureKinds_[i] == Program::TextureKind::DepthCubeValues;
        const bool depth = program.textureKinds_[i] == Program::TextureKind::Depth2d ||
                           program.textureKinds_[i] == Program::TextureKind::DepthCube || values;
        const bool volume = program.textureKinds_[i] == Program::TextureKind::Float3d;
        const bool array = program.textureKinds_[i] == Program::TextureKind::Float2dArray;
        const bool cube = program.textureKinds_[i] == Program::TextureKind::DepthCube || values ||
                          program.textureKinds_[i] == Program::TextureKind::FloatCube;
        module.bindings.push_back(Binding{group, binding++, BindingKind::Texture, "t_" + name, 0, depth, cube, volume, false, array});
        if (program.textureNeedsSampler(i) && program.samplerOwner(i) == i)
            module.bindings.push_back(Binding{group, binding++, BindingKind::Sampler, "smp_" + name, 0, depth, cube, volume, values, array});
    }
    return module;
}

namespace {
/**
 * Finds `pattern` in `code` from `from` on, skipping by the pattern's length (Boyer-Moore-Horspool). WGSL is dense in
 * the patterns' first letter, so std::string::find, which stops at each one, was as slow as a character loop.
 */
class Finder {
public:
    explicit Finder(std::string_view pattern) : searcher_(pattern.begin(), pattern.end()) {}
    size_t operator()(const std::string& code, size_t from) const {
        if (from >= code.size()) return std::string::npos;
        const auto found = std::search(code.begin() + std::ptrdiff_t(from), code.end(), searcher_);
        return found == code.end() ? std::string::npos : size_t(found - code.begin());
    }

private:
    std::boyer_moore_horspool_searcher<std::string_view::const_iterator> searcher_;
};
}  // namespace

void positionalGraphTextures(StageModule& module) {
    static constexpr std::string_view prefix = "nodeMapT";
    auto& labels = module.graphTextureLabels;
    const auto digitsEnd = [](std::string_view text, size_t from) {
        while (from < text.size() && text[from] >= '0' && text[from] <= '9') ++from;
        return from;
    };
    // Bindings first: they follow the stage's declaration order, so equal structures number their maps alike.
    for (Binding& b : module.bindings) {
        const size_t at = b.name.rfind(prefix, 4);
        if (at != 2 && at != 4) continue;  // "t_nodeMapT12" or "smp_nodeMapT12"
        if (b.name.substr(0, at) != (at == 2 ? "t_" : "smp_") || digitsEnd(b.name, at + prefix.size()) != b.name.size() ||
            b.name.size() == at + prefix.size()) continue;
        const std::string own = b.name.substr(at);
        auto found = std::find_if(labels.begin(), labels.end(), [&](const auto& label) { return label.second == own; });
        if (found == labels.end()) found = labels.insert(labels.end(), {"nodeMapP" + std::to_string(labels.size()), own});
        b.name = b.name.substr(0, at) + found->first;
    }
    if (labels.empty()) return;
    // Jump between matches and copy the text between them whole: a character-at-a-time copy of a 140 KB fragment
    // cost 1.5 ms in Wasm, paid again by every program a streamed batch copied mid-walk.
    const std::string& code = module.wgsl.code;
    std::string out;
    size_t from = 0;  // code[from, i) is not yet copied
    const Finder find(prefix);
    for (size_t i = find(code, 0); i != std::string::npos; i = find(code, i)) {
        const size_t end = digitsEnd(code, i + prefix.size());
        if (end == i + prefix.size()) { ++i; continue; }
        const std::string_view own(code.data() + i, end - i);
        const auto found = std::find_if(labels.begin(), labels.end(), [&](const auto& label) { return label.second == own; });
        if (found == labels.end()) { i = end; continue; }  // not one of this stage's maps: the text stays
        if (out.empty()) out.reserve(code.size());
        out.append(code, from, i - from);
        out += found->first;
        from = i = end;
    }
    if (from == 0) return;
    out.append(code, from, std::string::npos);
    module.wgsl.code = std::move(out);
}

void positionalSerialNames(StageModule& module) {
    static constexpr std::string_view prefixes[] = {"nodeUniform", "nodeVarying", "varyingProperty"};
    const std::string& code = module.wgsl.code;
    const auto word = [](char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '_'; };
    std::vector<std::pair<std::string, std::string>> names;  // own serial name, positional name
    // As positionalGraphTextures: jump to the nearest prefix and copy the text between matches whole (2.9 ms a
    // 140 KB fragment, character at a time).
    std::string out;
    size_t from = 0;  // code[from, i) is not yet copied
    const std::array<Finder, std::size(prefixes)> finds{Finder(prefixes[0]), Finder(prefixes[1]), Finder(prefixes[2])};
    std::array<size_t, std::size(prefixes)> next{};
    for (size_t k = 0; k < next.size(); ++k) next[k] = finds[k](code, 0);
    for (;;) {
        const size_t k = size_t(std::min_element(next.begin(), next.end()) - next.begin());
        const size_t i = next[k];
        if (i == std::string::npos) break;
        const std::string_view prefix = prefixes[k];
        size_t end = i + prefix.size();
        while (end < code.size() && code[end] >= '0' && code[end] <= '9') ++end;
        if (end == i + prefix.size() || (end < code.size() && word(code[end]))) {  // a serial ends the word
            next[k] = finds[k](code, i + 1);
            continue;
        }
        const std::string_view own(code.data() + i, end - i);
        auto found = std::find_if(names.begin(), names.end(), [&](const auto& name) { return name.first == own; });
        if (found == names.end())
            found = names.insert(names.end(), {std::string(own), std::string(prefix) + "S" + std::to_string(names.size())});
        if (out.empty()) out.reserve(code.size());
        out.append(code, from, i - from);
        out += found->second;
        from = end;
        for (size_t j = 0; j < next.size(); ++j)
            if (next[j] != std::string::npos && next[j] < end) next[j] = finds[j](code, end);
    }
    if (names.empty()) return;
    out.append(code, from, std::string::npos);
    module.wgsl.code = std::move(out);
}

bool acceptPackage(const ShaderPackage& package, std::string& error) {
    if (package.version != kShaderPackageVersion) {
        error = "TN_SHADER_PACKAGE_VERSION: package '" + package.name + "' is revision " +
                std::to_string(package.version) + ", the engine reads " + std::to_string(kShaderPackageVersion);
        return false;
    }
    if (!package.ok()) {
        error = "TN_SHADER_PACKAGE_INVALID: " + package.errors.front();
        return false;
    }
    for (const Variant& variant : package.variants) {
        for (const StageModule& stage : variant.stages) {
            if (!stage.wgsl.ok()) {
                error = "TN_SHADER_PACKAGE_INVALID: " + stage.wgsl.errors.front();
                return false;
            }
        }
    }
    return true;
}

}  // namespace tn::engine::shader
