import { AttachmentName, maxAttachmentBytes, makeTaskId, makeDeviceId } from "@cohall/protocol"
import { createServer } from "node:http"
import { type AddressInfo } from "node:net"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { DeviceConfiguration } from "./config.ts"
import { prepareTaskFiles, readInputAttachments } from "./task-attachments.ts"

it("reads explicit local files within the size bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-input-file-"))
  try {
    const path = join(directory, "screen.png")
    await writeFile(path, "image")
    expect(await readInputAttachments([path])).toEqual([
      { name: "screen.png", data: Buffer.from("image").toString("base64") },
    ])
    await expect(readInputAttachments([path, path])).rejects.toThrow("repeated")
    await writeFile(path, Buffer.alloc(maxAttachmentBytes + 1))
    await expect(readInputAttachments([path])).rejects.toThrow("regular file")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it("stages input bytes and collects selected output before removing temporary files", async () => {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer device-token") {
      response.writeHead(401).end()
      return
    }
    response.writeHead(200).end("image")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  const configuration = DeviceConfiguration.make({
    relayUrl: `http://127.0.0.1:${port}`,
    token: "device-token",
    id: makeDeviceId(),
    name: "worker",
    workspaces: [process.cwd()],
  })
  const files = await prepareTaskFiles(
    configuration,
    makeTaskId(),
    [AttachmentName.make("screen.png")],
    new AbortController().signal,
  )
  try {
    expect(await readFile(join(files.input, "screen.png"), "utf8")).toBe("image")
    await writeFile(join(files.output, "report.txt"), "answer")
    const nested = join(files.output, "nested")
    await mkdir(nested)
    await expect(files.collectOutputs()).rejects.toThrow("regular file")
    await rm(nested, { recursive: true })
    if (process.platform !== "win32") {
      const linked = join(files.output, "linked.txt")
      await symlink(join(files.input, "screen.png"), linked)
      await expect(files.collectOutputs()).rejects.toThrow("regular file")
      await rm(linked)
    }
    expect(await files.collectOutputs()).toEqual([
      { name: "report.txt", data: Buffer.from("answer").toString("base64") },
    ])
  } finally {
    await files.cleanup()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  await expect(readFile(join(files.input, "screen.png"))).rejects.toBeDefined()
})
