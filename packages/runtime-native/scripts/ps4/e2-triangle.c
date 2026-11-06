/*
 * test_triangle_ps4.c — PS4 Vulkan triangle test.
 *
 * Links against libvulkan_ps4.so and renders a colored triangle using
 * the Vulkan API.  The swapchain uses sceVideoOut internally.
 *
 * On PS4, there is no Vulkan loader — the app calls vk* symbols directly
 * from the ICD shared library.
 */

#include <vulkan/vulkan.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "vk_ps4_log.h"

int sceKernelUsleep(unsigned int microseconds);

/* === E2 readback patch (PRD-784): copy one presented frame back to a
 * host-visible buffer, count non-clear pixels, log one marker line, exit. === */
#define E2_W 1920u
#define E2_H 1080u
#define E2_RB_FRAME 120                 /* frame to read back */
#define E2_RB_BYTES (E2_W * E2_H * 4u)  /* RGBA8, linear VideoOut buffer */
/* E2 visual proof: the readback frame, downscaled 4x, as a binary PPM. shadPS4
 * mounts /data at <XDG_DATA_HOME>/shadPS4/data, inside the runner's HOME. */
#define E2_PPM_PATH "/data/tn_e2.ppm"
#define E2_PPM_W (E2_W / 4)
#define E2_PPM_H (E2_H / 4)

#ifndef E2_GUEST_VID
/* Simple vertex data: position (vec2) + color (vec3) */
static const float g_vertices[] = {
    /* x      y     r     g     b    */
     0.0f, -0.5f,  1.0f, 0.0f, 0.0f,  /* top */
    -0.5f,  0.5f,  0.0f, 1.0f, 0.0f,  /* bottom left */
     0.5f,  0.5f,  0.0f, 0.0f, 1.0f,  /* bottom right */
};

/* PRD-784 note: the arrays upstream ships here are malformed (SPIR-V header word 4 is
 * 0x11 instead of the schema word 0, and instructions are duplicated), so the ICD rejects the
 * module before any pipeline exists. Regenerated from the GLSL below with:
 *   glslangValidator -V --target-env vulkan1.0 -S vert|frag  (Glslang 11:16.6.0)
 *   spirv-val --target-env vulkan1.0  -> valid
 * Keep the GLSL above and these arrays in step. */
/* Minimal SPIR-V vertex shader:
 * #version 450
 * layout(location=0) in vec2 pos;
 * layout(location=1) in vec3 color;
 * layout(location=0) out vec3 vcolor;
 * void main() {
 *   gl_Position = vec4(pos, 0.0, 1.0);
 *   vcolor = color;
 * }
 */
static const uint32_t g_vert_spv[] = {
    0x07230203,0x00010000,0x0008000b,0x00000021,0x00000000,0x00020011,
    0x00000001,0x0006000b,0x00000001,0x4c534c47,0x6474732e,0x3035342e,
    0x00000000,0x0003000e,0x00000000,0x00000001,0x0009000f,0x00000000,
    0x00000004,0x6e69616d,0x00000000,0x0000000d,0x00000012,0x0000001d,
    0x0000001f,0x00030003,0x00000002,0x000001c2,0x00040005,0x00000004,
    0x6e69616d,0x00000000,0x00060005,0x0000000b,0x505f6c67,0x65567265,
    0x78657472,0x00000000,0x00060006,0x0000000b,0x00000000,0x505f6c67,
    0x7469736f,0x006e6f69,0x00070006,0x0000000b,0x00000001,0x505f6c67,
    0x746e696f,0x657a6953,0x00000000,0x00070006,0x0000000b,0x00000002,
    0x435f6c67,0x4470696c,0x61747369,0x0065636e,0x00070006,0x0000000b,
    0x00000003,0x435f6c67,0x446c6c75,0x61747369,0x0065636e,0x00030005,
    0x0000000d,0x00000000,0x00030005,0x00000012,0x00736f70,0x00040005,
    0x0000001d,0x6c6f6376,0x0000726f,0x00040005,0x0000001f,0x6f6c6f63,
    0x00000072,0x00030047,0x0000000b,0x00000002,0x00050048,0x0000000b,
    0x00000000,0x0000000b,0x00000000,0x00050048,0x0000000b,0x00000001,
    0x0000000b,0x00000001,0x00050048,0x0000000b,0x00000002,0x0000000b,
    0x00000003,0x00050048,0x0000000b,0x00000003,0x0000000b,0x00000004,
    0x00040047,0x00000012,0x0000001e,0x00000000,0x00040047,0x0000001d,
    0x0000001e,0x00000000,0x00040047,0x0000001f,0x0000001e,0x00000001,
    0x00020013,0x00000002,0x00030021,0x00000003,0x00000002,0x00030016,
    0x00000006,0x00000020,0x00040017,0x00000007,0x00000006,0x00000004,
    0x00040015,0x00000008,0x00000020,0x00000000,0x0004002b,0x00000008,
    0x00000009,0x00000001,0x0004001c,0x0000000a,0x00000006,0x00000009,
    0x0006001e,0x0000000b,0x00000007,0x00000006,0x0000000a,0x0000000a,
    0x00040020,0x0000000c,0x00000003,0x0000000b,0x0004003b,0x0000000c,
    0x0000000d,0x00000003,0x00040015,0x0000000e,0x00000020,0x00000001,
    0x0004002b,0x0000000e,0x0000000f,0x00000000,0x00040017,0x00000010,
    0x00000006,0x00000002,0x00040020,0x00000011,0x00000001,0x00000010,
    0x0004003b,0x00000011,0x00000012,0x00000001,0x0004002b,0x00000006,
    0x00000014,0x00000000,0x0004002b,0x00000006,0x00000015,0x3f800000,
    0x00040020,0x00000019,0x00000003,0x00000007,0x00040017,0x0000001b,
    0x00000006,0x00000003,0x00040020,0x0000001c,0x00000003,0x0000001b,
    0x0004003b,0x0000001c,0x0000001d,0x00000003,0x00040020,0x0000001e,
    0x00000001,0x0000001b,0x0004003b,0x0000001e,0x0000001f,0x00000001,
    0x00050036,0x00000002,0x00000004,0x00000000,0x00000003,0x000200f8,
    0x00000005,0x0004003d,0x00000010,0x00000013,0x00000012,0x00050051,
    0x00000006,0x00000016,0x00000013,0x00000000,0x00050051,0x00000006,
    0x00000017,0x00000013,0x00000001,0x00070050,0x00000007,0x00000018,
    0x00000016,0x00000017,0x00000014,0x00000015,0x00050041,0x00000019,
    0x0000001a,0x0000000d,0x0000000f,0x0003003e,0x0000001a,0x00000018,
    0x0004003d,0x0000001b,0x00000020,0x0000001f,0x0003003e,0x0000001d,
    0x00000020,0x000100fd,0x00010038,
};

/* Minimal SPIR-V fragment shader:
 * #version 450
 * layout(location=0) in vec3 vcolor;
 * layout(location=0) out vec4 fragColor;
 * void main() {
 *   fragColor = vec4(vcolor, 1.0);
 * }
 */
static const uint32_t g_frag_spv[] = {
    0x07230203,0x00010000,0x0008000b,0x00000013,0x00000000,0x00020011,
    0x00000001,0x0006000b,0x00000001,0x4c534c47,0x6474732e,0x3035342e,
    0x00000000,0x0003000e,0x00000000,0x00000001,0x0007000f,0x00000004,
    0x00000004,0x6e69616d,0x00000000,0x00000009,0x0000000c,0x00030010,
    0x00000004,0x00000007,0x00030003,0x00000002,0x000001c2,0x00040005,
    0x00000004,0x6e69616d,0x00000000,0x00050005,0x00000009,0x67617266,
    0x6f6c6f43,0x00000072,0x00040005,0x0000000c,0x6c6f6376,0x0000726f,
    0x00040047,0x00000009,0x0000001e,0x00000000,0x00040047,0x0000000c,
    0x0000001e,0x00000000,0x00020013,0x00000002,0x00030021,0x00000003,
    0x00000002,0x00030016,0x00000006,0x00000020,0x00040017,0x00000007,
    0x00000006,0x00000004,0x00040020,0x00000008,0x00000003,0x00000007,
    0x0004003b,0x00000008,0x00000009,0x00000003,0x00040017,0x0000000a,
    0x00000006,0x00000003,0x00040020,0x0000000b,0x00000001,0x0000000a,
    0x0004003b,0x0000000b,0x0000000c,0x00000001,0x0004002b,0x00000006,
    0x0000000e,0x3f800000,0x00050036,0x00000002,0x00000004,0x00000000,
    0x00000003,0x000200f8,0x00000005,0x0004003d,0x0000000a,0x0000000d,
    0x0000000c,0x00050051,0x00000006,0x0000000f,0x0000000d,0x00000000,
    0x00050051,0x00000006,0x00000010,0x0000000d,0x00000001,0x00050051,
    0x00000006,0x00000011,0x0000000d,0x00000002,0x00070050,0x00000007,
    0x00000012,0x0000000f,0x00000010,0x00000011,0x0000000e,0x0003003e,
    0x00000009,0x00000012,0x000100fd,0x00010038,
};
#else /* E2_GUEST_VID */
/* E2 variant A (TN_PS4_E2_GUEST=vid): the same test with NO vertex buffer and no
 * vertex-input state, so the draw needs no fetch shader for positions to exist.
 * A frame that is still the clear colour here means the loss is NOT the vertex
 * input. Regenerated the same way as the pair above (glslangValidator -V
 * --target-env vulkan1.0, Glslang 11:16.6.0; spirv-val --target-env vulkan1.0:
 * valid).
 * #version 450
 * void main() {
 *   vec2 p[3] = vec2[3](vec2(0.0,-0.5), vec2(-0.5,0.5), vec2(0.5,0.5));
 *   gl_Position = vec4(p[gl_VertexIndex], 0.0, 1.0);
 * }
 */
static const uint32_t g_vert_spv[] = {
    0x07230203,0x00010000,0x0008000b,0x00000028,0x00000000,0x00020011,
    0x00000001,0x0006000b,0x00000001,0x4c534c47,0x6474732e,0x3035342e,
    0x00000000,0x0003000e,0x00000000,0x00000001,0x0007000f,0x00000000,
    0x00000004,0x6e69616d,0x00000000,0x00000019,0x0000001d,0x00030003,
    0x00000002,0x000001c2,0x00040005,0x00000004,0x6e69616d,0x00000000,
    0x00030005,0x0000000c,0x00000070,0x00060005,0x00000017,0x505f6c67,
    0x65567265,0x78657472,0x00000000,0x00060006,0x00000017,0x00000000,
    0x505f6c67,0x7469736f,0x006e6f69,0x00070006,0x00000017,0x00000001,
    0x505f6c67,0x746e696f,0x657a6953,0x00000000,0x00070006,0x00000017,
    0x00000002,0x435f6c67,0x4470696c,0x61747369,0x0065636e,0x00070006,
    0x00000017,0x00000003,0x435f6c67,0x446c6c75,0x61747369,0x0065636e,
    0x00030005,0x00000019,0x00000000,0x00060005,0x0000001d,0x565f6c67,
    0x65747265,0x646e4978,0x00007865,0x00030047,0x00000017,0x00000002,
    0x00050048,0x00000017,0x00000000,0x0000000b,0x00000000,0x00050048,
    0x00000017,0x00000001,0x0000000b,0x00000001,0x00050048,0x00000017,
    0x00000002,0x0000000b,0x00000003,0x00050048,0x00000017,0x00000003,
    0x0000000b,0x00000004,0x00040047,0x0000001d,0x0000000b,0x0000002a,
    0x00020013,0x00000002,0x00030021,0x00000003,0x00000002,0x00030016,
    0x00000006,0x00000020,0x00040017,0x00000007,0x00000006,0x00000002,
    0x00040015,0x00000008,0x00000020,0x00000000,0x0004002b,0x00000008,
    0x00000009,0x00000003,0x0004001c,0x0000000a,0x00000007,0x00000009,
    0x00040020,0x0000000b,0x00000007,0x0000000a,0x0004002b,0x00000006,
    0x0000000d,0x00000000,0x0004002b,0x00000006,0x0000000e,0xbf000000,
    0x0005002c,0x00000007,0x0000000f,0x0000000d,0x0000000e,0x0004002b,
    0x00000006,0x00000010,0x3f000000,0x0005002c,0x00000007,0x00000011,
    0x0000000e,0x00000010,0x0005002c,0x00000007,0x00000012,0x00000010,
    0x00000010,0x0006002c,0x0000000a,0x00000013,0x0000000f,0x00000011,
    0x00000012,0x00040017,0x00000014,0x00000006,0x00000004,0x0004002b,
    0x00000008,0x00000015,0x00000001,0x0004001c,0x00000016,0x00000006,
    0x00000015,0x0006001e,0x00000017,0x00000014,0x00000006,0x00000016,
    0x00000016,0x00040020,0x00000018,0x00000003,0x00000017,0x0004003b,
    0x00000018,0x00000019,0x00000003,0x00040015,0x0000001a,0x00000020,
    0x00000001,0x0004002b,0x0000001a,0x0000001b,0x00000000,0x00040020,
    0x0000001c,0x00000001,0x0000001a,0x0004003b,0x0000001c,0x0000001d,
    0x00000001,0x00040020,0x0000001f,0x00000007,0x00000007,0x0004002b,
    0x00000006,0x00000022,0x3f800000,0x00040020,0x00000026,0x00000003,
    0x00000014,0x00050036,0x00000002,0x00000004,0x00000000,0x00000003,
    0x000200f8,0x00000005,0x0004003b,0x0000000b,0x0000000c,0x00000007,
    0x0003003e,0x0000000c,0x00000013,0x0004003d,0x0000001a,0x0000001e,
    0x0000001d,0x00050041,0x0000001f,0x00000020,0x0000000c,0x0000001e,
    0x0004003d,0x00000007,0x00000021,0x00000020,0x00050051,0x00000006,
    0x00000023,0x00000021,0x00000000,0x00050051,0x00000006,0x00000024,
    0x00000021,0x00000001,0x00070050,0x00000014,0x00000025,0x00000023,
    0x00000024,0x0000000d,0x00000022,0x00050041,0x00000026,0x00000027,
    0x00000019,0x0000001b,0x0003003e,0x00000027,0x00000025,0x000100fd,
    0x00010038,
};

/* The same fragment stage with a constant colour, so the PS reads nothing the VS
 * exported and a missing PS input cannot hide the reason:
 * #version 450
 * layout(location=0) out vec4 fragColor;
 * void main() { fragColor = vec4(1.0, 0.5, 0.0, 1.0); }
 */
static const uint32_t g_frag_spv[] = {
    0x07230203,0x00010000,0x0008000b,0x0000000e,0x00000000,0x00020011,
    0x00000001,0x0006000b,0x00000001,0x4c534c47,0x6474732e,0x3035342e,
    0x00000000,0x0003000e,0x00000000,0x00000001,0x0006000f,0x00000004,
    0x00000004,0x6e69616d,0x00000000,0x00000009,0x00030010,0x00000004,
    0x00000007,0x00030003,0x00000002,0x000001c2,0x00040005,0x00000004,
    0x6e69616d,0x00000000,0x00050005,0x00000009,0x67617266,0x6f6c6f43,
    0x00000072,0x00040047,0x00000009,0x0000001e,0x00000000,0x00020013,
    0x00000002,0x00030021,0x00000003,0x00000002,0x00030016,0x00000006,
    0x00000020,0x00040017,0x00000007,0x00000006,0x00000004,0x00040020,
    0x00000008,0x00000003,0x00000007,0x0004003b,0x00000008,0x00000009,
    0x00000003,0x0004002b,0x00000006,0x0000000a,0x3f800000,0x0004002b,
    0x00000006,0x0000000b,0x3f000000,0x0004002b,0x00000006,0x0000000c,
    0x00000000,0x0007002c,0x00000007,0x0000000d,0x0000000a,0x0000000b,
    0x0000000c,0x0000000a,0x00050036,0x00000002,0x00000004,0x00000000,
    0x00000003,0x000200f8,0x00000005,0x0003003e,0x00000009,0x0000000d,
    0x000100fd,0x00010038,
};
#endif /* E2_GUEST_VID */

/* Write the readback frame as a 4x-downscaled binary PPM (P6), box-averaging
 * each 4x4 block of the packed RGBA8 frame. Returns 0 on success. */
static int e2_write_ppm(const unsigned char *rgba) {
    static unsigned char row[E2_PPM_W * 3];
    FILE *f = fopen(E2_PPM_PATH, "wb");
    if (!f) return -1;
    if (fprintf(f, "P6\n%u %u\n255\n", E2_PPM_W, E2_PPM_H) < 0) goto fail;
    for (unsigned y = 0; y < E2_PPM_H; y++) {
        for (unsigned x = 0; x < E2_PPM_W; x++) {
            unsigned r = 0, g = 0, b = 0;
            for (unsigned dy = 0; dy < 4; dy++) {
                const unsigned char *p =
                    rgba + ((size_t)(y * 4 + dy) * E2_W + x * 4) * 4;
                for (unsigned dx = 0; dx < 4; dx++, p += 4) {
                    r += p[0]; g += p[1]; b += p[2];
                }
            }
            row[x * 3 + 0] = (unsigned char)((r + 8u) / 16u);
            row[x * 3 + 1] = (unsigned char)((g + 8u) / 16u);
            row[x * 3 + 2] = (unsigned char)((b + 8u) / 16u);
        }
        if (fwrite(row, 3, E2_PPM_W, f) != E2_PPM_W) goto fail;
    }
    if (fclose(f) != 0) return -1;
    return 0;
fail:
    fclose(f);
    return -1;
}

int main(void) {
    printf("=== vulkan-ps4 PS4 Triangle Test ===\n");

    /* Open breadcrumb log early so all ICD calls are traced */
    vk_ps4_log_open("/data/vk_ps4_breadcrumb.log");
    vk_ps4_log_raw("=== test_triangle_ps4 started ===");

    /* 1. Create instance */
    vk_ps4_log_raw("TEST: creating instance");
    VkInstanceCreateInfo inst_ci = {0};
    inst_ci.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO;
    VkInstance inst = VK_NULL_HANDLE;
    VkResult vr = vkCreateInstance(&inst_ci, NULL, &inst);
    if (vr != VK_SUCCESS) {
        printf("vkCreateInstance failed: %d\n", vr);
        vk_ps4_log("TEST: vkCreateInstance FAILED: %d", (int)vr);
        vk_ps4_log_close();
        return 1;
    }
    printf("Instance created OK\n");
    vk_ps4_log_raw("TEST: instance OK");

    /* 2. Enumerate physical device */
    uint32_t phys_count = 0;
    vkEnumeratePhysicalDevices(inst, &phys_count, NULL);
    if (phys_count == 0) {
        printf("No physical devices\n");
        vkDestroyInstance(inst, NULL);
        return 1;
    }
    VkPhysicalDevice phys = VK_NULL_HANDLE;
    vkEnumeratePhysicalDevices(inst, &phys_count, &phys);
    printf("Physical device: %u\n", phys_count);

    /* 3. Get queue family */
    uint32_t qf_count = 0;
    vkGetPhysicalDeviceQueueFamilyProperties(phys, &qf_count, NULL);
    VkQueueFamilyProperties qf[4] = {0};
    vkGetPhysicalDeviceQueueFamilyProperties(phys, &qf_count, qf);
    printf("Queue families: %u, family0: graphics=%d, count=%u\n",
           qf_count, !!(qf[0].queueFlags & VK_QUEUE_GRAPHICS_BIT), qf[0].queueCount);

    /* 4. Create device + queue */
    float queue_pri = 1.0f;
    VkDeviceQueueCreateInfo q_ci = {0};
    q_ci.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO;
    q_ci.queueFamilyIndex = 0;
    q_ci.queueCount = 1;
    q_ci.pQueuePriorities = &queue_pri;

    const char *dev_exts[] = { VK_KHR_SWAPCHAIN_EXTENSION_NAME };
    VkDeviceCreateInfo dev_ci = {0};
    dev_ci.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO;
    dev_ci.queueCreateInfoCount = 1;
    dev_ci.pQueueCreateInfos = &q_ci;
    dev_ci.enabledExtensionCount = 1;
    dev_ci.ppEnabledExtensionNames = dev_exts;

    VkDevice dev = VK_NULL_HANDLE;
    vk_ps4_log_raw("TEST: creating device");
    vr = vkCreateDevice(phys, &dev_ci, NULL, &dev);
    if (vr != VK_SUCCESS) {
        printf("vkCreateDevice failed: %d\n", vr);
        vk_ps4_log("TEST: vkCreateDevice FAILED: %d", (int)vr);
        vkDestroyInstance(inst, NULL);
        vk_ps4_log_close();
        return 1;
    }
    printf("Device created OK\n");
    vk_ps4_log_raw("TEST: device OK");

    VkQueue queue;
    vkGetDeviceQueue(dev, 0, 0, &queue);

    /* 5. Create swapchain */
    vk_ps4_log_raw("TEST: creating swapchain");
    VkSurfaceKHR surface = VK_NULL_HANDLE;
    /* On PS4, the swapchain creates the surface internally via sceVideoOut.
     * We pass VK_NULL_HANDLE as the surface — the ICD handles it. */
    VkSwapchainCreateInfoKHR sw_ci = {0};
    sw_ci.sType = VK_STRUCTURE_TYPE_SWAPCHAIN_CREATE_INFO_KHR;
    sw_ci.surface = surface;
    sw_ci.minImageCount = 2;
    sw_ci.imageFormat = VK_FORMAT_R8G8B8A8_UNORM;
    sw_ci.imageColorSpace = VK_COLOR_SPACE_SRGB_NONLINEAR_KHR;
    sw_ci.imageExtent.width = 1920;
    sw_ci.imageExtent.height = 1080;
    sw_ci.imageArrayLayers = 1;
    sw_ci.imageUsage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT |
                       VK_IMAGE_USAGE_TRANSFER_SRC_BIT;  /* E2 readback */
    sw_ci.imageSharingMode = VK_SHARING_MODE_EXCLUSIVE;
    sw_ci.preTransform = VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR;
    sw_ci.compositeAlpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
    sw_ci.presentMode = VK_PRESENT_MODE_FIFO_KHR;
    sw_ci.clipped = VK_TRUE;

    VkSwapchainKHR swapchain = VK_NULL_HANDLE;
    vr = vkCreateSwapchainKHR(dev, &sw_ci, NULL, &swapchain);
    if (vr != VK_SUCCESS) {
        printf("vkCreateSwapchainKHR failed: %d\n", vr);
        vk_ps4_log("TEST: vkCreateSwapchainKHR FAILED: %d", (int)vr);
        vkDestroyDevice(dev, NULL);
        vkDestroyInstance(inst, NULL);
        vk_ps4_log_close();
        return 1;
    }
    printf("Swapchain created OK (1920x1080)\n");
    vk_ps4_log_raw("TEST: swapchain OK");

    /* 6. Get swapchain images */
    uint32_t sw_img_count = 0;
    vkGetSwapchainImagesKHR(dev, swapchain, &sw_img_count, NULL);
    VkImage *sw_images = malloc(sw_img_count * sizeof(*sw_images));
    vkGetSwapchainImagesKHR(dev, swapchain, &sw_img_count, sw_images);
    printf("Swapchain images: %u\n", sw_img_count);

    /* 7. Create render pass */
    VkAttachmentDescription att = {0};
    att.format = VK_FORMAT_R8G8B8A8_UNORM;
    att.samples = VK_SAMPLE_COUNT_1_BIT;
    att.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
    att.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
    att.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    att.finalLayout = VK_IMAGE_LAYOUT_PRESENT_SRC_KHR;

    VkAttachmentReference ref = {0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
    VkSubpassDescription subpass = {0};
    subpass.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS;
    subpass.colorAttachmentCount = 1;
    subpass.pColorAttachments = &ref;

    VkRenderPassCreateInfo rp_ci = {0};
    rp_ci.sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO;
    rp_ci.attachmentCount = 1;
    rp_ci.pAttachments = &att;
    rp_ci.subpassCount = 1;
    rp_ci.pSubpasses = &subpass;

    VkRenderPass rp = VK_NULL_HANDLE;
    vkCreateRenderPass(dev, &rp_ci, NULL, &rp);
    printf("Render pass created OK\n");

    /* 8. Create image views + framebuffers */
    VkImageView *sw_views = malloc(sw_img_count * sizeof(*sw_views));
    VkFramebuffer *fbs = malloc(sw_img_count * sizeof(*fbs));
    for (uint32_t i = 0; i < sw_img_count; i++) {
        VkImageViewCreateInfo iv_ci = {0};
        iv_ci.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO;
        iv_ci.image = sw_images[i];
        iv_ci.viewType = VK_IMAGE_VIEW_TYPE_2D;
        iv_ci.format = VK_FORMAT_R8G8B8A8_UNORM;
        iv_ci.subresourceRange.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
        iv_ci.subresourceRange.levelCount = 1;
        iv_ci.subresourceRange.layerCount = 1;
        vkCreateImageView(dev, &iv_ci, NULL, &sw_views[i]);

        VkFramebufferCreateInfo fb_ci = {0};
        fb_ci.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO;
        fb_ci.renderPass = rp;
        fb_ci.attachmentCount = 1;
        fb_ci.pAttachments = &sw_views[i];
        fb_ci.width = 1920;
        fb_ci.height = 1080;
        fb_ci.layers = 1;
        vkCreateFramebuffer(dev, &fb_ci, NULL, &fbs[i]);
    }
    printf("Image views + framebuffers created OK\n");

    /* 9. Create vertex buffer */
    VkBuffer vbuf = VK_NULL_HANDLE;
    VkDeviceMemory vbuf_mem = VK_NULL_HANDLE;
#ifndef E2_GUEST_VID
    VkBufferCreateInfo vb_ci = {0};
    vb_ci.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
    vb_ci.size = sizeof(g_vertices);
    vb_ci.usage = VK_BUFFER_USAGE_VERTEX_BUFFER_BIT;
    vb_ci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;

    vkCreateBuffer(dev, &vb_ci, NULL, &vbuf);

    VkMemoryRequirements vbuf_mem_req;
    vkGetBufferMemoryRequirements(dev, vbuf, &vbuf_mem_req);

    VkMemoryAllocateInfo vbuf_mem_ai = {0};
    vbuf_mem_ai.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    vbuf_mem_ai.allocationSize = vbuf_mem_req.size;
    vbuf_mem_ai.memoryTypeIndex = 0;  /* Garlic (GPU-visible) */

    vkAllocateMemory(dev, &vbuf_mem_ai, NULL, &vbuf_mem);
    vkBindBufferMemory(dev, vbuf, vbuf_mem, 0);

    /* Copy vertex data */
    void *mapped = NULL;
    vkMapMemory(dev, vbuf_mem, 0, VK_WHOLE_SIZE, 0, &mapped);
    if (mapped) {
        memcpy(mapped, g_vertices, sizeof(g_vertices));
        vkUnmapMemory(dev, vbuf_mem);
    }
    printf("Vertex buffer created OK\n");
#else
    /* Variant A: no vertex buffer at all: positions come from gl_VertexIndex, so the
     * draw asks the vertex stage for no fetch shader. */
    printf("Variant A: no vertex buffer\n");
#endif /* E2_GUEST_VID */

    /* 9b. E2: readback buffer (memoryType 0 = Onion, host visible+coherent) */
    VkBufferCreateInfo rb_ci = {0};
    rb_ci.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO;
    rb_ci.size = E2_RB_BYTES;
    rb_ci.usage = VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    rb_ci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    VkBuffer rb_buf;
    vkCreateBuffer(dev, &rb_ci, NULL, &rb_buf);

    VkMemoryRequirements rb_req;
    vkGetBufferMemoryRequirements(dev, rb_buf, &rb_req);
    VkMemoryAllocateInfo rb_ai = {0};
    rb_ai.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO;
    rb_ai.allocationSize = rb_req.size;
    rb_ai.memoryTypeIndex = 0;
    VkDeviceMemory rb_mem;
    vkAllocateMemory(dev, &rb_ai, NULL, &rb_mem);
    vkBindBufferMemory(dev, rb_buf, rb_mem, 0);

    /* 10. Create shader modules */
    vk_ps4_log_raw("TEST: creating shader modules");
    VkShaderModuleCreateInfo vs_ci = {0};
    vs_ci.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    vs_ci.codeSize = sizeof(g_vert_spv);
    vs_ci.pCode = g_vert_spv;
    VkShaderModule vs_mod;
    vkCreateShaderModule(dev, &vs_ci, NULL, &vs_mod);

    VkShaderModuleCreateInfo fs_ci = {0};
    fs_ci.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO;
    fs_ci.codeSize = sizeof(g_frag_spv);
    fs_ci.pCode = g_frag_spv;
    VkShaderModule fs_mod;
    vkCreateShaderModule(dev, &fs_ci, NULL, &fs_mod);
    printf("Shader modules created OK\n");
    vk_ps4_log_raw("TEST: shader modules OK");

    /* 11. Create graphics pipeline */
    VkPipelineShaderStageCreateInfo stages[2] = {0};
    stages[0].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    stages[0].stage = VK_SHADER_STAGE_VERTEX_BIT;
    stages[0].module = vs_mod;
    stages[0].pName = "main";
    stages[1].sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;
    stages[1].stage = VK_SHADER_STAGE_FRAGMENT_BIT;
    stages[1].module = fs_mod;
    stages[1].pName = "main";

#ifndef E2_GUEST_VID
    VkVertexInputBindingDescription vibd = {0};
    vibd.binding = 0;
    vibd.stride = 5 * sizeof(float);
    vibd.inputRate = VK_VERTEX_INPUT_RATE_VERTEX;

    VkVertexInputAttributeDescription viads[2] = {0};
    viads[0].location = 0;
    viads[0].binding = 0;
    viads[0].format = VK_FORMAT_R32G32_SFLOAT;
    viads[0].offset = 0;
    viads[1].location = 1;
    viads[1].binding = 0;
    viads[1].format = VK_FORMAT_R32G32B32_SFLOAT;
    viads[1].offset = 2 * sizeof(float);

    VkPipelineVertexInputStateCreateInfo vii = {0};
    vii.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO;
    vii.vertexBindingDescriptionCount = 1;
    vii.pVertexBindingDescriptions = &vibd;
    vii.vertexAttributeDescriptionCount = 2;
    vii.pVertexAttributeDescriptions = viads;
#else
    /* Variant A: an empty vertex-input state is legal and binds no fetch shader. */
    VkPipelineVertexInputStateCreateInfo vii = {0};
    vii.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO;
#endif /* E2_GUEST_VID */

    VkPipelineInputAssemblyStateCreateInfo iai = {0};
    iai.sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO;
    iai.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST;

    VkViewport vp = {0, 0, 1920.0f, 1080.0f, 0.0f, 1.0f};
    VkRect2D sc = {{0, 0}, {1920, 1080}};
    VkPipelineViewportStateCreateInfo vpsi = {0};
    vpsi.sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO;
    vpsi.viewportCount = 1;
    vpsi.pViewports = &vp;
    vpsi.scissorCount = 1;
    vpsi.pScissors = &sc;

    VkPipelineRasterizationStateCreateInfo rsi = {0};
    rsi.sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO;
    rsi.polygonMode = VK_POLYGON_MODE_FILL;
    rsi.lineWidth = 1.0f;
    rsi.cullMode = VK_CULL_MODE_NONE;

    VkPipelineMultisampleStateCreateInfo msi = {0};
    msi.sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO;
    msi.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT;

    VkPipelineColorBlendAttachmentState cba = {0};
    cba.colorWriteMask = VK_COLOR_COMPONENT_R_BIT | VK_COLOR_COMPONENT_G_BIT |
                         VK_COLOR_COMPONENT_B_BIT | VK_COLOR_COMPONENT_A_BIT;
    VkPipelineColorBlendStateCreateInfo cbsi = {0};
    cbsi.sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO;
    cbsi.attachmentCount = 1;
    cbsi.pAttachments = &cba;

    VkPipelineLayoutCreateInfo pl_ci = {0};
    pl_ci.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO;
    VkPipelineLayout pl;
    vkCreatePipelineLayout(dev, &pl_ci, NULL, &pl);

    VkGraphicsPipelineCreateInfo gpci = {0};
    gpci.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO;
    gpci.stageCount = 2;
    gpci.pStages = stages;
    gpci.pVertexInputState = &vii;
    gpci.pInputAssemblyState = &iai;
    gpci.pViewportState = &vpsi;
    gpci.pRasterizationState = &rsi;
    gpci.pMultisampleState = &msi;
    gpci.pColorBlendState = &cbsi;
    gpci.layout = pl;
    gpci.renderPass = rp;
    gpci.subpass = 0;

    VkPipeline pipeline;
    vk_ps4_log_raw("TEST: creating graphics pipeline");
    vr = vkCreateGraphicsPipelines(dev, VK_NULL_HANDLE, 1, &gpci, NULL, &pipeline);
    if (vr != VK_SUCCESS) {
        printf("vkCreateGraphicsPipelines failed: %d\n", vr);
        vk_ps4_log("TEST: vkCreateGraphicsPipelines FAILED: %d", (int)vr);
    } else {
        printf("Pipeline created OK\n");
        vk_ps4_log_raw("TEST: pipeline OK");
    }

    /* 12. Create command pool + buffer */
    VkCommandPoolCreateInfo cp_ci = {0};
    cp_ci.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO;
    cp_ci.queueFamilyIndex = 0;
    VkCommandPool cmd_pool;
    vkCreateCommandPool(dev, &cp_ci, NULL, &cmd_pool);

    VkCommandBufferAllocateInfo cb_ai = {0};
    cb_ai.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO;
    cb_ai.commandPool = cmd_pool;
    cb_ai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    cb_ai.commandBufferCount = 1;
    VkCommandBuffer cmd;
    vkAllocateCommandBuffers(dev, &cb_ai, &cmd);

    /* 13. Create sync objects */
    VkSemaphoreCreateInfo sem_ci = {0};
    sem_ci.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO;
    VkSemaphore image_avail, render_done;
    vkCreateSemaphore(dev, &sem_ci, NULL, &image_avail);
    vkCreateSemaphore(dev, &sem_ci, NULL, &render_done);

    VkFenceCreateInfo fence_ci = {0};
    fence_ci.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO;
    fence_ci.flags = VK_FENCE_CREATE_SIGNALED_BIT;
    VkFence flight_fence;
    vkCreateFence(dev, &fence_ci, NULL, &flight_fence);

    /* 14. Render loop — 600 frames (~10 seconds at 60fps) then exit */
    printf("Starting render loop (600 frames)...\n");
    vk_ps4_log_raw("TEST: render loop start (600 frames)");
    for (int frame = 0; frame < 600; frame++) {
        vkWaitForFences(dev, 1, &flight_fence, VK_TRUE, 1000000000ULL);
        vkResetFences(dev, 1, &flight_fence);

        uint32_t img_idx = 0;
        vr = vkAcquireNextImageKHR(dev, swapchain, 1000000000ULL,
                                   image_avail, VK_NULL_HANDLE, &img_idx);
        if (vr != VK_SUCCESS) {
            printf("vkAcquireNextImageKHR failed: %d (frame %d)\n", vr, frame);
            vk_ps4_log("TEST: AcquireNextImage FAILED frame=%d vr=%d", frame, (int)vr);
            break;
        }

        VkCommandBufferBeginInfo cmd_bi = {0};
        cmd_bi.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO;
        vkBeginCommandBuffer(cmd, &cmd_bi);

        VkRenderPassBeginInfo rpbi = {0};
        rpbi.sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO;
        rpbi.renderPass = rp;
        rpbi.framebuffer = fbs[img_idx];
        rpbi.renderArea.offset = (VkOffset2D){0, 0};
        rpbi.renderArea.extent = (VkExtent2D){1920, 1080};
        VkClearValue clear = {0};
        clear.color.float32[0] = 0.1f;
        clear.color.float32[1] = 0.1f;
        clear.color.float32[2] = 0.2f;
        clear.color.float32[3] = 1.0f;
        rpbi.clearValueCount = 1;
        rpbi.pClearValues = &clear;

        vkCmdBeginRenderPass(cmd, &rpbi, VK_SUBPASS_CONTENTS_INLINE);
        vkCmdBindPipeline(cmd, VK_PIPELINE_BIND_POINT_GRAPHICS, pipeline);
#ifndef E2_GUEST_VID
        VkDeviceSize offset = 0;
        vkCmdBindVertexBuffers(cmd, 0, 1, &vbuf, &offset);
#endif
        vkCmdDraw(cmd, 3, 1, 0, 0);
        vkCmdEndRenderPass(cmd);

        /* E2: read back the swapchain image of frame E2_RB_FRAME. The image
         * is in PRESENT_SRC_KHR after the pass; the ICD treats swapchain
         * images as display-linear VideoOut buffers, so the copy is a
         * row-for-row linear DMA. */
        if (frame == E2_RB_FRAME) {
            VkBufferImageCopy rb_region = {0};
            rb_region.imageSubresource.aspectMask = VK_IMAGE_ASPECT_COLOR_BIT;
            rb_region.imageSubresource.layerCount = 1;
            rb_region.imageExtent.width = E2_W;
            rb_region.imageExtent.height = E2_H;
            rb_region.imageExtent.depth = 1;
            vkCmdCopyImageToBuffer(cmd, sw_images[img_idx],
                                   VK_IMAGE_LAYOUT_PRESENT_SRC_KHR,
                                   rb_buf, 1, &rb_region);
        }

        vkEndCommandBuffer(cmd);

        VkSubmitInfo submit = {0};
        submit.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO;
        submit.waitSemaphoreCount = 1;
        submit.pWaitSemaphores = &image_avail;
        VkPipelineStageFlags wait_stage = VK_PIPELINE_STAGE_COLOR_ATTACHMENT_OUTPUT_BIT;
        submit.pWaitDstStageMask = &wait_stage;
        submit.commandBufferCount = 1;
        submit.pCommandBuffers = &cmd;
        submit.signalSemaphoreCount = 1;
        submit.pSignalSemaphores = &render_done;

        vr = vkQueueSubmit(queue, 1, &submit, flight_fence);
        if (vr != VK_SUCCESS) {
            printf("vkQueueSubmit failed: %d (frame %d)\n", vr, frame);
            vk_ps4_log("TEST: QueueSubmit FAILED frame=%d vr=%d", frame, (int)vr);
            break;
        }

        VkPresentInfoKHR present = {0};
        present.sType = VK_STRUCTURE_TYPE_PRESENT_INFO_KHR;
        present.waitSemaphoreCount = 1;
        present.pWaitSemaphores = &render_done;
        present.swapchainCount = 1;
        present.pSwapchains = &swapchain;
        present.pImageIndices = &img_idx;

        vr = vkQueuePresentKHR(queue, &present);
        if (vr != VK_SUCCESS) {
            printf("vkQueuePresentKHR failed: %d (frame %d)\n", vr, frame);
            vk_ps4_log("TEST: QueuePresent FAILED frame=%d vr=%d", frame, (int)vr);
            break;
        }

        /* E2: after the frame is submitted and presented, map the readback
         * buffer, count pixels that differ from the clear colour
         * (0.1, 0.1, 0.2 -> 26, 26, 51 in UNORM8, +-2 for rounding), print
         * one marker line and exit the loop. */
        if (frame == E2_RB_FRAME) {
            vkDeviceWaitIdle(dev);
            void *px = NULL;
            unsigned nonblank = 0;
            vkMapMemory(dev, rb_mem, 0, VK_WHOLE_SIZE, 0, &px);
            if (px) {
                const unsigned char *p = (const unsigned char *)px;
                for (unsigned i = 0; i < E2_W * E2_H; i++) {
                    int dr = (int)p[i * 4 + 0] - 26;
                    int dg = (int)p[i * 4 + 1] - 26;
                    int db = (int)p[i * 4 + 2] - 51;
                    if (dr < -2 || dr > 2 || dg < -2 || dg > 2 || db < -2 || db > 2)
                        nonblank++;
                }
                /* E2 visual proof: the same frame, as a downscaled PPM the runner copies out. */
                printf("TN_PS4_E2 ppm %s write=%d\n", E2_PPM_PATH, e2_write_ppm(p));
                vkUnmapMemory(dev, rb_mem);
            }
            printf("TN_PS4_E2 pixels nonblank=%u of %u\n", nonblank, E2_W * E2_H);
            vk_ps4_log("TN_PS4_E2 pixels nonblank=%u of %u", nonblank, E2_W * E2_H);
            break;  /* E2: done after the readback frame */
        }

        if (frame % 60 == 0) {
            printf("  Frame %d OK\n", frame);
            vk_ps4_log("TEST: frame %d OK", frame);
        }
    }
    printf("Render loop done\n");
    vk_ps4_log_raw("TEST: render loop done");
    /* Hold the last presented frame until the harness stops the run, as E1 idles after its marker:
     * a guest that exits blanks the window before a late host capture (run-experiment.mjs judges
     * the last one), and how soon 600 frames end depends on the host's load. */
    printf("TN_PS4_E2 holding the last frame\n");
    for (;;)
        sceKernelUsleep(1000000);

    /* 15. Cleanup */
    vk_ps4_log_raw("TEST: cleanup start");
    vkDeviceWaitIdle(dev);
    vkDestroyFence(dev, flight_fence, NULL);
    vkDestroySemaphore(dev, image_avail, NULL);
    vkDestroySemaphore(dev, render_done, NULL);
    vkDestroyCommandPool(dev, cmd_pool, NULL);
    vkDestroyPipeline(dev, pipeline, NULL);
    vkDestroyPipelineLayout(dev, pl, NULL);
    vkDestroyShaderModule(dev, vs_mod, NULL);
    vkDestroyShaderModule(dev, fs_mod, NULL);
#ifndef E2_GUEST_VID
    vkFreeMemory(dev, vbuf_mem, NULL);
    vkDestroyBuffer(dev, vbuf, NULL);
#endif
    vkFreeMemory(dev, rb_mem, NULL);   /* E2 readback buffer */
    vkDestroyBuffer(dev, rb_buf, NULL);
    for (uint32_t i = 0; i < sw_img_count; i++) {
        vkDestroyFramebuffer(dev, fbs[i], NULL);
        vkDestroyImageView(dev, sw_views[i], NULL);
    }
    free(fbs);
    free(sw_views);
    free(sw_images);
    vkDestroyRenderPass(dev, rp, NULL);
    vkDestroySwapchainKHR(dev, swapchain, NULL);
    vkDestroyDevice(dev, NULL);
    vkDestroyInstance(inst, NULL);
    vk_ps4_log_raw("TEST: cleanup done");
    vk_ps4_log_close();

    printf("=== Test complete ===\n");
    return 0;
}
