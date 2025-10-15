// esbuild.config.mjs
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  entryPoints: ["main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",        // Important: Obsidian uses require()
  platform: "node",
  target: "es2020",
  external: ["obsidian"],
};

if (watch) {
  const ctx = await esbuild.context(common);
  await ctx.watch();
  console.log("[esbuild] watching…");
} else {
  await esbuild.build(common);
  console.log("[esbuild] build complete");
}
