import { DeviceConfiguration } from "./config.ts"
import { allowedWorkspace } from "./daemon.ts"
import { DeviceId } from "@cohall/protocol"
import { Effect } from "effect"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseWorkspaces } from "./config.ts"

const directories: Array<string> = []

const temporary = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-config-"))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe("device workspace configuration", () => {
  it("canonicalizes existing roots and preserves commas in JSON paths", async () => {
    const directory = await temporary()
    const first = join(directory, "cohall,primary")
    const second = join(directory, "cohall-secondary")
    await Promise.all([mkdir(first), mkdir(second)])
    expect(
      await Effect.runPromise(parseWorkspaces("", JSON.stringify([first, second, first]))),
    ).toEqual([first, second])
  })

  it("rejects a symlink that escapes an allowed workspace", async () => {
    const directory = await temporary()
    const root = join(directory, "root")
    const outside = join(directory, "outside")
    await Promise.all([mkdir(root), mkdir(outside)])
    const escape = join(root, "escape")
    await symlink(outside, escape)
    const configuration = DeviceConfiguration.make({
      relayUrl: "http://127.0.0.1:8787",
      token: "test",
      id: DeviceId.make("11111111-1111-4111-8111-111111111111"),
      name: "test",
      workspaces: [root],
    })
    await expect(allowedWorkspace(configuration, escape)).rejects.toThrow("outside")
    await expect(allowedWorkspace(configuration, root)).resolves.toBe(root)
  })
})
