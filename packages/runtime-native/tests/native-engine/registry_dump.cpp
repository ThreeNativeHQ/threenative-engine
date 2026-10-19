// Prints the engine's binding registry as JSON, the truth of what is natively implemented and
// bound (PRD-531 phase 1). `--check FILE` compares the output with a committed snapshot and fails
// on drift, ignoring whitespace (the snapshot is Biome-formatted; no registry name holds a space);
// the sync script reads the same JSON to update the catalog.

#include "engine/abi/bindings.h"
#include "engine/foundation/ThreeConstants.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

namespace {

std::string escape(const std::string& text) {
    std::string out;
    out.reserve(text.size() + 2);
    for (char c : text) {
        if (c == '"' || c == '\\') out += '\\';
        out += c;
    }
    return out;
}

template <typename Map>
std::string keys(const Map& map) {
    std::string out = "[";
    bool first = true;
    for (const auto& [key, value] : map) {
        (void)value;
        if (!first) out += ", ";
        first = false;
        out += '"' + escape(key) + '"';
    }
    return out + "]";
}

std::string dump(const tn::binding::Registry& registry) {
    std::ostringstream out;
    out << "{\n  \"classes\": {\n";
    bool firstClass = true;
    for (const auto& [name, binding] : registry) {
        if (!firstClass) out << ",\n";
        firstClass = false;
        out << "    \"" << escape(name) << "\": {\n";
        out << "      \"constructor\": " << (binding.ctor ? "true" : "false") << ",\n";
        out << "      \"methods\": " << keys(binding.methods) << ",\n";
        out << "      \"getters\": " << keys(binding.getters) << ",\n";
        out << "      \"setters\": " << keys(binding.setters) << ",\n";
        out << "      \"members\": " << keys(binding.members) << ",\n";
        out << "      \"callbacks\": " << keys(binding.callbacks) << ",\n";
        out << "      \"events\": " << keys(binding.events) << ",\n";
        out << "      \"fixedMembers\": [";
        bool firstFixed = true;
        for (const auto& member : binding.fixedMembers) {
            out << (firstFixed ? "" : ", ") << "\"" << escape(member) << "\"";
            firstFixed = false;
        }
        out << "],\n      \"fields\": {";
        bool firstField = true;
        for (const auto& [field, at] : binding.fields) {
            out << (firstField ? "" : ", ") << "\"" << escape(field) << "\": [" << at.first << ", " << at.second << "]";
            firstField = false;
        }
        out << "}\n";
        out << "    }";
    }
    out << "\n  },\n  \"constants\": [";
    std::vector<std::string> constantNames;
    constantNames.reserve(sizeof(tn::engine::kThreeConstants) / sizeof(tn::engine::kThreeConstants[0]));
    for (const auto& c : tn::engine::kThreeConstants) {
        constantNames.push_back(c.name);
    }
    std::sort(constantNames.begin(), constantNames.end());
    for (size_t i = 0; i < constantNames.size(); ++i) {
        if (i > 0) out << ", ";
        out << "\n    \"" << escape(constantNames[i]) << "\"";
    }
    if (!constantNames.empty()) out << "\n  ";
    out << "]\n}\n";
    return out.str();
}

std::string withoutSpace(std::string text) {
    text.erase(std::remove_if(text.begin(), text.end(), [](unsigned char c) { return std::isspace(c); }),
               text.end());
    return text;
}

std::string readFile(const char* path) {
    std::ifstream file(path, std::ios::binary);
    std::ostringstream buffer;
    buffer << file.rdbuf();
    return buffer.str();
}

}  // namespace

int main(int argc, char** argv) {
    tn::binding::Registry registry;
    tn::binding::registerAll(registry);
    const std::string text = dump(registry);

    const char* check = nullptr;
    const char* out = nullptr;
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "--check" && i + 1 < argc) check = argv[++i];
        else if (arg == "--out" && i + 1 < argc) out = argv[++i];
    }

    if (out != nullptr) {
        std::ofstream file(out, std::ios::binary);
        file << text;
    }
    if (check != nullptr) {
        const std::string committed = readFile(check);
        if (withoutSpace(committed) != withoutSpace(text)) {
            std::fprintf(stderr, "native registry snapshot drift: %s\n", check);
            return 1;
        }
        return 0;
    }
    std::fputs(text.c_str(), stdout);
    return 0;
}
