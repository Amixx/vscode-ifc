import * as vscode from "vscode";

export function createOutputChannel(): vscode.LogOutputChannel {
  return vscode.window.createOutputChannel("IFC", { log: true });
}
