import type { FileHandle } from "node:fs/promises"

export const readBoundedFile = async (handle: FileHandle, limit: number): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(limit + 1)
  let size = 0
  while (size < buffer.length) {
    const { bytesRead } = await handle.read({
      buffer,
      offset: size,
      length: buffer.length - size,
      position: null,
    })
    if (bytesRead === 0) break
    size += bytesRead
  }
  return buffer.subarray(0, size)
}
