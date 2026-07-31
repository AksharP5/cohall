import { mkdir } from "node:fs/promises"
import { join } from "node:path"

const targets = {
  "aarch64-apple-darwin": "bun-darwin-arm64",
  "x86_64-apple-darwin": "bun-darwin-x64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64-baseline",
  "x86_64-pc-windows-msvc": "bun-windows-x64-baseline",
} as const

type TauriTarget = keyof typeof targets

const requestedTarget = (): string | undefined => {
  const index = Bun.argv.indexOf("--target")
  if (index === -1) {
    return process.env.TAURI_ENV_TARGET_TRIPLE
  }
  return Bun.argv[index + 1]
}

const hostTarget = async (): Promise<string> => {
  const process = Bun.spawn(["rustc", "-vV"], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(process.stdout).text()
  const status = await process.exited
  if (status !== 0) {
    throw new Error(`rustc -vV failed: ${await new Response(process.stderr).text()}`)
  }
  const host = output
    .split("\n")
    .find((line) => line.startsWith("host: "))
    ?.slice("host: ".length)
  if (host === undefined) {
    throw new Error("rustc did not report its host target")
  }
  return host
}

const main = async (): Promise<void> => {
  const target = requestedTarget() ?? (await hostTarget())
  if (!(target in targets)) {
    throw new Error(
      `Unsupported desktop target ${target}. Supported targets: ${Object.keys(targets).join(", ")}`,
    )
  }
  const tauriTarget = target as TauriTarget
  const extension = tauriTarget.includes("windows") ? ".exe" : ""
  const directory = join(import.meta.dir, "../apps/desktop/src-tauri/binaries")
  const output = join(directory, `cohall-device-${tauriTarget}${extension}`)
  await mkdir(directory, { recursive: true })

  const process = Bun.spawn(
    [
      "bun",
      "build",
      "--compile",
      `--target=${targets[tauriTarget]}`,
      "apps/device/src/main.ts",
      `--outfile=${output}`,
    ],
    {
      cwd: join(import.meta.dir, ".."),
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  const status = await process.exited
  if (status !== 0) {
    throw new Error(`Device sidecar build failed with exit code ${status}`)
  }
}

await main()
