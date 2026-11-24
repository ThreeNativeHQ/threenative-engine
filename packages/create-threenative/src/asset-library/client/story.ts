// A code story (`src/**/*.story.ts`) runs in its own frame, `<base>story.html`, inside the game's
// own module graph: `three` there is whatever the game resolves (the Wasm engine by default), so a
// TSL material or a spell looks as it will in the game. The shell drives it by postMessage.
import type { IAssetControl, IAssetElement } from "../types.js";
import type { IViewerHost, IViewerMode } from "./viewers.js";
import { mb } from "./viewers.js";

interface IStoryMessage {
  readonly type?: string;
  readonly title?: string;
  readonly category?: string;
  readonly controls?: readonly IAssetControl[];
  readonly triangles?: number;
  readonly drawCalls?: number;
  readonly bytes?: number;
  readonly ms?: number;
  readonly url?: string;
  readonly error?: string;
}

export async function storyView(element: IAssetElement, host: IViewerHost): Promise<IViewerMode> {
  const file = element.path ?? element.id;
  host.view.renderer.domElement.style.visibility = "hidden";
  const layer = host.overlay("inset-0");
  const frame = host.el("iframe", "size-full border-0 bg-app");
  frame.title = `Story: ${element.name}`;
  frame.src = `${host.base}story.html?path=${encodeURIComponent(file)}`;
  layer.append(frame);
  let props: Record<string, unknown> = {};
  let title = element.name;
  let sheetWaiter: ((url: string) => void) | undefined;
  const post = (message: object) => frame.contentWindow?.postMessage(message, "*");
  const onMessage = (event: MessageEvent<IStoryMessage>) => {
    if (event.source !== frame.contentWindow || typeof event.data !== "object") return;
    const message = event.data;
    if (message.type === "tn-story:meta") {
      title = message.title ?? title;
      props = host.setStoryControls(message.controls ?? []);
      post({ type: "tn-story:props", props });
      renderDocs();
    } else if (message.type === "tn-story:stats") {
      host.rowsInto(host.stats, [
        ["Draw calls", String(message.drawCalls ?? 0)],
        ["Triangles", (message.triangles ?? 0).toLocaleString()],
        ["GPU memory (est.)", mb(message.bytes ?? 0)],
        ["Create", `${message.ms ?? 0} ms`],
        ["Renderer", "the game's own three (story frame)"],
      ]);
      host.say(
        `${title} · ${(message.triangles ?? 0).toLocaleString()} triangles · ${message.drawCalls ?? 0} draws`,
      );
      host.invalidate();
    } else if (message.type === "tn-story:error") host.say(message.error ?? "story failed", true);
    else if (message.type === "tn-story:sheet" && message.url) sheetWaiter?.(message.url);
  };
  window.addEventListener("message", onMessage);
  const snippet = (values: Record<string, unknown>) => {
    const stem = file.split("/").pop()?.replace(/\.ts$/u, ".js") ?? "story.js";
    return `import story from "./${stem}";\n\nconst object = await story.create(${JSON.stringify(values, null, 2)});\nscene.add(object);`;
  };
  const renderDocs = () =>
    host.docs.replaceChildren(
      host.el("h2", "text-xl font-extrabold text-white", title),
      host.el("p", "text-muted", file),
      host.el(
        "p",
        "text-muted",
        "Edit the story file and the frame reloads it in place; tuned controls stay set. Copy the props or the snippet into game code.",
      ),
      host.el(
        "pre",
        "whitespace-pre-wrap rounded border border-line bg-sidebar p-3 font-mono text-xs",
        snippet(props),
      ),
      host.copyButton("Copy snippet", () => snippet(props)),
    );
  renderDocs();
  return {
    storyProps(next) {
      props = next;
      post({ type: "tn-story:props", props });
      renderDocs();
    },
    storySnippet: snippet,
    wireframe: (on) => post({ type: "tn-story:wireframe", on }),
    leave() {
      window.removeEventListener("message", onMessage);
    },
    sheet: () =>
      new Promise<HTMLCanvasElement>((resolve) => {
        sheetWaiter = (url) => {
          const image = new Image();
          image.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            canvas.getContext("2d")?.drawImage(image, 0, 0);
            resolve(canvas);
          };
          image.src = url;
        };
        const ask = () => post({ type: "tn-story:sheet" });
        if (frame.contentDocument?.readyState === "complete") ask();
        frame.addEventListener("load", ask, { once: true });
        setTimeout(ask, 1500);
      }),
  };
}
