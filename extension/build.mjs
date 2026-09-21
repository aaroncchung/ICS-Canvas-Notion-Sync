import { build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";

await mkdir("dist/extension", { recursive: true });
await build({
  entryPoints: ["extension/src/worker.ts", "extension/src/ui.ts"],
  outdir: "dist/extension",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
});
for (const file of ["manifest.json", "popup.html", "options.html", "style.css"]) {
  await copyFile(`extension/static/${file}`, `dist/extension/${file}`);
}
