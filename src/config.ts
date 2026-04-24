import * as vscode from "vscode";
import { Trace } from "vscode-languageclient/node";

export interface IfcExtensionConfig {
  serverPath: string;
  serverArgs: string[];
  preferPath: boolean;
  autoDownload: boolean;
  githubRepository: string;
  downloadAssetPattern: string;
  trace: Trace;
}

export function getIfcConfig(): IfcExtensionConfig {
  const config = vscode.workspace.getConfiguration("ifc");

  return {
    serverPath: config.get<string>("server.path", "").trim(),
    serverArgs: config.get<string[]>("server.args", []),
    preferPath: config.get<boolean>("server.preferPath", true),
    autoDownload: config.get<boolean>("server.autoDownload", true),
    githubRepository: config.get<string>(
      "server.githubRepository",
      "NepomukWolf/IFC-Language-Server",
    ),
    downloadAssetPattern: config.get<string>("server.downloadAssetPattern", "").trim(),
    trace: toTrace(config.get<string>("trace.server", "off")),
  };
}

function toTrace(value: string): Trace {
  switch (value) {
    case "messages":
      return Trace.Messages;
    case "verbose":
      return Trace.Verbose;
    default:
      return Trace.Off;
  }
}
