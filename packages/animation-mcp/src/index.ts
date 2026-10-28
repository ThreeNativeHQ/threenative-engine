import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import type { TransformValue } from "./client/recipe.js";
import { bakeAttachment } from "./ops/attach.js";
import { inspectModel } from "./ops/inspect.js";
import { ANCHOR_SPECS, type AnchorId, type AnchorInfo } from "./ops/landmarks.js";
import {
  type AnimationLog,
  type KeyOp,
  appendOp,
  logPathFor,
  upgradeLog,
  writeLog,
} from "./ops/log.js";
import { verifyClip } from "./ops/verify.js";
import { startPoseLab } from "./server.js";

const TransformSchema = z.object({
  position: z.tuple([z.number(), z.number(), z.number()]),
  rotation: z.tuple([z.number(), z.number(), z.number()]),
  scale: z.tuple([z.number(), z.number(), z.number()]),
});

const AnchorIdSchema = z.enum(ANCHOR_SPECS.map((spec) => spec.id) as [AnchorId, ...AnchorId[]]);

const KeySchema = z.object({
  attachment: z.enum(["attached", "detached"]).optional(),
  clip: z.string().min(1).max(200),
  time: z.number().min(0).max(600),
  transform: TransformSchema,
});

const InspectInputSchema = z.object({ file: z.string().min(1) });

const InspectOutputSchema = z.object({
  bones: z.array(z.string()),
  bytes: z.number(),
  clips: z.array(
    z.object({
      channels: z.number(),
      duration: z.number(),
      horizontalTravel: z.number(),
      inPlace: z.boolean(),
      name: z.string(),
    }),
  ),
  extensionsUsed: z.array(z.string()),
  file: z.string(),
  generator: z.string(),
  inPlace: z.boolean(),
  landmarks: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      node: z.string(),
      source: z.enum(["detected", "estimated"]),
    }),
  ),
  meshes: z.number(),
  rootBone: z.string().nullable(),
  skins: z.number(),
  warnings: z.array(z.string()),
});

const AttachInputSchema = z.object({
  anchor: AnchorIdSchema.default("right-hand"),
  attached: z.string().min(1).optional(),
  bone: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  keys: z.array(KeySchema).max(2_000).optional(),
  log: z.string().min(1).optional(),
  output: z.string().min(1).optional(),
  recipe: z.string().min(1).optional(),
});

const AttachOutputSchema = z.object({
  anchor: z.string(),
  attached: z.string(),
  clips: z.array(z.string()),
  detached: z.array(z.string()),
  file: z.string(),
  log: z.string(),
  node: z.string(),
});

const VerifyInputSchema = z.object({
  clip: z.string().min(1).max(200),
  file: z.string().min(1),
  fps: z.number().int().min(1).max(240).default(30),
  scale: z.number().positive().default(1),
});

const VerifyOutputSchema = z.object({
  bones: z.number(),
  clip: z.string(),
  defects: z.array(
    z.object({
      bone: z.string(),
      detail: z.string(),
      fromFrame: z.number(),
      fromTime: z.number(),
      kind: z.enum(["bone-stretch", "foot-skate", "ground-penetration", "jitter", "loop-seam"]),
      limit: z.number(),
      measured: z.number(),
      toFrame: z.number(),
      toTime: z.number(),
    }),
  ),
  duration: z.number(),
  file: z.string(),
  fps: z.number(),
  frames: z.number(),
  passed: z.boolean(),
  scale: z.number(),
  thresholds: z.object({
    contact: z.number(),
    jitter: z.number(),
    penetration: z.number(),
    seam: z.number(),
    skate: z.number(),
    stretch: z.number(),
  }),
});

const ViewInputSchema = z.object({
  anchor: AnchorIdSchema.default("right-hand"),
  attach: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  output: z.string().min(1).optional(),
  port: z.number().int().min(0).max(65_535).optional(),
  project: z.string().min(1).optional(),
});

const ViewOutputSchema = z.object({
  port: z.number(),
  url: z.string(),
});

const annotations = (readOnly: boolean) => ({
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: readOnly,
});

const text = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value) }];

/** The bone a landmark resolves to. Fails closed: an anchor the rig does not name is reported
 * with the landmarks it does have, rather than baked onto whatever was nearest. */
function resolveAnchor(landmarks: readonly AnchorInfo[], id: AnchorId, bone?: string): AnchorInfo {
  if (bone !== undefined) {
    const spec = ANCHOR_SPECS.find((candidate) => candidate.id === id);
    if (spec === undefined) throw new Error(`Unknown anchor '${id}'.`);
    return { id, label: spec.label, node: bone, source: "detected" };
  }
  const found = landmarks.find((candidate) => candidate.id === id);
  if (found !== undefined) return found;
  const available = landmarks.map((candidate) => `${candidate.id} → ${candidate.node}`);
  throw new Error(
    `The host names no '${id}' landmark. It answers to: ${available.length === 0 ? "none" : available.join(", ")}. Pass 'bone' to name one directly.`,
  );
}

function transformOf(value: z.output<typeof TransformSchema>): TransformValue {
  return { position: value.position, rotation: value.rotation, scale: value.scale };
}

function defaultOutputFor(host: string): string {
  const parsed = path.parse(host);
  return path.join(parsed.dir, `${parsed.name}.anim.glb`);
}

async function attach(
  input: z.output<typeof AttachInputSchema>,
): Promise<z.output<typeof AttachOutputSchema>> {
  const keys: KeyOp[] = (input.keys ?? []).map((key) => ({
    attachment: key.attachment,
    clip: key.clip,
    op: "key",
    time: key.time,
    transform: transformOf(key.transform),
  }));

  let log: AnimationLog;
  if (input.recipe !== undefined) {
    log = upgradeLog(JSON.parse(await readFile(input.recipe, "utf8")) as unknown);
    for (const key of keys) log = appendOp(log, key);
  } else {
    if (input.host === undefined || input.attached === undefined)
      throw new Error("Pass 'host' and 'attached', or a 'recipe' that names both.");
    const report = await inspectModel(input.host);
    log = {
      host: input.host,
      ops: [
        {
          anchor: resolveAnchor(report.landmarks, input.anchor, input.bone),
          attached: input.attached,
          op: "attach",
        },
        ...keys,
      ],
      version: 4,
    };
  }

  const logFile = input.log ?? logPathFor(log.host);
  await writeLog(logFile, log);
  const baked = await bakeAttachment(log, input.output ?? defaultOutputFor(log.host));
  return { ...baked, log: path.resolve(logFile) };
}

/** One view per MCP process: `animation_open_view` is a window a human opens, not a server a
 * caller starts twice. */
let view: Promise<z.output<typeof ViewOutputSchema>> | undefined;

function openView(input: z.output<typeof ViewInputSchema>) {
  view ??= (async () => {
    const started = await startPoseLab({
      ...(input.port === undefined ? {} : { port: input.port }),
      ...(input.project === undefined ? {} : { project: input.project }),
    });
    const query = new URLSearchParams();
    if (input.host !== undefined) query.set("host", input.host);
    if (input.attach !== undefined) query.set("attach", input.attach);
    if (input.output !== undefined) query.set("output", input.output);
    query.set("anchor", input.anchor);
    return { port: started.port, url: `http://127.0.0.1:${started.port}/pose?${query.toString()}` };
  })();
  return view;
}

export function createAnimationServer(): McpServer {
  const server = new McpServer({ name: "threenative-animation", version: "0.1.3" });

  server.registerTool(
    "animation_inspect",
    {
      annotations: annotations(true),
      description:
        "Inspect a local rigged GLB: bones, skeleton landmarks, clips with durations, root-motion travel and in-place detection, meshes, skins and extensions. Reads one local file and writes nothing.",
      inputSchema: InspectInputSchema,
      outputSchema: InspectOutputSchema,
      title: "Inspect a rig and its clips",
    },
    async (input) => {
      try {
        const report = InspectOutputSchema.parse(await inspectModel(input.file));
        return { content: text(report), structuredContent: report };
      } catch (error) {
        return {
          content: text({ message: error instanceof Error ? error.message : String(error) }),
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "animation_attach",
    {
      annotations: annotations(false),
      description:
        "Attach a prop GLB to a bone, with per-clip keyed offsets, and bake it into an ordinary GLB beside the source. Writes the v4 op log (<model>.anim.json) next to the source GLB and the baked GLB; a version 3 pose recipe loads as the same ops and still bakes.",
      inputSchema: AttachInputSchema,
      outputSchema: AttachOutputSchema,
      title: "Attach a prop to a bone and bake it",
    },
    async (input) => {
      try {
        const result = AttachOutputSchema.parse(await attach(AttachInputSchema.parse(input)));
        return { content: text(result), structuredContent: result };
      } catch (error) {
        return {
          content: text({ message: error instanceof Error ? error.message : String(error) }),
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "animation_verify",
    {
      annotations: annotations(true),
      description:
        "Measure one clip for the defects a still frame cannot show: a planted foot that slides (2 cm), ground penetration (1 cm), a loop seam (5°), a one-frame jitter spike, and bones whose length changes. Every defect names the bone and the frame range it spans. Thresholds are in metres; pass `scale` for a model that is not (Mixamo and Quaternius are centimetres: 0.01).",
      inputSchema: VerifyInputSchema,
      outputSchema: VerifyOutputSchema,
      title: "Verify a clip's motion",
    },
    async (input) => {
      try {
        const parsed = VerifyInputSchema.parse(input);
        const report = VerifyOutputSchema.parse(
          await verifyClip(parsed.file, parsed.clip, { fps: parsed.fps, scale: parsed.scale }),
        );
        return { content: text(report), structuredContent: report };
      } catch (error) {
        return {
          content: text({ message: error instanceof Error ? error.message : String(error) }),
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "animation_open_view",
    {
      annotations: annotations(false),
      description:
        "Start the animation calibrator page on 127.0.0.1 and return its URL. A human drags the prop into place there; the same operations an agent calls are what the page records.",
      inputSchema: ViewInputSchema,
      outputSchema: ViewOutputSchema,
      title: "Open the animation calibrator",
    },
    async (input) => {
      try {
        const result = ViewOutputSchema.parse(await openView(ViewInputSchema.parse(input)));
        return { content: text(result), structuredContent: result };
      } catch (error) {
        return {
          content: text({ message: error instanceof Error ? error.message : String(error) }),
          isError: true,
        };
      }
    },
  );

  return server;
}

export function runServer(): void {
  serveStdio(() => createAnimationServer());
}

/** Whether this file is the process's main module. `realpath` on both sides is the whole point:
 * an installed package runs through `node_modules/.bin/threenative-animation-mcp`, a symlink, so
 * `argv[1]` is the link and `import.meta.url` the file it points at. Comparing the two literally
 * started nothing at all — the server initialized and went silent, which a host reports as a
 * timeout in whichever editor the agent happened to be using. */
function invokedAsCli(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  // `--view` is the human's entry: the same page `animation_open_view` returns, without an agent in
  // between. No argument is the stdio server, which is the contract `.mcp.json` depends on.
  if (process.argv[2] === "--view") {
    openView(ViewInputSchema.parse({ project: process.cwd() })).then(
      ({ url }) => process.stdout.write(`Animation view: ${url}\n`),
      (error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      },
    );
  } else {
    runServer();
  }
}
