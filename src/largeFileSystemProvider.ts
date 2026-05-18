import * as vscode from "vscode";
import * as fs from "fs";

type LargeFileReadState = {
  limitSize: boolean;
  rereadScheduled: boolean;
  rereadTimer?: ReturnType<typeof setTimeout>;
  virtualMtime?: number;
};

function toFileUri(uri: vscode.Uri): vscode.Uri {
  return uri.with({ scheme: "file" });
}

// VS Code refuses to sync a document larger than the extension-host cap
// (~50 MB) — `openTextDocument` either rejects or returns a placeholder.
// To get the editor to open a multi-hundred-MB IFC at all, the FS provider
// initially reports a truncated size and serves only the first `limitedSize`
// bytes from `stat`/`readFile`. VS Code accepts that, opens the document,
// and registers it with the language layer. After `rereadDelayMs` we flip
// the state and fire a `Changed` event; VS Code calls `readFile` again and
// this time we return the full bytes, which it accepts because the document
// is already open and the size limit is enforced only at open time.
//
// Side effects: the editor shows a 1 MB head briefly, then swaps to the full
// document. Hover, definition, and visible-range diagnostics go through the
// language server's on-disk copy, so the in-editor text is only used for
// display and for VS Code's own position math.
export class IfcLargeFileSystemProvider implements vscode.FileSystemProvider {
  private readonly limitedSize = 1024 * 1024;
  private readonly rereadDelayMs = 5000;
  private readonly states = new Map<string, LargeFileReadState>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  mark(uri: vscode.Uri): void {
    this.states.set(uri.toString(), { limitSize: true, rereadScheduled: false });
  }

  forceFullReload(uri: vscode.Uri): void {
    this.promoteToFullRead(uri, this.state(uri));
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const realUri = toFileUri(uri);
    const realStat = await fs.promises.stat(realUri.fsPath);
    const state = this.state(uri);
    const size = state.limitSize && realStat.size > this.limitedSize ? this.limitedSize : realStat.size;
    return {
      type: realStat.isFile()
        ? vscode.FileType.File
        : realStat.isDirectory()
          ? vscode.FileType.Directory
          : vscode.FileType.Unknown,
      ctime: realStat.ctimeMs,
      mtime: state.virtualMtime ?? realStat.mtimeMs,
      size,
    };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const state = this.state(uri);
    const realUri = toFileUri(uri);
    if (state.limitSize) {
      this.scheduleFullRead(uri, state);
      const file = await fs.promises.open(realUri.fsPath, "r");
      try {
        const buffer = Buffer.allocUnsafe(this.limitedSize);
        const result = await file.read(buffer, 0, this.limitedSize, 0);
        return buffer.subarray(0, result.bytesRead);
      } finally {
        await file.close();
      }
    }
    return fs.promises.readFile(realUri.fsPath);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const entries = await fs.promises.readdir(toFileUri(uri).fsPath, { withFileTypes: true });
    return entries.map((entry) => [
      entry.name,
      entry.isFile()
        ? vscode.FileType.File
        : entry.isDirectory()
          ? vscode.FileType.Directory
          : vscode.FileType.Unknown,
    ]);
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions();
  }

  private state(uri: vscode.Uri): LargeFileReadState {
    const key = uri.toString();
    let state = this.states.get(key);
    if (!state) {
      state = { limitSize: true, rereadScheduled: false };
      this.states.set(key, state);
    }
    return state;
  }

  private scheduleFullRead(
    uri: vscode.Uri,
    state: LargeFileReadState,
  ): void {
    if (state.rereadScheduled || !state.limitSize) return;
    state.rereadScheduled = true;
    // Fallback path: if `forceFullReload` is never called (e.g. a different
    // open path that doesn't go through `openLargeDocument`), promote the
    // document anyway after a short delay so the editor swaps from the 1 MB
    // head to the full content.
    state.rereadTimer = setTimeout(() => {
      state.rereadTimer = undefined;
      // The state may already have been promoted by `forceFullReload` while
      // the timer was pending; in that case there's nothing to do.
      if (!state.limitSize) return;
      this.promoteToFullRead(uri, state);
    }, this.rereadDelayMs);
  }

  private promoteToFullRead(
    uri: vscode.Uri,
    state: LargeFileReadState,
  ): void {
    if (state.rereadTimer !== undefined) {
      clearTimeout(state.rereadTimer);
      state.rereadTimer = undefined;
    }
    if (!state.limitSize) {
      // Already promoted — don't fire a redundant Changed event.
      state.rereadScheduled = false;
      return;
    }
    const previousMtime = state.virtualMtime ?? 0;
    state.limitSize = false;
    state.rereadScheduled = false;
    state.virtualMtime = Math.max(Date.now(), previousMtime + 1);
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }
}
