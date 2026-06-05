import { GeometryProcessor } from "@ifc-lite/geometry";
import { Renderer as IfcLiteRenderer } from "@ifc-lite/renderer";
import type { EngineOptions, RenderEngine, RenderLoad, RenderStats } from "./engine";
import type { EngineKind } from "../../src/viewer/protocol";

function canvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  return { x: clientX - rect.left, y: clientY - rect.top };
}

/** IFC-Lite geometry processor + IFC-Lite WebGPU renderer. */
export class IfcLiteRenderEngine implements RenderEngine {
  readonly kind: EngineKind = "ifc-lite";

  private renderer: IfcLiteRenderer | undefined;
  private processor: GeometryProcessor | undefined;
  private pointerDown: { x: number; y: number } | undefined;
  private selectedId: number | undefined;

  constructor(private readonly container: HTMLElement, private readonly options: EngineOptions = {}) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "viewer-render-canvas";
    this.container.appendChild(this.canvas);
    this.installControls();
  }

  readonly canvas: HTMLCanvasElement;

  async load(load: RenderLoad): Promise<RenderStats> {
    await this.resetRenderer();
    const processor = await this.getProcessor();
    const result = await processor.process(load.bytes);
    this.renderer!.loadGeometry(result);
    this.renderer!.fitToView();
    this.renderer!.requestRender();
    return {
      meshes: result.meshes.length,
      triangles: result.totalTriangles,
    };
  }

  fit(): void {
    this.renderer?.fitToView();
    this.renderer?.requestRender();
  }

  reset(): void {
    this.fit();
  }

  async pick(clientX: number, clientY: number): Promise<number | undefined> {
    if (!this.renderer) {
      return undefined;
    }
    const point = canvasPoint(this.canvas, clientX, clientY);
    const hit = await this.renderer.pick(point.x, point.y);
    if (!hit || hit.expressId <= 0) {
      this.options.log?.(`pick: no element at ${Math.round(point.x)},${Math.round(point.y)}`);
      return undefined;
    }
    const meshData = this.renderer.getScene().getMeshData(hit.expressId, hit.modelIndex);
    if (!meshData) {
      this.options.log?.(`pick: hit ${hit.expressId}, but no per-element mesh data was available`);
      return undefined;
    }
    this.renderer.createMeshFromData(meshData);
    this.selectedId = hit.expressId;
    this.renderer.requestRender();
    this.options.log?.(`pick: selected #${hit.expressId}`);
    return hit.expressId;
  }

  resize(width: number, height: number): void {
    this.renderer?.resize(width, height);
    this.renderer?.requestRender();
  }

  update(deltaMs: number): void {
    const cameraMoving = this.renderer?.getCamera().update(deltaMs / 1000) ?? false;
    if (cameraMoving) {
      this.renderer?.requestRender();
    }
    if (this.renderer?.consumeRenderRequest()) {
      this.renderer.render({ selectedId: this.selectedId });
    }
  }

  dispose(): void {
    this.renderer?.destroy();
    this.processor?.dispose();
    this.canvas.remove();
  }

  private async resetRenderer(): Promise<void> {
    this.renderer?.destroy();
    const renderer = new IfcLiteRenderer(this.canvas);
    await renderer.init();
    this.renderer = renderer;
    this.selectedId = undefined;
    this.resize(this.container.clientWidth || 1, this.container.clientHeight || 1);
  }

  private async getProcessor(): Promise<GeometryProcessor> {
    if (this.processor) {
      return this.processor;
    }
    const processor = new GeometryProcessor();
    await processor.init();
    this.processor = processor;
    return processor;
  }

  private installControls(): void {
    this.canvas.addEventListener("pointerdown", (event) => {
      this.pointerDown = { x: event.clientX, y: event.clientY };
      this.canvas.setPointerCapture(event.pointerId);
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.pointerDown || !this.renderer) {
        return;
      }
      const dx = event.clientX - this.pointerDown.x;
      const dy = event.clientY - this.pointerDown.y;
      this.pointerDown = { x: event.clientX, y: event.clientY };
      const camera = this.renderer.getCamera();
      if (event.shiftKey || event.buttons === 4) {
        camera.pan(dx, dy);
      } else {
        camera.orbit(dx, dy);
      }
      this.renderer.requestRender();
    });
    this.canvas.addEventListener("pointerup", () => {
      this.pointerDown = undefined;
    });
    this.canvas.addEventListener("wheel", (event) => {
      if (!this.renderer) {
        return;
      }
      event.preventDefault();
      const point = canvasPoint(this.canvas, event.clientX, event.clientY);
      this.renderer.getCamera().zoom(event.deltaY, false, point.x, point.y, this.canvas.clientWidth, this.canvas.clientHeight);
      this.renderer.requestRender();
    });
  }
}
