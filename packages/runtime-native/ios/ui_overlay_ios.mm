#include "mystral/platform/ui_overlay.h"
#include "mystral/platform/window.h"
#include <SDL3/SDL.h>

#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

#include <string>
#include <vector>

/**
 * The UI layer on iOS — a transparent `WKWebView` composited over the game surface.
 *
 * Same shape as the Android host and the desktop one, and deliberately so: the page is served from
 * a real origin rather than `file://`, the bridge is a `MessagePort`-shaped channel, and the
 * interactive rectangles the page publishes decide which surface a touch belongs to. What differs
 * is only who provides each of those.
 *
 * - **Assets** come from a `WKURLSchemeHandler`, iOS's answer to `WebViewAssetLoader`. `file://`
 *   would work and would quietly stop `fetch` and module imports behaving as they do on web, which
 *   is the equivalence the whole PRD exists to keep.
 * - **The bridge** is `WKScriptMessageHandler` outbound and `evaluateJavaScript` inbound, calling
 *   the same `window.__tnUiReceive` every other host calls.
 * - **The hit test** is `hitTest:withEvent:`, overridden to return nil outside the published
 *   rectangles. UIKit then continues to the view behind — SDL's — which is the same rule Android
 *   gets from returning false out of `dispatchTouchEvent`, and the same rule X11 gets from an
 *   input shape. `pointer-events: none` is not the mechanism on any of the three.
 *
 * **Proof.** `scripts/verify-ios-simulator.mjs` launches a web-renderer variant of the smoke app and
 * judges the markers this file logs (`scripts/ios-webui-log.mjs`): attach, load, page ready, first
 * state, and the overlay frame against its parent. Simulator runs do not establish physical-device
 * input or presentation latency.
 */

namespace {

/** Must match `UI_BRIDGE_GLOBALS.uiHost` in @threenative/core/ui-layer. */
NSString* const kHostObject = @"tnHost";
/** Must match `HIT_REGIONS_MESSAGE`. */
NSString* const kHitRegions = @"tn:hit-regions";
/** Pageside diagnostics posted by the document-start probe; consumed by the host, never the game. */
NSString* const kUiDiagnostic = @"tn:ui-diagnostic";
/** The origin the UI is served from, chosen to look like the web build's rather than like a file. */
NSString* const kOrigin = @"threenative://localhost/";

/**
 * Document-start probe: the only page-side observability iOS has. iOS captures no WebView JS
 * console into console.json, so without this a bundle that never executes is a transparent view
 * over a working game with zero errors. The probe forwards `console.error`, `window.onerror`
 * and `unhandledrejection` plus one-shot `ready` (when `window.__tnUiReceive` is installed) and
 * `first-state` (when the host first calls it) to the existing `tnHost` message handler; the
 * host logs them as `TN_UI_PAGE` and never forwards them to the game.
 */
NSString* const kPageDiagnostics =
    @"(function(){var T='tn:ui-diagnostic';"
    @"var H=null;try{H=window.webkit.messageHandlers.tnHost;}catch(e){}"
    @"var ready=false,state=false,queue=[];"
    @"function send(o){var s;try{s=JSON.stringify(o);}catch(e){return;}"
    @"if(H&&H.postMessage){try{H.postMessage(s);return;}catch(e){}}queue.push(s);}"
    @"setInterval(function(){if(!queue.length)return;try{H=window.webkit.messageHandlers.tnHost;}catch(e){return;}"
    @"if(!H||!H.postMessage)return;while(queue.length){try{H.postMessage(queue.shift());}catch(e){return;}}},500);"
    @"function err(k,m,st){send({type:T,event:'error',kind:k,message:String(m),stack:String(st||'')});}"
    @"var ce=console.error;console.error=function(){try{err('console.error',"
    @"Array.prototype.map.call(arguments,function(a){try{return typeof a==='object'?JSON.stringify(a):String(a);}catch(e){return String(a);}}).join(' '),'');"
    @"}catch(e){}return ce.apply(console,arguments);};"
    @"window.addEventListener('error',function(e){try{err('onerror',e.message,(e.error&&e.error.stack)||'');}catch(x){}});"
    @"window.addEventListener('unhandledrejection',function(e){var r=e.reason;"
    @"try{err('unhandledrejection',(r&&r.message)||String(r),(r&&r.stack)||'');}catch(x){}});"
    @"function noteReady(){if(!ready){ready=true;send({type:T,event:'ready'});}}"
    @"function noteState(){if(!state){state=true;send({type:T,event:'first-state'});}}"
    @"var cur=window.__tnUiReceive;"
    @"function wrap(fn){return function(frame){try{noteState();}catch(e){}return fn.call(this,frame);};}"
    @"if(typeof cur==='function'){noteReady();try{window.__tnUiReceive=wrap(cur);}catch(e){}}"
    @"else{try{Object.defineProperty(window,'__tnUiReceive',{configurable:true,enumerable:true,"
    @"get:function(){return cur;},set:function(fn){cur=(typeof fn==='function')?wrap(fn):fn;noteReady();}});}"
    @"catch(e){var iv=setInterval(function(){if(typeof window.__tnUiReceive==='function'){clearInterval(iv);"
    @"noteReady();try{window.__tnUiReceive=wrap(window.__tnUiReceive);}catch(x){}}},50);}}})();";

static NSString* resolveUiFile(NSString* root, NSURL* url) {
    if (![url.scheme.lowercaseString isEqualToString:@"threenative"] ||
        ![url.host.lowercaseString isEqualToString:@"localhost"] || url.port != nil || url.user != nil ||
        url.password != nil)
        return nil;
    NSString* path = url.path;
    while ([path hasPrefix:@"/"])
        path = [path substringFromIndex:1];
    if (path.length == 0)
        path = @"index.html";
    NSString* resolvedRoot = root.stringByStandardizingPath.stringByResolvingSymlinksInPath;
    NSString* file =
        [resolvedRoot stringByAppendingPathComponent:path].stringByStandardizingPath.stringByResolvingSymlinksInPath;
    return [file hasPrefix:[resolvedRoot stringByAppendingString:@"/"]] ? file : nil;
}

}  // namespace

@interface TnUiSchemeHandler : NSObject <WKURLSchemeHandler>
@property(nonatomic, copy) NSString* root;
@end

@interface TnUiOverlayView : WKWebView
/** Published rectangles, normalized to the viewport, four floats each. */
@property(nonatomic, strong) NSArray<NSNumber*>* regions;
@end

@implementation TnUiSchemeHandler

- (void)dealloc {
    [_root release];
    [super dealloc];
}

- (void)webView:(WKWebView*)webView startURLSchemeTask:(id<WKURLSchemeTask>)task {
    NSString* file = resolveUiFile(self.root, task.request.URL);
    if (file == nil) {
        [task didFailWithError:[NSError errorWithDomain:@"TnUiOverlay" code:403 userInfo:nil]];
        return;
    }
    NSData* body = [NSData dataWithContentsOfFile:file];
    if (body == nil) {
        [task didFailWithError:[NSError errorWithDomain:@"TnUiOverlay" code:404 userInfo:nil]];
        return;
    }
    // An HTTP response, not a bare URL response. The packager emits Vite bundles whose
    // `index.html` carries `crossorigin` module scripts, and WebKit refuses a CORS-mode module
    // on a custom scheme whose response carries no `Access-Control-Allow-Origin` — the script
    // never executes, `__tnUiReceive` is never installed, yet `didFinishNavigation` still fires.
    // That is a blank page with no error anywhere iOS captures, exactly what CI showed.
    // Android never hits this: `WebViewAssetLoader` answers real HTTP semantics already.
    NSHTTPURLResponse* response = [[NSHTTPURLResponse alloc] initWithURL:task.request.URL
                                                              statusCode:200
                                                             HTTPVersion:@"HTTP/1.1"
                                                            headerFields:@{
        @"Content-Type" : [TnUiSchemeHandler mimeTypeFor:file],
        @"Content-Length" : [@(body.length) stringValue],
        @"Access-Control-Allow-Origin" : @"*",
    }];
    [task didReceiveResponse:response];
    [response release];
    [task didReceiveData:body];
    [task didFinish];
}

- (void)webView:(WKWebView*)webView stopURLSchemeTask:(id<WKURLSchemeTask>)task {
}

/** A wrong type here is a stylesheet the page silently ignores, so the common ones are named. */
+ (NSString*)mimeTypeFor:(NSString*)path {
    NSString* extension = path.pathExtension.lowercaseString;
    if ([extension isEqualToString:@"html"]) return @"text/html";
    if ([extension isEqualToString:@"js"] || [extension isEqualToString:@"mjs"]) return @"text/javascript";
    if ([extension isEqualToString:@"css"]) return @"text/css";
    if ([extension isEqualToString:@"json"] || [extension isEqualToString:@"map"]) return @"application/json";
    if ([extension isEqualToString:@"ico"]) return @"image/x-icon";
    if ([extension isEqualToString:@"woff"]) return @"font/woff";
    if ([extension isEqualToString:@"woff2"]) return @"font/woff2";
    if ([extension isEqualToString:@"ttf"]) return @"font/ttf";
    if ([extension isEqualToString:@"otf"]) return @"font/otf";
    if ([extension isEqualToString:@"svg"]) return @"image/svg+xml";
    if ([extension isEqualToString:@"png"]) return @"image/png";
    if ([extension isEqualToString:@"webp"]) return @"image/webp";
    if ([extension isEqualToString:@"woff2"]) return @"font/woff2";
    return @"application/octet-stream";
}

@end

@implementation TnUiOverlayView

- (void)dealloc {
    [_regions release];
    [super dealloc];
}

/**
 * The hit test, and the only place ownership is decided.
 *
 * Returning nil for a point outside every published rectangle makes UIKit continue to the view
 * behind this one — SDL's — and deliver the whole gesture there. Ownership therefore lands with
 * the first touch and stays, which is the rule a drag starting on the game needs in order not to
 * be stolen by a button it passes over.
 */
- (UIView*)hitTest:(CGPoint)point withEvent:(UIEvent*)event {
    if (self.regions.count < 4 || self.bounds.size.width <= 0 || self.bounds.size.height <= 0) {
        return nil;
    }
    const CGFloat x = point.x / self.bounds.size.width;
    const CGFloat y = point.y / self.bounds.size.height;
    for (NSUInteger index = 0; index + 3 < self.regions.count; index += 4) {
        const CGFloat left = self.regions[index].doubleValue;
        const CGFloat top = self.regions[index + 1].doubleValue;
        const CGFloat width = self.regions[index + 2].doubleValue;
        const CGFloat height = self.regions[index + 3].doubleValue;
        if (x < left || y < top || x > left + width || y > top + height) continue;
        return [super hitTest:point withEvent:event];
    }
    return nil;
}

@end

@interface TnUiOverlayBridge : NSObject <WKScriptMessageHandler, WKNavigationDelegate>
@property(nonatomic, assign) TnUiOverlayView* overlay;
@end

@implementation TnUiOverlayBridge

- (void)userContentController:(WKUserContentController*)controller
      didReceiveScriptMessage:(WKScriptMessage*)message {
    if (![message.body isKindOfClass:[NSString class]]) return;
    NSString* frame = (NSString*)message.body;
    if ([frame containsString:kUiDiagnostic]) {
        [self reportPageDiagnostic:frame];
        return;
    }
    if ([frame containsString:kHitRegions]) {
        [self applyHitRegions:frame];
        return;
    }
    mystral::platform::queueUiMessage(frame.UTF8String);
}

/**
 * Page diagnostics from the document-start probe. Ready and first-state are plain `TN_UI_PAGE`
 * lines for the next CI run to assert on; an error carries the `[error]` marker so the playtest
 * console classification files it as an error and the run fails with the page's own message.
 * Diagnostics stop here: forwarding them to the game would hand it frames outside the bridge
 * contract, and a diagnostic the host cannot parse is itself the news, so it logs as an error.
 */
- (void)reportPageDiagnostic:(NSString*)frame {
    NSString* event = nil;
    NSDictionary* parsed = [NSJSONSerialization
        JSONObjectWithData:[frame dataUsingEncoding:NSUTF8StringEncoding]
                   options:0
                     error:nil];
    if ([parsed isKindOfClass:[NSDictionary class]] &&
        [parsed[@"type"] isEqualToString:kUiDiagnostic] &&
        [parsed[@"event"] isKindOfClass:[NSString class]]) {
        event = parsed[@"event"];
    }
    if ([event isEqualToString:@"error"] || event == nil) {
        NSLog(@"TN_UI_PAGE [error]: %@", frame);
    } else {
        NSLog(@"TN_UI_PAGE:%@", frame);
    }
}

/**
 * Load observability. iOS captures no WebView JS console into console.json, so without these a
 * missing bundle, a 404 from the scheme handler, or a module that never parses is a transparent
 * view over a working game with zero errors — exactly the failure that was shipped. One CI run
 * now discriminates: `loaded:true` plus the frame, or `loaded:false` plus the reason.
 */
- (void)webView:(WKWebView*)webView didFinishNavigation:(WKNavigation*)navigation {
    (void)navigation;
    NSLog(@"TN_UI_OVERLAY:{\"loaded\":true,\"frame\":\"%@\",\"parent\":\"%@\"}",
          NSStringFromCGRect(webView.frame), NSStringFromCGRect(webView.superview.bounds));
}

- (void)webView:(WKWebView*)webView
    didFailProvisionalNavigation:(WKNavigation*)navigation
                       withError:(NSError*)error {
    (void)webView;
    (void)navigation;
    NSLog(@"TN_UI_OVERLAY:{\"loaded\":false,\"error\":\"%@ %ld\"}", error.domain, (long)error.code);
}

- (void)webView:(WKWebView*)webView
    didFailNavigation:(WKNavigation*)navigation
            withError:(NSError*)error {
    (void)webView;
    (void)navigation;
    NSLog(@"TN_UI_OVERLAY:{\"loaded\":false,\"error\":\"%@ %ld\"}", error.domain, (long)error.code);
}

/**
 * Hit regions stop here: the host owns the hit test, and sending them on to the game would add a
 * hop to the input path for no reader. Same rule as the Android and desktop hosts.
 */
- (void)applyHitRegions:(NSString*)frame {
    NSError* error = nil;
    NSDictionary* parsed = [NSJSONSerialization
        JSONObjectWithData:[frame dataUsingEncoding:NSUTF8StringEncoding]
                   options:0
                     error:&error];
    NSArray* published = parsed[@"regions"];
    if (error != nil || ![published isKindOfClass:[NSArray class]]) {
        // Fail closed and loudly. Quietly ignoring a malformed publication leaves the previous
        // snapshot in place and decides every later touch against rectangles that no longer exist.
        NSLog(@"TN_UI_HIT_REGIONS_MALFORMED: %@", frame);
        return;
    }
    NSMutableArray<NSNumber*>* flat = [NSMutableArray arrayWithCapacity:published.count * 4];
    for (NSDictionary* region in published) {
        [flat addObject:region[@"x"] ?: @0];
        [flat addObject:region[@"y"] ?: @0];
        [flat addObject:region[@"width"] ?: @0];
        [flat addObject:region[@"height"] ?: @0];
    }
    self.overlay.regions = flat;
}

@end

namespace {

TnUiOverlayView* g_overlay = nil;
/**
 * The bridge outlives the configuration object it was registered on: `attach` releases that
 * object, and whether the web view's own copy shares or copies the user-content controller is
 * WebKit's business. One explicit retain, balanced in detach, so the delegate and the message
 * handler can never dangle.
 */
TnUiOverlayBridge* g_bridge = nil;
/** Whether the current overlay has delivered state yet; reset on every attach. */
bool g_uiFirstStateLogged = false;

}  // namespace

namespace mystral {
namespace platform {

bool attachIosUiOverlay(const std::string& uiRoot) {
    if (![NSThread isMainThread]) {
        NSLog(@"TN_UI_OVERLAY_FAILED: UIKit requires the main thread");
        return false;
    }
    SDL_Window* sdlWindow = getSDLWindow();
    UIWindow* window = sdlWindow == nullptr
                           ? nil
                           : (UIWindow*)SDL_GetPointerProperty(SDL_GetWindowProperties(sdlWindow),
                                                               SDL_PROP_WINDOW_UIKIT_WINDOW_POINTER, nullptr);
    UIView* parent = window.rootViewController.view;
    if (parent == nil) {
        NSLog(@"TN_UI_OVERLAY:{\"attached\":false,\"reason\":\"no SDL UIKit view\"}");
        return false;
    }

    WKWebViewConfiguration* configuration = [[WKWebViewConfiguration alloc] init];
    TnUiSchemeHandler* handler = [[TnUiSchemeHandler alloc] init];
    handler.root = [NSString stringWithUTF8String:uiRoot.c_str()];
    [configuration setURLSchemeHandler:handler forURLScheme:@"threenative"];

    // Registered BEFORE the web view exists. The web view copies its configuration at init, so a
    // handler added to the original object afterwards never reaches the page: then
    // `webkit.messageHandlers.tnHost` is undefined there, core finds no outbound channel, falls
    // back to the in-process broker, never installs `window.__tnUiReceive`, and the page mirrors
    // no state — a transparent view over a working game, with no error anywhere. That was the
    // shipped order, and the invisible overlay it produced.
    TnUiOverlayBridge* bridge = [[TnUiOverlayBridge alloc] init];
    [configuration.userContentController addScriptMessageHandler:bridge name:kHostObject];
    // Document-start, so the probe is in place before any page script runs. Added here for the
    // same reason as the message handler: the web view copies its configuration at init.
    WKUserScript* probe = [[WKUserScript alloc] initWithSource:kPageDiagnostics
                                                injectionTime:WKUserScriptInjectionTimeAtDocumentStart
                                             forMainFrameOnly:NO];
    [configuration.userContentController addUserScript:probe];
    [probe release];

    TnUiOverlayView* overlay = [[TnUiOverlayView alloc] initWithFrame:parent.bounds configuration:configuration];
    if (overlay == nil) {
        [bridge release];
        [handler release];
        [configuration release];
        return false;
    }
    bridge.overlay = overlay;
    overlay.navigationDelegate = bridge;

    overlay.opaque = NO;
    overlay.backgroundColor = UIColor.clearColor;
    overlay.scrollView.backgroundColor = UIColor.clearColor;
    overlay.scrollView.scrollEnabled = NO;
    // Pinned to the parent, not sized from it. `parent.bounds` at attach time predates first
    // layout — CI showed a landscape frame on a portrait app — and an autoresizing mask only
    // follows if the parent lays its subviews out again, which SDL's root view did not do before
    // the page finished loading. Constraints follow every layout pass instead.
    overlay.translatesAutoresizingMaskIntoConstraints = NO;
    // `addSubview:` puts the overlay above SDL's view; nothing later adds a sibling above it.
    [parent addSubview:overlay];
    [NSLayoutConstraint activateConstraints:@[
        [overlay.topAnchor constraintEqualToAnchor:parent.topAnchor],
        [overlay.leadingAnchor constraintEqualToAnchor:parent.leadingAnchor],
        [overlay.trailingAnchor constraintEqualToAnchor:parent.trailingAnchor],
        [overlay.bottomAnchor constraintEqualToAnchor:parent.bottomAnchor],
    ]];
    [overlay loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:
        [kOrigin stringByAppendingString:@"index.html"]]]];

    g_overlay = overlay;
    g_bridge = bridge;
    g_uiFirstStateLogged = false;
    [handler release];
    [configuration release];
    setUiOverlayAttached(true);
    NSLog(@"TN_UI_OVERLAY:{\"attached\":true}");
    return true;
}

void detachIosUiOverlay() {
    NSCAssert([NSThread isMainThread], @"UIKit requires the main thread");
    [g_overlay.configuration.userContentController removeScriptMessageHandlerForName:kHostObject];
    [g_overlay removeFromSuperview];
    [g_overlay release];
    g_overlay = nil;
    [g_bridge release];
    g_bridge = nil;
    setUiOverlayAttached(false);
}

/** Deliver one bridge frame to the page, through the global every host calls. */
bool postIosUiMessage(const std::string& frame) {
    NSCAssert([NSThread isMainThread], @"WebKit requires the main thread");
    if (g_overlay == nil) return false;
    if (!g_uiFirstStateLogged) {
        g_uiFirstStateLogged = true;
        // The frame at first state delivery, next to the one at navigation finish: together they
        // say whether the overlay tracked the parent through rotation or froze at attach size.
        NSLog(@"TN_UI_OVERLAY:{\"firstState\":true,\"frame\":\"%@\",\"parent\":\"%@\"}",
              NSStringFromCGRect(g_overlay.frame), NSStringFromCGRect(g_overlay.superview.bounds));
    }
    @autoreleasepool {
        NSString* payload = [NSString stringWithUTF8String:frame.c_str()];
        NSData* quoted = [NSJSONSerialization dataWithJSONObject:@[ payload ] options:0 error:nil];
        NSString* literal = [[[NSString alloc] initWithData:quoted encoding:NSUTF8StringEncoding] autorelease];
        // `[frame]` minus its brackets is the JSON string literal, so a quote or a newline in the
        // payload cannot end the expression.
        NSString* inner = [literal substringWithRange:NSMakeRange(1, literal.length - 2)];
        NSString* script = [NSString stringWithFormat:@"window.__tnUiReceive && window.__tnUiReceive(%@)", inner];
        [g_overlay evaluateJavaScript:script completionHandler:nil];
    }
    return true;
}

}  // namespace platform
}  // namespace mystral
