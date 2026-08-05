import { mkdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"

const metadata: unknown = JSON.parse(await readFile(resolve("package.json"), "utf8"))
if (
  typeof metadata !== "object" ||
  metadata === null ||
  !("version" in metadata) ||
  typeof metadata.version !== "string"
) {
  throw new Error("package.json must contain a string version")
}

const directory = resolve("bin")
await mkdir(directory, { recursive: true })
const result = await Bun.build({
  entrypoints: [resolve("apps/device/src/main.ts")],
  outdir: directory,
  naming: "cohall.js",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "external",
  external: ["effect", "@modelcontextprotocol/sdk/*", "zod/*", "ws"],
  define: { __COHALL_VERSION__: JSON.stringify(metadata.version) },
  loader: { ".md": "text" },
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

console.log(resolve(directory, "cohall.js"))
