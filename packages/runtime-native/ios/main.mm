#include "mystral/runtime.h"
#include "mystral/platform/input.h"
#include "mystral/platform/ui_overlay.h"

#include <SDL3/SDL_main.h>

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>

#include <cstdlib>
#include <cmath>
#include <fstream>
#include <sstream>
#include <string>

namespace {

std::string readFile(const std::string& path) {
    std::ifstream input(path, std::ios::binary);
    if (!input.is_open()) return {};
    std::ostringstream contents;
    contents << input.rdbuf();
    return contents.str();
}

std::string javascriptString(const std::string& value) {
    std::string escaped = "'";
    for (char character : value) {
        if (character == '\\' || character == '\'') escaped.push_back('\\');
        if (character == '\n') {
            escaped += "\\n";
        } else if (character != '\r') {
            escaped.push_back(character);
        }
    }
    return escaped + "'";
}

std::string mailboxRoot() {
    const char* configured = std::getenv("TN_PLAYTEST_MAILBOX_ROOT");
    if (configured != nullptr && configured[0] != '\0') return configured;
    NSArray<NSURL*>* directories = [[NSFileManager defaultManager]
        URLsForDirectory:NSDocumentDirectory inDomains:NSUserDomainMask];
    return directories.count == 0 ? std::string() : directories.firstObject.path.UTF8String;
}

void refreshIosSafeAreaInsets() {
    NSArray<UIScene*>* scenes = UIApplication.sharedApplication.connectedScenes.allObjects;
    for (UIScene* scene in scenes) {
        if (![scene isKindOfClass:[UIWindowScene class]]) continue;
        UIWindowScene* windowScene = (UIWindowScene*)scene;
        for (UIWindow* window in windowScene.windows) {
            if (!window.isKeyWindow && windowScene.windows.count > 1) continue;
            const UIEdgeInsets insets = window.safeAreaInsets;
            mystral::platform::setSafeAreaInsets(
                static_cast<int>(std::round(insets.top)),
                static_cast<int>(std::round(insets.right)),
                static_cast<int>(std::round(insets.bottom)),
                static_cast<int>(std::round(insets.left)));
            return;
        }
    }
}

}  // namespace

int main(int, char**) {
    @autoreleasepool {
        NSString* scriptPath = [[NSBundle mainBundle] pathForResource:@"native-smoke" ofType:@"js"];
        if (scriptPath == nil) {
            NSLog(@"TN_IOS_PROOF_FAILED: native-smoke.js is absent from the app bundle");
            return 2;
        }
        const std::string script = readFile(scriptPath.UTF8String);
        if (script.empty()) {
            NSLog(@"TN_IOS_PROOF_FAILED: native-smoke.js is empty or unreadable");
            return 2;
        }
        NSString* gamePath = [[[NSBundle mainBundle] resourceURL]
            URLByAppendingPathComponent:@"game" isDirectory:YES].path;
        const BOOL hasGameAssets = [[NSFileManager defaultManager] fileExistsAtPath:gamePath];
        if (hasGameAssets && ![[NSFileManager defaultManager] changeCurrentDirectoryPath:gamePath]) {
            NSLog(@"TN_IOS_PROOF_FAILED: packaged game asset directory is unreadable");
            return 2;
        }

        mystral::RuntimeConfig config;
        NSDictionary* info = NSBundle.mainBundle.infoDictionary;
        NSString* title = info[@"TNWindowTitle"] ?: info[@"CFBundleDisplayName"] ?: @"ThreeNative";
        const BOOL fullscreen = info[@"TNFullscreen"] == nil ? YES : [info[@"TNFullscreen"] boolValue];
        const BOOL keepScreenOn = [info[@"TNKeepScreenOn"] boolValue];
        [[UIApplication sharedApplication] setIdleTimerDisabled:keepScreenOn];
        config.width = 0;
        config.height = 0;
        config.title = title.UTF8String;
        config.fullscreen = fullscreen;
        config.maxFps = info[@"TNMaxFps"] == nil ? 60 : [info[@"TNMaxFps"] unsignedIntValue];
        config.resizable = false;
        refreshIosSafeAreaInsets();
        id safeAreaObserver = [[NSNotificationCenter defaultCenter]
            addObserverForName:UIDeviceOrientationDidChangeNotification
            object:nil
            queue:[NSOperationQueue mainQueue]
            usingBlock:^(__unused NSNotification* notification) {
                refreshIosSafeAreaInsets();
            }];
        auto runtime = mystral::Runtime::create(config);
        if (!runtime) {
            [[NSNotificationCenter defaultCenter] removeObserver:safeAreaObserver];
            NSLog(@"TN_IOS_PROOF_FAILED: runtime initialization failed");
            return 2;
        }

        NSString* renderer = info[@"TNUIRenderer"] ?: @"native";
        if (![renderer isEqualToString:@"native"] && ![renderer isEqualToString:@"web"]) {
            NSLog(@"TN_UI_RENDERER_INVALID: %@", renderer);
            [[NSNotificationCenter defaultCenter] removeObserver:safeAreaObserver];
            return 2;
        }
        if ([renderer isEqualToString:@"web"]) {
            NSString* uiRoot = [NSBundle.mainBundle.resourcePath stringByAppendingPathComponent:@"ui"];
            BOOL directory = NO;
            const BOOL hasIndex =
                [[NSFileManager defaultManager] fileExistsAtPath:[uiRoot stringByAppendingPathComponent:@"index.html"]
                                                     isDirectory:&directory];
            if (!hasIndex || directory) {
                NSLog(@"TN_UI_BUNDLE_MISSING: selected WebUI has no ui/index.html");
                [[NSNotificationCenter defaultCenter] removeObserver:safeAreaObserver];
                return 2;
            }
            if (!mystral::platform::attachIosUiOverlay(uiRoot.UTF8String)) {
                NSLog(@"TN_UI_OVERLAY_FAILED: selected WebUI could not attach");
                [[NSNotificationCenter defaultCenter] removeObserver:safeAreaObserver];
                return 2;
            }
        }

        const char* endpointValue = std::getenv("TN_PLAYTEST_ENDPOINT");
        const std::string endpoint = endpointValue == nullptr ? std::string() : endpointValue;
        const std::string root = mailboxRoot();
        if (!endpoint.empty()) {
            runtime->evalScript("globalThis.TN_PLAYTEST_ENDPOINT=" + javascriptString(endpoint) + ";",
                                "threenative-playtest-endpoint.js");
        }
        if (!root.empty()) {
            const std::string mailbox = "globalThis.TN_PLAYTEST_MAILBOX={request:" +
                javascriptString(root + "/tn-playtest-request.json") + ",response:" +
                javascriptString(root + "/tn-playtest-response.json") + "};";
            runtime->evalScript(mailbox, "threenative-playtest-mailbox.js");
        }
        NSLog(@"TN_IOS_GAME_EVAL");
        if (!runtime->evalScript(script, scriptPath.UTF8String)) {
            NSLog(@"TN_IOS_PROOF_FAILED: JavaScript evaluation failed");
            mystral::platform::detachIosUiOverlay();
            [[NSNotificationCenter defaultCenter] removeObserver:safeAreaObserver];
            return 2;
        }
        runtime->run();
        mystral::platform::detachIosUiOverlay();
        [[NSNotificationCenter defaultCenter] removeObserver:safeAreaObserver];
        return runtime->getExitCode();
    }
}
