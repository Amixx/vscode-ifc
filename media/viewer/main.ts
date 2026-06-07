import "./viewer.css";
import { render as renderHtml } from "lit-html";
import { createRenderEngine, RenderEngine } from "./engine";
import { viewerTemplate, type ViewerTemplateState } from "./template";
import type { EngineKind, HostToWebview, LoadMessage, WebviewToHost } from "../../src/viewer/protocol";

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHost): void };

const vscode = acquireVsCodeApi();

function post(message: WebviewToHost): void {
  vscode.postMessage(message);
}

class Viewer {
  private readonly root: HTMLElement;
  private readonly canvasHost: HTMLElement;

  private engine: RenderEngine | undefined;
  private activeEngine: EngineKind = "web-ifc";
  private lastMessage: LoadMessage | undefined;
  private renderSeq = 0;
  private lastFrame = performance.now();
  private activeLoadStage = "";
  private resizeObserver: ResizeObserver | undefined;
  private animationFrame = 0;

  private hudTitle = "";
  private hudSub = "";
  private hudStats = "";
  private hudWarn = "";
  private overlayText = "";
  private overlayBusy = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.renderChrome();
    this.canvasHost = this.findCanvasHost();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvasHost);
    this.resize();
    this.tick();
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    cancelAnimationFrame(this.animationFrame);
    this.engine?.dispose();
  }

  async render(message: LoadMessage): Promise<void> {
    this.lastMessage = message;
    this.activeEngine = message.engine;
    this.renderChrome();
    await this.renderWith(message.engine);
  }

  private readonly toggleEngine = async (): Promise<void> => {
    if (!this.lastMessage) {
      return;
    }
    this.activeEngine = this.activeEngine === "ifc-lite" ? "web-ifc" : "ifc-lite";
    this.renderChrome();
    await this.renderWith(this.activeEngine);
  };

  private async renderWith(engineKind: EngineKind): Promise<void> {
    const message = this.lastMessage;
    if (!message) {
      return;
    }
    const seq = ++this.renderSeq;
    this.activeLoadStage = "";
    this.setOverlay(`Loading with ${engineKind}…`, true);
    this.setHud(message);
    const started = performance.now();
    try {
      const engine = this.getEngine(engineKind);
      const stats = await engine.load({
        bytes: new Uint8Array(message.ifcBytes),
        rootId: message.rootId,
        renderIds: message.renderIds,
      });
      if (seq !== this.renderSeq) {
        return;
      }
      if (stats.meshes === 0) {
        this.setOverlay("No renderable geometry for this element.", false);
        post({
          type: "status",
          token: message.token,
          state: "empty",
          message: `#${message.rootId} ${message.rootType ?? ""} produced no geometry.`,
          engine: engineKind,
        });
        return;
      }

      this.setOverlay("", false);
      const elapsedMs = Math.round(performance.now() - started);
      this.hudStats =
        `${stats.meshes} mesh${stats.meshes === 1 ? "" : "es"}` +
        (stats.triangles === undefined ? "" : ` · ${stats.triangles.toLocaleString()} tris`) +
        ` · ${engineKind} · ${elapsedMs} ms`;
      this.renderChrome();
      post({
        type: "status",
        token: message.token,
        state: "rendered",
        meshes: stats.meshes,
        triangles: stats.triangles,
        engine: engineKind,
        elapsedMs,
      });
    } catch (error) {
      if (seq !== this.renderSeq) {
        return;
      }
      const text = error instanceof Error ? error.message : String(error);
      this.setOverlay(`Render failed: ${text}`, false);
      post({ type: "status", token: message.token, state: "error", message: text, engine: engineKind });
      post({ type: "log", level: "error", message: text });
    }
  }

  private getEngine(kind: EngineKind): RenderEngine {
    if (this.engine && this.engine.kind === kind) {
      return this.engine;
    }
    // Switching engines: fully unmount the previous one (dispose its canvas and
    // GPU context) so only one renderer is ever mounted. A reload is ~100ms, so
    // recreating from scratch is cheaper than juggling two live canvases.
    this.engine?.dispose();
    const engine = createRenderEngine(kind, this.canvasHost, {
      log: (message) => this.logEngine(kind, message),
    });
    this.engine = engine;
    this.resizeEngine(engine);
    return engine;
  }

  private logEngine(kind: EngineKind, message: string): void {
    const text = `${kind}: ${message}`;
    post({ type: "log", level: "info", message: text });
    if (message.startsWith("load:")) {
      this.activeLoadStage = message.slice("load:".length).trim();
      this.setOverlay(`Loading with ${kind}… ${this.activeLoadStage}`, true);
    }
  }

  private currentEngine(): RenderEngine | undefined {
    return this.engine;
  }

  private findCanvasHost(): HTMLElement {
    const canvasHost = this.root.querySelector<HTMLElement>(".viewer-canvas");
    if (!canvasHost) {
      throw new Error("Viewer canvas host is not mounted.");
    }
    return canvasHost;
  }

  private readonly fit = (): void => {
    void this.currentEngine()?.fit();
  };

  private readonly reset = (): void => {
    void this.currentEngine()?.reset();
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    const canvas = this.currentEngine()?.canvas;
    if (!canvas) {
      return;
    }
    canvas.dataset.pointerDownX = String(event.clientX);
    canvas.dataset.pointerDownY = String(event.clientY);
  };

  private readonly onPointerUp = async (event: PointerEvent): Promise<void> => {
    const engine = this.currentEngine();
    if (!engine) {
      return;
    }
    const downX = Number(engine.canvas.dataset.pointerDownX);
    const downY = Number(engine.canvas.dataset.pointerDownY);
    if (Number.isFinite(downX) && Math.hypot(event.clientX - downX, event.clientY - downY) > 5) {
      return;
    }
    const expressId = await engine.pick(event.clientX, event.clientY);
    if (typeof expressId === "number") {
      post({ type: "pick", expressId });
    }
  };

  private setHud(message: LoadMessage): void {
    this.hudTitle = `${message.rootType ?? "Element"} #${message.rootId}`;
    const bits = [message.rootName, message.schema, message.fileName].filter(Boolean);
    this.hudSub = bits.join(" · ");
    this.hudStats = "";
    const warnings: string[] = [];
    if (message.childCount > 0) {
      warnings.push(`+${message.childCount} child element${message.childCount === 1 ? "" : "s"}`);
    }
    if (message.truncated) {
      warnings.push("⚠ extraction truncated (very large element)");
    }
    this.hudWarn = warnings.join(" · ");
    this.renderChrome();
  }

  private setOverlay(text: string, busy: boolean): void {
    this.overlayText = text;
    this.overlayBusy = busy;
    this.renderChrome();
  }

  private resize(): void {
    if (this.engine) {
      this.resizeEngine(this.engine);
    }
  }

  private resizeEngine(engine: RenderEngine): void {
    engine.resize(this.canvasHost.clientWidth || 1, this.canvasHost.clientHeight || 1);
  }

  private tick = (): void => {
    this.animationFrame = requestAnimationFrame(this.tick);
    const now = performance.now();
    const delta = now - this.lastFrame;
    this.lastFrame = now;
    this.currentEngine()?.update(delta);
  };

  private renderChrome(): void {
    renderHtml(
      viewerTemplate(this.templateState(), {
        onPointerDown: this.onPointerDown,
        onPointerUp: this.onPointerUp,
        onFit: this.fit,
        onReset: this.reset,
        onToggleEngine: this.toggleEngine,
      }),
      this.root,
    );
  }

  private templateState(): ViewerTemplateState {
    return {
      hudTitle: this.hudTitle,
      hudSub: this.hudSub,
      hudStats: this.hudStats,
      hudWarn: this.hudWarn,
      overlayText: this.overlayText,
      overlayBusy: this.overlayBusy,
      activeEngine: this.activeEngine,
      hasMessage: this.lastMessage !== undefined,
    };
  }
}

const app = document.getElementById("app");
if (app) {
  const viewer = new Viewer(app);
  window.addEventListener("message", (event: MessageEvent<HostToWebview>) => {
    const message = event.data;
    if (message.type === "load") {
      void viewer.render(message);
    }
  });
  window.addEventListener("unload", () => viewer.dispose());
  post({ type: "ready" });
}
