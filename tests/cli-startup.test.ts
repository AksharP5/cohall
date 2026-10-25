import { execFile } from "node:child_process"
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { expect, it } from "vitest"
import metadata from "../package.json" with { type: "json" }

const execute = promisify(execFile)

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
