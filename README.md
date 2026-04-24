# VS Code IFC

VS Code support for IFC STEP files backed by the [IFC Language Server](https://github.com/NepomukWolf/IFC-Language-Server).

## Features

- Syntax highlighting for `.ifc`, `.stp`, and `.step`
- Bracket matching and colored bracket pairs
- Hover, go to definition, and references through the IFC language server
- Automatic language server discovery:
  - uses `ifc-language-server` or `ifc-lsp` from `PATH` when available
  - otherwise can download the latest matching release from GitHub

## Installation

After the extension is installed, it tries to resolve the language server in this order:

1. `ifc.server.path` if configured
2. a matching binary on `PATH`
3. a previously downloaded cached binary
4. the latest GitHub release if `ifc.server.autoDownload` is enabled

The downloaded binary is cached in the extension's global storage directory.

## Extension Settings

- `ifc.server.path`: Absolute path to a custom language server binary.
- `ifc.server.args`: Extra command-line arguments passed to the server.
- `ifc.server.preferPath`: Prefer a system-installed binary over the cached download.
- `ifc.server.autoDownload`: Download the latest matching GitHub release when no server is available.
- `ifc.server.githubRepository`: Release source in `owner/repo` form.
- `ifc.server.downloadAssetPattern`: Optional substring used to narrow release asset selection.
- `ifc.trace.server`: Trace level for the VS Code language client.

## Commands

- `IFC: Download Language Server`
- `IFC: Restart Language Server`
- `IFC: Show Resolved Language Server`

## Release Asset Expectations

For automatic downloads, GitHub releases should publish platform-specific assets whose names include operating-system and architecture hints, for example:

- `linux-x64`
- `linux-arm64`
- `macos-arm64`
- `darwin-x64`
- `windows-x64`

The asset may be:

- a raw executable
- a `.zip`
- a `.tar.gz` or `.tgz`

The archive should contain either `ifc-language-server` or `ifc-lsp` (with `.exe` on Windows).
