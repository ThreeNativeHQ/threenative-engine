/**
 * MystralNative Vulkan Ray Tracing Backend Implementation
 *
 * This file implements hardware-accelerated ray tracing using Vulkan's
 * VK_KHR_ray_tracing_pipeline and VK_KHR_acceleration_structure extensions.
 *
 * Architecture Overview:
 * - VulkanRTBackend manages Vulkan instance, device, and RT resources
 * - Geometry is uploaded to GPU buffers and referenced by BLAS
 * - BLAS contains geometry in object space (can be reused/instanced)
 * - TLAS contains positioned instances of BLASes
 * - RT pipeline defines ray generation, miss, and closest hit shaders
 * - Shader Binding Table (SBT) maps shader groups to shader programs
 *
 * Reference: Khronos VK_KHR_ray_tracing_pipeline specification
 * Reference: NVIDIA VK Ray Tracing Tutorial (nvpro-samples)
 */

#include "vulkan_rt.h"
#include <iostream>
#include <cstring>
#include <algorithm>
#include <fstream>
#include <array>
#include <chrono>
#if !defined(_WIN32)
#include <unistd.h>
#endif

// Embedded SPIR-V shaders, generated from the GLSL beside them by cmake/CompileRTShaders.cmake
#include "shaders/rt_shaders_spirv.h"
#include "shaders/probe_trace_spirv.h"

namespace mystral {
namespace rt {

// ============================================================================
// Constants
// ============================================================================

static const std::vector<const char*> REQUIRED_INSTANCE_EXTENSIONS = {
    VK_KHR_GET_PHYSICAL_DEVICE_PROPERTIES_2_EXTENSION_NAME,
};

static const std::vector<const char*> REQUIRED_DEVICE_EXTENSIONS = {
    VK_KHR_ACCELERATION_STRUCTURE_EXTENSION_NAME,
    VK_KHR_RAY_TRACING_PIPELINE_EXTENSION_NAME,
    VK_KHR_DEFERRED_HOST_OPERATIONS_EXTENSION_NAME,
    VK_KHR_BUFFER_DEVICE_ADDRESS_EXTENSION_NAME,
    VK_KHR_SPIRV_1_4_EXTENSION_NAME,
    VK_KHR_SHADER_FLOAT_CONTROLS_EXTENSION_NAME,
};

// ============================================================================
// VulkanRTBackend Implementation
// ============================================================================

VulkanRTBackend::VulkanRTBackend() = default;

VulkanRTBackend::~VulkanRTBackend() {
    // Every release below is guarded by its handle, so a backend whose initialize() failed
    // halfway frees what it created instead of leaking the instance and the device.

    // Wait for device to be idle before cleanup
    if (device_ != VK_NULL_HANDLE) {
        vkDeviceWaitIdle(device_);
    }
    destroySharedTrace();

    // Clean up all tracked resources
    for (auto& [id, tlas] : tlases_) {
        if (tlas && tlas->accelerationStructure != VK_NULL_HANDLE && vkDestroyAccelerationStructureKHR_) {
            vkDestroyAccelerationStructureKHR_(device_, tlas->accelerationStructure, nullptr);
        }
        if (tlas) {
            destroyBuffer(tlas->buffer);
            destroyBuffer(tlas->instanceBuffer);
        }
    }
    tlases_.clear();

    for (auto& [id, blas] : blases_) {
        if (blas && blas->accelerationStructure != VK_NULL_HANDLE && vkDestroyAccelerationStructureKHR_) {
            vkDestroyAccelerationStructureKHR_(device_, blas->accelerationStructure, nullptr);
        }
        if (blas) {
            destroyBuffer(blas->buffer);
        }
    }
    blases_.clear();

    for (auto& [id, geom] : geometries_) {
        if (geom) {
            destroyBuffer(geom->vertexBuffer);
            destroyBuffer(geom->indexBuffer);
        }
    }
    geometries_.clear();

    // Clean up output resources
    if (outputImageView_ != VK_NULL_HANDLE) {
        vkDestroyImageView(device_, outputImageView_, nullptr);
    }
    if (outputImage_ != VK_NULL_HANDLE) {
        vkDestroyImage(device_, outputImage_, nullptr);
    }
    if (outputImageMemory_ != VK_NULL_HANDLE) {
        vkFreeMemory(device_, outputImageMemory_, nullptr);
    }
    destroyBuffer(stagingBuffer_);
    destroyBuffer(cameraUBO_);
    destroyBuffer(sbtBuffer_);

    // Clean up the ray batch kernel (its command buffer goes with the command pool)
    destroyBuffer(batchRaysStaging_);
    destroyBuffer(batchRaysDevice_);
    destroyBuffer(batchHitsDevice_);
    destroyBuffer(batchHitsStaging_);
    if (batchFence_ != VK_NULL_HANDLE) {
        vkDestroyFence(device_, batchFence_, nullptr);
    }
    if (timestampPool_ != VK_NULL_HANDLE) {
        vkDestroyQueryPool(device_, timestampPool_, nullptr);
    }
    if (batchPipeline_ != VK_NULL_HANDLE) {
        vkDestroyPipeline(device_, batchPipeline_, nullptr);
    }
    if (batchPipelineLayout_ != VK_NULL_HANDLE) {
        vkDestroyPipelineLayout(device_, batchPipelineLayout_, nullptr);
    }
    if (batchSetLayout_ != VK_NULL_HANDLE) {
        vkDestroyDescriptorSetLayout(device_, batchSetLayout_, nullptr);
    }
    if (batchPool_ != VK_NULL_HANDLE) {
        vkDestroyDescriptorPool(device_, batchPool_, nullptr);
    }

    // Clean up pipeline
    if (rtPipeline_ != VK_NULL_HANDLE) {
        vkDestroyPipeline(device_, rtPipeline_, nullptr);
    }
    if (pipelineLayout_ != VK_NULL_HANDLE) {
        vkDestroyPipelineLayout(device_, pipelineLayout_, nullptr);
    }
    if (descriptorSetLayout_ != VK_NULL_HANDLE) {
        vkDestroyDescriptorSetLayout(device_, descriptorSetLayout_, nullptr);
    }
    if (descriptorPool_ != VK_NULL_HANDLE) {
        vkDestroyDescriptorPool(device_, descriptorPool_, nullptr);
    }

    // Clean up command pool
    if (commandPool_ != VK_NULL_HANDLE) {
        vkDestroyCommandPool(device_, commandPool_, nullptr);
    }

    // Clean up device and instance
    if (device_ != VK_NULL_HANDLE) {
        vkDestroyDevice(device_, nullptr);
    }
    if (instance_ != VK_NULL_HANDLE) {
        vkDestroyInstance(instance_, nullptr);
    }

    std::cout << "[VulkanRT] Backend cleaned up" << std::endl;
}

bool VulkanRTBackend::initialize() {
    if (initialized_) return rtSupported_;

    std::cout << "[VulkanRT] Initializing Vulkan ray tracing backend..." << std::endl;

    // The core steps must all succeed: an instance, a device with the acceleration structure
    // extensions, their function pointers, a command pool and the descriptor pool.
    if (!createInstance()) {
        std::cerr << "[VulkanRT] Failed to create Vulkan instance" << std::endl;
        initError_ = "no Vulkan 1.2 instance";
        return false;
    }

    if (!selectPhysicalDevice()) {
        std::cerr << "[VulkanRT] No RT-capable GPU found" << std::endl;
        initError_ = "no GPU with VK_KHR_acceleration_structure and VK_KHR_ray_tracing_pipeline";
        return false;
    }

    if (!createDevice()) {
        std::cerr << "[VulkanRT] Failed to create logical device" << std::endl;
        initError_ = "vkCreateDevice failed with the ray tracing extensions";
        return false;
    }

    if (!loadExtensionFunctions()) {
        std::cerr << "[VulkanRT] Failed to load extension functions" << std::endl;
        initError_ = "a ray tracing function pointer is missing";
        return false;
    }

    if (!createCommandPool()) {
        std::cerr << "[VulkanRT] Failed to create command pool" << std::endl;
        initError_ = "vkCreateCommandPool failed";
        return false;
    }

    if (!createDescriptorPool()) {
        std::cerr << "[VulkanRT] Failed to create descriptor pool" << std::endl;
        initError_ = "the camera descriptor pool could not be created";
        return false;
    }

    // The two ways to trace are independent. The camera path draws an image, the batch path
    // returns hit records. A driver can run one and refuse the other, so each keeps its own reason.
    imagePathReady_ = createImagePath();
    batchReady_ = createBatchPath();
    if (!imagePathReady_ && !batchReady_) {
        initError_ = "the camera path failed (" + imageError_ + ") and the ray batch path failed (" +
                     batchError_ + ")";
        return false;
    }

    initialized_ = true;
    rtSupported_ = true;

    std::cout << "[VulkanRT] Vulkan ray tracing backend initialized (camera path: "
              << (imagePathReady_ ? std::string("ready") : imageError_) << ", ray batch: "
              << (batchReady_ ? std::string("ready") : batchError_) << ")" << std::endl;
    return true;
}

// ============================================================================
// Capability Queries
// ============================================================================

bool VulkanRTBackend::isSupported() {
    return initialized_ && rtSupported_;
}

RTBackendType VulkanRTBackend::getBackendType() {
    return RTBackendType::Vulkan;
}

const char* VulkanRTBackend::getBackend() {
    return "vulkan";
}

// ============================================================================
// Instance Creation
// ============================================================================

bool VulkanRTBackend::createInstance() {
    // Check for Vulkan loader
    uint32_t instanceVersion = 0;
    if (vkEnumerateInstanceVersion(&instanceVersion) != VK_SUCCESS) {
        std::cerr << "[VulkanRT] Vulkan not available" << std::endl;
        return false;
    }

    uint32_t major = VK_VERSION_MAJOR(instanceVersion);
    uint32_t minor = VK_VERSION_MINOR(instanceVersion);
    std::cout << "[VulkanRT] Vulkan version: " << major << "." << minor << std::endl;

    // Require Vulkan 1.2+ for ray tracing
    if (instanceVersion < VK_API_VERSION_1_2) {
        std::cerr << "[VulkanRT] Vulkan 1.2+ required for ray tracing" << std::endl;
        return false;
    }

    // Check for required instance extensions
    uint32_t extensionCount = 0;
    vkEnumerateInstanceExtensionProperties(nullptr, &extensionCount, nullptr);
    std::vector<VkExtensionProperties> availableExtensions(extensionCount);
    vkEnumerateInstanceExtensionProperties(nullptr, &extensionCount, availableExtensions.data());

    for (const char* required : REQUIRED_INSTANCE_EXTENSIONS) {
        bool found = false;
        for (const auto& ext : availableExtensions) {
            if (strcmp(required, ext.extensionName) == 0) {
                found = true;
                break;
            }
        }
        if (!found) {
            std::cerr << "[VulkanRT] Missing required instance extension: " << required << std::endl;
            return false;
        }
    }

    VkApplicationInfo appInfo = {};
    appInfo.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO;
    appInfo.pApplicationName = "MystralNative";
    appInfo.applicationVersion = VK_MAKE_VERSION(1, 0, 0);
    appInfo.pEngineName = "Mystral";
    appInfo.engineVersion = VK_MAKE_VERSION(1, 0, 0);
    appInfo.apiVersion = VK_API_VERSION_1_2;

    VkInstanceCreateInfo createInfo = {};
    createInfo.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    createInfo.pApplicationInfo = &appInfo;
    createInfo.enabledExtensionCount = static_cast<uint32_t>(REQUIRED_INSTANCE_EXTENSIONS.size());
    createInfo.ppEnabledExtensionNames = REQUIRED_INSTANCE_EXTENSIONS.data();

    if (vkCreateInstance(&createInfo, nullptr, &instance_) != VK_SUCCESS) {
        std::cerr << "[VulkanRT] Failed to create Vulkan instance" << std::endl;
        return false;
    }

    return true;
}

// ============================================================================
// Physical Device Selection
// ============================================================================

bool VulkanRTBackend::selectPhysicalDevice() {
    uint32_t deviceCount = 0;
    vkEnumeratePhysicalDevices(instance_, &deviceCount, nullptr);
    if (deviceCount == 0) {
        std::cerr << "[VulkanRT] No Vulkan devices found" << std::endl;
        return false;
    }

    std::vector<VkPhysicalDevice> devices(deviceCount);
    vkEnumeratePhysicalDevices(instance_, &deviceCount, devices.data());

    for (VkPhysicalDevice device : devices) {
        VkPhysicalDeviceProperties props;
        vkGetPhysicalDeviceProperties(device, &props);

        std::cout << "[VulkanRT] Checking device: " << props.deviceName << std::endl;

        // Check for required device extensions
        uint32_t extensionCount = 0;
        vkEnumerateDeviceExtensionProperties(device, nullptr, &extensionCount, nullptr);
        std::vector<VkExtensionProperties> availableExtensions(extensionCount);
        vkEnumerateDeviceExtensionProperties(device, nullptr, &extensionCount, availableExtensions.data());

        bool allExtensionsSupported = true;
        for (const char* required : REQUIRED_DEVICE_EXTENSIONS) {
            bool found = false;
            for (const auto& ext : availableExtensions) {
                if (strcmp(required, ext.extensionName) == 0) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                std::cout << "[VulkanRT]   Missing extension: " << required << std::endl;
                allExtensionsSupported = false;
                break;
            }
        }

        if (!allExtensionsSupported) continue;

        bool hasRayQueryExtension = false;
        for (const auto& ext : availableExtensions) {
            if (strcmp(VK_KHR_RAY_QUERY_EXTENSION_NAME, ext.extensionName) == 0) {
                hasRayQueryExtension = true;
                break;
            }
        }

        // Check for compute queue family
        uint32_t queueFamilyCount = 0;
        vkGetPhysicalDeviceQueueFamilyProperties(device, &queueFamilyCount, nullptr);
        std::vector<VkQueueFamilyProperties> queueFamilies(queueFamilyCount);
        vkGetPhysicalDeviceQueueFamilyProperties(device, &queueFamilyCount, queueFamilies.data());

        bool hasComputeQueue = false;
        for (uint32_t i = 0; i < queueFamilyCount; i++) {
            if (queueFamilies[i].queueFlags & VK_QUEUE_COMPUTE_BIT) {
                queueFamilyIndex_ = i;
                hasComputeQueue = true;
                break;
            }
        }

        if (!hasComputeQueue) {
            std::cout << "[VulkanRT]   No compute queue family" << std::endl;
            continue;
        }

        // Get RT pipeline properties
        rtPipelineProperties_.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_RAY_TRACING_PIPELINE_PROPERTIES_KHR;

        VkPhysicalDeviceProperties2 props2 = {};
        props2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2;
        props2.pNext = &rtPipelineProperties_;

        // Get the function pointer for vkGetPhysicalDeviceProperties2
        auto vkGetPhysicalDeviceProperties2Fn =
            (PFN_vkGetPhysicalDeviceProperties2)vkGetInstanceProcAddr(instance_, "vkGetPhysicalDeviceProperties2");
        if (vkGetPhysicalDeviceProperties2Fn) {
            vkGetPhysicalDeviceProperties2Fn(device, &props2);
        }

        // Check acceleration structure, pipeline and ray query features. The ray query struct joins
        // the chain only when the extension exists: an unknown struct in a query is not defined.
        asFeatures_.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ACCELERATION_STRUCTURE_FEATURES_KHR;

        VkPhysicalDeviceRayTracingPipelineFeaturesKHR rtPipelineFeatures = {};
        rtPipelineFeatures.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_RAY_TRACING_PIPELINE_FEATURES_KHR;
        VkPhysicalDeviceRayQueryFeaturesKHR rayQueryFeatures = {};
        rayQueryFeatures.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_RAY_QUERY_FEATURES_KHR;
        asFeatures_.pNext = &rtPipelineFeatures;
        rtPipelineFeatures.pNext = hasRayQueryExtension ? &rayQueryFeatures : nullptr;

        VkPhysicalDeviceFeatures2 features2 = {};
        features2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
        features2.pNext = &asFeatures_;

        auto vkGetPhysicalDeviceFeatures2Fn =
            (PFN_vkGetPhysicalDeviceFeatures2)vkGetInstanceProcAddr(instance_, "vkGetPhysicalDeviceFeatures2");
        if (vkGetPhysicalDeviceFeatures2Fn) {
            vkGetPhysicalDeviceFeatures2Fn(device, &features2);
        }
        asFeatures_.pNext = nullptr;

        if (!asFeatures_.accelerationStructure) {
            std::cout << "[VulkanRT]   Acceleration structures not supported" << std::endl;
            continue;
        }
        if (!rtPipelineFeatures.rayTracingPipeline) {
            std::cout << "[VulkanRT]   Ray tracing pipeline not supported" << std::endl;
            continue;
        }

        // Found suitable device
        physicalDevice_ = device;
        rayQuerySupported_ = hasRayQueryExtension && rayQueryFeatures.rayQuery;

        caps_.backend = "vulkan";
        caps_.deviceName = props.deviceName;
        caps_.vendorId = props.vendorID;
        caps_.deviceId = props.deviceID;
        caps_.apiVersion = props.apiVersion;
        caps_.driverVersion = props.driverVersion;
        caps_.maxRayRecursionDepth = rtPipelineProperties_.maxRayRecursionDepth;
        caps_.timestampPeriodNs = props.limits.timestampPeriod;
        caps_.accelerationStructure = asFeatures_.accelerationStructure == VK_TRUE;
        caps_.rayTracingPipeline = true;
        caps_.rayQuery = rayQuerySupported_;
        timestampValidBits_ = queueFamilies[queueFamilyIndex_].timestampValidBits;
        // One ray is kRayWords floats and the kernel addresses a whole batch with one dispatch.
        maxBatchRays_ = std::min<uint64_t>(
            props.limits.maxStorageBufferRange / (kRayWords * sizeof(float)),
            static_cast<uint64_t>(props.limits.maxComputeWorkGroupCount[0]) * 64);
        std::cout << "[VulkanRT] Selected device: " << props.deviceName << std::endl;
        std::cout << "[VulkanRT]   Max ray recursion depth: " << rtPipelineProperties_.maxRayRecursionDepth << std::endl;
        std::cout << "[VulkanRT]   Shader group handle size: " << rtPipelineProperties_.shaderGroupHandleSize << std::endl;
        std::cout << "[VulkanRT]   Ray query: " << (rayQuerySupported_ ? "yes" : "no") << std::endl;
        return true;
    }

    return false;
}

// ============================================================================
// Logical Device Creation
// ============================================================================

bool VulkanRTBackend::createDevice() {
    float queuePriority = 1.0f;

    VkDeviceQueueCreateInfo queueCreateInfo = {};
    queueCreateInfo.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    queueCreateInfo.queueFamilyIndex = queueFamilyIndex_;
    queueCreateInfo.queueCount = 1;
    queueCreateInfo.pQueuePriorities = &queuePriority;

    // Enable required features
    // Ray query is optional: a device without it still runs the camera path.
    std::vector<const char*> deviceExtensions = REQUIRED_DEVICE_EXTENSIONS;
    VkPhysicalDeviceRayQueryFeaturesKHR rayQueryFeatures = {};
    rayQueryFeatures.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_RAY_QUERY_FEATURES_KHR;
    rayQueryFeatures.rayQuery = VK_TRUE;
    if (rayQuerySupported_) {
        deviceExtensions.push_back(VK_KHR_RAY_QUERY_EXTENSION_NAME);
    }

    // The shared trace transport (PRD-645) needs these four. Without them the batch path still
    // works and only the shared transport reports why it is off.
    {
        uint32_t extensionCount = 0;
        vkEnumerateDeviceExtensionProperties(physicalDevice_, nullptr, &extensionCount, nullptr);
        std::vector<VkExtensionProperties> available(extensionCount);
        vkEnumerateDeviceExtensionProperties(physicalDevice_, nullptr, &extensionCount, available.data());
        const char* sharing[] = {
            VK_KHR_EXTERNAL_MEMORY_EXTENSION_NAME,
            VK_KHR_EXTERNAL_MEMORY_FD_EXTENSION_NAME,
            VK_KHR_EXTERNAL_SEMAPHORE_EXTENSION_NAME,
            VK_KHR_EXTERNAL_SEMAPHORE_FD_EXTENSION_NAME,
        };
        externalSharingReady_ = std::all_of(std::begin(sharing), std::end(sharing), [&](const char* name) {
            return std::any_of(available.begin(), available.end(), [&](const VkExtensionProperties& found) {
                return std::strcmp(found.extensionName, name) == 0;
            });
        });
        if (externalSharingReady_) {
            deviceExtensions.insert(deviceExtensions.end(), std::begin(sharing), std::end(sharing));
        }
    }

    VkPhysicalDeviceBufferDeviceAddressFeatures bufferDeviceAddressFeatures = {};
    bufferDeviceAddressFeatures.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_BUFFER_DEVICE_ADDRESS_FEATURES;
    bufferDeviceAddressFeatures.bufferDeviceAddress = VK_TRUE;
    bufferDeviceAddressFeatures.pNext = rayQuerySupported_ ? &rayQueryFeatures : nullptr;

    VkPhysicalDeviceRayTracingPipelineFeaturesKHR rtPipelineFeatures = {};
    rtPipelineFeatures.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_RAY_TRACING_PIPELINE_FEATURES_KHR;
    rtPipelineFeatures.rayTracingPipeline = VK_TRUE;
    rtPipelineFeatures.pNext = &bufferDeviceAddressFeatures;

    VkPhysicalDeviceAccelerationStructureFeaturesKHR asFeatures = {};
    asFeatures.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ACCELERATION_STRUCTURE_FEATURES_KHR;
    asFeatures.accelerationStructure = VK_TRUE;
    asFeatures.pNext = &rtPipelineFeatures;

    VkPhysicalDeviceFeatures2 deviceFeatures2 = {};
    deviceFeatures2.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2;
    deviceFeatures2.pNext = &asFeatures;

    VkDeviceCreateInfo createInfo = {};
    createInfo.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    createInfo.pNext = &deviceFeatures2;
    createInfo.queueCreateInfoCount = 1;
    createInfo.pQueueCreateInfos = &queueCreateInfo;
    createInfo.enabledExtensionCount = static_cast<uint32_t>(deviceExtensions.size());
    createInfo.ppEnabledExtensionNames = deviceExtensions.data();

    if (vkCreateDevice(physicalDevice_, &createInfo, nullptr, &device_) != VK_SUCCESS) {
        std::cerr << "[VulkanRT] Failed to create logical device" << std::endl;
        return false;
    }

    vkGetDeviceQueue(device_, queueFamilyIndex_, 0, &queue_);
    return true;
}

// ============================================================================
// Extension Function Loading
// ============================================================================

bool VulkanRTBackend::loadExtensionFunctions() {
    #define LOAD_VK_FUNC(name) \
        name##_ = (PFN_##name)vkGetDeviceProcAddr(device_, #name); \
        if (!name##_) { \
            std::cerr << "[VulkanRT] Failed to load " #name << std::endl; \
            return false; \
        }

    LOAD_VK_FUNC(vkCreateAccelerationStructureKHR);
    LOAD_VK_FUNC(vkDestroyAccelerationStructureKHR);
    LOAD_VK_FUNC(vkGetAccelerationStructureBuildSizesKHR);
    LOAD_VK_FUNC(vkCmdBuildAccelerationStructuresKHR);
    LOAD_VK_FUNC(vkGetAccelerationStructureDeviceAddressKHR);
    LOAD_VK_FUNC(vkCreateRayTracingPipelinesKHR);
    LOAD_VK_FUNC(vkGetRayTracingShaderGroupHandlesKHR);
    LOAD_VK_FUNC(vkCmdTraceRaysKHR);
    LOAD_VK_FUNC(vkGetBufferDeviceAddressKHR);

    #undef LOAD_VK_FUNC

    if (externalSharingReady_) {
        vkGetMemoryFdKHR_ = (PFN_vkGetMemoryFdKHR)vkGetDeviceProcAddr(device_, "vkGetMemoryFdKHR");
        vkGetSemaphoreFdKHR_ = (PFN_vkGetSemaphoreFdKHR)vkGetDeviceProcAddr(device_, "vkGetSemaphoreFdKHR");
        vkImportSemaphoreFdKHR_ = (PFN_vkImportSemaphoreFdKHR)vkGetDeviceProcAddr(device_, "vkImportSemaphoreFdKHR");
        externalSharingReady_ = vkGetMemoryFdKHR_ && vkGetSemaphoreFdKHR_ && vkImportSemaphoreFdKHR_;
    }

    return true;
}

// ============================================================================
// Command Pool
// ============================================================================

bool VulkanRTBackend::createCommandPool() {
    VkCommandPoolCreateInfo poolInfo = {};
    poolInfo.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
    poolInfo.queueFamilyIndex = queueFamilyIndex_;
    poolInfo.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;

    if (vkCreateCommandPool(device_, &poolInfo, nullptr, &commandPool_) != VK_SUCCESS) {
        return false;
    }
    return true;
}

// ============================================================================
// Descriptor Pool and Layout
// ============================================================================

bool VulkanRTBackend::createDescriptorPool() {
    // Create descriptor pool
    std::array<VkDescriptorPoolSize, 3> poolSizes = {};
    poolSizes[0].type = VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR;
    poolSizes[0].descriptorCount = 1;
    poolSizes[1].type = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE;
    poolSizes[1].descriptorCount = 1;
    poolSizes[2].type = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
    poolSizes[2].descriptorCount = 1;

    VkDescriptorPoolCreateInfo poolInfo = {};
    poolInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
    poolInfo.poolSizeCount = static_cast<uint32_t>(poolSizes.size());
    poolInfo.pPoolSizes = poolSizes.data();
    poolInfo.maxSets = 1;

    if (vkCreateDescriptorPool(device_, &poolInfo, nullptr, &descriptorPool_) != VK_SUCCESS) {
        return false;
    }

    // Create descriptor set layout
    std::array<VkDescriptorSetLayoutBinding, 3> bindings = {};

    // Binding 0: TLAS
    bindings[0].binding = 0;
    bindings[0].descriptorType = VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR;
    bindings[0].descriptorCount = 1;
    bindings[0].stageFlags = VK_SHADER_STAGE_RAYGEN_BIT_KHR;

    // Binding 1: Output image
    bindings[1].binding = 1;
    bindings[1].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE;
    bindings[1].descriptorCount = 1;
    bindings[1].stageFlags = VK_SHADER_STAGE_RAYGEN_BIT_KHR;

    // Binding 2: Camera UBO
    bindings[2].binding = 2;
    bindings[2].descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
    bindings[2].descriptorCount = 1;
    bindings[2].stageFlags = VK_SHADER_STAGE_RAYGEN_BIT_KHR;

    VkDescriptorSetLayoutCreateInfo layoutInfo = {};
    layoutInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
    layoutInfo.bindingCount = static_cast<uint32_t>(bindings.size());
    layoutInfo.pBindings = bindings.data();

    if (vkCreateDescriptorSetLayout(device_, &layoutInfo, nullptr, &descriptorSetLayout_) != VK_SUCCESS) {
        return false;
    }

    // Allocate descriptor set
    VkDescriptorSetAllocateInfo allocInfo = {};
    allocInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
    allocInfo.descriptorPool = descriptorPool_;
    allocInfo.descriptorSetCount = 1;
    allocInfo.pSetLayouts = &descriptorSetLayout_;

    if (vkAllocateDescriptorSets(device_, &allocInfo, &descriptorSet_) != VK_SUCCESS) {
        return false;
    }

    return true;
}

// ============================================================================
// RT Pipeline Creation
// ============================================================================

bool VulkanRTBackend::createRTPipeline() {
    // Create shader modules from embedded SPIR-V
    VkShaderModule raygenModule = createShaderModule(
        std::vector<uint32_t>(raygen_spirv, raygen_spirv + raygen_spirv_size));
    VkShaderModule missModule = createShaderModule(
        std::vector<uint32_t>(miss_spirv, miss_spirv + miss_spirv_size));
    VkShaderModule closestHitModule = createShaderModule(
        std::vector<uint32_t>(closesthit_spirv, closesthit_spirv + closesthit_spirv_size));

    if (!raygenModule || !missModule || !closestHitModule) {
        std::cerr << "[VulkanRT] Failed to create shader modules" << std::endl;
        return false;
    }

    // Shader stages
    std::array<VkPipelineShaderStageCreateInfo, 3> shaderStages = {};

    shaderStages[0].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    shaderStages[0].stage = VK_SHADER_STAGE_RAYGEN_BIT_KHR;
    shaderStages[0].module = raygenModule;
    shaderStages[0].pName = "main";

    shaderStages[1].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    shaderStages[1].stage = VK_SHADER_STAGE_MISS_BIT_KHR;
    shaderStages[1].module = missModule;
    shaderStages[1].pName = "main";

    shaderStages[2].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    shaderStages[2].stage = VK_SHADER_STAGE_CLOSEST_HIT_BIT_KHR;
    shaderStages[2].module = closestHitModule;
    shaderStages[2].pName = "main";

    // Shader groups
    std::array<VkRayTracingShaderGroupCreateInfoKHR, 3> shaderGroups = {};

    // Ray generation group
    shaderGroups[0].sType = VK_STRUCTURE_TYPE_RAY_TRACING_SHADER_GROUP_CREATE_INFO_KHR;
    shaderGroups[0].type = VK_RAY_TRACING_SHADER_GROUP_TYPE_GENERAL_KHR;
    shaderGroups[0].generalShader = 0;  // raygen
    shaderGroups[0].closestHitShader = VK_SHADER_UNUSED_KHR;
    shaderGroups[0].anyHitShader = VK_SHADER_UNUSED_KHR;
    shaderGroups[0].intersectionShader = VK_SHADER_UNUSED_KHR;

    // Miss group
    shaderGroups[1].sType = VK_STRUCTURE_TYPE_RAY_TRACING_SHADER_GROUP_CREATE_INFO_KHR;
    shaderGroups[1].type = VK_RAY_TRACING_SHADER_GROUP_TYPE_GENERAL_KHR;
    shaderGroups[1].generalShader = 1;  // miss
    shaderGroups[1].closestHitShader = VK_SHADER_UNUSED_KHR;
    shaderGroups[1].anyHitShader = VK_SHADER_UNUSED_KHR;
    shaderGroups[1].intersectionShader = VK_SHADER_UNUSED_KHR;

    // Closest hit group
    shaderGroups[2].sType = VK_STRUCTURE_TYPE_RAY_TRACING_SHADER_GROUP_CREATE_INFO_KHR;
    shaderGroups[2].type = VK_RAY_TRACING_SHADER_GROUP_TYPE_TRIANGLES_HIT_GROUP_KHR;
    shaderGroups[2].generalShader = VK_SHADER_UNUSED_KHR;
    shaderGroups[2].closestHitShader = 2;  // closest hit
    shaderGroups[2].anyHitShader = VK_SHADER_UNUSED_KHR;
    shaderGroups[2].intersectionShader = VK_SHADER_UNUSED_KHR;

    // Pipeline layout
    VkPipelineLayoutCreateInfo pipelineLayoutInfo = {};
    pipelineLayoutInfo.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
    pipelineLayoutInfo.setLayoutCount = 1;
    pipelineLayoutInfo.pSetLayouts = &descriptorSetLayout_;

    if (vkCreatePipelineLayout(device_, &pipelineLayoutInfo, nullptr, &pipelineLayout_) != VK_SUCCESS) {
        std::cerr << "[VulkanRT] Failed to create pipeline layout" << std::endl;
        return false;
    }

    // Create ray tracing pipeline
    VkRayTracingPipelineCreateInfoKHR pipelineInfo = {};
    pipelineInfo.sType = VK_STRUCTURE_TYPE_RAY_TRACING_PIPELINE_CREATE_INFO_KHR;
    pipelineInfo.stageCount = static_cast<uint32_t>(shaderStages.size());
    pipelineInfo.pStages = shaderStages.data();
    pipelineInfo.groupCount = static_cast<uint32_t>(shaderGroups.size());
    pipelineInfo.pGroups = shaderGroups.data();
    pipelineInfo.maxPipelineRayRecursionDepth = 1;
    pipelineInfo.layout = pipelineLayout_;

    VkResult result = vkCreateRayTracingPipelinesKHR_(
        device_, VK_NULL_HANDLE, VK_NULL_HANDLE, 1, &pipelineInfo, nullptr, &rtPipeline_);

    // Clean up shader modules (no longer needed after pipeline creation)
    vkDestroyShaderModule(device_, raygenModule, nullptr);
    vkDestroyShaderModule(device_, missModule, nullptr);
    vkDestroyShaderModule(device_, closestHitModule, nullptr);

    if (result != VK_SUCCESS) {
        std::cerr << "[VulkanRT] vkCreateRayTracingPipelinesKHR failed (VkResult " << result << ")" << std::endl;
        return false;
    }

    return true;
}

// ============================================================================
// Shader Binding Table
// ============================================================================

bool VulkanRTBackend::createShaderBindingTable() {
    const uint32_t handleSize = rtPipelineProperties_.shaderGroupHandleSize;
    const uint32_t handleAlignment = rtPipelineProperties_.shaderGroupHandleAlignment;
    const uint32_t baseAlignment = rtPipelineProperties_.shaderGroupBaseAlignment;

    // Align handle size to handle alignment
    const uint32_t handleSizeAligned = (handleSize + handleAlignment - 1) & ~(handleAlignment - 1);

    const uint32_t groupCount = 3;  // raygen, miss, hit

    // Get shader group handles
    const uint32_t dataSize = groupCount * handleSize;
    std::vector<uint8_t> handles(dataSize);

    if (vkGetRayTracingShaderGroupHandlesKHR_(
            device_, rtPipeline_, 0, groupCount, dataSize, handles.data()) != VK_SUCCESS) {
        std::cerr << "[VulkanRT] Failed to get shader group handles" << std::endl;
        return false;
    }

    // Calculate SBT regions (each region starts at baseAlignment boundary)
    const VkDeviceSize raygenSize = (handleSizeAligned + baseAlignment - 1) & ~(baseAlignment - 1);
    const VkDeviceSize missSize = (handleSizeAligned + baseAlignment - 1) & ~(baseAlignment - 1);
    const VkDeviceSize hitSize = (handleSizeAligned + baseAlignment - 1) & ~(baseAlignment - 1);
    const VkDeviceSize sbtSize = raygenSize + missSize + hitSize;

    // Create SBT buffer
    if (!createBuffer(sbtSize,
                      VK_BUFFER_USAGE_SHADER_BINDING_TABLE_BIT_KHR |
                      VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
                      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                      sbtBuffer_)) {
        std::cerr << "[VulkanRT] Failed to create SBT buffer" << std::endl;
        return false;
    }

    // Map and copy handles
    void* mapped;
    vkMapMemory(device_, sbtBuffer_.memory, 0, sbtSize, 0, &mapped);

    uint8_t* data = static_cast<uint8_t*>(mapped);
    memcpy(data, handles.data() + 0 * handleSize, handleSize);  // raygen
    memcpy(data + raygenSize, handles.data() + 1 * handleSize, handleSize);  // miss
    memcpy(data + raygenSize + missSize, handles.data() + 2 * handleSize, handleSize);  // hit

    vkUnmapMemory(device_, sbtBuffer_.memory);

    // Set up strided device address regions
    VkDeviceAddress sbtAddress = sbtBuffer_.deviceAddress;

    raygenRegion_.deviceAddress = sbtAddress;
    raygenRegion_.stride = raygenSize;
    raygenRegion_.size = raygenSize;

    missRegion_.deviceAddress = sbtAddress + raygenSize;
    missRegion_.stride = handleSizeAligned;
    missRegion_.size = missSize;

    hitRegion_.deviceAddress = sbtAddress + raygenSize + missSize;
    hitRegion_.stride = handleSizeAligned;
    hitRegion_.size = hitSize;

    callableRegion_ = {};  // Not used

    return true;
}

// ============================================================================
// Buffer Management
// ============================================================================

bool VulkanRTBackend::createBuffer(VkDeviceSize size, VkBufferUsageFlags usage,
                                    VkMemoryPropertyFlags properties, VulkanBuffer& buffer, bool strict) {
    buffer.size = size;

    VkBufferCreateInfo bufferInfo = {};
    bufferInfo.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
    bufferInfo.size = size;
    bufferInfo.usage = usage;
    bufferInfo.sharingMode = VK_SHARING_MODE_EXCLUSIVE;

    if (vkCreateBuffer(device_, &bufferInfo, nullptr, &buffer.buffer) != VK_SUCCESS) {
        return false;
    }

    VkMemoryRequirements memRequirements;
    vkGetBufferMemoryRequirements(device_, buffer.buffer, &memRequirements);

    VkMemoryAllocateFlagsInfo allocFlagsInfo = {};
    allocFlagsInfo.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_FLAGS_INFO;
    if (usage & VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT) {
        allocFlagsInfo.flags = VK_MEMORY_ALLOCATE_DEVICE_ADDRESS_BIT;
    }

    VkMemoryAllocateInfo allocInfo = {};
    allocInfo.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    allocInfo.pNext = (usage & VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT) ? &allocFlagsInfo : nullptr;
    allocInfo.allocationSize = memRequirements.size;
    allocInfo.memoryTypeIndex = findMemoryTypeIndex(memRequirements.memoryTypeBits, properties);
    if (allocInfo.memoryTypeIndex == UINT32_MAX) {
        if (strict) {
            vkDestroyBuffer(device_, buffer.buffer, nullptr);
            buffer.buffer = VK_NULL_HANDLE;
            return false;
        }
        allocInfo.memoryTypeIndex = 0;  // Fallback (may cause issues)
    }

    if (vkAllocateMemory(device_, &allocInfo, nullptr, &buffer.memory) != VK_SUCCESS) {
        vkDestroyBuffer(device_, buffer.buffer, nullptr);
        buffer.buffer = VK_NULL_HANDLE;
        return false;
    }

    vkBindBufferMemory(device_, buffer.buffer, buffer.memory, 0);

    // Get device address if requested
    if (usage & VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT) {
        VkBufferDeviceAddressInfo addressInfo = {};
        addressInfo.sType = VK_STRUCTURE_TYPE_BUFFER_DEVICE_ADDRESS_INFO;
        addressInfo.buffer = buffer.buffer;
        buffer.deviceAddress = vkGetBufferDeviceAddressKHR_(device_, &addressInfo);
    }

    return true;
}

void VulkanRTBackend::destroyBuffer(VulkanBuffer& buffer) {
    if (buffer.buffer != VK_NULL_HANDLE) {
        vkDestroyBuffer(device_, buffer.buffer, nullptr);
        buffer.buffer = VK_NULL_HANDLE;
    }
    if (buffer.memory != VK_NULL_HANDLE) {
        vkFreeMemory(device_, buffer.memory, nullptr);
        buffer.memory = VK_NULL_HANDLE;
    }
    buffer.deviceAddress = 0;
    buffer.size = 0;
}

uint32_t VulkanRTBackend::findMemoryTypeIndex(uint32_t typeFilter, VkMemoryPropertyFlags properties) {
    VkPhysicalDeviceMemoryProperties memProperties;
    vkGetPhysicalDeviceMemoryProperties(physicalDevice_, &memProperties);

    for (uint32_t i = 0; i < memProperties.memoryTypeCount; i++) {
        if ((typeFilter & (1 << i)) &&
            (memProperties.memoryTypes[i].propertyFlags & properties) == properties) {
            return i;
        }
    }

    return UINT32_MAX;
}

uint32_t VulkanRTBackend::findMemoryType(uint32_t typeFilter, VkMemoryPropertyFlags properties) {
    const uint32_t found = findMemoryTypeIndex(typeFilter, properties);
    return found == UINT32_MAX ? 0 : found;  // Fallback (may cause issues)
}

// ============================================================================
// Command Buffer Helpers
// ============================================================================

VkCommandBuffer VulkanRTBackend::beginSingleTimeCommands() {
    VkCommandBufferAllocateInfo allocInfo = {};
    allocInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    allocInfo.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    allocInfo.commandPool = commandPool_;
    allocInfo.commandBufferCount = 1;

    VkCommandBuffer commandBuffer;
    vkAllocateCommandBuffers(device_, &allocInfo, &commandBuffer);

    VkCommandBufferBeginInfo beginInfo = {};
    beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    beginInfo.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;

    vkBeginCommandBuffer(commandBuffer, &beginInfo);
    return commandBuffer;
}

void VulkanRTBackend::endSingleTimeCommands(VkCommandBuffer commandBuffer) {
    vkEndCommandBuffer(commandBuffer);

    VkSubmitInfo submitInfo = {};
    submitInfo.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    submitInfo.commandBufferCount = 1;
    submitInfo.pCommandBuffers = &commandBuffer;

    vkQueueSubmit(queue_, 1, &submitInfo, VK_NULL_HANDLE);
    vkQueueWaitIdle(queue_);

    vkFreeCommandBuffers(device_, commandPool_, 1, &commandBuffer);
}

// ============================================================================
// Shader Module Creation
// ============================================================================

VkShaderModule VulkanRTBackend::createShaderModule(const std::vector<uint32_t>& spirvCode) {
    VkShaderModuleCreateInfo createInfo = {};
    createInfo.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    createInfo.codeSize = spirvCode.size() * sizeof(uint32_t);
    createInfo.pCode = spirvCode.data();

    VkShaderModule shaderModule;
    if (vkCreateShaderModule(device_, &createInfo, nullptr, &shaderModule) != VK_SUCCESS) {
        return VK_NULL_HANDLE;
    }
    return shaderModule;
}

// ============================================================================
// Geometry Creation
// ============================================================================

RTGeometryHandle VulkanRTBackend::createGeometry(const RTGeometryDesc& desc) {
    if (!initialized_) {
        std::cerr << "[VulkanRT] createGeometry: Not initialized" << std::endl;
        return RTGeometryHandle{};
    }

    auto geometry = std::make_unique<VulkanGeometry>();
    geometry->vertexCount = static_cast<uint32_t>(desc.vertexCount);
    geometry->indexCount = static_cast<uint32_t>(desc.indexCount);
    geometry->vertexStride = desc.vertexStride;

    // Create vertex buffer
    VkDeviceSize vertexBufferSize = desc.vertexCount * desc.vertexStride;
    if (!createBuffer(vertexBufferSize,
                      VK_BUFFER_USAGE_VERTEX_BUFFER_BIT |
                      VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_BIT_KHR |
                      VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
                      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                      geometry->vertexBuffer)) {
        std::cerr << "[VulkanRT] createGeometry: Failed to create vertex buffer" << std::endl;
        return RTGeometryHandle{};
    }

    // Copy vertex data
    void* data;
    vkMapMemory(device_, geometry->vertexBuffer.memory, 0, vertexBufferSize, 0, &data);
    memcpy(data, desc.vertices, vertexBufferSize);
    vkUnmapMemory(device_, geometry->vertexBuffer.memory);

    // Create index buffer if indexed
    if (desc.indices && desc.indexCount > 0) {
        VkDeviceSize indexBufferSize = desc.indexCount * sizeof(uint32_t);
        if (!createBuffer(indexBufferSize,
                          VK_BUFFER_USAGE_INDEX_BUFFER_BIT |
                          VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_BIT_KHR |
                          VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
                          VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                          geometry->indexBuffer)) {
            std::cerr << "[VulkanRT] createGeometry: Failed to create index buffer" << std::endl;
            destroyBuffer(geometry->vertexBuffer);
            return RTGeometryHandle{};
        }

        vkMapMemory(device_, geometry->indexBuffer.memory, 0, indexBufferSize, 0, &data);
        memcpy(data, desc.indices, indexBufferSize);
        vkUnmapMemory(device_, geometry->indexBuffer.memory);
    }

    return allocateRtHandle<RTGeometryHandle>(nextGeometryId_, geometries_, std::move(geometry));
}

void VulkanRTBackend::destroyGeometry(RTGeometryHandle geometry) {
    auto it = geometries_.find(geometry._id);
    if (it != geometries_.end()) {
        destroyBuffer(it->second->vertexBuffer);
        destroyBuffer(it->second->indexBuffer);
        geometries_.erase(it);
    }
}

// ============================================================================
// BLAS Creation
// ============================================================================

RTBLASHandle VulkanRTBackend::createBLAS(RTGeometryHandle* geometries, size_t count) {
    if (!initialized_ || count == 0) {
        std::cerr << "[VulkanRT] createBLAS: Not initialized or empty" << std::endl;
        return RTBLASHandle{};
    }

    auto blas = std::make_unique<VulkanBLAS>();

    // Build geometry descriptions
    std::vector<VkAccelerationStructureGeometryKHR> asGeometries;
    std::vector<VkAccelerationStructureBuildRangeInfoKHR> buildRanges;
    std::vector<uint32_t> maxPrimitiveCounts;

    for (size_t i = 0; i < count; i++) {
        VulkanGeometry* geom = static_cast<VulkanGeometry*>(geometries[i]._handle);
        if (!geom) continue;

        blas->geometryIds.push_back(geometries[i]._id);

        VkAccelerationStructureGeometryKHR asGeom = {};
        asGeom.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_KHR;
        asGeom.geometryType = VK_GEOMETRY_TYPE_TRIANGLES_KHR;
        asGeom.flags = VK_GEOMETRY_OPAQUE_BIT_KHR;

        asGeom.geometry.triangles.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_TRIANGLES_DATA_KHR;
        asGeom.geometry.triangles.vertexFormat = VK_FORMAT_R32G32B32_SFLOAT;
        asGeom.geometry.triangles.vertexData.deviceAddress = geom->vertexBuffer.deviceAddress;
        asGeom.geometry.triangles.vertexStride = geom->vertexStride;
        asGeom.geometry.triangles.maxVertex = geom->vertexCount - 1;

        if (geom->indexCount > 0) {
            asGeom.geometry.triangles.indexType = VK_INDEX_TYPE_UINT32;
            asGeom.geometry.triangles.indexData.deviceAddress = geom->indexBuffer.deviceAddress;
        } else {
            asGeom.geometry.triangles.indexType = VK_INDEX_TYPE_NONE_KHR;
        }

        asGeometries.push_back(asGeom);

        VkAccelerationStructureBuildRangeInfoKHR buildRange = {};
        buildRange.primitiveCount = geom->indexCount > 0 ? geom->indexCount / 3 : geom->vertexCount / 3;
        buildRange.primitiveOffset = 0;
        buildRange.firstVertex = 0;
        buildRange.transformOffset = 0;
        buildRanges.push_back(buildRange);

        maxPrimitiveCounts.push_back(buildRange.primitiveCount);
    }

    // Get build sizes
    VkAccelerationStructureBuildGeometryInfoKHR buildInfo = {};
    buildInfo.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_GEOMETRY_INFO_KHR;
    buildInfo.type = VK_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL_KHR;
    buildInfo.flags = VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_TRACE_BIT_KHR;
    buildInfo.mode = VK_BUILD_ACCELERATION_STRUCTURE_MODE_BUILD_KHR;
    buildInfo.geometryCount = static_cast<uint32_t>(asGeometries.size());
    buildInfo.pGeometries = asGeometries.data();

    VkAccelerationStructureBuildSizesInfoKHR sizeInfo = {};
    sizeInfo.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_SIZES_INFO_KHR;

    vkGetAccelerationStructureBuildSizesKHR_(device_,
        VK_ACCELERATION_STRUCTURE_BUILD_TYPE_DEVICE_KHR,
        &buildInfo, maxPrimitiveCounts.data(), &sizeInfo);

    // Create BLAS buffer
    if (!createBuffer(sizeInfo.accelerationStructureSize,
                      VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_STORAGE_BIT_KHR |
                      VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
                      VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
                      blas->buffer)) {
        std::cerr << "[VulkanRT] createBLAS: Failed to create AS buffer" << std::endl;
        return RTBLASHandle{};
    }

    // Create acceleration structure
    VkAccelerationStructureCreateInfoKHR asCreateInfo = {};
    asCreateInfo.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_CREATE_INFO_KHR;
    asCreateInfo.buffer = blas->buffer.buffer;
    asCreateInfo.size = sizeInfo.accelerationStructureSize;
    asCreateInfo.type = VK_ACCELERATION_STRUCTURE_TYPE_BOTTOM_LEVEL_KHR;

    if (vkCreateAccelerationStructureKHR_(device_, &asCreateInfo, nullptr, &blas->accelerationStructure) != VK_SUCCESS) {
        std::cerr << "[VulkanRT] createBLAS: Failed to create AS" << std::endl;
        destroyBuffer(blas->buffer);
        return RTBLASHandle{};
    }

    // Get device address
    VkAccelerationStructureDeviceAddressInfoKHR addressInfo = {};
    addressInfo.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_DEVICE_ADDRESS_INFO_KHR;
    addressInfo.accelerationStructure = blas->accelerationStructure;
    blas->deviceAddress = vkGetAccelerationStructureDeviceAddressKHR_(device_, &addressInfo);

    // Create scratch buffer
    VulkanBuffer scratchBuffer;
    if (!createBuffer(sizeInfo.buildScratchSize,
                      VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
                      VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
                      scratchBuffer)) {
        std::cerr << "[VulkanRT] createBLAS: Failed to create scratch buffer" << std::endl;
        vkDestroyAccelerationStructureKHR_(device_, blas->accelerationStructure, nullptr);
        destroyBuffer(blas->buffer);
        return RTBLASHandle{};
    }

    // Build BLAS
    buildInfo.dstAccelerationStructure = blas->accelerationStructure;
    buildInfo.scratchData.deviceAddress = scratchBuffer.deviceAddress;

    VkCommandBuffer cmd = beginSingleTimeCommands();

    const VkAccelerationStructureBuildRangeInfoKHR* pBuildRanges = buildRanges.data();
    vkCmdBuildAccelerationStructuresKHR_(cmd, 1, &buildInfo, &pBuildRanges);

    endSingleTimeCommands(cmd);

    // Clean up scratch buffer
    destroyBuffer(scratchBuffer);

    return allocateRtHandle<RTBLASHandle>(nextBLASId_, blases_, std::move(blas));
}

void VulkanRTBackend::destroyBLAS(RTBLASHandle blas) {
    auto it = blases_.find(blas._id);
    if (it != blases_.end()) {
        if (it->second->accelerationStructure != VK_NULL_HANDLE) {
            vkDestroyAccelerationStructureKHR_(device_, it->second->accelerationStructure, nullptr);
        }
        destroyBuffer(it->second->buffer);
        blases_.erase(it);
    }
}

// ============================================================================
// TLAS Creation
// ============================================================================

// A ray batch hit names a triangle, which only means one thing when the TLAS holds one instance of
// a BLAS built from one geometry.
static bool resolvesToOneTriangleList(const RTTLASInstance* instances, size_t count) {
    if (count != 1) return false;
    const VulkanBLAS* blas = static_cast<const VulkanBLAS*>(instances[0].blas._handle);
    return blas != nullptr && blas->geometryIds.size() == 1;
}

RTTLASHandle VulkanRTBackend::createTLAS(const RTTLASInstance* instances, size_t count) {
    if (!initialized_ || count == 0) {
        std::cerr << "[VulkanRT] createTLAS: Not initialized or empty" << std::endl;
        return RTTLASHandle{};
    }

    auto tlas = std::make_unique<VulkanTLAS>();
    tlas->instanceCount = static_cast<uint32_t>(count);

    // Build VkAccelerationStructureInstanceKHR array
    std::vector<VkAccelerationStructureInstanceKHR> vkInstances(count);

    for (size_t i = 0; i < count; i++) {
        const RTTLASInstance& inst = instances[i];
        VulkanBLAS* blasPtr = static_cast<VulkanBLAS*>(inst.blas._handle);
        if (!blasPtr) {
            std::cerr << "[VulkanRT] createTLAS: Invalid BLAS at instance " << i << std::endl;
            return RTTLASHandle{};
        }

        VkAccelerationStructureInstanceKHR& vkInst = vkInstances[i];

        // Convert 4x4 column-major to VkTransformMatrixKHR (3x4 row-major)
        // Input is column-major 4x4: [m0 m4 m8  m12]
        //                           [m1 m5 m9  m13]
        //                           [m2 m6 m10 m14]
        //                           [m3 m7 m11 m15]
        // Output is row-major 3x4: matrix[row][col]
        for (int row = 0; row < 3; row++) {
            for (int col = 0; col < 4; col++) {
                vkInst.transform.matrix[row][col] = inst.transform[col * 4 + row];
            }
        }

        vkInst.instanceCustomIndex = inst.instanceId & 0xFFFFFF;  // 24-bit
        vkInst.mask = inst.mask;
        vkInst.instanceShaderBindingTableRecordOffset = 0;
        vkInst.flags = VK_GEOMETRY_INSTANCE_TRIANGLE_FACING_CULL_DISABLE_BIT_KHR;
        vkInst.accelerationStructureReference = blasPtr->deviceAddress;
    }
    tlas->oneTriangleList = resolvesToOneTriangleList(instances, count);

    // Create instance buffer
    VkDeviceSize instanceBufferSize = count * sizeof(VkAccelerationStructureInstanceKHR);
    if (!createBuffer(instanceBufferSize,
                      VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_BUILD_INPUT_READ_ONLY_BIT_KHR |
                      VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
                      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                      tlas->instanceBuffer)) {
        std::cerr << "[VulkanRT] createTLAS: Failed to create instance buffer" << std::endl;
        return RTTLASHandle{};
    }

    // Copy instance data
    void* data;
    vkMapMemory(device_, tlas->instanceBuffer.memory, 0, instanceBufferSize, 0, &data);
    memcpy(data, vkInstances.data(), instanceBufferSize);
    vkUnmapMemory(device_, tlas->instanceBuffer.memory);

    // Get build sizes
    VkAccelerationStructureGeometryKHR asGeom = {};
    asGeom.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_KHR;
    asGeom.geometryType = VK_GEOMETRY_TYPE_INSTANCES_KHR;
    asGeom.flags = VK_GEOMETRY_OPAQUE_BIT_KHR;
    asGeom.geometry.instances.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_INSTANCES_DATA_KHR;
    asGeom.geometry.instances.data.deviceAddress = tlas->instanceBuffer.deviceAddress;

    VkAccelerationStructureBuildGeometryInfoKHR buildInfo = {};
    buildInfo.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_GEOMETRY_INFO_KHR;
    buildInfo.type = VK_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL_KHR;
    buildInfo.flags = VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_TRACE_BIT_KHR |
                      VK_BUILD_ACCELERATION_STRUCTURE_ALLOW_UPDATE_BIT_KHR;
    buildInfo.mode = VK_BUILD_ACCELERATION_STRUCTURE_MODE_BUILD_KHR;
    buildInfo.geometryCount = 1;
    buildInfo.pGeometries = &asGeom;

    uint32_t primitiveCount = static_cast<uint32_t>(count);

    VkAccelerationStructureBuildSizesInfoKHR sizeInfo = {};
    sizeInfo.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_SIZES_INFO_KHR;

    vkGetAccelerationStructureBuildSizesKHR_(device_,
        VK_ACCELERATION_STRUCTURE_BUILD_TYPE_DEVICE_KHR,
        &buildInfo, &primitiveCount, &sizeInfo);

    // Create TLAS buffer
    if (!createBuffer(sizeInfo.accelerationStructureSize,
                      VK_BUFFER_USAGE_ACCELERATION_STRUCTURE_STORAGE_BIT_KHR |
                      VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
                      VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
                      tlas->buffer)) {
        std::cerr << "[VulkanRT] createTLAS: Failed to create AS buffer" << std::endl;
        destroyBuffer(tlas->instanceBuffer);
        return RTTLASHandle{};
    }

    // Create acceleration structure
    VkAccelerationStructureCreateInfoKHR asCreateInfo = {};
    asCreateInfo.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_CREATE_INFO_KHR;
    asCreateInfo.buffer = tlas->buffer.buffer;
    asCreateInfo.size = sizeInfo.accelerationStructureSize;
    asCreateInfo.type = VK_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL_KHR;

    if (vkCreateAccelerationStructureKHR_(device_, &asCreateInfo, nullptr, &tlas->accelerationStructure) != VK_SUCCESS) {
        std::cerr << "[VulkanRT] createTLAS: Failed to create AS" << std::endl;
        destroyBuffer(tlas->buffer);
        destroyBuffer(tlas->instanceBuffer);
        return RTTLASHandle{};
    }

    // Get device address
    VkAccelerationStructureDeviceAddressInfoKHR addressInfo = {};
    addressInfo.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_DEVICE_ADDRESS_INFO_KHR;
    addressInfo.accelerationStructure = tlas->accelerationStructure;
    tlas->deviceAddress = vkGetAccelerationStructureDeviceAddressKHR_(device_, &addressInfo);

    // Create scratch buffer
    VulkanBuffer scratchBuffer;
    if (!createBuffer(sizeInfo.buildScratchSize,
                      VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
                      VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
                      scratchBuffer)) {
        std::cerr << "[VulkanRT] createTLAS: Failed to create scratch buffer" << std::endl;
        vkDestroyAccelerationStructureKHR_(device_, tlas->accelerationStructure, nullptr);
        destroyBuffer(tlas->buffer);
        destroyBuffer(tlas->instanceBuffer);
        return RTTLASHandle{};
    }

    // Build TLAS
    buildInfo.dstAccelerationStructure = tlas->accelerationStructure;
    buildInfo.scratchData.deviceAddress = scratchBuffer.deviceAddress;

    VkAccelerationStructureBuildRangeInfoKHR buildRange = {};
    buildRange.primitiveCount = primitiveCount;

    VkCommandBuffer cmd = beginSingleTimeCommands();

    const VkAccelerationStructureBuildRangeInfoKHR* pBuildRange = &buildRange;
    vkCmdBuildAccelerationStructuresKHR_(cmd, 1, &buildInfo, &pBuildRange);

    endSingleTimeCommands(cmd);

    // Clean up scratch buffer
    destroyBuffer(scratchBuffer);

    return allocateRtHandle<RTTLASHandle>(nextTLASId_, tlases_, std::move(tlas));
}

void VulkanRTBackend::updateTLAS(RTTLASHandle tlas, const RTTLASInstance* instances, size_t count) {
    auto it = tlases_.find(tlas._id);
    if (it == tlases_.end()) {
        std::cerr << "[VulkanRT] updateTLAS: Invalid TLAS" << std::endl;
        return;
    }

    VulkanTLAS* tlasPtr = it->second.get();
    if (count != tlasPtr->instanceCount) {
        std::cerr << "[VulkanRT] updateTLAS: Instance count mismatch" << std::endl;
        return;
    }

    // Update instance buffer with new transforms
    std::vector<VkAccelerationStructureInstanceKHR> vkInstances(count);

    for (size_t i = 0; i < count; i++) {
        const RTTLASInstance& inst = instances[i];
        VulkanBLAS* blasPtr = static_cast<VulkanBLAS*>(inst.blas._handle);
        if (!blasPtr) continue;

        VkAccelerationStructureInstanceKHR& vkInst = vkInstances[i];

        for (int row = 0; row < 3; row++) {
            for (int col = 0; col < 4; col++) {
                vkInst.transform.matrix[row][col] = inst.transform[col * 4 + row];
            }
        }

        vkInst.instanceCustomIndex = inst.instanceId & 0xFFFFFF;
        vkInst.mask = inst.mask;
        vkInst.instanceShaderBindingTableRecordOffset = 0;
        vkInst.flags = VK_GEOMETRY_INSTANCE_TRIANGLE_FACING_CULL_DISABLE_BIT_KHR;
        vkInst.accelerationStructureReference = blasPtr->deviceAddress;
    }
    tlasPtr->oneTriangleList = resolvesToOneTriangleList(instances, count);

    // Copy to instance buffer
    void* data;
    VkDeviceSize instanceBufferSize = count * sizeof(VkAccelerationStructureInstanceKHR);
    vkMapMemory(device_, tlasPtr->instanceBuffer.memory, 0, instanceBufferSize, 0, &data);
    memcpy(data, vkInstances.data(), instanceBufferSize);
    vkUnmapMemory(device_, tlasPtr->instanceBuffer.memory);

    // Rebuild TLAS (could use UPDATE mode for faster rebuilds)
    VkAccelerationStructureGeometryKHR asGeom = {};
    asGeom.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_KHR;
    asGeom.geometryType = VK_GEOMETRY_TYPE_INSTANCES_KHR;
    asGeom.flags = VK_GEOMETRY_OPAQUE_BIT_KHR;
    asGeom.geometry.instances.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_GEOMETRY_INSTANCES_DATA_KHR;
    asGeom.geometry.instances.data.deviceAddress = tlasPtr->instanceBuffer.deviceAddress;

    VkAccelerationStructureBuildGeometryInfoKHR buildInfo = {};
    buildInfo.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_GEOMETRY_INFO_KHR;
    buildInfo.type = VK_ACCELERATION_STRUCTURE_TYPE_TOP_LEVEL_KHR;
    buildInfo.flags = VK_BUILD_ACCELERATION_STRUCTURE_PREFER_FAST_TRACE_BIT_KHR |
                      VK_BUILD_ACCELERATION_STRUCTURE_ALLOW_UPDATE_BIT_KHR;
    buildInfo.mode = VK_BUILD_ACCELERATION_STRUCTURE_MODE_UPDATE_KHR;
    buildInfo.srcAccelerationStructure = tlasPtr->accelerationStructure;
    buildInfo.dstAccelerationStructure = tlasPtr->accelerationStructure;
    buildInfo.geometryCount = 1;
    buildInfo.pGeometries = &asGeom;

    uint32_t primitiveCount = static_cast<uint32_t>(count);

    VkAccelerationStructureBuildSizesInfoKHR sizeInfo = {};
    sizeInfo.sType = VK_STRUCTURE_TYPE_ACCELERATION_STRUCTURE_BUILD_SIZES_INFO_KHR;

    vkGetAccelerationStructureBuildSizesKHR_(device_,
        VK_ACCELERATION_STRUCTURE_BUILD_TYPE_DEVICE_KHR,
        &buildInfo, &primitiveCount, &sizeInfo);

    // Create scratch buffer
    VulkanBuffer scratchBuffer;
    createBuffer(sizeInfo.updateScratchSize,
                 VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
                 VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
                 scratchBuffer);

    buildInfo.scratchData.deviceAddress = scratchBuffer.deviceAddress;

    VkAccelerationStructureBuildRangeInfoKHR buildRange = {};
    buildRange.primitiveCount = primitiveCount;

    VkCommandBuffer cmd = beginSingleTimeCommands();

    const VkAccelerationStructureBuildRangeInfoKHR* pBuildRange = &buildRange;
    vkCmdBuildAccelerationStructuresKHR_(cmd, 1, &buildInfo, &pBuildRange);

    endSingleTimeCommands(cmd);

    destroyBuffer(scratchBuffer);
}

void VulkanRTBackend::destroyTLAS(RTTLASHandle tlas) {
    auto it = tlases_.find(tlas._id);
    if (it != tlases_.end()) {
        if (it->second->accelerationStructure != VK_NULL_HANDLE) {
            vkDestroyAccelerationStructureKHR_(device_, it->second->accelerationStructure, nullptr);
        }
        destroyBuffer(it->second->buffer);
        destroyBuffer(it->second->instanceBuffer);
        tlases_.erase(it);
    }
}

// ============================================================================
// Ray Tracing Execution
// ============================================================================

void VulkanRTBackend::traceRays(const TraceRaysOptions& options) {
    if (!initialized_ || !imagePathReady_) {
        std::cerr << "[VulkanRT] traceRays: the camera path is not available"
                  << (imageError_.empty() ? "" : " (" + imageError_ + ")") << std::endl;
        return;
    }

    VulkanTLAS* tlasPtr = static_cast<VulkanTLAS*>(options.tlas._handle);
    if (!tlasPtr) {
        std::cerr << "[VulkanRT] traceRays: Invalid TLAS" << std::endl;
        return;
    }

    // Recreate output image if size changed
    if (options.width != outputWidth_ || options.height != outputHeight_) {
        // Clean up old resources
        if (outputImageView_ != VK_NULL_HANDLE) {
            vkDestroyImageView(device_, outputImageView_, nullptr);
        }
        if (outputImage_ != VK_NULL_HANDLE) {
            vkDestroyImage(device_, outputImage_, nullptr);
        }
        if (outputImageMemory_ != VK_NULL_HANDLE) {
            vkFreeMemory(device_, outputImageMemory_, nullptr);
        }
        destroyBuffer(stagingBuffer_);

        outputWidth_ = options.width;
        outputHeight_ = options.height;

        // Create output image
        VkImageCreateInfo imageInfo = {};
        imageInfo.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
        imageInfo.imageType = VK_IMAGE_TYPE_2D;
        imageInfo.format = VK_FORMAT_R8G8B8A8_UNORM;
        imageInfo.extent = {options.width, options.height, 1};
        imageInfo.mipLevels = 1;
        imageInfo.arrayLayers = 1;
        imageInfo.samples = VK_SAMPLE_COUNT_1_BIT;
        imageInfo.tiling = VK_IMAGE_TILING_OPTIMAL;
        imageInfo.usage = VK_IMAGE_USAGE_STORAGE_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT;
        imageInfo.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;

        vkCreateImage(device_, &imageInfo, nullptr, &outputImage_);

        VkMemoryRequirements memReq;
        vkGetImageMemoryRequirements(device_, outputImage_, &memReq);

        VkMemoryAllocateInfo allocInfo = {};
        allocInfo.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
        allocInfo.allocationSize = memReq.size;
        allocInfo.memoryTypeIndex = findMemoryType(memReq.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);

        vkAllocateMemory(device_, &allocInfo, nullptr, &outputImageMemory_);
        vkBindImageMemory(device_, outputImage_, outputImageMemory_, 0);

        // Create image view
        VkImageViewCreateInfo viewInfo = {};
        viewInfo.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
        viewInfo.image = outputImage_;
        viewInfo.viewType = VK_IMAGE_VIEW_TYPE_2D;
        viewInfo.format = VK_FORMAT_R8G8B8A8_UNORM;
        viewInfo.subresourceRange.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
        viewInfo.subresourceRange.baseMipLevel = 0;
        viewInfo.subresourceRange.levelCount = 1;
        viewInfo.subresourceRange.baseArrayLayer = 0;
        viewInfo.subresourceRange.layerCount = 1;

        vkCreateImageView(device_, &viewInfo, nullptr, &outputImageView_);

        // Create staging buffer for readback
        VkDeviceSize bufferSize = options.width * options.height * 4;
        createBuffer(bufferSize,
                     VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                     VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                     stagingBuffer_);

        // Transition image layout
        VkCommandBuffer cmd = beginSingleTimeCommands();

        VkImageMemoryBarrier barrier = {};
        barrier.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER;
        barrier.oldLayout = VK_IMAGE_LAYOUT_UNDEFINED;
        barrier.newLayout = VK_IMAGE_LAYOUT_GENERAL;
        barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
        barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
        barrier.image = outputImage_;
        barrier.subresourceRange.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
        barrier.subresourceRange.baseMipLevel = 0;
        barrier.subresourceRange.levelCount = 1;
        barrier.subresourceRange.baseArrayLayer = 0;
        barrier.subresourceRange.layerCount = 1;
        barrier.srcAccessMask = 0;
        barrier.dstAccessMask = VK_ACCESS_SHADER_WRITE_BIT;

        vkCmdPipelineBarrier(cmd,
            VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,
            VK_PIPELINE_STAGE_RAY_TRACING_SHADER_BIT_KHR,
            0, 0, nullptr, 0, nullptr, 1, &barrier);

        endSingleTimeCommands(cmd);
    }

    // Update camera UBO if uniforms provided
    if (options.uniforms && options.uniformsSize > 0) {
        void* data;
        vkMapMemory(device_, cameraUBO_.memory, 0, options.uniformsSize, 0, &data);
        memcpy(data, options.uniforms, options.uniformsSize);
        vkUnmapMemory(device_, cameraUBO_.memory);
    }

    // Update descriptor set
    VkWriteDescriptorSetAccelerationStructureKHR asWriteInfo = {};
    asWriteInfo.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET_ACCELERATION_STRUCTURE_KHR;
    asWriteInfo.accelerationStructureCount = 1;
    asWriteInfo.pAccelerationStructures = &tlasPtr->accelerationStructure;

    VkDescriptorImageInfo imageDescInfo = {};
    imageDescInfo.imageView = outputImageView_;
    imageDescInfo.imageLayout = VK_IMAGE_LAYOUT_GENERAL;

    VkDescriptorBufferInfo bufferDescInfo = {};
    bufferDescInfo.buffer = cameraUBO_.buffer;
    bufferDescInfo.offset = 0;
    bufferDescInfo.range = VK_WHOLE_SIZE;

    std::array<VkWriteDescriptorSet, 3> writes = {};

    writes[0].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
    writes[0].pNext = &asWriteInfo;
    writes[0].dstSet = descriptorSet_;
    writes[0].dstBinding = 0;
    writes[0].descriptorCount = 1;
    writes[0].descriptorType = VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR;

    writes[1].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
    writes[1].dstSet = descriptorSet_;
    writes[1].dstBinding = 1;
    writes[1].descriptorCount = 1;
    writes[1].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_IMAGE;
    writes[1].pImageInfo = &imageDescInfo;

    writes[2].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
    writes[2].dstSet = descriptorSet_;
    writes[2].dstBinding = 2;
    writes[2].descriptorCount = 1;
    writes[2].descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER;
    writes[2].pBufferInfo = &bufferDescInfo;

    vkUpdateDescriptorSets(device_, static_cast<uint32_t>(writes.size()), writes.data(), 0, nullptr);

    // Record and submit trace rays command
    VkCommandBuffer cmd = beginSingleTimeCommands();

    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_RAY_TRACING_KHR, rtPipeline_);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_RAY_TRACING_KHR,
                            pipelineLayout_, 0, 1, &descriptorSet_, 0, nullptr);

    vkCmdTraceRaysKHR_(cmd,
                       &raygenRegion_,
                       &missRegion_,
                       &hitRegion_,
                       &callableRegion_,
                       options.width, options.height, 1);

    // Copy output to staging buffer for WebGPU texture interop
    VkImageMemoryBarrier barrier = {};
    barrier.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER;
    barrier.oldLayout = VK_IMAGE_LAYOUT_GENERAL;
    barrier.newLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
    barrier.srcQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    barrier.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    barrier.image = outputImage_;
    barrier.subresourceRange.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
    barrier.subresourceRange.baseMipLevel = 0;
    barrier.subresourceRange.levelCount = 1;
    barrier.subresourceRange.baseArrayLayer = 0;
    barrier.subresourceRange.layerCount = 1;
    barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;

    vkCmdPipelineBarrier(cmd,
        VK_PIPELINE_STAGE_RAY_TRACING_SHADER_BIT_KHR,
        VK_PIPELINE_STAGE_TRANSFER_BIT,
        0, 0, nullptr, 0, nullptr, 1, &barrier);

    VkBufferImageCopy region = {};
    region.bufferOffset = 0;
    region.bufferRowLength = 0;
    region.bufferImageHeight = 0;
    region.imageSubresource.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
    region.imageSubresource.mipLevel = 0;
    region.imageSubresource.baseArrayLayer = 0;
    region.imageSubresource.layerCount = 1;
    region.imageOffset = {0, 0, 0};
    region.imageExtent = {options.width, options.height, 1};

    vkCmdCopyImageToBuffer(cmd, outputImage_, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                           stagingBuffer_.buffer, 1, &region);

    // Transition back to general for next frame
    barrier.oldLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL;
    barrier.newLayout = VK_IMAGE_LAYOUT_GENERAL;
    barrier.srcAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
    barrier.dstAccessMask = VK_ACCESS_SHADER_WRITE_BIT;

    vkCmdPipelineBarrier(cmd,
        VK_PIPELINE_STAGE_TRANSFER_BIT,
        VK_PIPELINE_STAGE_RAY_TRACING_SHADER_BIT_KHR,
        0, 0, nullptr, 0, nullptr, 1, &barrier);

    endSingleTimeCommands(cmd);

    // TODO: Copy staging buffer data to WebGPU texture
    // This requires WebGPU/Vulkan interop which will be implemented in the next phase
    // For now, the data is in stagingBuffer_ and can be read with vkMapMemory
}

// ============================================================================
// Camera Path
// ============================================================================

bool VulkanRTBackend::createImagePath() {
    if (!createRTPipeline()) {
        imageError_ = "the ray tracing pipeline could not be created";
        return false;
    }

    if (!createShaderBindingTable()) {
        imageError_ = "the shader binding table could not be created";
        return false;
    }

    VkDeviceSize uboSize = 2 * 16 * sizeof(float);  // viewInverse + projInverse
    if (!createBuffer(uboSize,
                      VK_BUFFER_USAGE_UNIFORM_BUFFER_BIT | VK_BUFFER_USAGE_SHADER_DEVICE_ADDRESS_BIT,
                      VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT,
                      cameraUBO_)) {
        imageError_ = "the camera uniform buffer could not be created";
        return false;
    }

    return true;
}

// ============================================================================
// Ray Batch
// ============================================================================

bool VulkanRTBackend::createBatchPath() {
    if (!rayQuerySupported_) {
        batchError_ = "the device does not expose VK_KHR_ray_query";
        return false;
    }

    // Set 0 holds the TLAS, the rays and the hits.
    std::array<VkDescriptorSetLayoutBinding, 3> bindings = {};
    bindings[0].binding = 0;
    bindings[0].descriptorType = VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR;
    bindings[0].descriptorCount = 1;
    bindings[0].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
    bindings[1].binding = 1;
    bindings[1].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    bindings[1].descriptorCount = 1;
    bindings[1].stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
    bindings[2] = bindings[1];
    bindings[2].binding = 2;

    VkDescriptorSetLayoutCreateInfo layoutInfo = {};
    layoutInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO;
    layoutInfo.bindingCount = static_cast<uint32_t>(bindings.size());
    layoutInfo.pBindings = bindings.data();
    if (vkCreateDescriptorSetLayout(device_, &layoutInfo, nullptr, &batchSetLayout_) != VK_SUCCESS) {
        batchError_ = "vkCreateDescriptorSetLayout failed";
        return false;
    }

    std::array<VkDescriptorPoolSize, 2> poolSizes = {};
    poolSizes[0].type = VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR;
    poolSizes[0].descriptorCount = 1;
    poolSizes[1].type = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    poolSizes[1].descriptorCount = 2;

    VkDescriptorPoolCreateInfo poolInfo = {};
    poolInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO;
    poolInfo.poolSizeCount = static_cast<uint32_t>(poolSizes.size());
    poolInfo.pPoolSizes = poolSizes.data();
    poolInfo.maxSets = 1;
    if (vkCreateDescriptorPool(device_, &poolInfo, nullptr, &batchPool_) != VK_SUCCESS) {
        batchError_ = "vkCreateDescriptorPool failed";
        return false;
    }

    VkDescriptorSetAllocateInfo setInfo = {};
    setInfo.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO;
    setInfo.descriptorPool = batchPool_;
    setInfo.descriptorSetCount = 1;
    setInfo.pSetLayouts = &batchSetLayout_;
    if (vkAllocateDescriptorSets(device_, &setInfo, &batchSet_) != VK_SUCCESS) {
        batchError_ = "vkAllocateDescriptorSets failed";
        return false;
    }

    VkPushConstantRange pushRange = {};
    pushRange.stageFlags = VK_SHADER_STAGE_COMPUTE_BIT;
    pushRange.offset = 0;
    pushRange.size = sizeof(uint32_t);  // rayCount

    VkPipelineLayoutCreateInfo pipelineLayoutInfo = {};
    pipelineLayoutInfo.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
    pipelineLayoutInfo.setLayoutCount = 1;
    pipelineLayoutInfo.pSetLayouts = &batchSetLayout_;
    pipelineLayoutInfo.pushConstantRangeCount = 1;
    pipelineLayoutInfo.pPushConstantRanges = &pushRange;
    if (vkCreatePipelineLayout(device_, &pipelineLayoutInfo, nullptr, &batchPipelineLayout_) != VK_SUCCESS) {
        batchError_ = "vkCreatePipelineLayout failed";
        return false;
    }

    VkShaderModule kernel = createShaderModule(
        std::vector<uint32_t>(probe_trace_spirv, probe_trace_spirv + probe_trace_spirv_size));
    if (kernel == VK_NULL_HANDLE) {
        batchError_ = "the ray query kernel was rejected by vkCreateShaderModule";
        return false;
    }

    VkComputePipelineCreateInfo pipelineInfo = {};
    pipelineInfo.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO;
    pipelineInfo.stage.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    pipelineInfo.stage.stage = VK_SHADER_STAGE_COMPUTE_BIT;
    pipelineInfo.stage.module = kernel;
    pipelineInfo.stage.pName = "main";
    pipelineInfo.layout = batchPipelineLayout_;
    const VkResult pipelineResult =
        vkCreateComputePipelines(device_, VK_NULL_HANDLE, 1, &pipelineInfo, nullptr, &batchPipeline_);
    vkDestroyShaderModule(device_, kernel, nullptr);
    if (pipelineResult != VK_SUCCESS) {
        batchError_ = "vkCreateComputePipelines failed for the ray query kernel (VkResult " +
                      std::to_string(pipelineResult) + ")";
        return false;
    }

    VkCommandBufferAllocateInfo commandInfo = {};
    commandInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    commandInfo.commandPool = commandPool_;
    commandInfo.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    commandInfo.commandBufferCount = 1;
    if (vkAllocateCommandBuffers(device_, &commandInfo, &batchCommands_) != VK_SUCCESS) {
        batchError_ = "vkAllocateCommandBuffers failed";
        return false;
    }

    VkFenceCreateInfo fenceInfo = {};
    fenceInfo.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
    if (vkCreateFence(device_, &fenceInfo, nullptr, &batchFence_) != VK_SUCCESS) {
        batchError_ = "vkCreateFence failed";
        return false;
    }

    // GPU timestamps are optional: a queue without valid bits still traces, it reports gpuMs = 0.
    if (timestampValidBits_ > 0 && caps_.timestampPeriodNs > 0) {
        VkQueryPoolCreateInfo queryInfo = {};
        queryInfo.sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO;
        queryInfo.queryType = VK_QUERY_TYPE_TIMESTAMP;
        queryInfo.queryCount = 2;
        if (vkCreateQueryPool(device_, &queryInfo, nullptr, &timestampPool_) != VK_SUCCESS) {
            timestampPool_ = VK_NULL_HANDLE;
        }
    }

    return true;
}

// Grow the four batch buffers to hold rayCount rays. Callers wait for the fence before returning,
// so the old buffers are idle when they are replaced.
bool VulkanRTBackend::ensureBatchCapacity(uint32_t rayCount) {
    if (rayCount <= batchCapacity_) return true;

    const uint64_t capacity = std::min<uint64_t>(
        std::max<uint64_t>({static_cast<uint64_t>(rayCount), static_cast<uint64_t>(batchCapacity_) * 2, 4096}),
        maxBatchRays_);
    const VkDeviceSize rayBytes = capacity * kRayWords * sizeof(float);
    const VkDeviceSize hitBytes = capacity * kHitWords * sizeof(uint32_t);

    VulkanBuffer raysStaging, raysDevice, hitsDevice, hitsStaging;
    auto release = [&]() {
        destroyBuffer(raysStaging);
        destroyBuffer(raysDevice);
        destroyBuffer(hitsDevice);
        destroyBuffer(hitsStaging);
    };

    const VkMemoryPropertyFlags hostVisible =
        VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT;
    bool created =
        createBuffer(rayBytes, VK_BUFFER_USAGE_TRANSFER_SRC_BIT, hostVisible, raysStaging, true) &&
        createBuffer(rayBytes, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                     VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, raysDevice, true) &&
        createBuffer(hitBytes, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_SRC_BIT,
                     VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, hitsDevice, true);
    if (created) {
        // The caller reads every hit back, so cached host memory is much faster than write combined.
        created = createBuffer(hitBytes, VK_BUFFER_USAGE_TRANSFER_DST_BIT,
                               hostVisible | VK_MEMORY_PROPERTY_HOST_CACHED_BIT, hitsStaging, true) ||
                  createBuffer(hitBytes, VK_BUFFER_USAGE_TRANSFER_DST_BIT, hostVisible, hitsStaging, true);
    }
    if (!created ||
        vkMapMemory(device_, raysStaging.memory, 0, VK_WHOLE_SIZE, 0, &raysStaging.mappedPtr) != VK_SUCCESS ||
        vkMapMemory(device_, hitsStaging.memory, 0, VK_WHOLE_SIZE, 0, &hitsStaging.mappedPtr) != VK_SUCCESS) {
        release();
        return false;
    }

    destroyBuffer(batchRaysStaging_);
    destroyBuffer(batchRaysDevice_);
    destroyBuffer(batchHitsDevice_);
    destroyBuffer(batchHitsStaging_);
    batchRaysStaging_ = raysStaging;
    batchRaysDevice_ = raysDevice;
    batchHitsDevice_ = hitsDevice;
    batchHitsStaging_ = hitsStaging;
    batchCapacity_ = static_cast<uint32_t>(capacity);
    return true;
}

void VulkanRTBackend::bindBatchBuffers(VulkanTLAS* tlas) {
    // The previous batch finished before it returned, so the set is idle and safe to rewrite.
    VkWriteDescriptorSetAccelerationStructureKHR tlasWrite = {};
    tlasWrite.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET_ACCELERATION_STRUCTURE_KHR;
    tlasWrite.accelerationStructureCount = 1;
    tlasWrite.pAccelerationStructures = &tlas->accelerationStructure;
    VkDescriptorBufferInfo raysInfo = {batchRaysDevice_.buffer, 0, VK_WHOLE_SIZE};
    VkDescriptorBufferInfo hitsInfo = {batchHitsDevice_.buffer, 0, VK_WHOLE_SIZE};

    std::array<VkWriteDescriptorSet, 3> writes = {};
    writes[0].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
    writes[0].pNext = &tlasWrite;
    writes[0].dstSet = batchSet_;
    writes[0].dstBinding = 0;
    writes[0].descriptorCount = 1;
    writes[0].descriptorType = VK_DESCRIPTOR_TYPE_ACCELERATION_STRUCTURE_KHR;
    writes[1].sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET;
    writes[1].dstSet = batchSet_;
    writes[1].dstBinding = 1;
    writes[1].descriptorCount = 1;
    writes[1].descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;
    writes[1].pBufferInfo = &raysInfo;
    writes[2] = writes[1];
    writes[2].dstBinding = 2;
    writes[2].pBufferInfo = &hitsInfo;
    vkUpdateDescriptorSets(device_, static_cast<uint32_t>(writes.size()), writes.data(), 0, nullptr);
}

TraceRayBatchResult VulkanRTBackend::traceRayBatch(const TraceRayBatchOptions& options) {
    const auto started = std::chrono::steady_clock::now();
    TraceRayBatchResult result;
    auto fail = [&](const std::string& message) {
        result.ok = false;
        result.error = "vulkan ray batch: " + message;
        return result;
    };

    if (!initialized_ || !batchReady_) {
        return fail("the batch path is not available (" +
                    (batchError_.empty() ? std::string("backend not initialized") : batchError_) + ")");
    }
    // A shared trace in flight owns the batch fence, command buffer and buffers until it is done.
    reclaimSharedTrace();
    if (!batchReady_) return fail("the batch path is not available (" + batchError_ + ")");

    VulkanTLAS* tlas = static_cast<VulkanTLAS*>(options.tlas._handle);
    bool tlasIsLive = false;
    for (const auto& entry : tlases_) {
        if (entry.second.get() == tlas) {
            tlasIsLive = tlas != nullptr;
            break;
        }
    }
    if (!tlasIsLive) {
        return fail("the TLAS handle is missing or was destroyed");
    }
    if (!tlas->oneTriangleList) {
        return fail("a hit names one triangle, so the TLAS must hold one instance of a BLAS built from one geometry");
    }

    if (options.rayCount == 0) {
        result.ok = true;
        return result;
    }
    if (options.rays == nullptr || options.hits == nullptr) {
        return fail("rays and hits must not be null");
    }
    if (options.rayCount > maxBatchRays_) {
        return fail("rayCount " + std::to_string(options.rayCount) + " is above the device limit of " +
                    std::to_string(maxBatchRays_) + " rays");
    }
    if (!ensureBatchCapacity(options.rayCount)) {
        return fail("allocating buffers for " + std::to_string(options.rayCount) + " rays failed");
    }

    const VkDeviceSize rayBytes = static_cast<VkDeviceSize>(options.rayCount) * kRayWords * sizeof(float);
    const VkDeviceSize hitBytes = static_cast<VkDeviceSize>(options.rayCount) * kHitWords * sizeof(uint32_t);
    std::memcpy(batchRaysStaging_.mappedPtr, options.rays, rayBytes);

    bindBatchBuffers(tlas);

    VkCommandBuffer cmd = batchCommands_;
    vkResetCommandBuffer(cmd, 0);
    VkCommandBufferBeginInfo beginInfo = {};
    beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    beginInfo.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkBeginCommandBuffer(cmd, &beginInfo);

    const bool timed = timestampPool_ != VK_NULL_HANDLE;
    if (timed) vkCmdResetQueryPool(cmd, timestampPool_, 0, 2);

    VkMemoryBarrier barrier = {};
    barrier.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER;

    VkBufferCopy upload = {0, 0, rayBytes};
    vkCmdCopyBuffer(cmd, batchRaysStaging_.buffer, batchRaysDevice_.buffer, 1, &upload);
    // The first timestamp lands once the upload is done, so gpuMs covers the trace dispatch alone.
    if (timed) vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, timestampPool_, 0);

    barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,
                         0, 1, &barrier, 0, nullptr, 0, nullptr);

    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, batchPipeline_);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, batchPipelineLayout_, 0, 1, &batchSet_,
                            0, nullptr);
    vkCmdPushConstants(cmd, batchPipelineLayout_, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(uint32_t),
                       &options.rayCount);
    vkCmdDispatch(cmd, (options.rayCount + 63u) / 64u, 1, 1);
    if (timed) vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, timestampPool_, 1);

    barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT,
                         0, 1, &barrier, 0, nullptr, 0, nullptr);

    VkBufferCopy download = {0, 0, hitBytes};
    vkCmdCopyBuffer(cmd, batchHitsDevice_.buffer, batchHitsStaging_.buffer, 1, &download);

    barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_HOST_READ_BIT;
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_HOST_BIT,
                         0, 1, &barrier, 0, nullptr, 0, nullptr);
    vkEndCommandBuffer(cmd);

    VkSubmitInfo submitInfo = {};
    submitInfo.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    submitInfo.commandBufferCount = 1;
    submitInfo.pCommandBuffers = &cmd;
    const VkResult submitted = vkQueueSubmit(queue_, 1, &submitInfo, batchFence_);
    if (submitted != VK_SUCCESS) {
        batchReady_ = false;
        batchError_ = "vkQueueSubmit failed (VkResult " + std::to_string(submitted) + ")";
        return fail(batchError_);
    }
    const VkResult waited = vkWaitForFences(device_, 1, &batchFence_, VK_TRUE, 10ull * 1000 * 1000 * 1000);
    if (waited != VK_SUCCESS) {
        // The GPU may still own the buffers, so the path stays off until the backend is rebuilt.
        batchReady_ = false;
        batchError_ = "vkWaitForFences failed (VkResult " + std::to_string(waited) + ")";
        return fail(batchError_);
    }
    vkResetFences(device_, 1, &batchFence_);

    if (timed) {
        uint64_t ticks[2] = {0, 0};
        if (vkGetQueryPoolResults(device_, timestampPool_, 0, 2, sizeof(ticks), ticks, sizeof(uint64_t),
                                  VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT) == VK_SUCCESS) {
            const uint64_t mask = timestampValidBits_ >= 64 ? ~0ull : ((1ull << timestampValidBits_) - 1);
            result.gpuMs = static_cast<double>((ticks[1] - ticks[0]) & mask) * caps_.timestampPeriodNs * 1e-6;
        }
    }

    std::memcpy(options.hits, batchHitsStaging_.mappedPtr, hitBytes);

    result.ok = true;
    result.totalMs =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    return result;
}

// ============================================================================
// Shared trace transport (PRD-645)
//
// The rays and the hits live in two Vulkan images whose memory the WebGPU device imports. A batch
// copies the ray image into the existing device-local ray buffer, runs the same ray query kernel,
// and copies the hit buffer into the hit image. Both images stay in GENERAL layout. Ownership
// moves between the two devices through opaque-fd semaphores, so no step waits on the CPU.
// ============================================================================

#if !defined(_WIN32)

namespace {

constexpr VkFormat kSharedFormat = VK_FORMAT_R32G32B32A32_SFLOAT;
constexpr uint32_t kSharedTexelBytes = 16;

// A copy region list for `texels` texels: the full rows, then one partial row.
std::vector<VkBufferImageCopy> sharedRegions(uint32_t texels) {
    std::vector<VkBufferImageCopy> regions;
    const uint32_t fullRows = texels / kSharedRowTexels;
    const uint32_t remainder = texels % kSharedRowTexels;
    VkBufferImageCopy region = {};
    region.imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1};
    if (fullRows > 0) {
        region.bufferRowLength = kSharedRowTexels;
        region.imageExtent = {kSharedRowTexels, fullRows, 1};
        regions.push_back(region);
    }
    if (remainder > 0) {
        region.bufferOffset = static_cast<VkDeviceSize>(fullRows) * kSharedRowTexels * kSharedTexelBytes;
        region.bufferRowLength = 0;
        region.imageOffset = {0, static_cast<int32_t>(fullRows), 0};
        region.imageExtent = {remainder, 1, 1};
        regions.push_back(region);
    }
    return regions;
}

VkImageMemoryBarrier sharedImageBarrier(VkImage image, uint32_t srcFamily, uint32_t dstFamily,
                                        VkImageLayout oldLayout, VkImageLayout newLayout,
                                        VkAccessFlags srcAccess, VkAccessFlags dstAccess) {
    VkImageMemoryBarrier barrier = {};
    barrier.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER;
    barrier.srcAccessMask = srcAccess;
    barrier.dstAccessMask = dstAccess;
    barrier.oldLayout = oldLayout;
    barrier.newLayout = newLayout;
    barrier.srcQueueFamilyIndex = srcFamily;
    barrier.dstQueueFamilyIndex = dstFamily;
    barrier.image = image;
    barrier.subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1};
    return barrier;
}

}  // namespace

bool VulkanRTBackend::createSharedImage(uint32_t width, uint32_t height, VkImage& image,
                                        VkDeviceMemory& memory, VkImageCreateInfo& info,
                                        SharedTraceImage& out, std::string& error) {
    info = {};
    info.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO;
    info.pNext = &sharedExternalInfo_;
    info.imageType = VK_IMAGE_TYPE_2D;
    info.format = kSharedFormat;
    info.extent = {width, height, 1};
    info.mipLevels = 1;
    info.arrayLayers = 1;
    info.samples = VK_SAMPLE_COUNT_1_BIT;
    info.tiling = VK_IMAGE_TILING_OPTIMAL;
    info.usage = VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT;
    info.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    info.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;

    VkPhysicalDeviceExternalImageFormatInfo externalFormat = {};
    externalFormat.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO;
    externalFormat.handleType = VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT;
    VkPhysicalDeviceImageFormatInfo2 formatInfo = {};
    formatInfo.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_IMAGE_FORMAT_INFO_2;
    formatInfo.pNext = &externalFormat;
    formatInfo.format = info.format;
    formatInfo.type = info.imageType;
    formatInfo.tiling = info.tiling;
    formatInfo.usage = info.usage;
    VkExternalImageFormatProperties externalProperties = {};
    externalProperties.sType = VK_STRUCTURE_TYPE_EXTERNAL_IMAGE_FORMAT_PROPERTIES;
    VkImageFormatProperties2 formatProperties = {};
    formatProperties.sType = VK_STRUCTURE_TYPE_IMAGE_FORMAT_PROPERTIES_2;
    formatProperties.pNext = &externalProperties;
    if (vkGetPhysicalDeviceImageFormatProperties2(physicalDevice_, &formatInfo, &formatProperties) != VK_SUCCESS) {
        error = "the device does not support a " + std::to_string(width) + " by " + std::to_string(height) +
                " RGBA32F image that an opaque fd can share";
        return false;
    }
    const VkExternalMemoryFeatureFlags features = externalProperties.externalMemoryProperties.externalMemoryFeatures;
    if (!(features & VK_EXTERNAL_MEMORY_FEATURE_EXPORTABLE_BIT) || !(features & VK_EXTERNAL_MEMORY_FEATURE_IMPORTABLE_BIT)) {
        error = "an RGBA32F image cannot be both exported and imported through an opaque fd on this device";
        return false;
    }
    if (width > formatProperties.imageFormatProperties.maxExtent.width ||
        height > formatProperties.imageFormatProperties.maxExtent.height) {
        error = "the shared image is larger than the device allows";
        return false;
    }

    if (vkCreateImage(device_, &info, nullptr, &image) != VK_SUCCESS) {
        error = "vkCreateImage failed";
        return false;
    }
    VkImageMemoryRequirementsInfo2 requirementsInfo = {};
    requirementsInfo.sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_REQUIREMENTS_INFO_2;
    requirementsInfo.image = image;
    VkMemoryRequirements2 requirements = {};
    requirements.sType = VK_STRUCTURE_TYPE_MEMORY_REQUIREMENTS_2;
    vkGetImageMemoryRequirements2(device_, &requirementsInfo, &requirements);

    // One dedicated allocation per image, which is what the importer's descriptor describes.
    VkMemoryDedicatedAllocateInfo dedicated = {};
    dedicated.sType = VK_STRUCTURE_TYPE_MEMORY_DEDICATED_ALLOCATE_INFO;
    dedicated.image = image;
    VkExportMemoryAllocateInfo exportInfo = {};
    exportInfo.sType = VK_STRUCTURE_TYPE_EXPORT_MEMORY_ALLOCATE_INFO;
    exportInfo.pNext = &dedicated;
    exportInfo.handleTypes = VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT;
    const uint32_t memoryType =
        findMemoryTypeIndex(requirements.memoryRequirements.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    if (memoryType == UINT32_MAX) {
        error = "no device-local memory type fits the shared image";
        return false;
    }
    VkMemoryAllocateInfo allocate = {};
    allocate.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    allocate.pNext = &exportInfo;
    allocate.allocationSize = requirements.memoryRequirements.size;
    allocate.memoryTypeIndex = memoryType;
    if (vkAllocateMemory(device_, &allocate, nullptr, &memory) != VK_SUCCESS) {
        error = "vkAllocateMemory failed for the shared image";
        return false;
    }
    if (vkBindImageMemory(device_, image, memory, 0) != VK_SUCCESS) {
        error = "vkBindImageMemory failed for the shared image";
        return false;
    }

    VkMemoryGetFdInfoKHR getFd = {};
    getFd.sType = VK_STRUCTURE_TYPE_MEMORY_GET_FD_INFO_KHR;
    getFd.memory = memory;
    getFd.handleType = VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT;
    int fd = -1;
    if (vkGetMemoryFdKHR_(device_, &getFd, &fd) != VK_SUCCESS || fd < 0) {
        error = "vkGetMemoryFdKHR failed";
        return false;
    }

    out.imageCreateInfo = &info;
    out.memoryFd = fd;
    out.memoryTypeIndex = memoryType;
    out.allocationSize = allocate.allocationSize;
    out.dedicatedAllocation = true;
    out.width = width;
    out.height = height;
    return true;
}

SharedTraceSetup VulkanRTBackend::createSharedTrace(uint32_t capacityRays) {
    SharedTraceSetup setup;
    auto fail = [&](const std::string& message) {
        setup.ok = false;
        setup.error = "vulkan shared trace: " + message;
        if (setup.rays.memoryFd >= 0) close(setup.rays.memoryFd);
        if (setup.hits.memoryFd >= 0) close(setup.hits.memoryFd);
        if (setup.signalHitsFd >= 0) close(setup.signalHitsFd);
        if (setup.signalRaysFd >= 0) close(setup.signalRaysFd);
        setup.rays.memoryFd = setup.hits.memoryFd = setup.signalHitsFd = setup.signalRaysFd = -1;
        destroySharedTrace();
        return setup;
    };

    if (!initialized_ || !batchReady_) {
        return fail("the ray batch path is off (" + (batchError_.empty() ? initError_ : batchError_) + ")");
    }
    if (!externalSharingReady_) {
        return fail("the device lacks VK_KHR_external_memory_fd or VK_KHR_external_semaphore_fd");
    }
    if (sharedRays_ != VK_NULL_HANDLE) {
        return fail("the shared images already exist");
    }
    if (capacityRays == 0 || capacityRays > maxBatchRays_) {
        return fail("capacity " + std::to_string(capacityRays) + " is outside 1 to " + std::to_string(maxBatchRays_) + " rays");
    }

    sharedExternalInfo_ = {};
    sharedExternalInfo_.sType = VK_STRUCTURE_TYPE_EXTERNAL_MEMORY_IMAGE_CREATE_INFO;
    sharedExternalInfo_.handleTypes = VK_EXTERNAL_MEMORY_HANDLE_TYPE_OPAQUE_FD_BIT;

    const uint32_t raysHeight = (capacityRays * 2 + kSharedRowTexels - 1) / kSharedRowTexels;
    const uint32_t hitsHeight = (capacityRays + kSharedRowTexels - 1) / kSharedRowTexels;
    std::string error;
    if (!createSharedImage(kSharedRowTexels, raysHeight, sharedRays_, sharedRaysMemory_, sharedRaysInfo_, setup.rays, error)) {
        return fail("ray image: " + error);
    }
    if (!createSharedImage(kSharedRowTexels, hitsHeight, sharedHits_, sharedHitsMemory_, sharedHitsInfo_, setup.hits, error)) {
        return fail("hit image: " + error);
    }

    // Both images start in GENERAL and stay there between uses.
    VkCommandBuffer cmd = beginSingleTimeCommands();
    const VkImageMemoryBarrier toGeneral[2] = {
        sharedImageBarrier(sharedRays_, VK_QUEUE_FAMILY_IGNORED, VK_QUEUE_FAMILY_IGNORED, VK_IMAGE_LAYOUT_UNDEFINED,
                           VK_IMAGE_LAYOUT_GENERAL, 0, 0),
        sharedImageBarrier(sharedHits_, VK_QUEUE_FAMILY_IGNORED, VK_QUEUE_FAMILY_IGNORED, VK_IMAGE_LAYOUT_UNDEFINED,
                           VK_IMAGE_LAYOUT_GENERAL, 0, 0),
    };
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, nullptr, 0,
                         nullptr, 2, toGeneral);
    endSingleTimeCommands(cmd);

    // Two semaphores live as long as the images: each trace signals them and the WebGPU device waits on
    // them through fences it imported once. Two more take the wait fds that the WebGPU device exports.
    VkExportSemaphoreCreateInfo exportSemaphore = {};
    exportSemaphore.sType = VK_STRUCTURE_TYPE_EXPORT_SEMAPHORE_CREATE_INFO;
    exportSemaphore.handleTypes = VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD_BIT;
    VkSemaphoreCreateInfo signalInfo = {};
    signalInfo.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO;
    signalInfo.pNext = &exportSemaphore;
    VkSemaphoreCreateInfo waitInfo = {};
    waitInfo.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO;
    for (VkSemaphore& semaphore : sharedSignals_) {
        if (vkCreateSemaphore(device_, &signalInfo, nullptr, &semaphore) != VK_SUCCESS) return fail("vkCreateSemaphore failed");
    }
    for (VkSemaphore& semaphore : sharedWaits_) {
        if (vkCreateSemaphore(device_, &waitInfo, nullptr, &semaphore) != VK_SUCCESS) return fail("vkCreateSemaphore failed");
    }
    VkSemaphoreGetFdInfoKHR getFd = {};
    getFd.sType = VK_STRUCTURE_TYPE_SEMAPHORE_GET_FD_INFO_KHR;
    getFd.handleType = VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD_BIT;
    getFd.semaphore = sharedSignals_[0];
    if (vkGetSemaphoreFdKHR_(device_, &getFd, &setup.signalHitsFd) != VK_SUCCESS) return fail("vkGetSemaphoreFdKHR failed");
    getFd.semaphore = sharedSignals_[1];
    if (vkGetSemaphoreFdKHR_(device_, &getFd, &setup.signalRaysFd) != VK_SUCCESS) return fail("vkGetSemaphoreFdKHR failed");

    sharedCapacity_ = capacityRays;
    setup.capacityRays = capacityRays;
    setup.layout = VK_IMAGE_LAYOUT_GENERAL;
    setup.ok = true;
    return setup;
}

void VulkanRTBackend::reclaimSharedTrace() {
    if (!sharedPending_) return;
    const VkResult waited = vkWaitForFences(device_, 1, &batchFence_, VK_TRUE, 10ull * 1000 * 1000 * 1000);
    if (waited != VK_SUCCESS) {
        // The GPU may still own the buffers, so the path stays off until the backend is rebuilt.
        batchReady_ = false;
        batchError_ = "vkWaitForFences failed (VkResult " + std::to_string(waited) + ")";
        return;
    }
    vkResetFences(device_, 1, &batchFence_);
    if (timestampPool_ != VK_NULL_HANDLE) {
        uint64_t ticks[2] = {0, 0};
        if (vkGetQueryPoolResults(device_, timestampPool_, 0, 2, sizeof(ticks), ticks, sizeof(uint64_t),
                                  VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT) == VK_SUCCESS) {
            const uint64_t mask = timestampValidBits_ >= 64 ? ~0ull : ((1ull << timestampValidBits_) - 1);
            sharedGpuMs_ = static_cast<double>((ticks[1] - ticks[0]) & mask) * caps_.timestampPeriodNs * 1e-6;
        }
    }
    sharedPending_ = false;
}

double VulkanRTBackend::sharedTraceGpuMs() {
    reclaimSharedTrace();
    return sharedGpuMs_;
}

void VulkanRTBackend::destroySharedTrace() {
    if (device_ == VK_NULL_HANDLE) return;
    if (sharedPending_) {
        vkWaitForFences(device_, 1, &batchFence_, VK_TRUE, 10ull * 1000 * 1000 * 1000);
        vkResetFences(device_, 1, &batchFence_);
        sharedPending_ = false;
    }
    for (VkSemaphore& semaphore : sharedSignals_) {
        if (semaphore != VK_NULL_HANDLE) vkDestroySemaphore(device_, semaphore, nullptr);
        semaphore = VK_NULL_HANDLE;
    }
    for (VkSemaphore& semaphore : sharedWaits_) {
        if (semaphore != VK_NULL_HANDLE) vkDestroySemaphore(device_, semaphore, nullptr);
        semaphore = VK_NULL_HANDLE;
    }
    if (sharedRays_ != VK_NULL_HANDLE) vkDestroyImage(device_, sharedRays_, nullptr);
    if (sharedHits_ != VK_NULL_HANDLE) vkDestroyImage(device_, sharedHits_, nullptr);
    if (sharedRaysMemory_ != VK_NULL_HANDLE) vkFreeMemory(device_, sharedRaysMemory_, nullptr);
    if (sharedHitsMemory_ != VK_NULL_HANDLE) vkFreeMemory(device_, sharedHitsMemory_, nullptr);
    sharedRays_ = sharedHits_ = VK_NULL_HANDLE;
    sharedRaysMemory_ = sharedHitsMemory_ = VK_NULL_HANDLE;
    sharedCapacity_ = 0;
}

SharedTraceResult VulkanRTBackend::traceShared(const SharedTraceOptions& options) {
    const auto started = std::chrono::steady_clock::now();
    SharedTraceResult result;
    int waitRaysFd = options.waitRaysFd;
    int waitHitsFd = options.waitHitsFd;
    auto fail = [&](const std::string& message) {
        result.ok = false;
        result.error = "vulkan shared trace: " + message;
        // Vulkan owns an fd once its import succeeds; any fd still held here is closed.
        if (waitRaysFd >= 0) close(waitRaysFd);
        if (waitHitsFd >= 0) close(waitHitsFd);
        return result;
    };

    if (!initialized_ || !batchReady_ || sharedRays_ == VK_NULL_HANDLE) {
        return fail("the shared images do not exist");
    }
    VulkanTLAS* tlas = static_cast<VulkanTLAS*>(options.tlas._handle);
    bool tlasIsLive = false;
    for (const auto& entry : tlases_) {
        if (entry.second.get() == tlas) {
            tlasIsLive = tlas != nullptr;
            break;
        }
    }
    if (!tlasIsLive) return fail("the TLAS handle is missing or was destroyed");
    if (!tlas->oneTriangleList) {
        return fail("a hit names one triangle, so the TLAS must hold one instance of a BLAS built from one geometry");
    }
    if (options.rayCount == 0 || options.rayCount > sharedCapacity_) {
        return fail("rayCount " + std::to_string(options.rayCount) + " is outside 1 to the shared capacity of " +
                    std::to_string(sharedCapacity_) + " rays");
    }

    // The previous shared trace must be done before its buffers and descriptors change.
    reclaimSharedTrace();
    if (!batchReady_) return fail(batchError_);
    if (!ensureBatchCapacity(options.rayCount)) {
        return fail("allocating buffers for " + std::to_string(options.rayCount) + " rays failed");
    }

    std::array<VkSemaphore, 2> waits = {VK_NULL_HANDLE, VK_NULL_HANDLE};
    uint32_t waitCount = 0;
    // The two wait semaphores are reused: the previous trace is done, so neither holds a payload.
    // A temporary import lasts for one wait, so the next call imports again.
    auto importWait = [&](int& fd, VkSemaphore semaphore) {
        if (fd < 0) return true;
        VkImportSemaphoreFdInfoKHR importInfo = {};
        importInfo.sType = VK_STRUCTURE_TYPE_IMPORT_SEMAPHORE_FD_INFO_KHR;
        importInfo.semaphore = semaphore;
        importInfo.flags = VK_SEMAPHORE_IMPORT_TEMPORARY_BIT;
        importInfo.handleType = VK_EXTERNAL_SEMAPHORE_HANDLE_TYPE_OPAQUE_FD_BIT;
        importInfo.fd = fd;
        if (vkImportSemaphoreFdKHR_(device_, &importInfo) != VK_SUCCESS) return false;
        fd = -1;  // Vulkan owns it now
        waits[waitCount++] = semaphore;
        return true;
    };
    if (!importWait(waitRaysFd, sharedWaits_[0]) || !importWait(waitHitsFd, sharedWaits_[1])) {
        return fail("importing a wait fd failed");
    }
    const std::array<VkSemaphore, 2> signals = {sharedSignals_[0], sharedSignals_[1]};  // hits ready, rays free

    bindBatchBuffers(tlas);

    VkCommandBuffer cmd = batchCommands_;
    vkResetCommandBuffer(cmd, 0);
    VkCommandBufferBeginInfo beginInfo = {};
    beginInfo.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
    beginInfo.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkBeginCommandBuffer(cmd, &beginInfo);

    const bool timed = timestampPool_ != VK_NULL_HANDLE;
    if (timed) vkCmdResetQueryPool(cmd, timestampPool_, 0, 2);

    // Take both images from the WebGPU device. Both are GENERAL, so only the ownership moves.
    const VkImageMemoryBarrier acquire[2] = {
        sharedImageBarrier(sharedRays_, VK_QUEUE_FAMILY_EXTERNAL, queueFamilyIndex_, VK_IMAGE_LAYOUT_GENERAL,
                           VK_IMAGE_LAYOUT_GENERAL, 0, VK_ACCESS_TRANSFER_READ_BIT),
        sharedImageBarrier(sharedHits_, VK_QUEUE_FAMILY_EXTERNAL, queueFamilyIndex_, VK_IMAGE_LAYOUT_GENERAL,
                           VK_IMAGE_LAYOUT_GENERAL, 0, VK_ACCESS_TRANSFER_WRITE_BIT),
    };
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 0, nullptr, 0,
                         nullptr, 2, acquire);

    const std::vector<VkBufferImageCopy> rayRegions = sharedRegions(options.rayCount * 2);
    vkCmdCopyImageToBuffer(cmd, sharedRays_, VK_IMAGE_LAYOUT_GENERAL, batchRaysDevice_.buffer,
                           static_cast<uint32_t>(rayRegions.size()), rayRegions.data());
    // The first timestamp lands once the ray copy is done, so gpuMs covers the trace dispatch alone.
    if (timed) vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, timestampPool_, 0);

    VkMemoryBarrier barrier = {};
    barrier.sType = VK_STRUCTURE_TYPE_MEMORY_BARRIER;
    barrier.srcAccessMask = VK_ACCESS_TRANSFER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_SHADER_READ_BIT;
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, 0, 1, &barrier, 0,
                         nullptr, 0, nullptr);

    vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, batchPipeline_);
    vkCmdBindDescriptorSets(cmd, VK_PIPELINE_BIND_POINT_COMPUTE, batchPipelineLayout_, 0, 1, &batchSet_, 0, nullptr);
    vkCmdPushConstants(cmd, batchPipelineLayout_, VK_SHADER_STAGE_COMPUTE_BIT, 0, sizeof(uint32_t), &options.rayCount);
    vkCmdDispatch(cmd, (options.rayCount + 63u) / 64u, 1, 1);
    if (timed) vkCmdWriteTimestamp(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, timestampPool_, 1);

    barrier.srcAccessMask = VK_ACCESS_SHADER_WRITE_BIT;
    barrier.dstAccessMask = VK_ACCESS_TRANSFER_READ_BIT;
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT, 0, 1, &barrier, 0,
                         nullptr, 0, nullptr);

    const std::vector<VkBufferImageCopy> hitRegions = sharedRegions(options.rayCount);
    vkCmdCopyBufferToImage(cmd, batchHitsDevice_.buffer, sharedHits_, VK_IMAGE_LAYOUT_GENERAL,
                           static_cast<uint32_t>(hitRegions.size()), hitRegions.data());

    // Give both images back to the WebGPU device.
    const VkImageMemoryBarrier release[2] = {
        sharedImageBarrier(sharedRays_, queueFamilyIndex_, VK_QUEUE_FAMILY_EXTERNAL, VK_IMAGE_LAYOUT_GENERAL,
                           VK_IMAGE_LAYOUT_GENERAL, VK_ACCESS_TRANSFER_READ_BIT, 0),
        sharedImageBarrier(sharedHits_, queueFamilyIndex_, VK_QUEUE_FAMILY_EXTERNAL, VK_IMAGE_LAYOUT_GENERAL,
                           VK_IMAGE_LAYOUT_GENERAL, VK_ACCESS_TRANSFER_WRITE_BIT, 0),
    };
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT, 0, 0, nullptr, 0,
                         nullptr, 2, release);
    vkEndCommandBuffer(cmd);

    const VkPipelineStageFlags waitStages[2] = {VK_PIPELINE_STAGE_TRANSFER_BIT, VK_PIPELINE_STAGE_TRANSFER_BIT};
    VkSubmitInfo submitInfo = {};
    submitInfo.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
    submitInfo.waitSemaphoreCount = waitCount;
    submitInfo.pWaitSemaphores = waits.data();
    submitInfo.pWaitDstStageMask = waitStages;
    submitInfo.commandBufferCount = 1;
    submitInfo.pCommandBuffers = &cmd;
    submitInfo.signalSemaphoreCount = 2;
    submitInfo.pSignalSemaphores = signals.data();
    const VkResult submitted = vkQueueSubmit(queue_, 1, &submitInfo, batchFence_);
    if (submitted != VK_SUCCESS) {
        batchReady_ = false;
        batchError_ = "vkQueueSubmit failed (VkResult " + std::to_string(submitted) + ")";
        return fail(batchError_);
    }
    sharedPending_ = true;

    result.ok = true;
    result.totalMs =
        std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
    return result;
}

#else  // _WIN32

SharedTraceSetup VulkanRTBackend::createSharedTrace(uint32_t) {
    SharedTraceSetup setup;
    setup.error = "vulkan shared trace: opaque fd sharing is not available on Windows";
    return setup;
}
void VulkanRTBackend::destroySharedTrace() {}
SharedTraceResult VulkanRTBackend::traceShared(const SharedTraceOptions&) {
    SharedTraceResult result;
    result.error = "vulkan shared trace: opaque fd sharing is not available on Windows";
    return result;
}
double VulkanRTBackend::sharedTraceGpuMs() { return 0; }
bool VulkanRTBackend::createSharedImage(uint32_t, uint32_t, VkImage&, VkDeviceMemory&, VkImageCreateInfo&,
                                        SharedTraceImage&, std::string&) { return false; }
void VulkanRTBackend::reclaimSharedTrace() {}

#endif  // _WIN32

RTCapabilities VulkanRTBackend::capabilities() {
    RTCapabilities found = caps_;
    found.rayBatch = initialized_ && batchReady_;
    // The camera path stops at a host buffer. No texture interop with the WebGPU device exists yet.
    found.imageOutput = false;
    found.sharedTransport = initialized_ && batchReady_ && externalSharingReady_;
    found.sharedTransportReason = found.sharedTransport
        ? std::string()
        : (initialized_ && batchReady_
               ? std::string("the device lacks VK_KHR_external_memory_fd or VK_KHR_external_semaphore_fd")
               : std::string("the ray batch path is off"));
    found.reason = found.rayBatch ? std::string() : (initialized_ ? batchError_ : initError_);
    return found;
}

}  // namespace rt
}  // namespace mystral
