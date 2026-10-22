import * as vscode from "vscode";
import { IfcLanguageClientManager, IfcSpatialTreeNode } from "./client";

const VIEW_ID = "ifc.modelTree";

interface IfcModelTreeItemPayload {
  uri: vscode.Uri;
  node: IfcSpatialTreeNode;
}

class IfcModelTreeItem extends vscode.TreeItem {
  constructor(
    readonly uri: vscode.Uri,
    readonly node: IfcSpatialTreeNode,
  ) {
    super(
      node.label,
      node.hasChildren
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );

    this.id = `${uri.toString()}#${node.id}`;
    this.description = node.description;
    this.contextValue = "ifcModelTreeNode";
    this.iconPath = iconForEntity(node.entityName);
    this.tooltip = `${node.entityName} #${node.id}${
      node.childCount > 0 ? ` (${node.childCount} children)` : ""
    }`;
    this.command = {
      command: "ifc.modelTree.preview",
      title: "Preview in 3D",
      arguments: [this.payload],
    };
  }

  get payload(): IfcModelTreeItemPayload {
    return { uri: this.uri, node: this.node };
  }
}

class IfcModelTreeProvider implements vscode.TreeDataProvider<IfcModelTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    IfcModelTreeItem | undefined
  >();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private uri: vscode.Uri | undefined;

  constructor(
    private readonly manager: IfcLanguageClientManager,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  setActiveDocument(document: vscode.TextDocument | undefined): void {
    const nextUri = document?.languageId === "ifc" && document.uri.scheme === "file"
      ? document.uri
      : undefined;

    if (this.uri?.toString() === nextUri?.toString()) {
      return;
    }

    this.uri = nextUri;
    this.refresh();
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: IfcModelTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: IfcModelTreeItem): Promise<IfcModelTreeItem[]> {
    const uri = element?.uri ?? this.uri;
    if (!uri) {
      return [];
    }

    try {
      const nodes = await this.manager.spatialTreeChildren(uri, element?.node.id);
      return nodes.map((node) => new IfcModelTreeItem(uri, node));
    } catch (error) {
      this.output.error(`Failed to load IFC model tree: ${asMessage(error)}`);
      return [];
    }
  }
}

export function registerModelTree(
  context: vscode.ExtensionContext,
  manager: IfcLanguageClientManager,
  output: vscode.LogOutputChannel,
): void {
  const provider = new IfcModelTreeProvider(manager, output);
  provider.setActiveDocument(vscode.window.activeTextEditor?.document);

  context.subscriptions.push(
    vscode.window.createTreeView(VIEW_ID, {
      treeDataProvider: provider,
      showCollapseAll: true,
    }),
    vscode.commands.registerCommand("ifc.modelTree.refresh", () => provider.refresh()),
    vscode.commands.registerCommand("ifc.modelTree.revealInEditor", async (payload) => {
      await revealPayload(payload);
    }),
    vscode.commands.registerCommand("ifc.modelTree.preview", async (payload) => {
      await previewPayload(payload);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      provider.setActiveDocument(editor?.document);
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.toString() === vscode.window.activeTextEditor?.document.uri.toString()) {
        provider.refresh();
      }
    }),
  );
}

async function previewPayload(payload: IfcModelTreeItemPayload | undefined): Promise<void> {
  if (!payload) {
    return;
  }

  const commands = await vscode.commands.getCommands(true);
  if (commands.includes("ifc.viewElement")) {
    await vscode.commands.executeCommand("ifc.viewElement", {
      uri: payload.uri,
      id: payload.node.id,
    });
    return;
  }

  await revealPayload(payload);
  void vscode.window.showInformationMessage(
    "3D preview command is not available in this extension build.",
  );
}

async function revealPayload(payload: IfcModelTreeItemPayload | undefined): Promise<void> {
  if (!payload) {
    return;
  }

  const document = await vscode.workspace.openTextDocument(payload.uri);
  const editor = await vscode.window.showTextDocument(document, { preview: false });
  const range = toVsCodeRange(payload.node.range);
  editor.selection = new vscode.Selection(range.start, range.start);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function toVsCodeRange(range: IfcSpatialTreeNode["range"]): vscode.Range {
  return new vscode.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

function iconForEntity(entityName: string): vscode.ThemeIcon {
  switch (entityName) {
    case "IFCPROJECT":
      return new vscode.ThemeIcon("project");
    case "IFCSITE":
      return new vscode.ThemeIcon("globe");
    case "IFCBUILDING":
      return new vscode.ThemeIcon("home");
    case "IFCBUILDINGSTOREY":
      return new vscode.ThemeIcon("layers");
    case "IFCSPACE":
      return new vscode.ThemeIcon("symbol-namespace");
    default:
      return new vscode.ThemeIcon("symbol-misc");
  }
}

function asMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
