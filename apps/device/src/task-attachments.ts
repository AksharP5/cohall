import { RelayClient } from "@cohall/client"
import {
  AttachmentName,
  maxAttachmentBytes,
  maxTaskAttachments,
  type InputAttachment,
  type TaskId,
} from "@cohall/protocol"
import { Effect, Schema } from "effect"
import { constants } from "node:fs"
import { lstat, mkdtemp, mkdir, open, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import type { DeviceConfiguration } from "./config.ts"
import { readBoundedFile } from "./bounded-file.ts"

export const readInputAttachments = async (
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<InputAttachment>> => {
  if (paths.length > maxTaskAttachments) {
    throw new Error(`A task supports at most ${maxTaskAttachments} input files`)
  }
  const names = new Set<string>()
  return Promise.all(
    paths.map(async (path) => {
      const name = Schema.decodeUnknownSync(AttachmentName)(basename(path))
      const key = name.normalize("NFC").toLocaleLowerCase("en-US")
      if (names.has(key)) {
        throw new Error(`Attachment name ${name} is repeated`)
      }
      names.add(key)
      const source = await lstat(path)
      if (!source.isFile()) {
        throw new Error(`Attachment ${name} must be a regular file`)
      }
      const handle = await open(
        path,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
      )
      try {
        const metadata = await handle.stat()
        if (
          !metadata.isFile() ||
          metadata.dev !== source.dev ||
          metadata.ino !== source.ino ||
          metadata.size < 1 ||
          metadata.size > maxAttachmentBytes
        ) {
          throw new Error(
            `Attachment ${name} must be a regular file of 1 to ${maxAttachmentBytes} bytes`,
          )
        }
        const data = await readBoundedFile(handle, maxAttachmentBytes)
        if (data.length < 1 || data.length > maxAttachmentBytes) {
          throw new Error(`Attachment ${name} changed size while reading`)
        }
        return { name, data: data.toString("base64") }
      } finally {
        await handle.close()
      }
    }),
  )
}

export interface TaskFiles {
  readonly input: string
  readonly output: string
  readonly inputNames: ReadonlyArray<string>
  readonly collectOutputs: () => Promise<ReadonlyArray<InputAttachment>>
}

export const prepareTaskFiles = Effect.fn("TaskFiles.prepare")(function* (
  configuration: DeviceConfiguration,
  taskId: TaskId,
  inputNames: ReadonlyArray<AttachmentName>,
) {
  const client = RelayClient.make({ baseUrl: configuration.relayUrl, token: configuration.token })
  const root = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => mkdtemp(join(tmpdir(), "cohall-task-")),
      catch: (cause) => cause,
    }),
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  )
  const input = join(root, "input")
  const output = join(root, "output")
  // Filesystem operations must finish before the scope can remove their directory.
  yield* Effect.tryPromise({ try: () => mkdir(input), catch: (cause) => cause }).pipe(
    Effect.uninterruptible,
  )
  yield* Effect.tryPromise({ try: () => mkdir(output), catch: (cause) => cause }).pipe(
    Effect.uninterruptible,
  )
  for (const name of inputNames) {
    const data = yield* client.readAttachment(taskId, name)
    yield* Effect.tryPromise({
      try: () => writeFile(join(input, name), data, { flag: "wx", mode: 0o600 }),
      catch: (cause) => cause,
    }).pipe(Effect.uninterruptible)
  }
  return {
    input,
    output,
    inputNames,
    collectOutputs: () => collectOutputs(output),
  }
})

const collectOutputs = async (directory: string): Promise<ReadonlyArray<InputAttachment>> => {
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.length > maxTaskAttachments) {
    throw new Error(`A task can return at most ${maxTaskAttachments} files`)
  }
  const files: Array<InputAttachment> = []
  const names = new Set<string>()
  for (const entry of entries) {
    const name = Schema.decodeUnknownSync(AttachmentName)(entry.name)
    if (!entry.isFile()) {
      throw new Error(`Output ${name} must be a regular file`)
    }
    const key = name.normalize("NFC").toLocaleLowerCase("en-US")
    if (names.has(key)) {
      throw new Error(`Output ${name} repeats another file name`)
    }
    names.add(key)
    const handle = await open(
      join(directory, name),
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    )
    try {
      const metadata = await handle.stat()
      const pathMetadata = await lstat(join(directory, name))
      if (
        !metadata.isFile() ||
        !pathMetadata.isFile() ||
        metadata.dev !== pathMetadata.dev ||
        metadata.ino !== pathMetadata.ino ||
        metadata.size < 1 ||
        metadata.size > maxAttachmentBytes
      ) {
        throw new Error(`Output ${name} must be a regular file of 1 to ${maxAttachmentBytes} bytes`)
      }
      const data = await readBoundedFile(handle, maxAttachmentBytes)
      if (data.length < 1 || data.length > maxAttachmentBytes) {
        throw new Error(`Output ${name} changed size while reading`)
      }
      files.push({ name, data: data.toString("base64") })
    } finally {
      await handle.close()
    }
  }
  return files
}
