/**
 * Canvas 2D JavaScript Bindings
 *
 * Creates JavaScript objects that wrap native Canvas2DContext.
 * This exposes the CanvasRenderingContext2D API to JavaScript.
 */

#include "mystral/canvas/canvas2d.h"
#include "mystral/js/engine.h"
#include "runtime_scripts.h"
#include <iostream>
#include <string>
#include <string_view>
#include <cmath>

namespace mystral {
namespace canvas {

static bool evalCanvasScript(js::Engine& engine, runtime_scripts::Script name, const char* filename) {
    const auto script = runtime_scripts::require(name);
    const std::string source(script.data, script.size);
    if (!engine.eval(source.c_str(), filename)) {
        std::cerr << "[Canvas2D] Failed to evaluate " << filename << ": "
                  << engine.getException() << std::endl;
        return false;
    }
    return true;
}

/**
 * Create a CanvasRenderingContext2D JS object that wraps a native Canvas2DContext
 *
 * IMPORTANT: Each method captures the native context pointer in its closure,
 * allowing multiple canvas contexts to work independently. This fixes the bug
 * where a global __canvas2dContext variable was used, causing only the last
 * created canvas to work.
 */
js::JSValueHandle createCanvas2DJSObject(js::Engine* engine, Canvas2DContext* ctx) {
    auto jsCtx = engine->newObject();

    // Store the native context pointer
    engine->setPrivateData(jsCtx, ctx);

    // Mark the type
    engine->setProperty(jsCtx, "_contextType", engine->newString("2d"));

    // Capture the native context pointer for use in all method closures
    // This ensures each canvas context object has methods that use its own context
    Canvas2DContext* capturedCtx = ctx;

    // ========================================================================
    // Properties (as getter functions for now)
    // ========================================================================

    // canvas property (will be set by caller)
    engine->setProperty(jsCtx, "canvas", engine->newNull());

    // fillStyle
    engine->setProperty(jsCtx, "fillStyle", engine->newString("#000000"));
    engine->setProperty(jsCtx, "_setFillStyle",
        engine->newFunction("_setFillStyle", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && !args.empty()) {
                capturedCtx->setFillStyle(engine->toString(args[0]));
            }
            return engine->newUndefined();
        })
    );

    // strokeStyle
    engine->setProperty(jsCtx, "strokeStyle", engine->newString("#000000"));
    engine->setProperty(jsCtx, "_setStrokeStyle",
        engine->newFunction("_setStrokeStyle", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && !args.empty()) {
                capturedCtx->setStrokeStyle(engine->toString(args[0]));
            }
            return engine->newUndefined();
        })
    );

    // lineWidth
    engine->setProperty(jsCtx, "lineWidth", engine->newNumber(1.0));
    engine->setProperty(jsCtx, "_setLineWidth",
        engine->newFunction("_setLineWidth", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && !args.empty()) {
                capturedCtx->setLineWidth(static_cast<float>(engine->toNumber(args[0])));
            }
            return engine->newUndefined();
        })
    );

    // globalAlpha
    engine->setProperty(jsCtx, "globalAlpha", engine->newNumber(1.0));
    engine->setProperty(jsCtx, "_setGlobalAlpha",
        engine->newFunction("_setGlobalAlpha", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && !args.empty()) {
                capturedCtx->setGlobalAlpha(static_cast<float>(engine->toNumber(args[0])));
            }
            return engine->newUndefined();
        })
    );

    // font
    engine->setProperty(jsCtx, "font", engine->newString("10px sans-serif"));
    engine->setProperty(jsCtx, "_setFont",
        engine->newFunction("_setFont", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && !args.empty()) {
                capturedCtx->setFont(engine->toString(args[0]));
            }
            return engine->newUndefined();
        })
    );

    // textAlign
    engine->setProperty(jsCtx, "textAlign", engine->newString("start"));
    engine->setProperty(jsCtx, "_setTextAlign",
        engine->newFunction("_setTextAlign", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && !args.empty()) {
                capturedCtx->setTextAlign(engine->toString(args[0]));
            }
            return engine->newUndefined();
        })
    );

    // textBaseline
    engine->setProperty(jsCtx, "textBaseline", engine->newString("alphabetic"));
    engine->setProperty(jsCtx, "_setTextBaseline",
        engine->newFunction("_setTextBaseline", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && !args.empty()) {
                capturedCtx->setTextBaseline(engine->toString(args[0]));
            }
            return engine->newUndefined();
        })
    );

    // ========================================================================
    // Methods - all capture the native context pointer in their closure
    // ========================================================================

    // save()
    engine->setProperty(jsCtx, "save",
        engine->newFunction("save", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx) capturedCtx->save();
            return engine->newUndefined();
        })
    );

    // restore()
    engine->setProperty(jsCtx, "restore",
        engine->newFunction("restore", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx) capturedCtx->restore();
            return engine->newUndefined();
        })
    );

    // fillText(text, x, y)
    engine->setProperty(jsCtx, "fillText",
        engine->newFunction("fillText", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 3) {
                std::string text = engine->toString(args[0]);
                float x = static_cast<float>(engine->toNumber(args[1]));
                float y = static_cast<float>(engine->toNumber(args[2]));
                capturedCtx->fillText(text, x, y);
            }
            return engine->newUndefined();
        })
    );

    // strokeText(text, x, y)
    engine->setProperty(jsCtx, "strokeText",
        engine->newFunction("strokeText", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 3) {
                std::string text = engine->toString(args[0]);
                float x = static_cast<float>(engine->toNumber(args[1]));
                float y = static_cast<float>(engine->toNumber(args[2]));
                capturedCtx->strokeText(text, x, y);
            }
            return engine->newUndefined();
        })
    );

    // measureText(text) -> { width }
    engine->setProperty(jsCtx, "measureText",
        engine->newFunction("measureText", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            auto result = engine->newObject();
            if (capturedCtx && !args.empty()) {
                std::string text = engine->toString(args[0]);
                TextMetrics metrics = capturedCtx->measureText(text);

                engine->setProperty(result, "width", engine->newNumber(metrics.width));
                engine->setProperty(result, "actualBoundingBoxLeft", engine->newNumber(metrics.actualBoundingBoxLeft));
                engine->setProperty(result, "actualBoundingBoxRight", engine->newNumber(metrics.actualBoundingBoxRight));
                engine->setProperty(result, "actualBoundingBoxAscent", engine->newNumber(metrics.actualBoundingBoxAscent));
                engine->setProperty(result, "actualBoundingBoxDescent", engine->newNumber(metrics.actualBoundingBoxDescent));
                engine->setProperty(result, "fontBoundingBoxAscent", engine->newNumber(metrics.fontBoundingBoxAscent));
                engine->setProperty(result, "fontBoundingBoxDescent", engine->newNumber(metrics.fontBoundingBoxDescent));
            } else {
                engine->setProperty(result, "width", engine->newNumber(0));
            }
            return result;
        })
    );

    // fillRect(x, y, width, height)
    engine->setProperty(jsCtx, "fillRect",
        engine->newFunction("fillRect", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 4) {
                capturedCtx->fillRect(
                    static_cast<float>(engine->toNumber(args[0])),
                    static_cast<float>(engine->toNumber(args[1])),
                    static_cast<float>(engine->toNumber(args[2])),
                    static_cast<float>(engine->toNumber(args[3]))
                );
            }
            return engine->newUndefined();
        })
    );

    // strokeRect(x, y, width, height)
    engine->setProperty(jsCtx, "strokeRect",
        engine->newFunction("strokeRect", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 4) {
                capturedCtx->strokeRect(
                    static_cast<float>(engine->toNumber(args[0])),
                    static_cast<float>(engine->toNumber(args[1])),
                    static_cast<float>(engine->toNumber(args[2])),
                    static_cast<float>(engine->toNumber(args[3]))
                );
            }
            return engine->newUndefined();
        })
    );

    // clearRect(x, y, width, height)
    engine->setProperty(jsCtx, "clearRect",
        engine->newFunction("clearRect", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 4) {
                capturedCtx->clearRect(
                    static_cast<float>(engine->toNumber(args[0])),
                    static_cast<float>(engine->toNumber(args[1])),
                    static_cast<float>(engine->toNumber(args[2])),
                    static_cast<float>(engine->toNumber(args[3]))
                );
            }
            return engine->newUndefined();
        })
    );

    // beginPath()
    engine->setProperty(jsCtx, "beginPath",
        engine->newFunction("beginPath", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx) capturedCtx->beginPath();
            return engine->newUndefined();
        })
    );

    // closePath()
    engine->setProperty(jsCtx, "closePath",
        engine->newFunction("closePath", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx) capturedCtx->closePath();
            return engine->newUndefined();
        })
    );

    // moveTo(x, y)
    engine->setProperty(jsCtx, "moveTo",
        engine->newFunction("moveTo", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 2) {
                capturedCtx->moveTo(
                    static_cast<float>(engine->toNumber(args[0])),
                    static_cast<float>(engine->toNumber(args[1]))
                );
            }
            return engine->newUndefined();
        })
    );

    // lineTo(x, y)
    engine->setProperty(jsCtx, "lineTo",
        engine->newFunction("lineTo", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 2) {
                capturedCtx->lineTo(
                    static_cast<float>(engine->toNumber(args[0])),
                    static_cast<float>(engine->toNumber(args[1]))
                );
            }
            return engine->newUndefined();
        })
    );

    // quadraticCurveTo(cpx, cpy, x, y)
    engine->setProperty(jsCtx, "quadraticCurveTo",
        engine->newFunction("quadraticCurveTo", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 4) {
                capturedCtx->quadraticCurveTo(
                    static_cast<float>(engine->toNumber(args[0])),
                    static_cast<float>(engine->toNumber(args[1])),
                    static_cast<float>(engine->toNumber(args[2])),
                    static_cast<float>(engine->toNumber(args[3]))
                );
            }
            return engine->newUndefined();
        })
    );

    // bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y)
    engine->setProperty(jsCtx, "bezierCurveTo",
        engine->newFunction("bezierCurveTo", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 6) {
                capturedCtx->bezierCurveTo(
                    static_cast<float>(engine->toNumber(args[0])),
                    static_cast<float>(engine->toNumber(args[1])),
                    static_cast<float>(engine->toNumber(args[2])),
                    static_cast<float>(engine->toNumber(args[3])),
                    static_cast<float>(engine->toNumber(args[4])),
                    static_cast<float>(engine->toNumber(args[5]))
                );
            }
            return engine->newUndefined();
        })
    );

    // arc(x, y, radius, startAngle, endAngle, counterclockwise)
    engine->setProperty(jsCtx, "arc",
        engine->newFunction("arc", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 5) {
                bool ccw = args.size() > 5 ? engine->toBoolean(args[5]) : false;
                capturedCtx->arc(
                    static_cast<float>(engine->toNumber(args[0])),
                    static_cast<float>(engine->toNumber(args[1])),
                    static_cast<float>(engine->toNumber(args[2])),
                    static_cast<float>(engine->toNumber(args[3])),
                    static_cast<float>(engine->toNumber(args[4])),
                    ccw
                );
            }
            return engine->newUndefined();
        })
    );

    // ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise)
    engine->setProperty(jsCtx, "ellipse",
        engine->newFunction("ellipse", [engine, capturedCtx](void*, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 7) {
                float values[7];
                for (size_t i = 0; i < 7; ++i) {
                    values[i] = static_cast<float>(engine->toNumber(args[i]));
                    if (!std::isfinite(values[i])) return engine->newUndefined();
                }
                if (values[2] < 0 || values[3] < 0) {
                    engine->throwException("IndexSizeError: ellipse radii must be non-negative");
                    return engine->newUndefined();
                }
                capturedCtx->ellipse(values[0], values[1], values[2], values[3], values[4],
                                     values[5], values[6], args.size() > 7 && engine->toBoolean(args[7]));
            }
            return engine->newUndefined();
        })
    );

    // fill()
    engine->setProperty(jsCtx, "fill",
        engine->newFunction("fill", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx) capturedCtx->fill();
            return engine->newUndefined();
        })
    );

    // stroke()
    engine->setProperty(jsCtx, "stroke",
        engine->newFunction("stroke", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx) capturedCtx->stroke();
            return engine->newUndefined();
        })
    );

    // getImageData(x, y, width, height) -> ImageData
    engine->setProperty(jsCtx, "getImageData",
        engine->newFunction("getImageData", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            auto result = engine->newObject();
            if (capturedCtx && args.size() >= 4) {
                int x = static_cast<int>(engine->toNumber(args[0]));
                int y = static_cast<int>(engine->toNumber(args[1]));
                int w = static_cast<int>(engine->toNumber(args[2]));
                int h = static_cast<int>(engine->toNumber(args[3]));

                ImageData imgData = capturedCtx->getImageData(x, y, w, h);

                engine->setProperty(result, "width", engine->newNumber(imgData.width));
                engine->setProperty(result, "height", engine->newNumber(imgData.height));

                // Create Uint8Array for data (ImageData.data is Uint8ClampedArray in browsers)
                // Using Uint8Array allows direct indexing with []
                auto dataArray = engine->createUint8Array(imgData.data.data(), imgData.data.size());
                engine->setProperty(result, "data", dataArray);
            }
            return result;
        })
    );

    // putImageData(imageData, x, y)
    engine->setProperty(jsCtx, "putImageData",
        engine->newFunction("putImageData", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 3) {
                auto imageDataObj = args[0];
                int x = static_cast<int>(engine->toNumber(args[1]));
                int y = static_cast<int>(engine->toNumber(args[2]));

                // Extract ImageData properties
                int width = static_cast<int>(engine->toNumber(engine->getProperty(imageDataObj, "width")));
                int height = static_cast<int>(engine->toNumber(engine->getProperty(imageDataObj, "height")));
                auto dataHandle = engine->getProperty(imageDataObj, "data");

                // Get the data array
                size_t dataSize = 0;
                void* dataPtr = engine->getArrayBufferData(dataHandle, &dataSize);

                if (dataPtr && dataSize > 0) {
                    ImageData imgData;
                    imgData.width = width;
                    imgData.height = height;
                    imgData.data.assign(static_cast<uint8_t*>(dataPtr),
                                       static_cast<uint8_t*>(dataPtr) + dataSize);
                    capturedCtx->putImageData(imgData, x, y);
                }
            }
            return engine->newUndefined();
        })
    );

    // createImageData(width, height) -> ImageData
    engine->setProperty(jsCtx, "createImageData",
        engine->newFunction("createImageData", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            auto result = engine->newObject();
            if (args.size() >= 2) {
                int width = static_cast<int>(engine->toNumber(args[0]));
                int height = static_cast<int>(engine->toNumber(args[1]));

                engine->setProperty(result, "width", engine->newNumber(width));
                engine->setProperty(result, "height", engine->newNumber(height));

                // Create Uint8Array filled with zeros (transparent black)
                size_t dataSize = width * height * 4;
                std::vector<uint8_t> data(dataSize, 0);
                auto dataArray = engine->createUint8Array(data.data(), data.size());
                engine->setProperty(result, "data", dataArray);
            }
            return result;
        })
    );

    // drawImage - draws another canvas or image onto this canvas
    // Supports: drawImage(image, dx, dy)
    //           drawImage(image, dx, dy, dWidth, dHeight)
    //           drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
    engine->setProperty(jsCtx, "drawImage",
        engine->newFunction("drawImage", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (!capturedCtx || args.empty()) {
                return engine->newUndefined();
            }

            auto imageArg = args[0];

            // Check if it's a canvas element (has getContext method and _context2d)
            auto context2d = engine->getProperty(imageArg, "_context2d");
            if (!engine->isUndefined(context2d) && !engine->isNull(context2d)) {
                // It's a canvas element, get its Canvas2DContext
                Canvas2DContext* sourceCtx = static_cast<Canvas2DContext*>(engine->getPrivateData(context2d));
                if (sourceCtx) {
                    // Get source canvas dimensions
                    int srcWidth = sourceCtx->getWidth();
                    int srcHeight = sourceCtx->getHeight();

                    // Get the pixel data from source canvas
                    ImageData srcData = sourceCtx->getImageData(0, 0, srcWidth, srcHeight);

                    if (args.size() == 3) {
                        // drawImage(image, dx, dy)
                        int dx = static_cast<int>(engine->toNumber(args[1]));
                        int dy = static_cast<int>(engine->toNumber(args[2]));
                        capturedCtx->putImageData(srcData, dx, dy);
                    } else if (args.size() == 5) {
                        // drawImage(image, dx, dy, dWidth, dHeight) - scaled
                        // For now, just use putImageData without scaling
                        // TODO: Implement scaling
                        int dx = static_cast<int>(engine->toNumber(args[1]));
                        int dy = static_cast<int>(engine->toNumber(args[2]));
                        capturedCtx->putImageData(srcData, dx, dy);
                    } else if (args.size() >= 9) {
                        // drawImage(image, sx, sy, sWidth, sHeight, dx, dy, dWidth, dHeight)
                        int sx = static_cast<int>(engine->toNumber(args[1]));
                        int sy = static_cast<int>(engine->toNumber(args[2]));
                        int sWidth = static_cast<int>(engine->toNumber(args[3]));
                        int sHeight = static_cast<int>(engine->toNumber(args[4]));
                        int dx = static_cast<int>(engine->toNumber(args[5]));
                        int dy = static_cast<int>(engine->toNumber(args[6]));
                        // dWidth and dHeight for scaling (ignored for now)

                        // Get sub-region of source
                        ImageData subData = sourceCtx->getImageData(sx, sy, sWidth, sHeight);
                        capturedCtx->putImageData(subData, dx, dy);
                    }
                }
            }
            // TODO: Support HTMLImageElement and ImageBitmap

            return engine->newUndefined();
        })
    );

    // Transform methods for PixiJS font rendering

    // scale(x, y)
    engine->setProperty(jsCtx, "scale",
        engine->newFunction("scale", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 2) {
                capturedCtx->scale(
                    static_cast<float>(engine->toNumber(args[0])),
                    static_cast<float>(engine->toNumber(args[1]))
                );
            }
            return engine->newUndefined();
        })
    );

    // rotate(angle)
    engine->setProperty(jsCtx, "rotate",
        engine->newFunction("rotate", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 1) {
                capturedCtx->rotate(static_cast<float>(engine->toNumber(args[0])));
            }
            return engine->newUndefined();
        })
    );

    // translate(x, y)
    engine->setProperty(jsCtx, "translate",
        engine->newFunction("translate", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 2) {
                capturedCtx->translate(
                    static_cast<float>(engine->toNumber(args[0])),
                    static_cast<float>(engine->toNumber(args[1]))
                );
            }
            return engine->newUndefined();
        })
    );

    // setTransform(a, b, c, d, e, f)
    engine->setProperty(jsCtx, "setTransform",
        engine->newFunction("setTransform", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 6) {
                capturedCtx->setTransform(
                    static_cast<float>(engine->toNumber(args[0])),
                    static_cast<float>(engine->toNumber(args[1])),
                    static_cast<float>(engine->toNumber(args[2])),
                    static_cast<float>(engine->toNumber(args[3])),
                    static_cast<float>(engine->toNumber(args[4])),
                    static_cast<float>(engine->toNumber(args[5]))
                );
            }
            return engine->newUndefined();
        })
    );

    // transform(a, b, c, d, e, f)
    engine->setProperty(jsCtx, "transform",
        engine->newFunction("transform", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx && args.size() >= 6) {
                capturedCtx->transform(
                    static_cast<float>(engine->toNumber(args[0])),
                    static_cast<float>(engine->toNumber(args[1])),
                    static_cast<float>(engine->toNumber(args[2])),
                    static_cast<float>(engine->toNumber(args[3])),
                    static_cast<float>(engine->toNumber(args[4])),
                    static_cast<float>(engine->toNumber(args[5]))
                );
            }
            return engine->newUndefined();
        })
    );

    // resetTransform()
    engine->setProperty(jsCtx, "resetTransform",
        engine->newFunction("resetTransform", [engine, capturedCtx](void* c, const std::vector<js::JSValueHandle>& args) {
            if (capturedCtx) {
                capturedCtx->resetTransform();
            }
            return engine->newUndefined();
        })
    );

    std::cout << "[Canvas2D] JS bindings created" << std::endl;
    return jsCtx;
}

/**
 * Create a new Canvas2D context for a canvas element
 *
 * This function creates both the native Canvas2DContext (Skia-backed) and
 * the JavaScript bindings. Each context captures its own native pointer in
 * closures, allowing multiple canvas contexts to work independently.
 *
 * @param engine The JS engine
 * @param width Canvas width
 * @param height Canvas height
 * @return JS object representing the CanvasRenderingContext2D
 */
js::JSValueHandle createCanvas2DContext(
    js::Engine* engine,
    int width,
    int height,
    std::vector<std::unique_ptr<Canvas2DContext>>& ownedContexts) {
    // Create native context
    auto nativeCtx = std::make_unique<Canvas2DContext>(width, height);
    Canvas2DContext* ctxPtr = nativeCtx.get();

    // Create JS bindings (methods capture ctxPtr in their closures)
    auto jsCtx = createCanvas2DJSObject(engine, ctxPtr);

    // Transfer native lifetime to the WebGPU binding state that owns the JS handle.
    const size_t contextIndex = ownedContexts.size();
    ownedContexts.push_back(std::move(nativeCtx));
    // IDs resolve only through this runtime's owned contexts; JS never supplies a
    // native pointer. Gradients can be shared across canvases and mutated after assignment.
    engine->setProperty(jsCtx, "createLinearGradient",
        engine->newFunction("createLinearGradient", [engine, ctxPtr, contextIndex](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() < 4) {
                engine->throwException("TypeError: createLinearGradient requires four coordinates");
                return engine->newUndefined();
            }
            float points[4];
            for (size_t i = 0; i < 4; ++i) {
                points[i] = static_cast<float>(engine->toNumber(args[i]));
                if (!std::isfinite(points[i])) {
                    engine->throwException("NotSupportedError: gradient coordinates must be finite");
                    return engine->newUndefined();
                }
            }
            const auto index = ctxPtr->createLinearGradient(points[0], points[1], points[2], points[3]);
            auto gradient = ctxPtr->getGradient(index);
            auto result = engine->newObject();
            engine->setProperty(result, "__tnGradientContext", engine->newNumber(contextIndex));
            engine->setProperty(result, "__tnGradientIndex", engine->newNumber(index));
            engine->setProperty(result, "addColorStop", engine->newFunction("addColorStop",
                [engine, gradient](void*, const std::vector<js::JSValueHandle>& stopArgs) {
                    if (stopArgs.size() < 2) {
                        engine->throwException("TypeError: addColorStop requires offset and color");
                        return engine->newUndefined();
                    }
                    const float offset = static_cast<float>(engine->toNumber(stopArgs[0]));
                    if (!std::isfinite(offset) || offset < 0 || offset > 1) {
                        engine->throwException("IndexSizeError: gradient offset must be between 0 and 1");
                    } else if (!gradient->addColorStop(offset, engine->toString(stopArgs[1]))) {
                        engine->throwException("SyntaxError: invalid gradient color");
                    }
                    return engine->newUndefined();
                }));
            return result;
        }));
    // The same object shape as the linear gradient above, six arguments instead of four. Skia
    // draws it as a two-point conical gradient, which is exactly what the canvas spec describes.
    engine->setProperty(jsCtx, "createRadialGradient",
        engine->newFunction("createRadialGradient", [engine, ctxPtr, contextIndex](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() < 6) {
                engine->throwException("TypeError: createRadialGradient requires six arguments");
                return engine->newUndefined();
            }
            float values[6];
            for (size_t i = 0; i < 6; ++i) {
                values[i] = static_cast<float>(engine->toNumber(args[i]));
                if (!std::isfinite(values[i])) {
                    engine->throwException("NotSupportedError: gradient coordinates must be finite");
                    return engine->newUndefined();
                }
            }
            // The spec is explicit that a negative radius is an IndexSizeError, not a clamp.
            if (values[2] < 0 || values[5] < 0) {
                engine->throwException("IndexSizeError: gradient radius must not be negative");
                return engine->newUndefined();
            }
            const auto index = ctxPtr->createRadialGradient(values[0], values[1], values[2],
                                                            values[3], values[4], values[5]);
            auto gradient = ctxPtr->getGradient(index);
            auto result = engine->newObject();
            engine->setProperty(result, "__tnGradientContext", engine->newNumber(contextIndex));
            engine->setProperty(result, "__tnGradientIndex", engine->newNumber(index));
            engine->setProperty(result, "addColorStop", engine->newFunction("addColorStop",
                [engine, gradient](void*, const std::vector<js::JSValueHandle>& stopArgs) {
                    if (stopArgs.size() < 2) {
                        engine->throwException("TypeError: addColorStop requires offset and color");
                        return engine->newUndefined();
                    }
                    const float offset = static_cast<float>(engine->toNumber(stopArgs[0]));
                    if (!std::isfinite(offset) || offset < 0 || offset > 1) {
                        engine->throwException("IndexSizeError: gradient offset must be between 0 and 1");
                    } else if (!gradient->addColorStop(offset, engine->toString(stopArgs[1]))) {
                        engine->throwException("SyntaxError: invalid gradient color");
                    }
                    return engine->newUndefined();
                }));
            return result;
        }));
    const auto setStyle = [engine, ctxPtr, &ownedContexts](bool stroke, const std::vector<js::JSValueHandle>& args) {
        if (args.empty()) return engine->newUndefined();
        if (engine->isObject(args[0])) {
            const double owner = engine->toNumber(engine->getProperty(args[0], "__tnGradientContext"));
            const double index = engine->toNumber(engine->getProperty(args[0], "__tnGradientIndex"));
            if (std::isfinite(owner) && owner >= 0 && owner < ownedContexts.size() && std::floor(owner) == owner &&
                std::isfinite(index) && index >= 0 && index < 4294967296.0 && std::floor(index) == index) {
                auto gradient = ownedContexts[static_cast<size_t>(owner)]->getGradient(static_cast<size_t>(index));
                if (gradient) ctxPtr->setGradient(stroke, std::move(gradient));
            }
        } else if (stroke) ctxPtr->setStrokeStyle(engine->toString(args[0]));
        else ctxPtr->setFillStyle(engine->toString(args[0]));
        return engine->newUndefined();
    };
    // Add native setter methods that capture the context pointer
    // These are called by the property interceptors below
    engine->setProperty(jsCtx, "__nativeSetFillStyle",
        engine->newFunction("__nativeSetFillStyle", [setStyle](void*, const std::vector<js::JSValueHandle>& args) {
            return setStyle(false, args);
        })
    );

    engine->setProperty(jsCtx, "__nativeSetStrokeStyle",
        engine->newFunction("__nativeSetStrokeStyle", [setStyle](void*, const std::vector<js::JSValueHandle>& args) {
            return setStyle(true, args);
        })
    );

    engine->setProperty(jsCtx, "__nativeSetLineWidth",
        engine->newFunction("__nativeSetLineWidth", [engine, ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) {
            if (ctxPtr && !args.empty()) {
                ctxPtr->setLineWidth(static_cast<float>(engine->toNumber(args[0])));
            }
            return engine->newUndefined();
        })
    );

    engine->setProperty(jsCtx, "__nativeSetLineCap",
        engine->newFunction("__nativeSetLineCap", [engine, ctxPtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (!args.empty()) ctxPtr->setLineCap(engine->toString(args[0]));
            return engine->newUndefined();
        }));
    engine->setProperty(jsCtx, "__nativeGetLineCap",
        engine->newFunction("__nativeGetLineCap", [engine, ctxPtr](void*, const std::vector<js::JSValueHandle>&) {
            return engine->newString(ctxPtr->getLineCap().c_str());
        }));

    engine->setProperty(jsCtx, "__nativeSetLineJoin",
        engine->newFunction("__nativeSetLineJoin", [engine, ctxPtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (!args.empty()) ctxPtr->setLineJoin(engine->toString(args[0]));
            return engine->newUndefined();
        }));
    engine->setProperty(jsCtx, "__nativeGetLineJoin",
        engine->newFunction("__nativeGetLineJoin", [engine, ctxPtr](void*, const std::vector<js::JSValueHandle>&) {
            return engine->newString(ctxPtr->getLineJoin().c_str());
        }));

    engine->setProperty(jsCtx, "setLineDash",
        engine->newFunction("setLineDash", [engine, ctxPtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.empty()) return engine->newUndefined();
            // `ctx.setLineDash(5)` is a plain game typo, and a number has no `length`: reading one
            // gives NaN, which used to cast to a size_t near 2^63 and push floats until the host
            // died. A browser throws a TypeError on a non-sequence, so this does.
            //
            // Any object with a numeric `length` stays accepted, as it always was -- a plain
            // array-like and a Float32Array both are. What is new is the range check before the
            // conversion: `length` must be a non-negative integer no larger than 2^32 - 1
            // (ECMAScript's maximum Array length). Outside that range `static_cast<size_t>` is
            // undefined, which is the actual bug (e.g. {length: 1e300}); inside it the conversion
            // and the uint32_t index are both defined. This fixes the conversion only: a legitimate
            // very large Array, or a Proxy that lies about its length within the range, still costs
            // work proportional to the length it reports, exactly as iterating such an object would
            // in a browser. A Set (no `length`) remains unsupported, as it always was.
            const double reported =
                engine->isObject(args[0]) ? engine->toNumber(engine->getProperty(args[0], "length")) : NAN;
            if (!std::isfinite(reported) || reported < 0.0 || reported > 4294967295.0
                || std::floor(reported) != reported) {
                engine->throwException("TypeError: setLineDash expects a sequence of numbers");
                return engine->newUndefined();
            }
            const size_t length = static_cast<size_t>(reported);
            std::vector<float> segments;
            for (size_t i = 0; i < length; ++i) {
                const double value =
                    engine->toNumber(engine->getPropertyIndex(args[0], static_cast<uint32_t>(i)));
                // The list is all or nothing, as the spec has it: an entry that is missing,
                // negative or not finite leaves the previous pattern in place.
                if (!std::isfinite(value) || value < 0) return engine->newUndefined();
                segments.push_back(static_cast<float>(value));
            }
            ctxPtr->setLineDash(segments);
            return engine->newUndefined();
        }));
    engine->setProperty(jsCtx, "__nativeGetLineDash",
        engine->newFunction("__nativeGetLineDash", [engine, ctxPtr](void*, const std::vector<js::JSValueHandle>&) {
            const auto segments = ctxPtr->getLineDash();
            auto array = engine->newObject();
            for (size_t i = 0; i < segments.size(); ++i) {
                engine->setProperty(array, std::to_string(i).c_str(), engine->newNumber(segments[i]));
            }
            engine->setProperty(array, "length", engine->newNumber(static_cast<double>(segments.size())));
            return array;
        }));

    engine->setProperty(jsCtx, "clip",
        engine->newFunction("clip", [engine, ctxPtr](void*, const std::vector<js::JSValueHandle>&) {
            ctxPtr->clip();
            return engine->newUndefined();
        }));

    engine->setProperty(jsCtx, "__nativeSetGlobalAlpha",
        engine->newFunction("__nativeSetGlobalAlpha", [engine, ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) {
            if (ctxPtr && !args.empty()) {
                ctxPtr->setGlobalAlpha(static_cast<float>(engine->toNumber(args[0])));
            }
            return engine->newUndefined();
        })
    );

    engine->setProperty(jsCtx, "__nativeSetFont",
        engine->newFunction("__nativeSetFont", [engine, ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) {
            if (ctxPtr && !args.empty()) {
                ctxPtr->setFont(engine->toString(args[0]));
            }
            return engine->newUndefined();
        })
    );

    engine->setProperty(jsCtx, "__nativeSetTextAlign",
        engine->newFunction("__nativeSetTextAlign", [engine, ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) {
            if (ctxPtr && !args.empty()) {
                ctxPtr->setTextAlign(engine->toString(args[0]));
            }
            return engine->newUndefined();
        })
    );

    engine->setProperty(jsCtx, "__nativeSetTextBaseline",
        engine->newFunction("__nativeSetTextBaseline", [engine, ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) {
            if (ctxPtr && !args.empty()) {
                ctxPtr->setTextBaseline(engine->toString(args[0]));
            }
            return engine->newUndefined();
        })
    );

    // Store this context temporarily for the property interceptor setup
    // This is only needed for the eval() call below and is immediately overwritten
    // when another context is created, but that's fine because we only use it
    // inside the IIFE that runs synchronously
    engine->setGlobalProperty("__canvas2dContextTemp", jsCtx);

    // Execute the property interceptor setup.
    if (!evalCanvasScript(*engine, runtime_scripts::Script::canvas2d_properties, "canvas2d-properties.js")) {
        std::cerr << "[Canvas2D] Failed to install property interceptors" << std::endl;
    }

    return jsCtx;
}

/**
 * Get the native Canvas2DContext from a JS context object
 */
Canvas2DContext* getCanvas2DContextFromJS(js::Engine* engine, js::JSValueHandle jsCtx) {
    return static_cast<Canvas2DContext*>(engine->getPrivateData(jsCtx));
}

}  // namespace canvas
}  // namespace mystral
