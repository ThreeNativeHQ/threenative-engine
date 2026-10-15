const capturePose=process.env.TN_CAPTURE_POSE ?? "lake";
const capturePoses={"ground": {"key": "Digit1", "position": [41, 14.799999999999999, -21.139]}, "edge": {"key": "Digit2", "position": [78.47, 19.1, 1.689]}, "overview": {"key": "Digit3", "position": [203.829, 233.1, 141.689]}, "lake": {"key": "Digit4", "position": [20, 84, 115]}};
const capturePoseSpec=capturePoses[capturePose as keyof typeof capturePoses];
if(!capturePoseSpec) throw new Error("Unknown frozen forest capture pose: "+capturePose);
import { regionMetrics } from "../../packages/playtest/src/runner/steps.js";
function canonicalVisualRows(png:any, visuals:any) {
  assert(Array.isArray(visuals) && visuals.length>0,"missing visual assertions");
  return visuals.map((visual:any,index:number)=>{
    assert(visual && typeof visual==="object" && Object.keys(visual).length===1 && visual.region,"unsupported visual clause");
    const region=visual.region;
    assert(Object.keys(region).every(k=>["x","y","width","height","minNonblankPixelRatio"].includes(k)),"unsupported region clause");
    assert([region.x,region.y,region.width,region.height].every(Number.isFinite),"invalid region bounds");
    assert(region.x>=0 && region.y>=0 && region.width>0 && region.height>0 && region.x+region.width<=png.width && region.y+region.height<=png.height,"region outside original raw raster");
    const minimum=region.minNonblankPixelRatio ?? 0.002;
    assert(Number.isFinite(minimum) && minimum>=0 && minimum<=1,"invalid nonblank minimum");
    const observation={...region,...regionMetrics(png,region)};
    return {id:`visual.${index}.region`,measurement:"packages/playtest/src/runner/steps.ts:regionMetrics",region,minimum,observation,pass:observation.nonblankPixelRatio>=minimum};
  });
}
import { connectPlaytestBridge, advanceFixedStep } from "../../packages/playtest/src/runner/index.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { PNG } from "../../packages/playtest/node_modules/pngjs/lib/png.js";
import { inspectFrame, assertCaptureNotBlank } from "../../packages/playtest/src/capture.js";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { WEBGPU_BROWSER_ARGS, softwareAdapterName } from "../../packages/playtest/src/runner/browser.js";
import { CaptureLockTimeoutError } from "../../packages/playtest/src/runner/captureLock.js";
import { PlaytestCliUsageError } from "../../packages/playtest/src/runner/config.js";
import type { IProvidedDisplay } from "../../packages/playtest/src/runner/captureEnvironment.js";
import { acquireRunnerCaptureLock, provideRunDisplay } from "../../packages/playtest/src/runner/runner-support.js";
import {
  createTraceAccumulator,
  formatTraceSummary,
  parseTraceArgs,
  traceExitCode,
  TRACE_CATEGORIES,
  type ITraceArgs,
  type ITraceEvent,
  type ITraceSummary,
  type TraceReadiness,
  summariseRafTimestamps,
} from "../../packages/playtest/src/runner/trace.js";

const root=resolve(process.env.TN_PRD614_ROOT ?? process.cwd());
const scenarioPath=resolve(root,".linchpin/prd614-laptop-settled",`prd614-forest-pose-${capturePose}.playtest.json`);

/**
 * The browser half of `threenative-playtest trace`: launch the game on a real display, wait for
 * the world, record, drive input, and hand the raw events to the streaming summariser in
 * `trace.ts`. Everything that decides what a number *means* lives there and is unit-tested; this
 * file only drives Chromium.
 */

/** The recipe extends the WebGPU arguments; replacing them reintroduces SwiftShader silently. */
export function traceBrowserArgs(extra: readonly string[]): string[] {
  return [...WEBGPU_BROWSER_ARGS, ...extra];
}

/**
 * Where the raw trace lands when the caller does not say. Under `artifacts/` because that is
 * where this package's other large outputs go, and named by the minute so two runs do not
 * silently overwrite one another's evidence.
 */
export function defaultTracePath(now: Date = new Date(), cwd: string = process.cwd()): string {
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  return resolve(cwd, "artifacts", "traces", `trace-${stamp}.json`);
}


const osCommand=(name:string,args:string[])=>execFileSync(name,args,{encoding:"utf8",timeout:20000,env:process.env}).trim();
function ownedWindows() {
  const clients=osCommand("xprop",["-root","_NET_CLIENT_LIST"]);
  const owned:any[]=[];
  for(const xid of clients.match(/0x[0-9a-f]+/g)??[]) {
    const props=osCommand("xprop",["-id",xid,"_NET_WM_PID","_NET_WM_WINDOW_TYPE","_NET_WM_NAME"]);
    if(!/_NET_WM_WINDOW_TYPE\(ATOM\) = _NET_WM_WINDOW_TYPE_NORMAL(?:,|$)/m.test(props)) continue;
    const pid=Number(props.match(/_NET_WM_PID.*=\s*(\d+)/)?.[1]);
    if(!pid) continue;
    let current=pid;const ancestry:any[]=[];
    try {
      while(current>1 && current!==process.pid) {
        const stat=readFileSync(`/proc/${current}/stat`,"utf8");
        const fields=stat.slice(stat.lastIndexOf(")")+2).split(" ");
        ancestry.push({pid:current,ppid:Number(fields[1]),pgid:Number(fields[2]),cwd:osCommand("readlink",[`/proc/${current}/cwd`]),cmdline:readFileSync(`/proc/${current}/cmdline`,"utf8").split("\0").filter(Boolean)});
        current=Number(fields[1]);
      }
    } catch {continue;}
    if(current!==process.pid) continue;
    const geometry=osCommand("xwininfo",["-id",xid]);
    if(!geometry.includes("IsViewable")) continue;
    owned.push({xid,props,geometry,pid,ancestry});
  }
  return {clients,owned};
}
async function discoverOwnedWindow(page:any,out:string,name:string) {
  const title=`PRD614-OWNED-OS-V3-${process.pid}-${name}`;
  await page.evaluate((title:string)=>{document.title=title;},title);
  const start=Date.now();let result:any;
  do {
    result=ownedWindows();
    if(result.owned.length===1 && result.owned[0].props.includes(title)) break;
    if(Date.now()-start>=2000) break;
    await page.waitForTimeout(50);
  } while(true);
  const metadata={title,elapsedMs:Date.now()-start,...result};
  writeFileSync(resolve(out,name+"-window.json"),JSON.stringify(metadata,null,2));
  assert.equal(result.owned.length,1,"require exactly one viewable NORMAL descendant-owned window");
  assert(result.owned[0].props.includes(title),"title did not propagate within 2 seconds");
  return {...result.owned[0],title};
}

export async function traceCommand(argv: readonly string[]): Promise<number> {
  
const args = parseTraceArgs(argv);
  const output = args.output === undefined ? defaultTracePath() : resolve(args.output);
  try {
    const summary = await recordTrace(args, output);
    const exitCode = traceExitCode(summary);
    process.stdout.write(args.text ? formatTraceSummary(summary) : `${JSON.stringify({ ...summary, pass: exitCode === 0 }, null, 2)}\n`);
    process.exitCode = exitCode;
    return exitCode;
  } catch (error) {
    // A usage error and a capture-lock timeout both belong to the CLI's own handlers; anything
    // else is this command failing to produce a trace, which is exit 2 with the cause named.
    if (error instanceof PlaytestCliUsageError) throw error;
    if (error instanceof CaptureLockTimeoutError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${JSON.stringify({ diagnostics: [{ code: "TN_TRACE_RUN_FAILED", message, severity: "error" }], pass: false }, null, 2)}\n`,
    );
    process.exitCode = 2;
    return 2;
  }
}

export async function recordTrace(args: ITraceArgs, output: string): Promise<ITraceSummary> {
  const { chromium } = await import("../../packages/playtest/node_modules/playwright/index.mjs");
  const accumulator = createTraceAccumulator({
    stallThresholdMs: args.stallThresholdMs,
    topFunctions: args.topFunctions,
  });
  await mkdir(dirname(output), { recursive: true });

  // Pixel work contends for one GPU and one compositor, so a trace queues behind any other
  // capture the same way a playtest does — and it must be the only thing measuring while it runs.
  const lease = await acquireRunnerCaptureLock();
  let display: IProvidedDisplay | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    display = await provideRunDisplay();
    browser = await chromium.launch({
      args: traceBrowserArgs(args.browserArgs),
      env: display.env,
      // Headed always. Headless Chromium serves WebGPU from SwiftShader even with the Vulkan
      // flag, and a trace of a CPU rasteriser names the rasteriser's functions.
      headless: false,
    });
    const page = await browser.newPage({ viewport: args.viewport });
    page.on("console", message => diagnostic("console", {type: message.type(), text: message.text()}));
    page.on("pageerror", error => diagnostic("pageerror", {message: error.message}));
    await page.addInitScript({content: "globalThis.__name = (target) => target"});
    const errors: unknown[] = [];
    page.on("console", m => { if(m.type()==="error") errors.push({kind:"console",text:m.text()}); });
    page.on("pageerror", e => errors.push({kind:"pageerror",text:e.message}));
    page.on("requestfailed", r => errors.push({kind:"network",url:r.url(),text:r.failure()}));
    page.on("response", r => { if(r.status()>=400) errors.push({kind:"http",url:r.url(),status:r.status()}); });
    await page.addInitScript(() => {
      const g=globalThis as any; g.__OS_GPU_ERRORS__=[]; g.__OS_RAF__=0;
      const sample=()=>{g.__OS_RAF__++; requestAnimationFrame(sample);}; requestAnimationFrame(sample);
      const proto=g.GPUAdapter?.prototype, original=proto?.requestDevice;
      if(original) proto.requestDevice=async function(...args:any[]) {
        const device=await original.apply(this,args);
        device.lost.then((info:any)=>g.__OS_GPU_ERRORS__.push({kind:"deviceLoss",reason:info.reason,message:info.message}));
        device.addEventListener("uncapturederror",(e:any)=>g.__OS_GPU_ERRORS__.push({kind:"gpu",message:e.error.message}));
        return device;
      };
    });
    await page.addInitScript(installGpuPipelineDiagnostics);
    const controlUrl = new URL("/__tn_trace_presentation_control__", args.url).href;
    await page.route(controlUrl, (route) => route.fulfill({
      body: "<!doctype html><title>ThreeNative trace presentation control</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}canvas{position:fixed;inset:0;width:100vw;height:100vh;display:block}</style><canvas width=1920 height=1080></canvas>",
      contentType: "text/html",
    }));
    await page.goto(controlUrl, { timeout: args.waitTimeoutSeconds * 1_000, waitUntil: "load" });
    await page.bringToFront();
    const out=dirname(output);
    const preflight:any={pass:false,stage:"browser-preflight",observerPid:process.pid,launchArgs:traceBrowserArgs(args.browserArgs),displayEnv:{DISPLAY:display.env.DISPLAY,XAUTHORITY:display.env.XAUTHORITY,XDG_SESSION_TYPE:display.env.XDG_SESSION_TYPE??null,WAYLAND_DISPLAY:display.env.WAYLAND_DISPLAY??null},presentationOverride:null};
    try {
      preflight.window=await discoverOwnedWindow(page,out,"preflight");
      preflight.pass=true;
    } catch(error:any) {preflight.error=error.message;throw error;}
    finally {writeFileSync(resolve(out,"preflight.json"),JSON.stringify(preflight,null,2));}
    const calibrationSession=await page.context().newCDPSession(page);
    const {windowId:calibrationWindow}=await calibrationSession.send("Browser.getWindowForTarget");
    await calibrationSession.send("Browser.setWindowBounds",{windowId:calibrationWindow,bounds:{windowState:"fullscreen"}});
    await page.waitForFunction(()=>innerWidth===1920 && innerHeight===1080,{},{timeout:10000});
    preflight.fullscreenGeometry=osCommand("xwininfo",["-id",preflight.window.xid]);
    preflight.calibration=await calibrateWindow(page,preflight.window.xid,parseWindowSize(preflight.fullscreenGeometry),out,"blank-calibration-window.png");
    const adapter = await probeAdapter(page);
    diagnostic("adapter", adapter);
    assert(adapter,"WebGPU adapter.info required");
    assert.equal(adapter.vendor?.toLowerCase(),"intel","Exact Intel adapter required");
    assert.equal(softwareAdapterName(adapter),undefined,"Software adapter refused");
    preflight.adapter=adapter;writeFileSync(resolve(out,"preflight.json"),JSON.stringify(preflight,null,2));
    await page.goto(args.url, { timeout: args.waitTimeoutSeconds * 1_000, waitUntil: "commit" });
    const scenario=JSON.parse(readFileSync(scenarioPath,"utf8"));
    const bridge=await connectPlaytestBridge(page,scenario);
    assert(bridge,"bridge required");
    assert(bridge.description.capabilities.includes("runtime.fixedStep"),"fixed-step capability required");
    const readiness = await awaitWorld(page, bridge, out, args.waitTimeoutSeconds * 1_000);
    diagnostic("readiness", readiness);
    const input:any={key:capturePoseSpec.key,holdTicks:2,settleTicks:150,api:"installed connectPlaytestBridge + advanceFixedStep",before:await bridge.sample({resources:["GameState"]})};
    assert.equal(input.before.resources?.GameState?.worldReady,1);
    assert.equal(input.before.resources?.GameState?.driveDone,1);
    await page.keyboard.down(capturePoseSpec.key);
    try {await advanceFixedStep(page,bridge,2);} finally {await page.keyboard.up(capturePoseSpec.key);}
    for(let ticks=0;ticks<150;ticks+=10) await advanceFixedStep(page,bridge,10);
    input.after=await bridge.sample({resources:["GameState"]});
    assert.equal(input.after.clock.tick-input.before.clock.tick,152,"input must advance exactly 152 ticks");
    assert.equal(input.after.resources.GameState.frames-input.before.resources.GameState.frames,152);
    writeFileSync(resolve(out,"input.json"),JSON.stringify(input,null,2));
    assert.equal(input.after.resources?.GameState?.view,capturePose);
    assert.deepEqual(input.after.entities?.find((e:any)=>e.id==="camera.main")?.transform?.position,capturePoseSpec.position);

    const settleStarted=Date.now();const settleSamples:any[]=[];let stable=0;let previousRing="";
    while(Date.now()-settleStarted<600000){
      const state:any=await bridge.sample({resources:["GameState"]});
      const terrain=state.components?.["terrain-diagnostic"];
      assert(terrain?.terrain && terrain?.readiness,"terrain component required");
      const d=terrain.terrain,r=terrain.readiness;
      assert([d.residentTiles,d.residentTileBudget,r.requiredTerrainTiles,r.loadedTerrainTiles].every(Number.isFinite));
      const complete=d.residentTiles===169 && d.residentTileBudget===169 && r.requiredTerrainTiles>0 && r.loadedTerrainTiles===r.requiredTerrainTiles && d.pendingConstruction===undefined && Number.isFinite(d.ringEpoch) && d.lodDecisions.length>0;
      settleSamples.push({elapsedMs:Date.now()-settleStarted,clock:state.clock,terrain,complete});
      // Nominal LOD targets can be constrained by neighbors; ringEpoch also tracks live morphs.
      const ring=JSON.stringify({epoch:d.ringEpoch,keys:d.residentKeys,levels:d.lodDecisions.map((x:any)=>[x.key,x.lodLevel])});
      stable=complete && ring===previousRing?stable+1:0;previousRing=ring;
      writeFileSync(resolve(out,"settle.json"),JSON.stringify({samples:settleSamples,pass:stable>=3},null,2));
      if(stable>=3)break;
      await page.waitForTimeout(200);
      await advanceFixedStep(page,bridge,10);
    }
    assert(stable>=3,"terrain ring and LOD did not settle within 600000 ms");
    input.capture=await bridge.sample({resources:["GameState"]});
    writeFileSync(resolve(out,"input.json"),JSON.stringify(input,null,2));
    await captureOwnedWindow(page, browser, adapter, errors, dirname(output));
    return {} as ITraceSummary;
  } finally {
    await browser?.close().catch(() => undefined);
    await display?.release();
    await lease.release();
  }
}

/**
 * Preserve WebGPU's behavior while recording the authored call site that supplied an invalid
 * depth descriptor. Chromium's eventual validation error otherwise points only into its async
 * pipeline compiler, after the descriptor's owner is no longer on the stack.
 */
export function installGpuPipelineDiagnostics(): void {
  type PipelineDescriptor = {
    readonly depthStencil?: { readonly format?: unknown };
    readonly label?: string;
  };
  type PipelineDiagnostic = {
    readonly depthStencil: Readonly<Record<string, unknown>>;
    readonly label?: string;
    readonly stack: string;
  };
  const globals: {
    console: Pick<Console, "error">;
    GPUDevice?: { prototype?: { createRenderPipelineAsync?(descriptor: PipelineDescriptor): Promise<unknown> } };
    __TN_TRACE_INVALID_GPU_PIPELINES__?: PipelineDiagnostic[];
    __TN_TRACE_GPU_PIPELINES_INSTALLED__?: boolean;
  } = globalThis;
  globals.__TN_TRACE_INVALID_GPU_PIPELINES__ = [];
  if (globals.__TN_TRACE_GPU_PIPELINES_INSTALLED__ === true) return;
  const prototype = globals.GPUDevice?.prototype;
  const create = prototype?.createRenderPipelineAsync;
  if (prototype === undefined || create === undefined) return;
  globals.__TN_TRACE_GPU_PIPELINES_INSTALLED__ = true;
  prototype.createRenderPipelineAsync = function (descriptor: PipelineDescriptor): Promise<unknown> {
    const depthStencil = descriptor?.depthStencil;
    if (depthStencil !== undefined && typeof depthStencil.format !== "string") {
      const diagnostic: PipelineDiagnostic = {
        depthStencil: { ...depthStencil },
        ...(typeof descriptor.label === "string" ? { label: descriptor.label } : {}),
        stack: new Error("createRenderPipelineAsync called without depthStencil.format").stack ?? "stack unavailable",
      };
      globals.__TN_TRACE_INVALID_GPU_PIPELINES__?.push(diagnostic);
      globals.console.error("TN_INVALID_DEPTH_PIPELINE", diagnostic);
    }
    return create.call(this, descriptor);
  };
}

async function sampleRafTimestamps(
  page: import("../../packages/playtest/node_modules/playwright/index.js").Page,
  timeoutMs: number,
): Promise<readonly number[]> {
  return await page.evaluate((sampleTimeoutMs) => new Promise<number[]>((resolveSample, rejectSample) => {
    const timestamps: number[] = [];
    const timeout = setTimeout(
      () => rejectSample(new Error(`presentation control observed only ${timestamps.length - 1} of 180 rAF intervals`)),
      sampleTimeoutMs,
    );
    function sample(time: number): void {
      timestamps.push(time);
      if (timestamps.length < 181) requestAnimationFrame(sample);
      else {
        clearTimeout(timeout);
        resolveSample(timestamps);
      }
    }
    requestAnimationFrame(sample);
  }), timeoutMs);
}

/**
 * Hold until the game says its world is up, then trace the *game*. Tracing the load instead puts
 * the loading tier's pipeline compiles in the same sample as the mid-play stalls this command
 * exists to find, and they are far larger. A gate that never fires degrades to tracing anyway
 * with the fact recorded, because a trace of the wrong window still beats a hang.
 */
async function awaitWorld(page:any, bridge:any, out:string, timeoutMs:number):Promise<TraceReadiness> {
  assert.equal(timeoutMs,120000,"preserve original admission timeout");
  const started=performance.now(), deadline=started+timeoutMs;
  const metadata:any={pass:false,stage:"resource-admission",timeoutMs,samples:[]};
  let lastLog=-Infinity, lastValues="";
  try {
    for (;;) {
      let sample=await bridge.sample({entities:[],include:["resources"],resources:["GameState"]});
      const elapsedMs=performance.now()-started;
      const state=sample.resources?.GameState;
      assert(state && Object.hasOwn(state,"worldReady") && Object.hasOwn(state,"driveDone"),"GameState readiness fields must be observed");
      const values={worldReady:state.worldReady,driveDone:state.driveDone};
      metadata.last={...values,elapsedMs};
      if(JSON.stringify(values)!==lastValues || elapsedMs-lastLog>=1000) {
        metadata.samples.push(metadata.last); diagnostic("admission",metadata.last);
        lastValues=JSON.stringify(values);lastLog=elapsedMs;
      }
      assert(elapsedMs<=timeoutMs,`Resource admission timed out: ${JSON.stringify(metadata.last)}`);
      if(state.worldReady===1 && state.driveDone===1) {
        sample=await bridge.sample({resources:["GameState"]});
        if(sample.resources?.GameState?.worldReady===1 && sample.resources?.GameState?.driveDone===1) {
          assert(performance.now()<=deadline,"Resource admission exceeded 120000 ms");
          metadata.pass=true;metadata.observation=sample;
          return "observed";
        }
      }
      const remaining=deadline-performance.now();
      assert(remaining>0,`Resource admission timed out: ${JSON.stringify(metadata.last)}`);
      await new Promise(resolve=>setTimeout(resolve,Math.min(16,remaining)));
      if(performance.now()<deadline) await advanceFixedStep(page,bridge,1);
    }
  } catch(error:any) {metadata.error=error.message;throw error;}
  finally {
    metadata.elapsedMs=performance.now()-started;
    writeFileSync(resolve(out,"readiness.json"),JSON.stringify(metadata,null,2));
  }
}

/** `adapter.info`, so the summary can refuse to describe a CPU rasteriser as the game's GPU. */
async function probeAdapter(
  page: import("../../packages/playtest/node_modules/playwright/index.js").Page,
): Promise<Record<string, string> | undefined> {
  try {
    return (await page.evaluate(async () => {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: unknown } | null> } }).gpu;
      const info = (await gpu?.requestAdapter())?.info as Record<string, unknown> | undefined;
      if (info === undefined) return undefined;
      const fields: Record<string, string> = {};
      for (const key of ["architecture", "description", "device", "vendor"]) {
        const value = info[key];
        if (typeof value === "string" && value.length > 0) fields[key] = value;
      }
      return fields;
    })) ?? undefined;
  } catch {
    // A page without WebGPU is a fact about the page, not a reason to abandon the trace.
    return undefined;
  }
}

/**
 * Hold the movement keys for the traced window. A standing camera re-uses everything it drew
 * last frame — culling results, shadow maps, the lot — so a trace taken from a parked viewpoint
 * measures a game nobody is playing.
 */
async function driveInput(page: import("../../packages/playtest/node_modules/playwright/index.js").Page, args: ITraceArgs): Promise<void> {
  for (const key of args.keys) await page.keyboard.down(key);
  try {
    await page.waitForTimeout(args.seconds * 1_000);
  } finally {
    for (const key of args.keys) await page.keyboard.up(key).catch(() => undefined);
  }
}

interface ITraceFileWriter {
  close(): Promise<void>;
  write(event: ITraceEvent): void;
}

/**
 * Streams the raw events to disk as they arrive, in DevTools' own `{ "traceEvents": [...] }`
 * shape. Collecting them into an array and serialising it at the end holds the trace twice, and
 * one 63-second recording came to 266 MB across 1.18 M events.
 */
function openTraceFile(output: string): ITraceFileWriter {
  const stream = createWriteStream(output, { encoding: "utf8" });
  stream.write('{"traceEvents":[');
  let written = 0;
  return {
    close(): Promise<void> {
      return new Promise<void>((settle, fail) => {
        stream.once("error", fail);
        stream.end("]}\n", () => settle());
      });
    },
    write(event: ITraceEvent): void {
      // Backpressure is left to the stream's own buffer: the handler CDP calls is synchronous,
      // so there is nowhere to await a drain, and a local disk keeps up with the trace.
      stream.write(written === 0 ? JSON.stringify(event) : `,${JSON.stringify(event)}`);
      written += 1;
    },
  };
}

function diagnostic(kind: string, value: unknown): void {
  process.stderr.write(JSON.stringify({at: new Date().toISOString(), kind, value}) + "\n");
}
async function observeCanvas(page: import("../../packages/playtest/node_modules/playwright/index.js").Page, label: string): Promise<void> {
  const dom = await page.evaluate(() => {
    let largestArea = 0, largestIndex = -1;
    const canvases = Array.from(document.querySelectorAll("canvas")).map((canvas, index) => {
      const area = canvas.width * canvas.height;
      if (area > largestArea) { largestArea = area; largestIndex = index; }
      const style = getComputedStyle(canvas), rect = canvas.getBoundingClientRect();
      return {index, width: canvas.width, height: canvas.height, rect: rect.toJSON(), connected: canvas.isConnected,
        display: style.display, visibility: style.visibility, opacity: style.opacity};
    });
    return {canvases, largestIndex, visibilityState: document.visibilityState, hasFocus: document.hasFocus()};
  });
  diagnostic(label + "-dom", dom);
  const raf = await page.evaluate(() => new Promise(resolve => {
    const start = performance.now(); let count = 0; const times: number[] = []; let done = false;
    const finish = () => { if(done) return; done=true; resolve({count, elapsedMs: performance.now()-start, times}); };
    const timer = setTimeout(finish, 2000);
    function sample(t: number) { if(done) return; count++; if(times.length<121) times.push(t);
      if(count >=121) {clearTimeout(timer); finish();} else requestAnimationFrame(sample); }
    requestAnimationFrame(sample);
  }));
  diagnostic(label + "-raf", raf);
  diagnostic(label + "-state", await page.evaluate(async () => {
    const bridge = (globalThis as any).__THREENATIVE_PLAYTEST_BRIDGE__;
    return await bridge?.sample({resources:["GameState"]});
  }));
}

const calibrationColors=[[251,3,197],[5,239,181],[241,137,7],[83,11,251]] as const;
function parseWindowSize(raw:string){
  const value=(label:string)=>Number(raw.match(new RegExp(label+":\\s+(\\d+)"))?.[1]);
  return {width:value("Width"),height:value("Height")};
}
async function calibrateWindow(page:any,xid:string,expected:{width:number,height:number},out:string,name:string){
  await page.evaluate(()=>{
    const r=document.querySelector("canvas")!.getBoundingClientRect();
    const colors=["rgb(251, 3, 197)","rgb(5, 239, 181)","rgb(241, 137, 7)","rgb(83, 11, 251)"];
    for(let i=0;i<4;i++){
      const el=document.createElement("div");el.dataset.osFiducial=String(i);
      el.style.cssText=`position:fixed;left:${r.left+(i%2)*(r.width-8)}px;top:${r.top+Math.floor(i/2)*(r.height-8)}px;width:8px;height:8px;background:${colors[i]};z-index:2147483647;pointer-events:none;`;
      document.body.append(el);
    }
  });
  const image=resolve(out,name);
  const waitForPixels=async(file:string,present:boolean)=>{
    const started=Date.now();const samples:any[]=[];
    while(Date.now()-started<30000){
      await page.waitForTimeout(500);
      execFileSync("import",["-window",xid,file],{encoding:"utf8",timeout:20000,env:process.env});
      const frame=PNG.sync.read(readFileSync(file));
      assert.equal(frame.width,expected.width);assert.equal(frame.height,expected.height);
      const counts=calibrationColors.map(rgb=>{let count=0;for(let i=0;i<frame.data.length;i+=4)if(rgb.every((v,j)=>frame.data[i+j]===v))count++;return count;});
      samples.push({elapsedMs:Date.now()-started,counts});
      if(counts.every(c=>c===(present?64:0)))return {frame,samples};
    }
    throw new Error(`calibration pixels ${present?"missing":"still present"} after 30000ms: ${JSON.stringify(samples)}`);
  };
  const inserted=await waitForPixels(image,true);const cal=inserted.frame;
  const markers=calibrationColors.map(rgb=>{
    const xs:number[]=[],ys:number[]=[];
    for(let y=0;y<cal.height;y++) for(let x=0;x<cal.width;x++){
      const p=(y*cal.width+x)*4;
      if(rgb.every((v,i)=>cal.data[p+i]===v)){xs.push(x);ys.push(y);}
    }
    assert.equal(xs.length,64,"each calibration marker must have exactly 64 pixels");
    const x=Math.min(...xs),y=Math.min(...ys);
    assert.equal(Math.max(...xs)-x,7);assert.equal(Math.max(...ys)-y,7);
    return {x,y};
  });
  const origin=markers[0]!;
  for(let i=0;i<4;i++) assert.deepEqual(markers[i],{x:origin.x+(i%2)*1912,y:origin.y+Math.floor(i/2)*1072},"canvas spacing must be 1:1");
  assert(origin.x>=0 && origin.y>=0 && origin.x+1920<=cal.width && origin.y+1080<=cal.height,"crop incomplete");
  await page.evaluate(()=>document.querySelectorAll("[data-os-fiducial]").forEach(e=>e.remove()));
  const cleared=await waitForPixels(resolve(out,name.replace(".png","-cleared.png")),false);
  return {markers,crop:{x:origin.x,y:origin.y,width:1920,height:1080},spacing:"1 CSS pixel = 1 X11 pixel",windowWidth:cal.width,windowHeight:cal.height,capture:name,presentation:{inserted:inserted.samples,cleared:cleared.samples}};
}

async function captureOwnedWindow(page:any, browser:any, adapter:any, errors:unknown[], out:string):Promise<void> {
  const metadata:any={pass:false,stage:"window-discovery",adapter,observerPid:process.pid};
  const save=()=>writeFileSync(resolve(out,"pilot.json"),JSON.stringify(metadata,null,2));
  const command=(name:string,args:string[])=>execFileSync(name,args,{encoding:"utf8",timeout:20000,env:process.env}).trim();
  const geometry=(id:string)=>{
    const raw=command("xwininfo",["-id",id]);
    const value=(label:string)=>Number(raw.match(new RegExp(label+":\\s+(-?\\d+)"))?.[1]);
    return {raw,x:value("Absolute upper-left X"),y:value("Absolute upper-left Y"),width:value("Width"),height:value("Height"),mapped:raw.includes("IsViewable")};
  };
  const snapshot=()=>page.evaluate(async()=>{
    const g=globalThis as any;
    const sample=await g.__THREENATIVE_PLAYTEST_BRIDGE__.sample({resources:["GameState"]});
    return {clock:sample.clock,state:sample.resources?.GameState,camera:sample.entities?.find((e:any)=>e.id==="camera.main"),terrain:sample.components?.["terrain-diagnostic"],raf:g.__OS_RAF__,gpuErrors:g.__OS_GPU_ERRORS__,fiducials:document.querySelectorAll("[data-os-fiducial]").length};
  });
  const checkState=(s:any)=>{
    assert.equal(s.state?.worldReady,1); assert.equal(s.state?.driveDone,1); assert.equal(s.state?.view,capturePose);
    assert.deepEqual(s.camera?.transform?.position,capturePoseSpec.position);
    assert(s.terrain?.terrain && s.terrain?.readiness,"terrain diagnostic was not observed through the scene bridge");
    assert.deepEqual(s.gpuErrors,[]);
  };
  const waitForTerrainSettle=async()=>{
    const started=Date.now();let previous="";let stable=0;const samples:any[]=[];
    try {
      for(;;){
        const sample=await snapshot();checkState(sample);
        const debug=sample.terrain.terrain,readiness=sample.terrain.readiness;
        const required=readiness.requiredTerrainTiles,loaded=readiness.loadedTerrainTiles;
        const residentTiles=debug.residentTiles,residentTileBudget=debug.residentTileBudget;
        const lodDecisions=Array.isArray(debug.lodDecisions)?debug.lodDecisions:[];
        const lodSettled=lodDecisions.length>0 && lodDecisions.every((decision:any)=>
          Number.isFinite(decision?.lodLevel) && Number.isFinite(decision?.targetLod) && decision.lodLevel===decision.targetLod);
        assert.equal(residentTileBudget,169,"terrain resident tile budget must be 169");
        const complete=[required,loaded,residentTiles,residentTileBudget].every(Number.isFinite) &&
          required>0 && loaded===required && residentTiles===169 && residentTileBudget===169 &&
          debug.pendingConstruction===undefined && Number.isFinite(debug.ringEpoch);
        const signature=JSON.stringify({required,loaded,residentTiles,residentTileBudget,pendingConstruction:debug.pendingConstruction,ringEpoch:debug.ringEpoch,levels:lodDecisions.map((x:any)=>[x.key,x.lodLevel])});
        samples.push({elapsedMs:Date.now()-started,clock:sample.clock,state:sample.state,camera:sample.camera,readiness,terrain:debug,lodSettled,raf:sample.raf,gpuErrors:sample.gpuErrors});
        if(complete && signature===previous) stable++; else stable=0;
        previous=signature;
        if(stable>=2) return {pass:true,elapsedMs:Date.now()-started,samples,snapshot:sample};
        if(Date.now()-started>=90000) {
          const last=samples.at(-1);
          throw new Error(`terrain async settle timed out: ${JSON.stringify({clock:last?.clock,readiness:last?.readiness,pendingConstruction:last?.terrain?.pendingConstruction,residentTiles:last?.terrain?.residentTiles,residentTileBudget:last?.terrain?.residentTileBudget,lodSettled:last?.lodSettled})}`);
        }
        await page.waitForTimeout(100);
      }
    } catch(error:any) {
      metadata.terrainSettle={pass:false,elapsedMs:Date.now()-started,samples,error:{message:error.message,stack:error.stack}};
      save();
      throw error;
    }
  };
  try {
    metadata.preCapture=await snapshot();checkState(metadata.preCapture);
    const owned=await discoverOwnedWindow(page,out,"game");
    const xid=owned.xid; metadata.xid=xid;metadata.title=owned.title;
    metadata.ownership=owned;save();
    const cdp=await page.context().newCDPSession(page);
    const {windowId}=await cdp.send("Browser.getWindowForTarget");
    await cdp.send("Browser.setWindowBounds",{windowId,bounds:{windowState:"fullscreen"}});
    command("xdotool",["windowactivate","--sync",xid]);
    await page.bringToFront(); await page.waitForTimeout(1000);
    const checkGeometry=async()=>{
      const win=geometry(xid), root=command("xwininfo",["-root"]);
      const screenW=Number(root.match(/Width:\s+(\d+)/)?.[1]),screenH=Number(root.match(/Height:\s+(\d+)/)?.[1]);
      assert(win.mapped && win.x>=0 && win.y>=0 && win.x+win.width<=screenW && win.y+win.height<=screenH,"owned window is offscreen");
      const stack=command("xprop",["-root","_NET_CLIENT_LIST_STACKING"]);
      const order=(stack.match(/0x[0-9a-f]+/g)??[]).map(x=>parseInt(x,16));
      const index=order.indexOf(Number(xid)); assert(index>=0,"owned window absent from stacking");
      const above:any[]=[];
      for(const id of order.slice(index+1)) {
        const other=geometry(String(id)); above.push({id,...other});
        assert(!other.mapped || other.x>=win.x+win.width || other.y>=win.y+win.height || other.x+other.width<=win.x || other.y+other.height<=win.y,"owned window occluded by "+id);
      }
      const dom=await page.evaluate(()=>{
        const c=document.querySelector("canvas")!; const r=c.getBoundingClientRect();
        return {innerWidth,innerHeight,outerWidth,outerHeight,devicePixelRatio,screenX,screenY,canvas:{width:c.width,height:c.height,rect:r.toJSON()},focused:document.hasFocus(),visibility:document.visibilityState};
      });
      assert.equal(dom.devicePixelRatio,1); assert.equal(dom.innerWidth,1920); assert.equal(dom.innerHeight,1080);
      assert.equal(dom.canvas.rect.width,1920); assert.equal(dom.canvas.rect.height,1080);
      assert(dom.focused && dom.visibility==="visible");
      return {win,screenW,screenH,stack,above,dom};
    };
    metadata.stage="calibration"; metadata.geometry=await checkGeometry();
    metadata.calibration=await calibrateWindow(page,xid,metadata.geometry.win,out,"calibration-window.png");save();
    const origin=metadata.calibration.crop;
    await page.waitForTimeout(1000);
    metadata.stage="final-capture";metadata.before=await snapshot();checkState(metadata.before);
    command("import",["-window",xid,resolve(out,"at-152-window.png")]);
    const at152=PNG.sync.read(readFileSync(resolve(out,"at-152-window.png")));
    assert.equal(at152.width,metadata.calibration.windowWidth);assert.equal(at152.height,metadata.calibration.windowHeight);
    const at152Crop=new PNG({width:1920,height:1080});
    PNG.bitblt(at152,at152Crop,origin.x,origin.y,1920,1080,0,0);
    writeFileSync(resolve(out,"at-152.png"),PNG.sync.write(at152Crop));
    metadata.at152Capture="at-152.png";
    metadata.terrainSettle=await waitForTerrainSettle();
    metadata.settled=metadata.terrainSettle.snapshot;checkState(metadata.settled);
    metadata.settledCapture="raw.png";
    assert.equal(metadata.before.fiducials,0);
    metadata.finalGeometry=await checkGeometry();
    assert.deepEqual(metadata.finalGeometry.win,metadata.geometry.win,"window changed after calibration");
    save();
    command("import",["-window",xid,resolve(out,"after-window.png")]);
    const bytes=readFileSync(resolve(out,"after-window.png")), frame=PNG.sync.read(bytes);
    assert.equal(frame.width,metadata.calibration.windowWidth);assert.equal(frame.height,metadata.calibration.windowHeight);
    assert.equal(frame.data.length,frame.width*frame.height*4);
    const crop=new PNG({width:1920,height:1080});
    PNG.bitblt(frame,crop,origin.x,origin.y,1920,1080,0,0);
    const png=PNG.sync.write(crop);writeFileSync(resolve(out,"raw.png"),png);
    metadata.metrics=inspectFrame(png);assertCaptureNotBlank(png,"AFTER-pilot");
    assert.equal(metadata.metrics.width,1920);assert.equal(metadata.metrics.height,1080);
    for(let q=3;q<crop.data.length;q+=4) assert.equal(crop.data[q],255,"returned frame must be entirely opaque");
    await page.waitForTimeout(500);
    metadata.after=await snapshot();checkState(metadata.after);assert.equal(metadata.after.fiducials,0);
    // Loop.advance freezes the live simulation; rendering/rAF continues (installed core:8161).
    assert.deepEqual(metadata.after.clock,metadata.before.clock,"snapshot tick changed");
    assert.deepEqual(metadata.after.camera,metadata.before.camera,"snapshot camera changed");
    assert.equal(metadata.after.state.frames,metadata.before.state.frames,"snapshot game frames changed");
    assert(metadata.after.raf>metadata.before.raf,"RAF progression missing");
    metadata.postGeometry=await checkGeometry();
    assert.deepEqual(metadata.postGeometry.win,metadata.geometry.win);
    assert.deepEqual(errors,[],"console/network errors observed");
    const savedInput=JSON.parse(readFileSync(resolve(out,"input.json"),"utf8"));
    assert.deepEqual(metadata.before.clock,savedInput.capture.clock);
    assert.deepEqual(metadata.after.state,metadata.before.state,"snapshot resources changed");
    const scenario=JSON.parse(readFileSync(scenarioPath,"utf8"));
    const rows=scenario.assert.resources.map((rule:any)=>{
      assert.equal(rule.id,"GameState");
      const value=rule.path.split(".").reduce((v:any,k:string)=>v?.[k],metadata.after.state);
      const pass=value!==undefined && (rule.equals===undefined || value===rule.equals) &&
        (rule.gte===undefined || (typeof value==="number" && Number.isFinite(value) && value>=rule.gte)) &&
        (rule.lte===undefined || (typeof value==="number" && Number.isFinite(value) && value<=rule.lte));
      return {id:`resource.${rule.id}.${rule.path}`,value,rule,pass};
    });
    assert(rows.length>0);assert(rows.every((row:any)=>row.pass),JSON.stringify(rows.filter((r:any)=>!r.pass)));
    assert.equal(metadata.after.state.loadingError,"");
    assert.equal(metadata.after.state.spawnCellsLoaded,metadata.after.state.spawnCellsRequired);
    assert.equal(metadata.after.state.spawnTerrainLoaded,metadata.after.state.spawnTerrainRequired);
    assert(metadata.after.state.spawnCellsRequired>0 && metadata.after.state.spawnTerrainRequired>0);
    const visualRows=canonicalVisualRows(PNG.sync.read(readFileSync(resolve(out,"raw.png"))),scenario.assert.visual);
    assert(visualRows.every((row:any)=>row.pass),"canonical static-region nonblank criterion failed: "+JSON.stringify(visualRows));
    writeFileSync(resolve(out,"report.json"),JSON.stringify({purpose:"fixed snapshot visual predicates",performanceGate:"UNVERIFIED: original scenario not executed",originalScenario:scenario,rows,resourceRows:rows,visualRows,observations:{visual:{nonblankRegions:visualRows.map((row:any)=>row.observation)}},diagnostics:{errors,gpuErrors:metadata.after.gpuErrors},readiness:JSON.parse(readFileSync(resolve(out,"readiness.json"),"utf8")),input:savedInput,metadata},null,2));
    metadata.errors=errors;metadata.stage="complete";metadata.pass=true;save();
  } catch(error:any) {
    metadata.error={message:error.message,stack:error.stack};metadata.errors=errors;save();throw error;
  }
}

const args = parseTraceArgs(["--url", "http://127.0.0.1:5201", "--viewport", "1920x1080", "--seconds", "2", "--no-input", "--wait-timeout", "120", "--wait-for", "async () => { const b = globalThis.__THREENATIVE_PLAYTEST_BRIDGE__; if (!b) return false; const s = await b.sample({resources:['GameState']}); return s.resources?.GameState?.worldReady === 1 && s.resources?.GameState?.driveDone === 1; }"]);
recordTrace(args, process.env.TN_CANVAS_TRACE_OUTPUT!).then(summary => {
  process.stdout.write(JSON.stringify(summary, null, 2)+"\n");
}).catch(error => { diagnostic("fatal", {message:error.message, stack:error.stack}); process.exitCode=2; });
