const esbuild = require("esbuild");
const fs = require("node:fs/promises");

const watch = process.argv.includes("--watch");

const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile: "out/extension.js",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  sourcesContent: true,
  logLevel: "info",
};

async function cleanOutDir() {
  await fs.rm("out", { recursive: true, force: true });
}

async function main() {
  if (watch) {
    const context = await esbuild.context(buildOptions);
    await context.watch();
    console.log("Watching extension bundle...");
    return;
  }

  await cleanOutDir();
  await esbuild.build(buildOptions);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
