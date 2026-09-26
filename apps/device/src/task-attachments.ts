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
        const data = await handle.readFile()
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
  readonly cleanup: () => Promise<void>
}

export const prepareTaskFiles = async (
  configuration: DeviceConfiguration,
  taskId: TaskId,
  inputNames: ReadonlyArray<AttachmentName>,
  signal: AbortSignal,
): Promise<TaskFiles> => {
  const client = RelayClient.make({ baseUrl: configuration.relayUrl, token: configuration.token })
  const root = await mkdtemp(join(tmpdir(), "cohall-task-"))
  const input = join(root, "input")
  const output = join(root, "output")
  try {
    await Promise.all([mkdir(input), mkdir(output)])
    for (const name of inputNames) {
      const data = await Effect.runPromise(client.readAttachment(taskId, name), { signal })
      await writeFile(join(input, name), data, { flag: "wx", mode: 0o600 })
    }
    return {
      input,
      output,
      inputNames,
      collectOutputs: () => collectOutputs(output),
      cleanup: () => rm(root, { recursive: true, force: true }),
    }
  } catch (cause) {
    await rm(root, { recursive: true, force: true })
    throw cause
  }
}

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
      const data = await handle.readFile()
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
