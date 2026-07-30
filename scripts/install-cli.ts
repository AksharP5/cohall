import { lstat, mkdir, readlink, symlink } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, dirname, join, resolve } from "node:path"

const source = resolve(import.meta.dir, "../apps/device/src/main.ts")
const directory = resolve(process.env.COHALL_BIN_DIR ?? join(homedir(), ".local/bin"))
const target = join(directory, "cohall")

const ignoreMissing = (cause: unknown): undefined => {
  if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
    return undefined
  }
  throw cause
}

const install = async (): Promise<void> => {
  await mkdir(directory, { recursive: true })
  const existing = await lstat(target).catch(ignoreMissing)
  if (existing !== undefined) {
    const destination = existing.isSymbolicLink()
      ? resolve(dirname(target), await readlink(target))
      : undefined
    if (destination !== source) {
      throw new Error(`${target} already exists and is not the Cohall CLI link`)
    }
    console.log(`Cohall CLI is already installed at ${target}`)
    return
  }

  await symlink(source, target)
  console.log(`Installed Cohall CLI at ${target}`)
  const paths = (process.env.PATH ?? "").split(delimiter)
  if (!paths.includes(directory)) {
    console.log(`Add ${directory} to PATH before running cohall`)
  }
}

await install().catch((cause: unknown) => {
  console.error(cause instanceof Error ? cause.message : String(cause))
  process.exitCode = 1
})
