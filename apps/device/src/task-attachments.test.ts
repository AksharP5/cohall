import { AttachmentName, maxAttachmentBytes, makeTaskId, makeDeviceId } from "@cohall/protocol"
import { Effect } from "effect"
import { createServer } from "node:http"
import { type AddressInfo } from "node:net"
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
  type FileHandle,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { DeviceConfiguration } from "./config.ts"
import { prepareTaskFiles, readInputAttachments } from "./task-attachments.ts"

const fileHandlePrototype = async (
  path: string,
): Promise<Pick<FileHandle, "stat" | "read" | "readFile">> => {
  const handle = await open(path)
  await handle.close()
  return Object.getPrototypeOf(handle) as Pick<FileHandle, "stat" | "read" | "readFile">
}

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

it("bounds input bytes when the file grows after its size check", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-growing-input-"))
  const path = join(directory, "input.bin")
  await writeFile(path, Buffer.alloc(1_024))
  const prototype = await fileHandlePrototype(path)
  const originalStat = prototype.stat
  const stat = vi.spyOn(prototype, "stat").mockImplementation(async function (this: FileHandle) {
    const metadata = await originalStat.call(this)
    await truncate(path, 8 * 1024 * 1024)
    return metadata
  })
  const readFileSpy = vi.spyOn(prototype, "readFile").mockImplementation(async () => {
    throw new Error("Unbounded file read")
  })
  try {
    await expect(readInputAttachments([path])).rejects.toThrow("changed size while reading")
    expect(readFileSpy).not.toHaveBeenCalled()
  } finally {
    stat.mockRestore()
    readFileSpy.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})

it("reads all bytes when an input read returns short chunks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cohall-short-input-"))
  const path = join(directory, "input.txt")
  await writeFile(path, "short read")
  const prototype = await fileHandlePrototype(path)
  const originalRead = prototype.read
  const read = vi.spyOn(prototype, "read").mockImplementation(function (this: FileHandle, options) {
    return originalRead.call(this, { ...options, length: Math.min(options?.length ?? 2, 2) })
  })
  try {
    expect(await readInputAttachments([path])).toEqual([
      { name: "input.txt", data: Buffer.from("short read").toString("base64") },
    ])
    expect(read.mock.calls.length).toBeGreaterThan(1)
  } finally {
    read.mockRestore()
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
  try {
    const input = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const files = yield* prepareTaskFiles(configuration, makeTaskId(), [
            AttachmentName.make("screen.png"),
          ])
          yield* Effect.promise(async () => {
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
            await writeFile(join(files.output, "report.txt"), Buffer.alloc(1_024))
            const prototype = await fileHandlePrototype(join(files.output, "report.txt"))
            const originalStat = prototype.stat
            const stat = vi
              .spyOn(prototype, "stat")
              .mockImplementation(async function (this: FileHandle) {
                const metadata = await originalStat.call(this)
                await truncate(join(files.output, "report.txt"), 8 * 1024 * 1024)
                return metadata
              })
            const readFileSpy = vi.spyOn(prototype, "readFile").mockImplementation(async () => {
              throw new Error("Unbounded file read")
            })
            try {
              await expect(files.collectOutputs()).rejects.toThrow("changed size while reading")
              expect(readFileSpy).not.toHaveBeenCalled()
            } finally {
              stat.mockRestore()
              readFileSpy.mockRestore()
            }
          })
          return join(files.input, "screen.png")
        }),
      ),
    )
    await expect(readFile(input)).rejects.toBeDefined()
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
