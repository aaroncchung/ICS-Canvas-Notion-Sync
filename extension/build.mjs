import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";

await mkdir("dist/extension", { recursive: true });
const options = {
  outdir: "dist/extension",
  bundle: true,
  platform: "browser",
  target: "chrome120",
};
await build({
  ...options,
  entryPoints: ["extension/src/worker.ts", "extension/src/ui.ts"],
  format: "esm",
});
// Content scripts run as classic scripts, never as modules.
await build({ ...options, entryPoints: ["extension/src/canvas.ts"], format: "iife" });
for (const file of ["manifest.json", "popup.html", "options.html", "style.css"]) {
  await copyFile(`extension/static/${file}`, `dist/extension/${file}`);
}
