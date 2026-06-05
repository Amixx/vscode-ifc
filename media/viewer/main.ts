import "./viewer.css";
import { createRenderEngine, RenderEngine } from "./engine";
import type { EngineKind, HostToWebview, LoadMessage, WebviewToHost } from "../../src/viewer/protocol";

declare function acquireVsCodeApi(): { postMessage(message: WebviewToHost): void };

const vscode = acquireVsCodeApi();

function post(message: WebviewToHost): void {
  vscode.postMessage(message);
}

class Viewer {
  private readonly canvasHost: HTMLElement;
  private readonly hudTitle: HTMLElement;
  private readonly hudSub: HTMLElement;
  private readonly hudStats: HTMLElement;
  private readonly hudWarn: HTMLElement;
  private readonly overlay: HTMLElement;

  private engine: RenderEngine | undefined;
  private activeEngine: EngineKind = "web-ifc";
  private engineButton: HTMLButtonElement | undefined;
  private lastMessage: LoadMessage | undefined;
  private renderSeq = 0;
  private lastFrame = performance.now();
  private activeLoadStage = "";

  constructor(root: HTMLElement) {
    this.canvasHost = el("div", "viewer-canvas");
    const hud = el("div", "hud");
    this.hudTitle = el("div", "hud-title");
    this.hudSub = el("div", "hud-sub");
    this.hudStats = el("div", "hud-stats");
    this.hudWarn = el("div", "hud-warn");
    hud.append(this.hudTitle, this.hudSub, this.hudStats, this.hudWarn);

    const toolbar = this.buildToolbar();
    this.overlay = el("div", "state-overlay");
    const hint = el("div", "hint");
    hint.textContent = "Click geometry to jump to its source line · drag to orbit · scroll to zoom";
    root.append(this.canvasHost, hud, toolbar, this.overlay, hint);

    new ResizeObserver(() => this.resize()).observe(this.canvasHost);
    this.canvasHost.addEventListener("pointerdown", (event) => this.onPointerDown(event));
    this.canvasHost.addEventListener("pointerup", (event) => void this.onPointerUp(event));

    this.resize();
    this.animate();
  }

  private buildToolbar(): HTMLElement {
    const bar = el("div", "toolbar");
    const buttons: Array<[string, string, () => void]> = [
      ["Fit", "Frame the element", () => void this.currentEngine()?.fit()],
      ["Reset", "Reset the camera", () => void this.currentEngine()?.reset()],
    ];
    for (const [label, title, action] of buttons) {
      const button = el("button", "tool-button");
      button.textContent = label;
      button.title = title;
      button.addEventListener("click", action);
      bar.appendChild(button);
    }

    const engineButton = el("button", "tool-button") as HTMLButtonElement;
    engineButton.title = "Switch renderer (ThatOpen/web-ifc ↔ ifc-lite)";
    engineButton.addEventListener("click", () => void this.toggleEngine());
    bar.appendChild(engineButton);
    this.engineButton = engineButton;
    this.updateEngineButton();
    return bar;
  }

  private updateEngineButton(): void {
    if (!this.engineButton) {
      return;
    }
    this.engineButton.textContent = `Engine: ${this.activeEngine}`;
    this.engineButton.disabled = this.lastMessage === undefined;
  }

  async render(message: LoadMessage): Promise<void> {
    this.lastMessage = message;
    this.activeEngine = message.engine;
    this.updateEngineButton();
    await this.renderWith(message.engine);
  }

  private async toggleEngine(): Promise<void> {
    if (!this.lastMessage) {
      return;
    }
    this.activeEngine = this.activeEngine === "ifc-lite" ? "web-ifc" : "ifc-lite";
    this.updateEngineButton();
    await this.renderWith(this.activeEngine);
  }

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
      this.hudStats.textContent =
        `${stats.meshes} mesh${stats.meshes === 1 ? "" : "es"}` +
        (stats.triangles === undefined ? "" : ` · ${stats.triangles.toLocaleString()} tris`) +
        ` · ${engineKind} · ${elapsedMs} ms`;
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

  private onPointerDown(event: PointerEvent): void {
    const canvas = this.currentEngine()?.canvas;
    if (!canvas) {
      return;
    }
    canvas.dataset.pointerDownX = String(event.clientX);
    canvas.dataset.pointerDownY = String(event.clientY);
  }

  private async onPointerUp(event: PointerEvent): Promise<void> {
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
  }

  private setHud(message: LoadMessage): void {
    this.hudTitle.textContent = `${message.rootType ?? "Element"} #${message.rootId}`;
    const bits = [message.rootName, message.schema, message.fileName].filter(Boolean);
    this.hudSub.textContent = bits.join(" · ");
    this.hudStats.textContent = "";
    const warnings: string[] = [];
    if (message.childCount > 0) {
      warnings.push(`+${message.childCount} child element${message.childCount === 1 ? "" : "s"}`);
    }
    if (message.truncated) {
      warnings.push("⚠ extraction truncated (very large element)");
    }
    this.hudWarn.textContent = warnings.join(" · ");
  }

  private setOverlay(text: string, busy: boolean): void {
    this.overlay.textContent = text;
    this.overlay.classList.toggle("busy", busy);
    this.overlay.style.display = text || busy ? "flex" : "none";
  }

  private resize(): void {
    if (this.engine) {
      this.resizeEngine(this.engine);
    }
  }

  private resizeEngine(engine: RenderEngine): void {
    engine.resize(this.canvasHost.clientWidth || 1, this.canvasHost.clientHeight || 1);
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    const now = performance.now();
    const delta = now - this.lastFrame;
    this.lastFrame = now;
    this.currentEngine()?.update(delta);
  };
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
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
  post({ type: "ready" });
}
