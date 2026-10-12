#include "package.h"

#include <string_view>

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
    for (std::string_view frame : {"time", "dt", "frame"}) {
        if (name == frame) return UpdateSchedule::Frame;
    }
    if (name == "resolution") return UpdateSchedule::Render;
    return UpdateSchedule::Material;
}

}  // namespace

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
    for (std::size_t i = 0; i < program.textures_.size(); ++i) {
        const std::string& name = program.textures_[i];
        const bool depth = program.textureKinds_[i] == Program::TextureKind::Depth2d ||
                           program.textureKinds_[i] == Program::TextureKind::DepthCube;
        const bool volume = program.textureKinds_[i] == Program::TextureKind::Float3d;
        const bool cube = program.textureKinds_[i] == Program::TextureKind::DepthCube ||
                          program.textureKinds_[i] == Program::TextureKind::FloatCube;
        module.bindings.push_back(Binding{group, binding++, BindingKind::Texture, "t_" + name, 0, depth, cube, volume});
        module.bindings.push_back(Binding{group, binding++, BindingKind::Sampler, "smp_" + name, 0, depth, cube, volume});
    }
    return module;
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
