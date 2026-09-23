import { BotId, Task, makeDeviceId, makeTaskId, makeThreadId, now } from "@cohall/protocol"
import { Schema } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { discoverGrokBots, runGrokBot } from "./grok-bot.ts"

const replies = vi.hoisted(() => ({
  receipts: new Map<string, { result?: string; error?: string }>(),
  deadlines: new Map<string, number>(),
  dispatched: new Set<string>(),
}))
vi.mock("./bot-replies.ts", () => ({
  prepareBotReply: async (task: Task) => {
    const deadline = replies.deadlines.get(task.id) ?? Date.now() + 6 * 60 * 60 * 1000
    replies.deadlines.set(task.id, deadline)
    return {
      deadline,
      command: "COHALL_CONFIG='/tmp/test cohall/config.json' cohall",
      dispatched: replies.dispatched.has(task.id),
    }
  },
  readBotReply: async (id: string) => replies.receipts.get(id),
  claimBotDispatch: async (id: string) => {
    if (replies.dispatched.has(id)) return false
    replies.dispatched.add(id)
    return true
  },
}))
beforeEach(() => {
  replies.receipts.clear()
  replies.deadlines.clear()
  replies.dispatched.clear()
})

const directories: Array<string> = []
const servers: Array<Server> = []
const Args = Schema.Record(Schema.String, Schema.Unknown)
const makeTask = () =>
  Task.make({
    id: makeTaskId(),
    threadId: makeThreadId(),
    targetDeviceId: makeDeviceId(),
    botId: BotId.make("reacher-id"),
    provider: "grok-bot",
    prompt: "Check the project",
    context: "Only inspect it",
    status: "running",
    createdAt: now(),
    updatedAt: now(),
  })
const bot = { id: "reacher-id", name: "Reacher", isRunning: false }
const accepted = (echoEntryId = "echo") => ({
  outcome: "found",
  record: { status: "accepted", echoEntryId },
})
type Request = { method: string; args: typeof Args.Type; authorization: string | undefined }
const gateway = async (
  respond: (request: Request, response: ServerResponse) => unknown | Promise<unknown>,
) => {
  const calls: Array<Request> = []
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Array<Buffer> = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const call = {
        method: request.url?.replace("/api/", "") ?? "",
        args: Schema.decodeUnknownSync(Args)(JSON.parse(Buffer.concat(chunks).toString("utf8"))),
        authorization: request.headers.authorization,
      }
      calls.push(call)
      const result = await respond(call, response)
      if (!response.writableEnded) response.end(JSON.stringify(result))
    })().catch(() => {
      response.statusCode = 500
      response.end("fixture error")
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("Missing fixture address")
  const directory = await mkdtemp(join(tmpdir(), "cohall-grok-test-"))
  directories.push(directory)
  const path = join(directory, "gateway.json")
  const discovery = { port: address.port, token: "private-gateway-token", pid: 123, startedAt: 1 }
  await writeFile(path, JSON.stringify(discovery))
  return { path, calls, discovery }
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

describe("Grok Bot gateway", () => {
  it("discovers all named bots, including hidden bots, without credentials or groups", async () => {
    const fixture = await gateway(() => [
      bot,
      {
        ...bot,
        id: "scout-id",
        name: "X Scout",
        isHiddenFromSidebar: true,
        description: "Find ideas",
      },
      { ...bot, id: "group-id", name: "Team", isGroup: true },
    ])
    await expect(discoverGrokBots(fixture.path)).resolves.toEqual([
      { id: "reacher-id", name: "Reacher" },
      { id: "scout-id", name: "X Scout", description: "Find ideas" },
    ])
    expect(fixture.calls[0]?.authorization).toBe("Bearer private-gateway-token")
  })

  it.each(["example.com", "192.168.1.2", "127.0.0.1@evil.test", "127.1", "::ffff:192.168.1.1"])(
    "rejects non-loopback host %s before contacting it",
    async (host) => {
      const fixture = await gateway(() => [bot])
      await writeFile(fixture.path, JSON.stringify({ ...fixture.discovery, host }))
      await expect(discoverGrokBots(fixture.path)).rejects.toThrow("loopback")
      expect(fixture.calls).toHaveLength(0)
    },
  )

  it("maps wildcard listen addresses to loopback and bounds/redacts invalid discovery", async () => {
    const fixture = await gateway(() => [bot])
    await writeFile(fixture.path, JSON.stringify({ ...fixture.discovery, host: "0.0.0.0" }))
    await expect(discoverGrokBots(fixture.path)).resolves.toHaveLength(1)
    await writeFile(fixture.path, `{"token":"private-gateway-token",${" ".repeat(65_536)}`)
    const error = await discoverGrokBots(fixture.path).catch((cause: unknown) => String(cause))
    expect(error).toContain("Cannot read")
    expect(error).not.toContain("private-gateway-token")
  })

  it("does not follow redirects or forward the gateway token", async () => {
    const target = await gateway(() => [bot])
    const source = await gateway((_request, response) => {
      response.writeHead(307, {
        location: `http://127.0.0.1:${target.discovery.port}/api/listAgents`,
      })
      response.end()
    })
    await expect(discoverGrokBots(source.path)).rejects.toThrow("listAgents failed")
    expect(target.calls).toHaveLength(0)
  })

  it("rejects oversized responses without exposing response content", async () => {
    const fixture = await gateway(() => ({ private: "private-gateway-token".repeat(220_000) }))
    const error = await discoverGrokBots(fixture.path).catch((cause: unknown) => String(cause))
    expect(error).toContain("response exceeded 4 MiB")
    expect(error).not.toContain("private-gateway-token")
  })

  it("sends to the native bot with delegation and callback instructions, completing only from its receipt", async () => {
    const task = makeTask()
    const fixture = await gateway(({ method, args }) => {
      if (method === "promptAcceptanceStatus") return { outcome: "not-found" }
      if (method === "listAgents") return [{ ...bot, harness: "temporal" }]
      expect(method).toBe("sendPrompt")
      expect(args.clientNonce).toBe(task.id)
      expect(args.directAddressedAcceptance).toBe(true)
      expect(args.prompt).toContain(task.context)
      expect(args.prompt).toContain(`--parent ${task.id}`)
      expect(args.prompt).toContain(`cohall reply ${task.id} --message-file`)
      for (const command of ["devices", "delegate", "reply"]) {
        expect(args.prompt).toContain(
          `COHALL_CONFIG='/tmp/test cohall/config.json' cohall ${command}`,
        )
      }
      replies.receipts.set(task.id, { result: "Finished by Reacher" })
      return { accepted: true }
    })
    await expect(runGrokBot(fixture.path, task, new AbortController().signal)).resolves.toEqual({
      result: "Finished by Reacher",
    })
    expect(fixture.calls.filter((call) => call.method === "sendPrompt")).toHaveLength(1)
    expect(fixture.calls.some((call) => call.method.includes("Transcript"))).toBe(false)
  })

  it("recovers a durable receipt without needing the gateway, even after its original deadline", async () => {
    const task = makeTask()
    replies.deadlines.set(task.id, Date.now() - 1000)
    replies.receipts.set(task.id, { result: "Saved before restart" })
    await expect(runGrokBot(undefined, task, new AbortController().signal)).resolves.toEqual({
      result: "Saved before restart",
    })
  })

  it.each(["accepted", "pending"])("resumes a %s prompt without sending again", async (status) => {
    const task = makeTask()
    const fixture = await gateway(() => {
      replies.receipts.set(task.id, { result: "Existing bot task replied" })
      return { outcome: "found", record: { status } }
    })
    await expect(runGrokBot(fixture.path, task, new AbortController().signal)).resolves.toEqual({
      result: "Existing bot task replied",
    })
    expect(fixture.calls.map((call) => call.method)).toEqual(["promptAcceptanceStatus"])
  })

  it("reconciles an ambiguous send without resending", async () => {
    const task = makeTask()
    let sent = false
    const fixture = await gateway(({ method }, response) => {
      if (method === "promptAcceptanceStatus") {
        if (!sent) return { outcome: "not-found" }
        replies.receipts.set(task.id, { result: "Accepted despite lost acknowledgement" })
        return accepted()
      }
      if (method === "listAgents") return [bot]
      sent = true
      response.statusCode = 502
      return { secret: "private-gateway-token" }
    })
    await expect(
      runGrokBot(fixture.path, task, new AbortController().signal),
    ).resolves.toMatchObject({ result: "Accepted despite lost acknowledgement" })
    expect(fixture.calls.filter((call) => call.method === "sendPrompt")).toHaveLength(1)
  })

  it.each([false, true])(
    "reports a delayed rejection after pending acceptance (resumed=%s)",
    async (resumed) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const task = makeTask()
      let sent = resumed
      let pendingLookups = 0
      if (resumed) replies.dispatched.add(task.id)
      const fixture = await gateway(({ method }, response) => {
        if (method === "listAgents") return [bot]
        if (method === "promptAcceptanceStatus") {
          if (!sent) return { outcome: "not-found" }
          pendingLookups += 1
          return {
            outcome: "found",
            record: { status: pendingLookups === 1 ? "pending" : "rejected" },
          }
        }
        sent = true
        response.statusCode = 502
        return {}
      })
      const controller = new AbortController()
      let failure: unknown
      const running = runGrokBot(fixture.path, task, controller.signal).catch((cause: unknown) => {
        failure = cause
      })
      try {
        await vi.waitFor(
          () => expect(failure).toMatchObject({ message: expect.stringContaining("rejected") }),
          { timeout: 10_000 },
        )
        expect(fixture.calls.filter((call) => call.method === "sendPrompt")).toHaveLength(
          resumed ? 0 : 1,
        )
      } finally {
        controller.abort()
        await running
      }
    },
  )

  it("receives a callback while resumed acceptance lookup is stalled and aborts the lookup", async () => {
    const task = makeTask()
    replies.dispatched.add(task.id)
    let lookupClosed = false
    const fixture = await gateway(async ({ method }, response) => {
      expect(method).toBe("promptAcceptanceStatus")
      replies.receipts.set(task.id, { result: "Completed while gateway stalled" })
      await new Promise<void>((resolve) => {
        response.once("close", () => {
          lookupClosed = true
          resolve()
        })
      })
      return {}
    })
    await expect(runGrokBot(fixture.path, task, new AbortController().signal)).resolves.toEqual({
      result: "Completed while gateway stalled",
    })
    await vi.waitFor(() => expect(lookupClosed).toBe(true))
    expect(fixture.calls.map((call) => call.method)).toEqual(["promptAcceptanceStatus"])
  })

  it("stops acceptance checks once accepted and still waits for the callback", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const task = makeTask()
    replies.dispatched.add(task.id)
    let lookups = 0
    const fixture = await gateway(() => {
      lookups += 1
      return accepted()
    })
    const controller = new AbortController()
    let completed = false
    const running = runGrokBot(fixture.path, task, controller.signal).then((result) => {
      completed = true
      return result
    })
    try {
      await vi.waitFor(() => expect(lookups).toBe(1))
      await vi.advanceTimersByTimeAsync(6000)
      expect(lookups).toBe(1)
      expect(completed).toBe(false)
      replies.receipts.set(task.id, { result: "Completed after acceptance" })
      await vi.advanceTimersByTimeAsync(1000)
      await expect(running).resolves.toEqual({
        result: "Completed after acceptance",
      })
      expect(lookups).toBe(1)
      expect(fixture.calls.some((call) => call.method === "sendPrompt")).toBe(false)
    } finally {
      controller.abort()
      await running.catch(() => undefined)
    }
  })

  it("awaits a delayed receipt after restart without requiring the unavailable gateway", async () => {
    const task = makeTask()
    replies.dispatched.add(task.id)
    const callback = setTimeout(() => {
      replies.receipts.set(task.id, { result: "Replied after the worker restarted" })
    }, 50)
    try {
      await expect(runGrokBot(undefined, task, new AbortController().signal)).resolves.toEqual({
        result: "Replied after the worker restarted",
      })
    } finally {
      clearTimeout(callback)
    }
  })

  it.each(["not-found", "unknown-durability", "unavailable"])(
    "awaits the receipt without resending after an ambiguous send and %s acceptance",
    async (outcome) => {
      const task = makeTask()
      let sent = false
      let callback: ReturnType<typeof setTimeout> | undefined
      const fixture = await gateway(({ method }, response) => {
        if (method === "listAgents") return [bot]
        if (method === "promptAcceptanceStatus") {
          if (!sent) return { outcome: "not-found" }
          callback = setTimeout(() => {
            replies.receipts.set(task.id, { result: "Completed despite missing acknowledgement" })
          }, 50)
          if (outcome === "unavailable") response.statusCode = 503
          return { outcome }
        }
        sent = true
        response.statusCode = 502
        return {}
      })
      try {
        await expect(runGrokBot(fixture.path, task, new AbortController().signal)).resolves.toEqual(
          {
            result: "Completed despite missing acknowledgement",
          },
        )
        expect(fixture.calls.filter((call) => call.method === "sendPrompt")).toHaveLength(1)
      } finally {
        clearTimeout(callback)
      }
    },
  )

  it("fails unknown acceptance without sending", async () => {
    const task = makeTask()
    const fixture = await gateway(() => ({ outcome: "unknown-durability" }))
    await expect(runGrokBot(fixture.path, task, new AbortController().signal)).rejects.toThrow(
      "cannot confirm",
    )
    expect(fixture.calls.map((call) => call.method)).toEqual(["promptAcceptanceStatus"])
  })

  it("reports the bot's explicit error receipt", async () => {
    const task = makeTask()
    replies.receipts.set(task.id, { error: "Reacher needs a repository URL" })
    await expect(runGrokBot(undefined, task, new AbortController().signal)).rejects.toThrow(
      "needs a repository URL",
    )
  })

  it("waits for a callback despite an idle bot and stops only local waiting on abort", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    const task = makeTask()
    const controller = new AbortController()
    const fixture = await gateway(({ method }) =>
      method === "promptAcceptanceStatus" ? accepted() : [bot],
    )
    let completed = false
    const running = runGrokBot(fixture.path, task, controller.signal).then((result) => {
      completed = true
      return result
    })
    try {
      await vi.waitFor(() => expect(fixture.calls).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(3000)
      expect(completed).toBe(false)
      expect(fixture.calls.map((call) => call.method)).toEqual(["promptAcceptanceStatus"])
      controller.abort()
      await expect(running).rejects.toThrow()
      expect(fixture.calls.some((call) => call.method === "interruptAgentRun")).toBe(false)
    } finally {
      controller.abort()
      await running.catch(() => undefined)
    }
  })

  it.each([false, true])(
    "enforces the saved deadline while waiting (new task=%s), without claiming the upstream task stopped",
    async (fresh) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
      const task = makeTask()
      replies.deadlines.set(task.id, Date.now() + 2000)
      const fixture = await gateway(({ method }) =>
        method === "promptAcceptanceStatus"
          ? fresh
            ? { outcome: "not-found" }
            : accepted()
          : method === "listAgents"
            ? [{ ...bot, isRunning: true }]
            : { accepted: true },
      )
      const controller = new AbortController()
      const running = runGrokBot(fixture.path, task, controller.signal)
      let done = false
      const observed = running.then(
        (value) => {
          done = true
          return { value }
        },
        (error: unknown) => {
          done = true
          return { error }
        },
      )
      try {
        await vi.waitFor(() => expect(fixture.calls.length).toBeGreaterThanOrEqual(fresh ? 2 : 1))
        await vi.waitFor(() => expect(done).toBe(true), { timeout: 5000 })
        await expect(observed).resolves.toMatchObject({
          error: expect.objectContaining({
            message: expect.stringContaining(
              "Timed out waiting for the bot to reply through Cohall; the bot may still be running",
            ),
          }),
        })
        expect(fixture.calls.some((call) => call.method === "interruptAgentRun")).toBe(false)
      } finally {
        controller.abort()
        await running.catch(() => undefined)
      }
    },
  )
})
