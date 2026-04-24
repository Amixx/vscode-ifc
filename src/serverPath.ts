import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { getIfcConfig } from "./config";
import { downloadIfcLanguageServer } from "./installer";
import { getTargetPlatform } from "./platform";

export interface ResolvedServer {
  command: string;
  args: string[];
  source: "configured" | "path" | "downloaded";
}

export async function resolveServer(
  context: vscode.ExtensionContext,
  output: vscode.LogOutputChannel,
  options?: { forceDownload?: boolean },
): Promise<ResolvedServer> {
  const config = getIfcConfig();
  const target = getTargetPlatform();
  output.info(
    `Resolving IFC language server for ${target.platform}-${target.arch} ` +
      `(preferPath=${config.preferPath}, autoDownload=${config.autoDownload}).`,
  );

  if (config.serverPath) {
    output.info(`Checking configured server path: ${config.serverPath}`);
    const configuredPath = await requireExecutable(config.serverPath);
    output.info(`Using configured IFC language server: ${configuredPath}`);
    return { command: configuredPath, args: config.serverArgs, source: "configured" };
  }

  const candidates = config.preferPath
    ? [
        { label: "PATH", resolver: () => findOnPath(target.binaryNames) },
        { label: "download cache", resolver: () => findCachedDownload(context, target.binaryNames) },
      ]
    : [
        { label: "download cache", resolver: () => findCachedDownload(context, target.binaryNames) },
        { label: "PATH", resolver: () => findOnPath(target.binaryNames) },
      ];

  for (const candidateEntry of candidates) {
    output.info(`Checking ${candidateEntry.label} for IFC language server.`);
    const candidate = await candidateEntry.resolver();
    if (candidate) {
      output.info(`Using IFC language server from ${candidateEntry.label}: ${candidate}`);
      return { command: candidate, args: config.serverArgs, source: candidateSource(candidate, context) };
    }
    output.info(`No IFC language server found in ${candidateEntry.label}.`);
  }

  if (options?.forceDownload || config.autoDownload) {
    output.info(
      `No local IFC language server found. Attempting download from ${config.githubRepository}.`,
    );
    const downloadedPath = await downloadIfcLanguageServer({
      context,
      repository: config.githubRepository,
      assetPattern: config.downloadAssetPattern,
      output,
    });

    output.info(`Using downloaded IFC language server: ${downloadedPath}`);
    return { command: downloadedPath, args: config.serverArgs, source: "downloaded" };
  }

  throw new Error(
    "Unable to locate IFC language server. Configure ifc.server.path, add it to PATH, or enable ifc.server.autoDownload.",
  );
}

async function requireExecutable(candidatePath: string): Promise<string> {
  const stat = await fs.stat(candidatePath);
  if (!stat.isFile()) {
    throw new Error(`Configured server path is not a file: ${candidatePath}`);
  }

  return candidatePath;
}

async function findCachedDownload(
  context: vscode.ExtensionContext,
  binaryNames: string[],
): Promise<string | undefined> {
  const targetDir = path.join(
    context.globalStorageUri.fsPath,
    "language-server",
    `${process.platform}-${process.arch}`,
  );

  for (const binaryName of binaryNames) {
    const candidate = path.join(targetDir, binaryName);
    if (await exists(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function findOnPath(binaryNames: string[]): Promise<string | undefined> {
  const pathValue = process.env.PATH;
  if (!pathValue) {
    return undefined;
  }

  const pathEntries = pathValue.split(path.delimiter);
  const windowsExtensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE").split(";").map((entry) => entry.toLowerCase())
    : [""];

  for (const directory of pathEntries) {
    for (const binaryName of binaryNames) {
      const variants = process.platform === "win32" && !path.extname(binaryName)
        ? windowsExtensions.map((extension) => path.join(directory, `${binaryName}${extension}`))
        : [path.join(directory, binaryName)];

      for (const candidate of variants) {
        if (await exists(candidate)) {
          return candidate;
        }
      }
    }
  }

  return undefined;
}

async function exists(candidatePath: string): Promise<boolean> {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function candidateSource(candidate: string, context: vscode.ExtensionContext): ResolvedServer["source"] {
  return candidate.startsWith(context.globalStorageUri.fsPath) ? "downloaded" : "path";
}
