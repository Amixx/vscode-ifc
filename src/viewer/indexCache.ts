import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { StepFileIndex } from "./stepIndex";

const MB = 1024 * 1024;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  index: StepFileIndex;
}

export class StepIndexCache {
  private readonly entries = new Map<string, CacheEntry>();

  async get(uri: vscode.Uri, maxFileSizeMb: number): Promise<StepFileIndex> {
    if (uri.scheme !== "file") {
      const doc = await vscode.workspace.openTextDocument(uri);
      return StepFileIndex.build(Buffer.from(doc.getText(), "utf8"));
    }

    const stat = await fs.stat(uri.fsPath);
    const cached = this.entries.get(uri.fsPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached.index;
    }
    if (stat.size > maxFileSizeMb * MB) {
      throw new Error(
        `File is ${(stat.size / MB).toFixed(0)} MB, above the ${maxFileSizeMb} MB limit ` +
          `(raise \`ifc.viewer.maxFileSizeMb\` to override).`,
      );
    }
    const buffer = await fs.readFile(uri.fsPath);
    const index = StepFileIndex.build(buffer);
    this.entries.set(uri.fsPath, { mtimeMs: stat.mtimeMs, size: stat.size, index });
    return index;
  }

  getCached(fsPath: string): StepFileIndex | undefined {
    return this.entries.get(fsPath)?.index;
  }

  invalidate(fsPath: string): void {
    this.entries.delete(fsPath);
  }

  dispose(): void {
    this.entries.clear();
  }
}
