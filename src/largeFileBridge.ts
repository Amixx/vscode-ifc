import * as vscode from "vscode";
import { IfcLanguageClientManager } from "./client";
import { IfcLargeFileSystemProvider } from "./largeFileSystemProvider";

const IFC_EXTENSIONS = [".ifc", ".step", ".stp"];
const IFC_LARGE_SCHEME = "ifc-large";

// VS Code stops syncing documents past ~50 MB to the extension host.
// Files at/above this size never produce textDocument/didOpen, so the server
// would never learn about them through the normal LSP path.
const SYNC_CAP_BYTES = 50 * 1024 * 1024;
// Could be promoted to a setting alongside `ifc.largeFiles.cache.maxSourceBytesMB`.
const LARGE_FILE_CACHE_MAX_ENTRIES = 3;

type LspPosition = {
  line: number;
  character: number;
};

type LspRange = {
  start: LspPosition;
  end: LspPosition;
};

type LspLocation = {
  uri: string;
  range: LspRange;
};

type LspLocationLink = {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
  originSelectionRange?: LspRange;
};

type LspHover = {
  contents:
    | string
    | { language?: string; value: string }
    | { kind: string; value: string }
    | Array<string | { language?: string; value: string } | { kind: string; value: string }>;
  range?: LspRange;
};

type LspDiagnostic = {
  range: LspRange;
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
};

type LargeFileCacheEntry = {
  uri: vscode.Uri;
  sourceBytes: number;
  pinned: boolean;
  lastUsed: number;
};

function tabUri(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input as { uri?: unknown } | undefined;
  if (input && input.uri instanceof vscode.Uri) {
    return input.uri;
  }
  return undefined;
}

function isCandidateIfcUri(uri: vscode.Uri): boolean {
  if (uri.scheme !== "file") return false;
  const lower = uri.path.toLowerCase();
  return IFC_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function toLargeUri(fileUri: vscode.Uri): vscode.Uri {
  return fileUri.with({ scheme: IFC_LARGE_SCHEME });
}

function toFileUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ scheme: "file" });
}

function toLspPosition(position: vscode.Position): LspPosition {
  return { line: position.line, character: position.character };
}

function toVsCodePosition(position: LspPosition): vscode.Position {
  return new vscode.Position(position.line, position.character);
}

function toVsCodeRange(range: LspRange): vscode.Range {
  return new vscode.Range(toVsCodePosition(range.start), toVsCodePosition(range.end));
}

function uriForLargeDocument(uri: string): vscode.Uri {
  return toLargeUri(vscode.Uri.parse(uri));
}

async function isCapExceeded(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.size >= SYNC_CAP_BYTES;
  } catch {
    return false;
  }
}

export function setupDiskOpenBridge(
  context: vscode.ExtensionContext,
  manager: IfcLanguageClientManager,
  output: vscode.LogOutputChannel,
): void {
  const indexed = new Set<string>();
  const indexing = new Map<string, Promise<boolean>>();
  const cachedLargeFiles = new Map<string, LargeFileCacheEntry>();
  const promptedOpenTabs = new Set<string>();
  const visibleDiagnosticTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let warnedUnsupportedLargeFiles = false;
  const diagnostics = vscode.languages.createDiagnosticCollection("ifc-large");
  const largeFileProvider = new IfcLargeFileSystemProvider();

  context.subscriptions.push(diagnostics);

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(IFC_LARGE_SCHEME, largeFileProvider, {
      isReadonly: true,
      isCaseSensitive: true,
    }),
  );

  const supports = (): boolean => {
    const exp = manager.serverCapabilities?.experimental as
      | { ifcLargeFileFeatures?: unknown }
      | undefined;
    return exp?.ifcLargeFileFeatures === true;
  };

  const warnUnsupportedLargeFiles = (): void => {
    if (warnedUnsupportedLargeFiles) return;
    warnedUnsupportedLargeFiles = true;
    output.warn("The active IFC language server does not support large-file disk loading.");
    void vscode.window.showWarningMessage(
      "The active IFC language server does not support large-file disk loading.",
    );
  };

  const openOnServer = async (
    uri: vscode.Uri,
    token?: vscode.CancellationToken,
    pinOnSuccess = false,
  ): Promise<boolean> => {
    const key = uri.toString();
    if (indexed.has(key)) {
      await touchCachedLargeFile(uri, pinOnSuccess ? true : undefined);
      return true;
    }
    const existing = indexing.get(key);
    if (existing) return existing;
    if (!supports()) {
      warnUnsupportedLargeFiles();
      return false;
    }
    const sourceBytes = await sourceSize(uri);
    const fileName = uri.path.split("/").pop() ?? key;
    const request = Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Indexing ${fileName} (large file)`,
          cancellable: true,
        },
        async (_progress, progressToken) => {
          if (token?.isCancellationRequested || progressToken.isCancellationRequested) {
            return false;
          }
          const disposable = token?.onCancellationRequested(() => {
            // `sendRequest` observes only one token. User-initiated cancellation
            // from the progress notification is the primary cancellation path.
          });
          try {
            await manager.sendRequest<void>(
              "ifc/openFromDisk",
              { uri: key },
              progressToken,
            );
          } finally {
            disposable?.dispose();
          }
          return !progressToken.isCancellationRequested;
        },
      ),
    )
      .then(
        async (completed) => {
          if (completed) {
            indexed.add(key);
            cachedLargeFiles.set(key, {
              uri,
              sourceBytes,
              pinned: pinOnSuccess || isLargeDocumentOpen(uri),
              lastUsed: Date.now(),
            });
            output.info(`Requested server-side load for ${key}`);
            await enforceCacheBudget();
          } else {
            output.info(`Cancelled server-side load for ${key}`);
          }
          return completed;
        },
        (error: unknown) => {
          output.error(
            `Server-side load failed for ${key}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return false;
        },
      )
      .finally(() => {
        indexing.delete(key);
      });
    indexing.set(key, request);
    return request;
  };

  const closeOnServer = async (uri: vscode.Uri): Promise<void> => {
    const key = uri.toString();
    cachedLargeFiles.delete(key);
    if (!indexed.delete(key)) return;
    if (!supports()) return;
    try {
      await manager.sendRequest<void>("ifc/closeFromDisk", { uri: key });
      output.info(`Evicted cached large IFC document: ${key}`);
    } catch {
      // Server might already be down or restarting; nothing actionable.
    }
  };

  const touchCachedLargeFile = async (
    uri: vscode.Uri,
    pinned?: boolean,
  ): Promise<void> => {
    const key = uri.toString();
    const entry = cachedLargeFiles.get(key);
    if (!entry) {
      if (indexed.has(key)) {
        cachedLargeFiles.set(key, {
          uri,
          sourceBytes: await sourceSize(uri),
          pinned: pinned ?? isLargeDocumentOpen(uri),
          lastUsed: Date.now(),
        });
      }
      return;
    }

    entry.lastUsed = Date.now();
    if (pinned !== undefined) entry.pinned = pinned;
    cachedLargeFiles.set(key, entry);
    await enforceCacheBudget();
  };

  const enforceCacheBudget = async (): Promise<void> => {
    const { maxEntries, maxSourceBytes } = largeFileCacheConfig();
    let entries = [...cachedLargeFiles.values()];
    let totalSourceBytes = entries.reduce((sum, entry) => sum + entry.sourceBytes, 0);

    const evictable = entries
      .filter((entry) => !entry.pinned)
      .sort((a, b) => a.lastUsed - b.lastUsed);

    while (
      (cachedLargeFiles.size > maxEntries || totalSourceBytes > maxSourceBytes) &&
      evictable.length > 0
    ) {
      const entry = evictable.shift();
      if (!entry) break;
      totalSourceBytes -= entry.sourceBytes;
      await closeOnServer(entry.uri);
    }

    entries = [...cachedLargeFiles.values()];
    totalSourceBytes = entries.reduce((sum, entry) => sum + entry.sourceBytes, 0);
    if (cachedLargeFiles.size > maxEntries || totalSourceBytes > maxSourceBytes) {
      output.warn(
        `Large IFC cache exceeds configured budget, but all remaining entries are open/pinned (${cachedLargeFiles.size} files, ${Math.round(totalSourceBytes / 1024 / 1024)} MB source text).`,
      );
    }
  };

  const setDiagnostics = (largeUri: vscode.Uri, items: LspDiagnostic[]): void => {
    diagnostics.set(
      largeUri,
      items.map((item) => {
        const diagnostic = new vscode.Diagnostic(
          toVsCodeRange(item.range),
          item.message,
          toVsCodeDiagnosticSeverity(item.severity),
        );
        diagnostic.source = item.source;
        diagnostic.code = item.code;
        return diagnostic;
      }),
    );
  };

  const refreshVisibleDiagnostics = async (
    editor: vscode.TextEditor,
    token?: vscode.CancellationToken,
  ): Promise<void> => {
    if (editor.document.uri.scheme !== IFC_LARGE_SCHEME) return;
    if (!supports()) return;
    const fileUri = toFileUri(editor.document.uri);
    if (!(await openOnServer(fileUri, token))) return;
    if (token?.isCancellationRequested) return;

    const ranges = editor.visibleRanges.map((range) => ({
      start: toLspPosition(range.start),
      end: toLspPosition(range.end),
    }));
    if (ranges.length === 0) return;

    try {
      const items = await manager.sendRequest<LspDiagnostic[]>(
        "ifc/visibleDiagnostics",
        { uri: fileUri.toString(), ranges },
        token,
      );
      if (token?.isCancellationRequested) return;
      setDiagnostics(editor.document.uri, items);
    } catch (error) {
      output.error(
        `Failed to refresh visible large-file diagnostics for ${fileUri.toString()}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const scheduleVisibleDiagnostics = (editor: vscode.TextEditor): void => {
    if (editor.document.uri.scheme !== IFC_LARGE_SCHEME) return;
    const key = editor.document.uri.toString();
    const existing = visibleDiagnosticTimers.get(key);
    if (existing) clearTimeout(existing);
    visibleDiagnosticTimers.set(
      key,
      setTimeout(() => {
        visibleDiagnosticTimers.delete(key);
        void refreshVisibleDiagnostics(editor);
      }, 300),
    );
  };

  const refreshDiagnostics = async (fileUri: vscode.Uri): Promise<void> => {
    if (!supports()) return;
    const sourceBytes = await sourceSize(fileUri);
    const maxSourceBytes = SYNC_CAP_BYTES;
    if (sourceBytes > maxSourceBytes) {
      diagnostics.delete(toLargeUri(fileUri));
      return;
    }

    try {
      const started = Date.now();
      const items = await manager.sendRequest<LspDiagnostic[]>(
        "ifc/diagnostics",
        fileUri.toString(),
      );
      setDiagnostics(toLargeUri(fileUri), items);
      output.info(
        `Refreshed large-file diagnostics for ${fileUri.toString()} (${items.length} diagnostics, ${Date.now() - started}ms).`,
      );
    } catch (error) {
      output.error(
        `Failed to refresh large-file diagnostics for ${fileUri.toString()}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const openLargeDocument = async (fileUri: vscode.Uri): Promise<boolean> => {
    if (!isCandidateIfcUri(fileUri)) {
      void vscode.window.showWarningMessage("Select a local .ifc, .step, or .stp file.");
      return false;
    }

    largeFileProvider.mark(toLargeUri(fileUri));
    if (!(await openOnServer(fileUri, undefined, true))) return false;
    const document = await vscode.workspace.openTextDocument(toLargeUri(fileUri));
    const ifcDocument =
      document.languageId === "ifc"
        ? document
        : await vscode.languages.setTextDocumentLanguage(document, "ifc");
    const editor = await vscode.window.showTextDocument(ifcDocument, { preview: false });
    largeFileProvider.forceFullReload(toLargeUri(fileUri));
    await touchCachedLargeFile(fileUri, true);
    await refreshDiagnostics(fileUri);
    await refreshVisibleDiagnostics(editor);
    return true;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "ifc.openLargeFileWithLanguageFeatures",
      async (uri?: vscode.Uri) => {
        const selected = uri ?? (await pickIfcFile());
        if (!selected) return;
        await openLargeDocument(toFileUri(selected));
      },
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      { language: "ifc", scheme: IFC_LARGE_SCHEME },
      {
        provideHover: async (document, position, token) => {
          const fileUri = toFileUri(document.uri);
          if (!(await openOnServer(fileUri, token))) return undefined;
          if (token.isCancellationRequested) return undefined;
          const hover = await manager.sendRequest<LspHover | null>(
            "textDocument/hover",
            {
              textDocument: { uri: fileUri.toString() },
              position: toLspPosition(position),
            },
            token,
          );
          return hover ? toVsCodeHover(hover) : undefined;
        },
      },
    ),
  );

  context.subscriptions.push(
    vscode.languages.registerDefinitionProvider(
      { language: "ifc", scheme: IFC_LARGE_SCHEME },
      {
        provideDefinition: async (document, position, token) => {
          const fileUri = toFileUri(document.uri);
          if (!(await openOnServer(fileUri, token))) return undefined;
          if (token.isCancellationRequested) return undefined;
          const response = await manager.sendRequest<
            LspLocation | LspLocation[] | LspLocationLink[] | null
          >(
            "textDocument/definition",
            {
              textDocument: { uri: fileUri.toString() },
              position: toLspPosition(position),
            },
            token,
          );
          return toVsCodeDefinition(response);
        },
      },
    ),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      scheduleVisibleDiagnostics(event.textEditor);
    }),
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) scheduleVisibleDiagnostics(editor);
    }),
  );

  const maybeOpenLargeTab = async (uri: vscode.Uri): Promise<void> => {
    if (!isCandidateIfcUri(uri)) return;
    if (!(await isCapExceeded(uri))) return;
    const key = uri.toString();
    if (promptedOpenTabs.has(key)) return;
    promptedOpenTabs.add(key);
    const action = await vscode.window.showInformationMessage(
      "This IFC file is too large for VS Code's normal extension-host sync. Open a read-only IFC view with hover, navigation, and diagnostics?",
      "Open IFC View",
    );
    if (action === "Open IFC View") {
      const opened = await openLargeDocument(uri);
      if (!opened) {
        promptedOpenTabs.delete(key);
      }
    }
  };

  const scanAllTabs = async (): Promise<void> => {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const uri = tabUri(tab);
        if (uri) await maybeOpenLargeTab(uri);
      }
    }
  };

  context.subscriptions.push(
    manager.onDidStart(() => {
      indexed.clear();
      indexing.clear();
      cachedLargeFiles.clear();
      warnedUnsupportedLargeFiles = false;
      // `promptedOpenTabs` is deliberately not cleared: the tab is still open,
      // re-prompting on every server restart would be noisy. Already-open
      // `ifc-large:` tabs lazily re-index on the next hover/definition request.
      void scanAllTabs();
    }),
  );

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      for (const tab of [...event.opened, ...event.changed]) {
        const uri = tabUri(tab);
        if (uri) void maybeOpenLargeTab(uri);
      }
      for (const tab of event.closed) {
        const uri = tabUri(tab);
        if (uri) {
          promptedOpenTabs.delete(uri.toString());
        }
      }
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      if (document.uri.scheme !== IFC_LARGE_SCHEME) return;
      diagnostics.delete(document.uri);
      const timer = visibleDiagnosticTimers.get(document.uri.toString());
      if (timer) {
        clearTimeout(timer);
        visibleDiagnosticTimers.delete(document.uri.toString());
      }
      void touchCachedLargeFile(toFileUri(document.uri), false);
    }),
  );

  function isLargeDocumentOpen(fileUri: vscode.Uri): boolean {
    const largeKey = toLargeUri(fileUri).toString();
    return vscode.workspace.textDocuments.some(
      (document) => document.uri.toString() === largeKey,
    );
  }
}

async function sourceSize(uri: vscode.Uri): Promise<number> {
  try {
    return (await vscode.workspace.fs.stat(uri)).size;
  } catch {
    return 0;
  }
}

function largeFileCacheConfig(): { maxEntries: number; maxSourceBytes: number } {
  const config = vscode.workspace.getConfiguration("ifc");
  const maxSourceBytesMB = Math.max(
    1,
    config.get<number>("largeFiles.cache.maxSourceBytesMB", 300),
  );
  return {
    maxEntries: LARGE_FILE_CACHE_MAX_ENTRIES,
    maxSourceBytes: maxSourceBytesMB * 1024 * 1024,
  };
}

async function pickIfcFile(): Promise<vscode.Uri | undefined> {
  const uris = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { "IFC files": ["ifc", "step", "stp"] },
    openLabel: "Open read-only IFC view",
  });
  return uris?.[0];
}

function toVsCodeDiagnosticSeverity(severity: number | undefined): vscode.DiagnosticSeverity {
  switch (severity) {
    case 1:
      return vscode.DiagnosticSeverity.Error;
    case 2:
      return vscode.DiagnosticSeverity.Warning;
    case 3:
      return vscode.DiagnosticSeverity.Information;
    case 4:
      return vscode.DiagnosticSeverity.Hint;
    default:
      return vscode.DiagnosticSeverity.Error;
  }
}

function toVsCodeHover(hover: LspHover): vscode.Hover {
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  const markdown = contents.map((content) => {
    if (typeof content === "string") {
      return new vscode.MarkdownString(content);
    }
    if ("language" in content && content.language) {
      return new vscode.MarkdownString(`\`\`\`${content.language}\n${content.value}\n\`\`\``);
    }
    return new vscode.MarkdownString(content.value);
  });
  return new vscode.Hover(markdown, hover.range ? toVsCodeRange(hover.range) : undefined);
}

function toVsCodeLocation(location: LspLocation): vscode.Location {
  return new vscode.Location(uriForLargeDocument(location.uri), toVsCodeRange(location.range));
}

function toVsCodeDefinition(
  response: LspLocation | LspLocation[] | LspLocationLink[] | null,
): vscode.Definition | vscode.DefinitionLink[] | undefined {
  if (!response) return undefined;
  const items = Array.isArray(response) ? response : [response];
  if (items.length === 0) return undefined;
  if ("targetUri" in items[0]) {
    return (items as LspLocationLink[]).map((link) => ({
      targetUri: uriForLargeDocument(link.targetUri),
      targetRange: toVsCodeRange(link.targetRange),
      targetSelectionRange: toVsCodeRange(link.targetSelectionRange),
      originSelectionRange: link.originSelectionRange
        ? toVsCodeRange(link.originSelectionRange)
        : undefined,
    }));
  }
  return (items as LspLocation[]).map(toVsCodeLocation);
}
