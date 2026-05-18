import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
} from "vscode-languageclient/node";
import { IfcExtensionConfig, getIfcConfig } from "./config";
import { resolveServer } from "./serverPath";

type IfcInitializationOptions = {
  overwriteExpSchemaWithLocal?: string;
  addLocalSchemaToSelection?: string[];
};

export class IfcLanguageClientManager {
  private client: LanguageClient | undefined;
  private serverChannel: vscode.OutputChannel | undefined;
  private readonly didStartEmitter = new vscode.EventEmitter<void>();
  readonly onDidStart = this.didStartEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.LogOutputChannel,
  ) {}

  get serverCapabilities(): Record<string, unknown> | undefined {
    return this.client?.initializeResult?.capabilities as
      | Record<string, unknown>
      | undefined;
  }

  async sendRequest<T>(
    method: string,
    params: unknown,
    token?: vscode.CancellationToken,
  ): Promise<T> {
    if (!this.client) {
      throw new Error("IFC language client is not running");
    }
    return await this.client.sendRequest<T>(method, params, token);
  }

  async start(options?: { forceDownload?: boolean }): Promise<void> {
    if (this.client) {
      this.output.info("IFC language server client is already running. Restarting instead.");
      await this.stop();
    }

    const resolved = await resolveServer(this.context, this.output, options);
    const config = getIfcConfig();
    this.output.info(`Starting IFC language server from ${resolved.source}: ${resolved.command}`);
    if (resolved.version) {
      this.output.info(`IFC language server version: ${resolved.version}`);
    }
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

    if (!this.serverChannel) {
      this.serverChannel = createServerChannelProxy(this.output);
    }

    const clientOptions: LanguageClientOptions = {
      documentSelector: [{ language: "ifc", scheme: "file" }],
      initializationOptions: getInitializationOptions(config),
      outputChannel: this.serverChannel,
    };

    this.client = new LanguageClient(
      "ifc-language-server",
      "IFC Language Server",
      serverOptions,
      clientOptions,
    );

    this.client.setTrace(config.trace);
    await this.client.start();
    this.output.info("IFC language client started.");
    this.didStartEmitter.fire();
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

// vscode-languageclient writes server `window/logMessage` notifications as
// "[Level  - HH:MM:SS] body". We strip that prefix and route to the matching
// LogOutputChannel level so VS Code's log UI (icons, level filter, dimmed
// timestamps) lights up instead of showing flat lines with a redundant prefix.
function createServerChannelProxy(
  log: vscode.LogOutputChannel,
): vscode.OutputChannel {
  const PREFIX = /^\[(Info|Warning|Error|Trace|Debug|Log)\s*-\s*[^\]]+\]\s?/;

  const writeLine = (raw: string): void => {
    const line = raw.replace(/\r$/, "");
    if (!line) return;
    const match = line.match(PREFIX);
    const level = match?.[1] ?? "Info";
    const body = match ? line.slice(match[0].length) : line;
    switch (level) {
      case "Error":
        log.error(body);
        break;
      case "Warning":
        log.warn(body);
        break;
      case "Debug":
      case "Trace":
        log.debug(body);
        break;
      default:
        log.info(body);
    }
  };

  return {
    name: log.name,
    append: (value: string) => {
      for (const part of value.split("\n")) writeLine(part);
    },
    appendLine: (value: string) => writeLine(value),
    replace: (value: string) => {
      log.clear();
      for (const part of value.split("\n")) writeLine(part);
    },
    clear: () => log.clear(),
    show: ((columnOrPreserve?: unknown, preserveFocus?: boolean) => {
      if (typeof columnOrPreserve === "boolean") {
        log.show(columnOrPreserve);
      } else {
        log.show(preserveFocus);
      }
    }) as vscode.OutputChannel["show"],
    hide: () => log.hide(),
    dispose: () => {
      // Lifecycle owned by the manager / extension context.
    },
  };
}

function getInitializationOptions(
  config: IfcExtensionConfig,
): IfcInitializationOptions {
  const initializationOptions: IfcInitializationOptions = {};

  if (config.overwriteExpSchemaWithLocal) {
    initializationOptions.overwriteExpSchemaWithLocal = config.overwriteExpSchemaWithLocal;
  }

  if (config.addLocalSchemaToSelection.length > 0) {
    initializationOptions.addLocalSchemaToSelection = config.addLocalSchemaToSelection;
  }

  return initializationOptions;
}
