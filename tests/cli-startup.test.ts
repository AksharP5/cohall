import { execFile } from "node:child_process"
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import metadata from "../package.json" with { type: "json" }

const execute = promisify(execFile)

it("reads configuration without loading MCP diagnostic dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-cli-dependencies-"))
  try {
    const hooks = join(directory, "hooks.mjs")
    await writeFile(
      hooks,
      `import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@modelcontextprotocol/sdk/")) {
      throw new Error("MCP diagnostics loaded for a configuration read");
    }
    return nextResolve(specifier, context);
  }
});`,
    )
    const configPath = join(directory, "absent.json")
    const result = await execute(
      process.execPath,
      ["--import", hooks, fileURLToPath(new URL("../bin/cohall.js", import.meta.url)), "config"],
      { env: { PATH: process.env.PATH ?? "", COHALL_CONFIG: configPath } },
    )
    expect(JSON.parse(result.stdout)).toEqual({ config_path: configPath, configured: false })
    expect(result.stderr).toBe("")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("prints version and help without loading runtime dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-startup-"))
  const packaged = fileURLToPath(new URL("../bin/", import.meta.url))
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}')
    await Promise.all(
      (await readdir(packaged))
        .filter((name) => name.endsWith(".js"))
        .map((name) => copyFile(join(packaged, name), join(directory, name))),
    )
    const entrypoint = join(directory, "cohall.js")
    for (const command of ["--version", "version"]) {
      const result = await execute(process.execPath, [entrypoint, command])
      expect(result.stdout).toBe(`${metadata.version}\n`)
    }
    const help = await execute(process.execPath, [entrypoint, "--help"])
    expect(help.stdout).toContain("Usage:")
    expect(help.stdout).toContain("cohall delegate")
    for (const args of [[], ["help"], ["-h"], ["device", "--help"], ["mcp", "help"]]) {
      const result = await execute(process.execPath, [entrypoint, ...args])
      expect(result.stdout).toBe(help.stdout)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
