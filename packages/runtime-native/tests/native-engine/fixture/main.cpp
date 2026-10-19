// tn-native-engine-fixture-driver: run-native.ts spawns this and writes one fixture on stdin.
#include "driver.h"
#include "engine/abi/bindings.h"

#include <iostream>

int main() {
    tn::fixture::Driver driver;
    tn::binding::registerAll(driver.classes);
    return driver.run(std::cin, std::cout);
}
