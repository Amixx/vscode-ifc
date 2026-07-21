import * as vscode from "vscode";
import { resolveExpressIdAtCursor } from "./viewer/expressId";
import { StepIndexCache } from "./viewer/indexCache";
import { StepFileIndex } from "./viewer/stepIndex";

const SPATIAL_TYPE_ICONS: Record<string, string> = {
  IFCPROJECT: "root-folder-opened",
  IFCSITE: "globe",
  IFCBUILDING: "home",
  IFCBUILDINGSTOREY: "layers",
  IFCSPACE: "symbol-method",
  IFCSPATIALZONE: "symbol-method",
};

function iconForType(type: string | undefined): vscode.ThemeIcon {
  if (type && SPATIAL_TYPE_ICONS[type]) {
    return new vscode.ThemeIcon(SPATIAL_TYPE_ICONS[type]);
  }
  return new vscode.ThemeIcon("file");
}

function shortType(type: string): string {
  return type.startsWith("IFC") ? type.slice(3) : type;
}

class IfcTreeNode extends vscode.TreeItem {
  constructor(
    readonly expressId: number,
    readonly uri: vscode.Uri,
    index: StepFileIndex,
  ) {
    const name = index.nameOf(expressId);
    const type = index.getType(expressId);
    const children = index.decompositionChildrenOf(expressId);

    super(
      name ?? `#${expressId}`,
      children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    this.id = String(expressId);
    this.description = type ? shortType(type) : undefined;
    this.iconPath = iconForType(type);
    this.contextValue = index.isPreviewable(expressId, includeChildren())
      ? "ifcNodePreviewable"
      : "ifcNode";
    this.command = {
      command: "ifc.revealInEditor",
      title: "Reveal in Editor",
      arguments: [{ uri, id: expressId }],
    };

    const tooltipParts = [`#${expressId}`];
    if (type) tooltipParts.push(type);
    if (name) tooltipParts.push(`"${name}"`);
    if (children.length > 0) tooltipParts.push(`(${children.length} children)`);
    this.tooltip = tooltipParts.join(" ");
  }
}

export class IfcModelTreeProvider implements vscode.TreeDataProvider<IfcTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<IfcTreeNode | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentUri: vscode.Uri | undefined;
  private nodeCache = new Map<number, IfcTreeNode>();
  private parentMap: Map<number, number> | undefined;
  private selectionDebounce: ReturnType<typeof setTimeout> | undefined;
  treeView: vscode.TreeView<IfcTreeNode> | undefined;

  constructor(
    private readonly indexCache: StepIndexCache,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  trackEditor(): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];

    disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor?.document.languageId === "ifc") {
          this.setCurrentUri(editor.document.uri);
        }
      }),
    );

    disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor.document.languageId !== "ifc") return;
        if (this.currentUri?.fsPath !== event.textEditor.document.uri.fsPath) return;
        if (this.selectionDebounce) clearTimeout(this.selectionDebounce);
        this.selectionDebounce = setTimeout(() => {
          const id = resolveExpressIdAtCursor(event.textEditor);
          if (id !== undefined) {
            this.revealNode(id);
          }
        }, 300);
      }),
    );

    disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.languageId === "ifc" && this.currentUri?.fsPath === doc.uri.fsPath) {
          this.indexCache.invalidate(doc.uri.fsPath);
          this.invalidate();
        }
      }),
    );

    return vscode.Disposable.from(...disposables);
  }

  setCurrentUri(uri: vscode.Uri): void {
    if (this.currentUri?.fsPath === uri.fsPath) return;
    this.currentUri = uri;
    if (this.treeView) {
      this.treeView.description = vscode.workspace.asRelativePath(uri, false);
    }
    this.invalidate();
  }

  private invalidate(): void {
    this.nodeCache.clear();
    this.parentMap = undefined;
    this._onDidChangeTreeData.fire(undefined);
  }

  refresh(): void {
    if (this.currentUri?.scheme === "file") {
      this.indexCache.invalidate(this.currentUri.fsPath);
    }
    this.invalidate();
  }

  getTreeItem(element: IfcTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: IfcTreeNode): Promise<IfcTreeNode[]> {
    if (!this.currentUri) return [];

    let index: StepFileIndex;
    try {
      index = await this.indexCache.get(this.currentUri, maxFileSizeMb());
    } catch (error) {
      if (!element && this.treeView) {
        this.treeView.message = error instanceof Error ? error.message : String(error);
      }
      this.output.warn(
        `IFC model tree could not index ${this.currentUri.fsPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }

    if (!element) {
      if (this.treeView) {
        this.treeView.message =
          index.projectId === undefined ? "This file does not contain an IfcProject." : undefined;
      }
      if (index.projectId === undefined) return [];
      return [this.getOrCreateNode(index.projectId, index)];
    }

    const childIds = [...new Set(index.decompositionChildrenOf(element.expressId))];
    return childIds
      .sort((a, b) => {
        const aSpatial = index.isSpatialContainer(a) ? 0 : 1;
        const bSpatial = index.isSpatialContainer(b) ? 0 : 1;
        if (aSpatial !== bSpatial) return aSpatial - bSpatial;
        return a - b;
      })
      .map((id) => this.getOrCreateNode(id, index));
  }

  getParent(element: IfcTreeNode): IfcTreeNode | undefined {
    if (!this.currentUri) return undefined;
    const index = this.indexCache.getCached(this.currentUri.fsPath);
    if (!index) return undefined;
    const parentMap = this.ensureParentMap(index);
    const parentId = parentMap.get(element.expressId);
    if (parentId === undefined) return undefined;
    return this.getOrCreateNode(parentId, index);
  }

  private getOrCreateNode(id: number, index: StepFileIndex): IfcTreeNode {
    let node = this.nodeCache.get(id);
    if (!node) {
      const uri = this.currentUri;
      if (!uri) {
        throw new Error("Cannot create an IFC model tree node without an active model.");
      }
      node = new IfcTreeNode(id, uri, index);
      this.nodeCache.set(id, node);
    }
    return node;
  }

  private async revealNode(expressId: number): Promise<void> {
    if (!this.currentUri || !this.treeView) return;

    let index: StepFileIndex;
    try {
      index = await this.indexCache.get(this.currentUri, maxFileSizeMb());
    } catch {
      return;
    }

    if (!index.hasId(expressId)) return;

    const path = this.buildPathTo(index, expressId);
    if (path.length === 0) return;

    for (const id of path) {
      this.getOrCreateNode(id, index);
    }

    const targetNode = this.nodeCache.get(expressId);
    if (targetNode) {
      try {
        await this.treeView.reveal(targetNode, { select: true, focus: false, expand: 1 });
      } catch {
        // Node not yet in the rendered tree (parents not expanded); ignore.
      }
    }
  }

  private ensureParentMap(index: StepFileIndex): Map<number, number> {
    if (this.parentMap) return this.parentMap;

    const map = new Map<number, number>();
    if (index.projectId !== undefined) {
      const stack = [index.projectId];
      const seen = new Set<number>();
      while (stack.length > 0) {
        const parentId = stack.pop();
        if (parentId === undefined) break;
        if (seen.has(parentId)) continue;
        seen.add(parentId);
        for (const childId of index.decompositionChildrenOf(parentId)) {
          map.set(childId, parentId);
          stack.push(childId);
        }
      }
    }
    this.parentMap = map;
    return map;
  }

  private buildPathTo(index: StepFileIndex, targetId: number): number[] {
    const parentMap = this.ensureParentMap(index);
    const path: number[] = [targetId];
    let current = targetId;
    while (parentMap.has(current)) {
      const parent = parentMap.get(current);
      if (parent === undefined) break;
      current = parent;
      path.unshift(current);
    }
    if (path[0] !== index.projectId) return [];
    return path;
  }

  dispose(): void {
    this.nodeCache.clear();
    this.parentMap = undefined;
    if (this.selectionDebounce) clearTimeout(this.selectionDebounce);
    this._onDidChangeTreeData.dispose();
  }
}

export function registerModelTree(
  context: vscode.ExtensionContext,
  indexCache: StepIndexCache,
  output: vscode.LogOutputChannel,
): void {
  const provider = new IfcModelTreeProvider(indexCache, output);

  const treeView = vscode.window.createTreeView("ifcModelTree", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.treeView = treeView;

  context.subscriptions.push(
    treeView,
    provider,
    provider.trackEditor(),

    vscode.commands.registerCommand(
      "ifc.revealInEditor",
      async (arg?: { uri?: vscode.Uri; id?: number }) => {
        if (!arg?.uri || typeof arg.id !== "number") return;
        try {
          const index = await indexCache.get(arg.uri, maxFileSizeMb());
          const doc = await vscode.workspace.openTextDocument(arg.uri);
          const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.One,
            preserveFocus: false,
          });
          const pos = index.positionOf(arg.id);
          if (pos) {
            const position = new vscode.Position(pos.line, pos.character);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(
              new vscode.Range(position, position),
              vscode.TextEditorRevealType.InCenter,
            );
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          output.error(`IFC reveal failed: ${message}`);
        }
      },
    ),

    vscode.commands.registerCommand("ifc.modelTreePreviewElement", (node?: IfcTreeNode) => {
      if (node) {
        void vscode.commands.executeCommand("ifc.viewElement", {
          uri: node.uri,
          id: node.expressId,
        });
      }
    }),

    vscode.commands.registerCommand("ifc.refreshModelTree", () => provider.refresh()),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("ifc.viewer.maxFileSizeMb") ||
        event.affectsConfiguration("ifc.viewer.includeChildren")
      ) {
        provider.refresh();
      }
    }),
  );

  const activeEditor = vscode.window.activeTextEditor;
  if (activeEditor?.document.languageId === "ifc") {
    provider.setCurrentUri(activeEditor.document.uri);
  }
}

function maxFileSizeMb(): number {
  return vscode.workspace.getConfiguration("ifc").get<number>("viewer.maxFileSizeMb", 400);
}

function includeChildren(): boolean {
  return vscode.workspace.getConfiguration("ifc").get<boolean>("viewer.includeChildren", true);
}
