import { Effect } from "effect"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { parseWorkspaces } from "./config.ts"

describe("device workspace configuration", () => {
  it("filters empty legacy entries before resolving paths", async () => {
    expect(await Effect.runPromise(parseWorkspaces(" , /tmp/cohall, "))).toEqual([
      resolve("/tmp/cohall"),
    ])
  })

  it("preserves commas in JSON workspace paths", async () => {
    expect(
      await Effect.runPromise(
        parseWorkspaces("", JSON.stringify(["/tmp/cohall,primary", "/tmp/cohall-secondary"])),
      ),
    ).toEqual([resolve("/tmp/cohall,primary"), resolve("/tmp/cohall-secondary")])
  })
})
