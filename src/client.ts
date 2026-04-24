import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import { getIfcConfig } from "./config";
import { resolveServer } from "./serverPath";

export class IfcLanguageClientManager {
  private client: LanguageClient | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  async start(options?: { forceDownload?: boolean }): Promise<void> {
    if (this.client) {
      this.output.info("IFC language server client is already running. Restarting instead.");
      await this.stop();
    }

    const resolved = await resolveServer(this.context, this.output, options);
    this.output.info(`Starting IFC language server from ${resolved.source}: ${resolved.command}`);
    if (resolved.args.length > 0) {
      this.output.info(`IFC language server arguments: ${JSON.stringify(resolved.args)}`);
    }

    const serverOptions: ServerOptions = {
      run: {
        command: resolved.command,
        args: resolved.args,
      },
      debug: {
        command: resolved.command,
        args: resolved.args,
      },
    };

    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ language: "ifc", scheme: "file" }],
      outputChannel: this.output,
    };

    this.client = new LanguageClient(
      "ifc-language-server",
      "IFC Language Server",
      serverOptions,
      clientOptions,
    );

    this.client.setTrace(getIfcConfig().trace);
    await this.client.start();
    this.output.info("IFC language client started.");
  }

  async stop(): Promise<void> {
    if (!this.client) {
      this.output.info("IFC language client stop requested, but no client is running.");
      return;
    }

    const client = this.client;
    this.client = undefined;
    this.output.info("Stopping IFC language client.");
    await client.stop();
    this.output.info("IFC language client stopped.");
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }
}
