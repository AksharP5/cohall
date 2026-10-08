import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { once } from "node:events"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { execa } from "execa"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DeviceId, DeviceOperation, OperationId, now } from "@cohall/protocol"
import { performDeviceOperation } from "./daemon.ts"
import { installDeviceService } from "./service.ts"
import {
  deviceVersionWarning,
  isTrustedGroupWritablePath,
  isTrustedSystemPath,
  normalizeUpgradeTarget,
  packageInstallCommand,
  packageInstallation,
  resolvePackageInstallation,
  pnpmServiceDirectories,
  serviceCandidates,
  trustedExecutable,
  upgrade,
  type CommandResult,
  type CommandRunner,
  type PackageManager,
} from "./upgrade.ts"

const temporaryDirectories: Array<string> = []
const packageName = "@akshar5/cohall"

it("runs pnpm discovery independently of project dispatch, including Windows cmd shims", async () => {
  const root = await mkdtemp(join(tmpdir(), "cohall-pnpm-dispatch-"))
  temporaryDirectories.push(root)
  const script = join(root, "manager.cjs")
  const executable = process.platform === "win32" ? join(root, "pnpm.cmd") : script
  await writeFile(
    script,
    `#!${process.execPath}\nif (process.env.COREPACK_ENABLE_PROJECT_SPEC !== "0") process.exit(1); process.stdout.write(${JSON.stringify(root)})`,
  )
  if (process.platform === "win32")
    await writeFile(executable, `@"${process.execPath}" "${script}" %*\r\n`)
  else await chmod(executable, 0o700)
  vi.stubEnv("COREPACK_ENABLE_PROJECT_SPEC", "1")
  await expect(pnpmServiceDirectories(executable, root)).resolves.toEqual({
    bin: root,
    store: root,
  })
  expect(process.env.COREPACK_ENABLE_PROJECT_SPEC).toBe("1")
})

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "cohall-upgrade-"))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

const npmGlobalCommand = async (
  entrypoint: string,
  platform: NodeJS.Platform = process.platform,
) => {
  const modules = dirname(dirname(dirname(dirname(entrypoint))))
  const prefix = platform === "win32" ? dirname(modules) : dirname(dirname(modules))
  if (platform === "win32") {
    await writeFile(
      join(prefix, "cohall.cmd"),
      '@ECHO off\r\n"%_prog%" "%dp0%\\node_modules\\@akshar5\\cohall\\bin\\cohall.js" %*\r\n',
    )
    return
  }
  const command = join(prefix, "bin", "cohall")
  await mkdir(dirname(command), { recursive: true })
  await symlink(entrypoint, command, "file")
}

const success = (): CommandResult => ({ exitCode: 0, stdout: "", stderr: "" })
const resolveExecutable = (command: string): Promise<string> =>
  Promise.resolve(command === "systemctl" ? "/usr/bin/systemctl" : command)

it.skipIf(process.platform !== "win32")(
  "runs Windows package-manager shims without interpreting prefix arguments",
  async () => {
    const root = await temporaryDirectory()
    const prefix = join(root, "global tools & packages")
    const entrypoint = join(prefix, "node_modules", "@akshar5", "cohall", "bin", "cohall.js")
    const metadata = join(dirname(dirname(entrypoint)), "package.json")
    const argumentsPath = join(root, "arguments.json")
    const script = join(root, "installer.cjs")
    const shim = join(root, "npm.cmd")
    await mkdir(dirname(entrypoint), { recursive: true })
    await writeFile(entrypoint, "")
    await npmGlobalCommand(entrypoint, "win32")
    await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version: "1.2.2" }))
    await writeFile(shim, `@ECHO off\r\n"${process.execPath}" "%~dp0installer.cjs" %*\r\n`)
    await writeFile(
      script,
      `const fs = require("node:fs")
fs.writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)))
fs.writeFileSync(${JSON.stringify(metadata)}, JSON.stringify({name: "@akshar5/cohall", version: "1.2.3"}))
`,
    )
    const options = {
      currentVersion: "1.2.2",
      target: "1.2.3",
      restart: false,
      dryRun: false,
      entrypoint,
      statePath: join(root, "receipt.json"),
      resolveExecutable: async (command: string) => {
        if (command === "npm") return shim
        throw new Error(`Could not find ${command} on PATH`)
      },
    }
    await expect(upgrade(options)).resolves.toMatchObject({ installed_version: "1.2.3" })
    expect(JSON.parse(await readFile(argumentsPath, "utf8"))).toEqual([
      "install",
      "--global",
      "--prefix",
      (await realpath(prefix)).replaceAll("\\", "/"),
      "@akshar5/cohall@1.2.3",
    ])

    await writeFile(script, 'console.error("fixture installer failed"); process.exit(12)\n')
    await expect(upgrade({ ...options, target: "1.2.4" })).rejects.toThrow(
      "failed with status 12: fixture installer failed",
    )
  },
)

describe("upgrade target", () => {
  it("warns when the CLI and running daemon use different installations", () => {
    expect(deviceVersionWarning("1.2.3", "1.2.3")).toBeUndefined()
    expect(deviceVersionWarning("1.2.3", undefined)).toBeUndefined()
    expect(deviceVersionWarning("1.2.3", "1.2.2")).toContain(
      "executable configured by the device service",
    )
  })

  it("accepts latest and exact semantic versions", () => {
    expect(normalizeUpgradeTarget(undefined)).toBe("latest")
    expect(normalizeUpgradeTarget("latest")).toBe("latest")
    expect(normalizeUpgradeTarget("v1.2.3")).toBe("1.2.3")
    expect(normalizeUpgradeTarget("1.2.3-beta.1")).toBe("1.2.3-beta.1")
  })

  it("rejects tags and command-like input", () => {
    expect(() => normalizeUpgradeTarget("next")).toThrow("exact semantic version")
    expect(() => normalizeUpgradeTarget("1.2.3; reboot")).toThrow("exact semantic version")
  })

  it("trusts fixed Linux OS paths without trusting other users' private paths", () => {
    expect(isTrustedSystemPath("linux", "/usr/bin/systemctl")).toBe(true)
    expect(isTrustedSystemPath("linux", "/usr/lib/node_modules/npm/bin/npm-cli.js")).toBe(true)
    expect(isTrustedSystemPath("linux", "/usr/share/nodejs/npm/bin/npm-cli.js")).toBe(true)
    expect(isTrustedSystemPath("linux", "/nix/store/hash/bin/systemctl")).toBe(true)
    expect(isTrustedSystemPath("linux", "/usr/bin-attacker/systemctl")).toBe(false)
    expect(isTrustedSystemPath("linux", "/usr/local/bin/systemctl")).toBe(false)
    expect(isTrustedSystemPath("darwin", "/usr/bin/systemctl")).toBe(false)
    expect(isTrustedSystemPath("linux", "/")).toBe(true)
    expect(isTrustedSystemPath("linux", "/usr")).toBe(true)
    expect(isTrustedSystemPath("linux", "/home")).toBe(true)
    expect(isTrustedSystemPath("linux", "/home/other-user/bin/npm")).toBe(false)
    expect(isTrustedSystemPath("linux", "/home-attacker")).toBe(false)
  })
})

describe("latest upgrades", () => {
  const installation = async (
    version: string,
    manager: PackageManager = "npm",
    platform: NodeJS.Platform = process.platform,
  ) => {
    const root = await temporaryDirectory()
    const prefix =
      manager === "bun"
        ? join(root, ".bun", "install", "global")
        : manager === "pnpm"
          ? join(root, "pnpm", "global", "5")
          : platform === "win32"
            ? root
            : join(root, "lib")
    const entrypoint = join(prefix, "node_modules", "@akshar5", "cohall", "bin", "cohall.js")
    const metadata = join(dirname(dirname(entrypoint)), "package.json")
    await mkdir(dirname(entrypoint), { recursive: true })
    await writeFile(entrypoint, "#!/usr/bin/env node\n")
    await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version }))
    if (manager === "npm") await npmGlobalCommand(entrypoint, platform)
    return { root, entrypoint, metadata }
  }

  it.each([
    ["2.0.0", "1.99.99"],
    ["1.10.0", "1.9.99"],
    ["1.2.10", "1.2.9"],
    ["1.2.3", "1.2.3-rc.10"],
    ["1.2.3-rc.10", "1.2.3-rc.9"],
    ["1.2.3-beta", "1.2.3-99"],
    ["1.2.3-beta.1", "1.2.3-beta"],
    ["1.2.4-rc.1+build.1", "1.2.3+build.99"],
  ])("leaves %s installed when latest is older (%s)", async (currentVersion, latest) => {
    const { root, entrypoint, metadata } = await installation(currentVersion, "npm", "linux")
    const invocations: Array<string> = []
    const runner: CommandRunner = {
      run: async (command, arguments_) => {
        const invocation = [command, ...arguments_].join(" ")
        invocations.push(invocation)
        if (arguments_[0] === "view") {
          return { exitCode: 0, stdout: JSON.stringify(latest), stderr: "" }
        }
        if (arguments_.includes("show")) {
          return {
            exitCode: 0,
            stdout: `{ path=${entrypoint} ; argv[]=${entrypoint} device ; }`,
            stderr: "",
          }
        }
        if (command === "npm") {
          await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version: latest }))
        }
        return success()
      },
    }

    const result = await upgrade({
      currentVersion,
      restart: true,
      dryRun: false,
      entrypoint,
      platform: "linux",
      statePath: join(root, "receipt.json"),
      runner,
      resolveExecutable,
    })

    expect(result).toMatchObject({
      upgraded: false,
      installed_version: currentVersion,
      requested_version: "latest",
      services_restarted: [],
    })
    expect(invocations).toContain(
      `npm view --global --prefix ${root} @akshar5/cohall@latest version --json`,
    )
    expect(invocations.some((invocation) => invocation.includes(" install "))).toBe(false)
    expect(invocations.some((invocation) => invocation.includes(" restart "))).toBe(false)
    expect(JSON.parse(await readFile(metadata, "utf8"))).toMatchObject({ version: currentVersion })
  })

  it("reports retained pending restarts when latest is older", async () => {
    const { root, entrypoint } = await installation("1.2.3", "npm", "linux")
    const statePath = join(root, "receipt.json")
    const pendingServices = ["systemd-user:cohall-device.service"]
    const receipt = JSON.stringify({
      version: "1.2.3",
      fromVersion: "1.2.2",
      packageManager: "npm",
      pendingServices,
      restartedServices: [],
    })
    await writeFile(statePath, receipt)
    const invocations: Array<string> = []
    const result = await upgrade({
      currentVersion: "1.2.3",
      restart: false,
      dryRun: false,
      entrypoint,
      platform: "linux",
      statePath,
      resolveExecutable,
      runner: {
        run: async (command, arguments_) => {
          invocations.push([command, ...arguments_].join(" "))
          return arguments_[0] === "view"
            ? { ...success(), stdout: JSON.stringify("1.2.2") }
            : { exitCode: 3, stdout: "", stderr: "" }
        },
      },
    })
    expect(result).toMatchObject({
      upgraded: false,
      installed_version: "1.2.3",
      services_pending_restart: pendingServices,
    })
    expect(await readFile(statePath, "utf8")).toBe(receipt)
    expect(invocations.some((invocation) => invocation.includes(" install "))).toBe(false)
    expect(invocations.some((invocation) => invocation.includes(" restart "))).toBe(false)
  })

  it.each([
    { target: "1.2.3", latest: "1.2.4", installed: "1.2.3", installs: 1, restarts: 1 },
    { target: "latest", latest: "1.2.4", installed: "1.2.4", installs: 0, restarts: 1 },
    { target: "latest", latest: "1.2.3", installed: "1.2.4", installs: 0, restarts: 0 },
  ])(
    "checks disk before recovering a stale $target receipt with latest=$latest",
    async ({ target, latest, installed, installs, restarts }) => {
      const { root, entrypoint, metadata } = await installation("1.2.4", "npm", "linux")
      const statePath = join(root, "receipt.json")
      const pendingServices = ["systemd-user:cohall-device.service"]
      const receipt = JSON.stringify({
        version: "1.2.3",
        fromVersion: "1.2.2",
        packageManager: "npm",
        pendingServices,
        restartedServices: [],
      })
      await writeFile(statePath, receipt)
      const installedTargets: Array<string | undefined> = []
      const restartedVersions: Array<string> = []
      const result = await upgrade({
        currentVersion: "1.2.3",
        target,
        restart: true,
        dryRun: false,
        entrypoint,
        platform: "linux",
        uid: 1000,
        statePath,
        resolveExecutable,
        runner: {
          run: async (command, arguments_) => {
            if (arguments_.includes("is-active"))
              return {
                ...success(),
                exitCode:
                  arguments_.includes("--user") && arguments_.at(-1) === "cohall-device.service"
                    ? 0
                    : 3,
              }
            if (arguments_.includes("show"))
              return {
                ...success(),
                stdout: `{ path=${entrypoint} ; argv[]=${entrypoint} device ; }`,
              }
            if (arguments_[0] === "view") return { ...success(), stdout: JSON.stringify(latest) }
            if (command === "npm" && arguments_[0] === "install") {
              installedTargets.push(arguments_.at(-1))
              await writeFile(metadata, JSON.stringify({ name: packageName, version: installed }))
            }
            if (arguments_.includes("restart"))
              restartedVersions.push(JSON.parse(await readFile(metadata, "utf8")).version)
            return success()
          },
        },
      })

      expect(result).toMatchObject({
        installed_version: installed,
        requested_version: target,
        resumed_after_restart: false,
        services_pending_restart: restarts === 0 ? pendingServices : [],
      })
      expect(installedTargets).toEqual(installs === 0 ? [] : [`${packageName}@${installed}`])
      expect(restartedVersions).toEqual(restarts === 0 ? [] : [installed])
      expect(JSON.parse(await readFile(metadata, "utf8"))).toMatchObject({ version: installed })
      if (restarts === 0) expect(await readFile(statePath, "utf8")).toBe(receipt)
    },
  )

  it.each(["npm", "bun", "pnpm"] as const)(
    "pins a newer latest version before installing with %s",
    async (manager) => {
      const { root, entrypoint, metadata } = await installation("1.2.3-rc.1", manager)
      const invocations: Array<string> = []
      const runner: CommandRunner = {
        run: async (command, arguments_) => {
          const invocation = [command, ...arguments_].join(" ")
          invocations.push(invocation)
          if (command === "bun" && arguments_[1] === "ls")
            return {
              ...success(),
              stdout: `${join(root, ".bun", "install", "global")} node_modules (1 installed)\n└── @akshar5/cohall@1.2.3`,
            }
          if (command === "pnpm" && arguments_[0] === "root")
            return { ...success(), stdout: join(root, "pnpm", "global", "5", "node_modules") }
          if (arguments_[0] === "--version") {
            return { exitCode: 0, stdout: "1.2.15\n", stderr: "" }
          }
          if (arguments_.includes("view")) {
            return { exitCode: 0, stdout: '"1.2.3"', stderr: "" }
          }
          if (command === manager) {
            await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }))
            return success()
          }
          return { exitCode: 3, stdout: "", stderr: "" }
        },
      }

      const result = await upgrade({
        currentVersion: "1.2.3-rc.1",
        target: "latest",
        restart: false,
        dryRun: false,
        entrypoint,
        statePath: join(root, "receipt.json"),
        runner,
        resolveExecutable,
      })

      expect(result).toMatchObject({ upgraded: true, installed_version: "1.2.3" })
      const install = packageInstallCommand(
        {
          ...packageInstallation(await realpath(entrypoint)),
          ...(manager === "pnpm" ? { globalDir: join(root, "pnpm", "global") } : {}),
        },
        "1.2.3",
      )
      expect(invocations).toContain([install.command, ...install.arguments].join(" "))
      expect(invocations.some((invocation) => /(?:install|add).*@latest$/.test(invocation))).toBe(
        false,
      )
    },
  )

  it.each([
    ["1.2.3", "1.2.5"],
    ["1.2.5", "1.2.3"],
  ])(
    "guards a delegated latest operation with running %s and installed %s",
    async (running, installed) => {
      const { root, entrypoint } = await installation(installed)
      const invocations: Array<string> = []
      const runner: CommandRunner = {
        run: async (command, arguments_) => {
          invocations.push([command, ...arguments_].join(" "))
          return arguments_[0] === "view"
            ? { exitCode: 0, stdout: '"1.2.4"', stderr: "" }
            : { exitCode: 3, stdout: "", stderr: "" }
        },
      }
      const operation = DeviceOperation.make({
        id: OperationId.make("66666666-6666-4666-8666-666666666666"),
        kind: "upgrade",
        status: "assigned",
        targetDeviceId: DeviceId.make("11111111-1111-4111-8111-111111111111"),
        requestedVersion: "latest",
        restart: true,
        createdAt: now(),
        updatedAt: now(),
      })

      const output = await performDeviceOperation(operation, running, (options) =>
        upgrade({
          ...options,
          entrypoint,
          statePath: join(root, "receipt.json"),
          runner,
          resolveExecutable,
        }),
      )

      expect(JSON.parse(output)).toMatchObject({
        installed_version: installed,
        requested_version: "latest",
      })
      expect(invocations.some((invocation) => invocation.startsWith("npm install"))).toBe(false)
    },
  )

  it.each(["npm", "bun"] as const)(
    "allows an exact %s version rollback without a latest lookup",
    async (manager) => {
      const { root, entrypoint, metadata } = await installation("1.2.5", manager)
      const invocations: Array<string> = []
      const runner: CommandRunner = {
        run: async (command, arguments_) => {
          invocations.push([command, ...arguments_].join(" "))
          if (command === "bun" && arguments_[1] === "ls")
            return {
              ...success(),
              stdout: `${join(root, ".bun", "install", "global")} node_modules (1 installed)`,
            }
          if (command !== manager) return { exitCode: 3, stdout: "", stderr: "" }
          if (arguments_.includes("view") || arguments_[0] === "--version") {
            throw new Error("Exact versions must not look up latest or check the manager version")
          }
          await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }))
          return success()
        },
      }

      await expect(
        upgrade({
          currentVersion: "1.2.5",
          target: "1.2.3",
          restart: false,
          dryRun: false,
          entrypoint,
          statePath: join(root, "receipt.json"),
          runner,
          resolveExecutable,
        }),
      ).resolves.toMatchObject({ installed_version: "1.2.3", requested_version: "1.2.3" })
      expect(invocations.some((invocation) => invocation.includes(" view "))).toBe(false)
    },
  )

  it.each(["1.2.14", "1.2.15-rc.1"])(
    "refuses a latest lookup on unsupported Bun %s",
    async (bunVersion) => {
      const { root, entrypoint } = await installation("1.2.3", "bun")
      const invocations: Array<string> = []
      const runner: CommandRunner = {
        run: async (command, arguments_) => {
          invocations.push([command, ...arguments_].join(" "))
          if (command === "bun" && arguments_[1] === "ls")
            return {
              ...success(),
              stdout: `${join(root, ".bun", "install", "global")} node_modules (1 installed)`,
            }
          return command === "bun" && arguments_[0] === "--version"
            ? { exitCode: 0, stdout: bunVersion, stderr: "" }
            : { exitCode: 3, stdout: "", stderr: "" }
        },
      }

      await expect(
        upgrade({
          currentVersion: "1.2.3",
          restart: true,
          dryRun: false,
          entrypoint,
          statePath: join(root, "receipt.json"),
          runner,
          resolveExecutable,
        }),
      ).rejects.toThrow("Latest upgrades require Bun 1.2.15 or newer")
      expect(invocations.filter((invocation) => invocation.startsWith("bun "))).toEqual([
        "bun pm ls --global",
        "bun --version",
      ])
    },
  )

  it("resolves latest through npm's custom global registry configuration", async () => {
    const { root, entrypoint } = await installation("99.0.0")
    const requests: Array<string> = []
    const registry = createServer((request, response) => {
      requests.push(request.url ?? "")
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({
          name: "@akshar5/cohall",
          "dist-tags": { latest: "1.2.3" },
          versions: { "1.2.3": { name: "@akshar5/cohall", version: "1.2.3" } },
        }),
      )
    })
    registry.listen(0, "127.0.0.1")
    await once(registry, "listening")
    const address = registry.address()
    if (address === null || typeof address === "string")
      throw new Error("Registry did not bind a port")
    const registryUrl = `http://127.0.0.1:${address.port}/`
    await mkdir(join(root, "etc"))
    await writeFile(
      join(root, "etc", "npmrc"),
      `registry=${registryUrl}\n@akshar5:registry=${registryUrl}\n`,
    )
    const userConfig = join(root, "user-npmrc")
    await writeFile(userConfig, "")
    vi.stubEnv("npm_config_userconfig", userConfig)
    vi.stubEnv("npm_config_cache", join(root, "cache"))
    vi.stubEnv("npm_config_update_notifier", "false")
    const runner: CommandRunner = {
      run: async (command, arguments_) => {
        if (command !== "npm") return { exitCode: 3, stdout: "", stderr: "" }
        if (arguments_[0] !== "view") throw new Error("This test must never install a package")
        const result = await execa(command, arguments_, { reject: false })
        return { exitCode: result.exitCode ?? 1, stdout: result.stdout, stderr: result.stderr }
      },
    }

    try {
      await expect(
        upgrade({
          currentVersion: "99.0.0",
          restart: false,
          dryRun: false,
          entrypoint,
          statePath: join(root, "receipt.json"),
          runner,
          resolveExecutable,
        }),
      ).resolves.toMatchObject({ installed_version: "99.0.0", upgraded: false })
      expect(requests.map((path) => decodeURIComponent(path))).toContain("/@akshar5/cohall")
    } finally {
      await new Promise<void>((resolve, reject) =>
        registry.close((error) => (error === undefined ? resolve() : reject(error))),
      )
    }
  })

  it("refuses latest when a stale process cannot verify the installed version", async () => {
    const { root, entrypoint, metadata } = await installation("1.2.5")
    await rm(metadata)
    const invocations: Array<string> = []
    const runner: CommandRunner = {
      run: async (command, arguments_) => {
        invocations.push([command, ...arguments_].join(" "))
        return arguments_[0] === "view"
          ? { exitCode: 0, stdout: '"1.2.4"', stderr: "" }
          : { exitCode: 3, stdout: "", stderr: "" }
      },
    }

    await expect(
      upgrade({
        currentVersion: "1.2.3",
        restart: false,
        dryRun: false,
        entrypoint,
        statePath: join(root, "receipt.json"),
        runner,
        resolveExecutable,
      }),
    ).rejects.toThrow("Could not verify the installed version before upgrading latest")
    expect(invocations.some((invocation) => invocation.startsWith("npm install"))).toBe(false)
  })

  it.each(['"latest"', '"1.2.3-01"', '["1.2.3"]'])(
    "leaves the installation and recovery state intact when latest is invalid: %s",
    async (stdout) => {
      const { root, entrypoint, metadata } = await installation("1.2.3")
      const statePath = join(root, "receipt.json")
      const receipt = JSON.stringify({
        version: "1.2.2",
        fromVersion: "1.2.1",
        packageManager: "npm",
        pendingServices: [],
        restartedServices: [],
      })
      await writeFile(statePath, receipt)
      const invocations: Array<string> = []
      const runner: CommandRunner = {
        run: async (command, arguments_) => {
          invocations.push([command, ...arguments_].join(" "))
          return arguments_[0] === "view"
            ? { exitCode: 0, stdout, stderr: "" }
            : { exitCode: 3, stdout: "", stderr: "" }
        },
      }

      await expect(
        upgrade({
          currentVersion: "1.2.3",
          restart: true,
          dryRun: false,
          entrypoint,
          statePath,
          runner,
          resolveExecutable,
        }),
      ).rejects.toThrow("Could not resolve @akshar5/cohall@latest")
      expect(invocations.some((invocation) => invocation.includes(" install "))).toBe(false)
      expect(JSON.parse(await readFile(metadata, "utf8"))).toMatchObject({ version: "1.2.3" })
      expect(await readFile(statePath, "utf8")).toBe(receipt)
    },
  )
})

describe("package installation", () => {
  const platforms = [
    { platform: "linux", name: "Linux" },
    { platform: "win32", name: "Windows" },
  ] as const
  it.each([
    { platform: "linux" as const, name: "Linux", localRoot: "project" },
    { platform: "linux" as const, name: "Linux", localRoot: "project/lib" },
    { platform: "win32" as const, name: "Windows", localRoot: "project" },
  ])(
    "rejects local npm at $localRoot on $name before changing an installation or service",
    async ({ platform, localRoot }) => {
      const root = await temporaryDirectory()
      const entrypoint = join(root, localRoot, "node_modules", packageName, "bin", "cohall.js")
      await mkdir(dirname(entrypoint), { recursive: true })
      await writeFile(entrypoint, "")
      await writeFile(
        join(dirname(dirname(entrypoint)), "package.json"),
        JSON.stringify({ name: packageName, version: "1.2.3" }),
      )
      const commands: Array<ReadonlyArray<string>> = []
      const runner: CommandRunner = {
        run: async (command, args) => {
          commands.push([command, ...args])
          return { exitCode: 1, stdout: "", stderr: "not installed" }
        },
      }
      const options = { entrypoint, platform, runner, resolveExecutable }
      await expect(
        upgrade({
          ...options,
          currentVersion: "1.2.3",
          target: "1.2.4",
          restart: true,
          dryRun: false,
          statePath: join(root, "receipt.json"),
        }),
      ).rejects.toThrow("verified global")
      await expect(installDeviceService({ ...options, home: root })).rejects.toThrow(
        "verified global",
      )
      expect(commands).toEqual([
        ["bun", "pm", "ls", "--global"],
        ["bun", "pm", "ls", "--global"],
      ])
    },
  )

  it.each(platforms)("preserves a verified custom npm prefix on $name", async ({ platform }) => {
    const root = await temporaryDirectory()
    const prefix = join(root, "custom global tools", "lib")
    const entrypoint = join(
      prefix,
      ...(platform === "win32" ? [] : ["lib"]),
      "node_modules",
      packageName,
      "bin",
      "cohall.js",
    )
    await mkdir(dirname(entrypoint), { recursive: true })
    await writeFile(entrypoint, "")
    const metadata = join(dirname(dirname(entrypoint)), "package.json")
    await writeFile(metadata, JSON.stringify({ name: packageName, version: "1.2.3" }))
    await npmGlobalCommand(entrypoint, platform)
    const commands: Array<ReadonlyArray<string>> = []
    await expect(
      upgrade({
        currentVersion: "1.2.3",
        target: "1.2.4",
        restart: false,
        dryRun: false,
        platform,
        entrypoint,
        statePath: join(root, "receipt.json"),
        resolveExecutable,
        runner: {
          run: async (command, args) => {
            commands.push([command, ...args])
            if (command !== "npm") return { ...success(), exitCode: 1 }
            await writeFile(metadata, JSON.stringify({ name: packageName, version: "1.2.4" }))
            return success()
          },
        },
      }),
    ).resolves.toMatchObject({ installed_version: "1.2.4", package_manager: "npm" })
    expect(commands.filter(([command]) => command === "npm")).toEqual([
      [
        "npm",
        "install",
        "--global",
        "--prefix",
        (await realpath(prefix)).replaceAll("\\", "/"),
        `${packageName}@1.2.4`,
      ],
    ])
    expect(commands.some(([command]) => command === "bun")).toBe(false)
  })

  it.each(platforms)(
    "rejects an npm global command pointing to another installation on $name",
    async ({ platform }) => {
      const root = await temporaryDirectory()
      const entrypoint = join(
        root,
        ...(platform === "win32" ? [] : ["lib"]),
        "node_modules",
        packageName,
        "bin",
        "cohall.js",
      )
      await mkdir(dirname(entrypoint), { recursive: true })
      await writeFile(entrypoint, "")
      if (platform === "win32") {
        await writeFile(join(root, "cohall.cmd"), '@node "%dp0%\\other\\cohall.js" %*\r\n')
      } else {
        const other = join(root, "other.js")
        await writeFile(other, "")
        await mkdir(join(root, "bin"))
        await symlink(other, join(root, "bin", "cohall"), "file")
      }
      await expect(
        resolvePackageInstallation(entrypoint, {
          platform,
          resolveExecutable: async () => {
            throw new Error("Could not find manager on PATH")
          },
        }),
      ).rejects.toThrow("verified global")
    },
  )

  it.each([
    { version: "1.2.15 and 1.3.13", count: "1" },
    { version: "1.4.1", count: "1 installed" },
  ])("identifies custom Bun $version globals and pins the install root", async ({ count }) => {
    const root = await temporaryDirectory()
    const global = join(root, "custom Bun packages")
    const entrypoint = join(global, "node_modules", packageName, "bin", "cohall.js")
    await mkdir(dirname(entrypoint), { recursive: true })
    await writeFile(entrypoint, "")
    const metadata = join(dirname(dirname(entrypoint)), "package.json")
    await writeFile(metadata, JSON.stringify({ name: packageName, version: "1.2.3" }))
    const invocations: Array<{
      command: string
      args: ReadonlyArray<string>
      environment?: Readonly<Record<string, string>>
    }> = []
    const runner: CommandRunner = {
      run: async (command, args, _timeout, environment) => {
        invocations.push({ command, args, ...(environment === undefined ? {} : { environment }) })
        if (command === "bun" && args[1] === "ls")
          return {
            ...success(),
            stdout: `${global} node_modules (${count})\n\u001b[0m└── @akshar5/cohall@1.2.3\u001b[0m\n`,
          }
        if (command === "bun" && args[0] === "add") {
          expect(environment).toEqual({ BUN_INSTALL_GLOBAL_DIR: global })
          await writeFile(metadata, JSON.stringify({ name: packageName, version: "1.2.4" }))
          return success()
        }
        return { ...success(), exitCode: 1 }
      },
    }
    await expect(
      upgrade({
        currentVersion: "1.2.3",
        target: "1.2.4",
        restart: false,
        dryRun: false,
        entrypoint,
        statePath: join(root, "receipt.json"),
        runner,
        resolveExecutable,
      }),
    ).resolves.toMatchObject({ package_manager: "bun", installed_version: "1.2.4" })
    expect(invocations.filter(({ args }) => args[0] === "add")).toEqual([
      {
        command: "bun",
        args: ["add", "--global", `${packageName}@1.2.4`],
        environment: { BUN_INSTALL_GLOBAL_DIR: global },
      },
    ])
    expect(invocations.some(({ command }) => command === "npm")).toBe(false)
  })

  it("rejects a Bun installation when the selected manager reports a different global root", async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(
      root,
      "selected",
      ".bun",
      "install",
      "global",
      "node_modules",
      packageName,
      "bin",
      "cohall.js",
    )
    const other = join(root, "other")
    await mkdir(dirname(entrypoint), { recursive: true })
    await writeFile(entrypoint, "")
    const runner: CommandRunner = {
      run: async () => ({ ...success(), stdout: `${other} node_modules (1 installed)` }),
    }
    await expect(
      resolvePackageInstallation(entrypoint, { runner, resolveExecutable }),
    ).rejects.toThrow("verified global")
  })

  it.skipIf(process.platform === "win32")(
    "preserves a selected manager symlink while validating both path ancestries",
    async () => {
      const root = await mkdtemp(join(process.cwd(), ".cohall-manager-path-"))
      temporaryDirectories.push(root)
      const safe = join(root, "safe")
      const unsafe = join(root, "unsafe")
      await mkdir(safe, { mode: 0o700 })
      await mkdir(unsafe, { mode: 0o700 })
      const target = join(safe, "pnpm")
      const replacement = join(safe, "pnpm-next")
      for (const path of [target, replacement])
        await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      const shim = join(root, "pnpm")
      await symlink(target, shim)
      await expect(trustedExecutable(shim, { preserveSymlink: true })).resolves.toBe(shim)
      await rm(shim)
      await symlink(replacement, shim)
      await expect(trustedExecutable(shim, { preserveSymlink: true })).resolves.toBe(shim)
      const unsafeShim = join(unsafe, "pnpm")
      await symlink(target, unsafeShim)
      await chmod(unsafe, 0o770)
      await expect(trustedExecutable(unsafeShim, { preserveSymlink: true })).rejects.toThrow(
        "group- or world-writable",
      )
    },
  )

  it.skipIf(process.platform === "win32")(
    "uses a trusted PATH candidate when an earlier installation is unsafe",
    async () => {
      const root = await mkdtemp(join(process.cwd(), ".cohall-upgrade-path-"))
      temporaryDirectories.push(root)
      const unsafe = join(root, "unsafe")
      const safe = join(root, "safe")
      for (const directory of [unsafe, safe]) {
        await mkdir(directory, { mode: 0o700 })
        await writeFile(join(directory, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
      }
      await chmod(unsafe, 0o770)
      vi.stubEnv("PATH", `${unsafe}:${safe}`)

      await expect(trustedExecutable("npm")).resolves.toBe(join(safe, "npm"))
      await expect(trustedExecutable(join(unsafe, "npm"))).rejects.toThrow(
        "group- or world-writable",
      )
      await chmod(safe, 0o770)
      await expect(trustedExecutable("npm")).rejects.toThrow("group- or world-writable")
    },
  )

  it.skipIf(process.platform === "win32")(
    "rejects executables beneath writable directories",
    async () => {
      const root = await temporaryDirectory()
      const executable = join(root, "npm")
      await writeFile(executable, "#!/bin/sh\nexit 0\n")
      await chmod(root, 0o777)
      await chmod(executable, 0o755)
      await expect(trustedExecutable(executable)).rejects.toThrow("group- or world-writable")
      await expect(trustedExecutable(executable, { writableRoot: root })).rejects.toThrow(
        "group- or world-writable",
      )
    },
  )

  it.skipIf(process.platform === "win32")(
    "rejects arbitrary group-writable installation prefixes",
    async () => {
      const root = await mkdtemp(join(process.cwd(), ".cohall-upgrade-trusted-"))
      temporaryDirectories.push(root)
      const executable = join(root, "npm")
      await writeFile(executable, "#!/bin/sh\nexit 0\n")
      await chmod(root, 0o770)
      await chmod(executable, 0o755)

      await expect(trustedExecutable(executable)).rejects.toThrow("group- or world-writable")
      await expect(trustedExecutable(executable, { writableRoot: root })).rejects.toThrow(
        "group- or world-writable",
      )
    },
  )

  it("limits group-writable package paths to the macOS Homebrew admin group", () => {
    const homebrew = {
      platform: "darwin" as const,
      canonical: "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js",
      writableRoot: "/opt/homebrew",
      path: "/opt/homebrew/lib",
      uid: 501,
      ownerUid: 501,
      ownerGid: 80,
    }

    expect(isTrustedGroupWritablePath(homebrew)).toBe(true)
    expect(isTrustedGroupWritablePath({ ...homebrew, platform: "linux" })).toBe(false)
    expect(isTrustedGroupWritablePath({ ...homebrew, ownerGid: 20 })).toBe(false)
    expect(isTrustedGroupWritablePath({ ...homebrew, ownerUid: 502 })).toBe(false)
    expect(isTrustedGroupWritablePath({ ...homebrew, writableRoot: "/Users/user/.local" })).toBe(
      false,
    )
  })

  it("preserves a custom npm prefix", () => {
    const installation = packageInstallation(
      "/home/user/.local/lib/node_modules/@akshar5/cohall/bin/cohall.js",
      undefined,
      "linux",
    )

    expect(installation).toEqual({
      manager: "npm",
      prefix: "/home/user/.local",
      entrypoint: "/home/user/.local/lib/node_modules/@akshar5/cohall/bin/cohall.js",
    })
    expect(packageInstallCommand(installation, "1.2.3")).toEqual({
      command: "npm",
      arguments: ["install", "--global", "--prefix", "/home/user/.local", "@akshar5/cohall@1.2.3"],
    })
  })

  it("recognizes Bun and pnpm global installs", () => {
    expect(
      packageInstallation(
        "/home/user/.bun/install/global/node_modules/@akshar5/cohall/bin/cohall.js",
      ).manager,
    ).toBe("bun")
    expect(
      packageInstallation(
        "/home/user/.local/share/pnpm/global/5/node_modules/@akshar5/cohall/bin/cohall.js",
      ).manager,
    ).toBe("pnpm")
  })

  it("refuses temporary package runners and source checkouts", () => {
    expect(() =>
      packageInstallation("/home/user/.npm/_npx/123/node_modules/@akshar5/cohall/bin/cohall.js"),
    ).toThrow("temporary package-runner cache")
    expect(() => packageInstallation("/work/cohall/bin/cohall.js")).toThrow("requires a global")
    expect(() =>
      packageInstallation(
        "/home/user/.local/share/pnpm/store/v11/links/package/node_modules/@akshar5/cohall/bin/cohall.js",
        "/home/user/.local/share/pnpm/dlx/cache/node_modules/@akshar5/cohall/bin/cohall.js",
      ),
    ).toThrow("temporary package-runner cache")
  })
})

describe("Windows service upgrades", () => {
  const fixture = async (manager: "npm" | "pnpm" = "npm") => {
    const root = await temporaryDirectory()
    const entrypoint = join(
      root,
      manager === "pnpm" ? "pnpm/global/5" : "current ' & é",
      "node_modules/@akshar5/cohall/bin/cohall.js",
    )
    const other = join(root, "other", "node_modules/@akshar5/cohall/bin/cohall.js")
    const metadata = join(dirname(dirname(entrypoint)), "package.json")
    for (const path of [entrypoint, other]) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, "")
      await writeFile(
        join(dirname(dirname(path)), "package.json"),
        JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }),
      )
    }
    if (manager === "npm") await npmGlobalCommand(entrypoint, "win32")
    const action = (path: string) => ({
      Execute: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      Arguments: `-NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(
        `$ErrorActionPreference = 'Stop'\r\n$env:COHALL_CONFIG = 'C:\\chosen config.json'\r\n${manager === "pnpm" ? "$env:PNPM_HOME = 'C:\\custom tools'\r\n$env:PATH = 'C:\\custom tools\\bin;C:\\custom tools' + ';' + $env:PATH\r\n" : ""}$env:PATH = 'C:\\Program Files\\nodejs' + ';' + $env:PATH\r\n& 'C:\\Program Files\\nodejs\\node.exe' '${path.replaceAll("'", "''")}' device\r\nexit $LASTEXITCODE\r\n`,
        "utf16le",
      ).toString("base64")}`,
    })
    const invocations: Array<{ command: string; arguments: ReadonlyArray<string> }> = []
    const statePath = join(root, "receipt.json")
    const run = (definition: unknown, currentVersion = "1.2.3") =>
      upgrade({
        currentVersion,
        target: "1.2.4",
        restart: true,
        dryRun: false,
        platform: "win32",
        entrypoint,
        statePath,
        resolveExecutable: async (command) => command,
        runner: {
          run: async (command, arguments_) => {
            invocations.push({ command, arguments: arguments_ })
            if (command === "pnpm" && arguments_[0] === "root")
              return { ...success(), stdout: join(root, "pnpm", "global", "5", "node_modules") }
            if (arguments_.some((argument) => argument.includes("ConvertTo-Json"))) {
              return { exitCode: 0, stdout: JSON.stringify(definition), stderr: "" }
            }
            if (command === manager) {
              await writeFile(
                metadata,
                JSON.stringify({ name: "@akshar5/cohall", version: "1.2.4" }),
              )
            }
            return success()
          },
        },
      })
    return { entrypoint, other, metadata, statePath, action, invocations, run }
  }

  it("upgrades a Windows pnpm task with its saved global home", async () => {
    const { entrypoint, action, run } = await fixture("pnpm")
    await expect(run(action(entrypoint))).resolves.toMatchObject({
      installed_version: "1.2.4",
      package_manager: "pnpm",
      services_restarted: ["scheduled-task:Cohall Device"],
    })
  })

  it("upgrades and restarts a Windows task using the same installation", async () => {
    const { entrypoint, action, invocations, run } = await fixture()
    await expect(run(action(entrypoint))).resolves.toMatchObject({
      installed_version: "1.2.4",
      services_restarted: ["scheduled-task:Cohall Device"],
    })
    expect(invocations.filter(({ command }) => command === "schtasks.exe")).toHaveLength(2)
    const inspection = invocations.findIndex(({ arguments: arguments_ }) =>
      arguments_.some((argument) => argument.includes("ConvertTo-Json")),
    )
    expect(inspection).toBeGreaterThanOrEqual(0)
    expect(inspection).toBeLessThan(invocations.findIndex(({ command }) => command === "npm"))
  })

  it.each([
    "different installation",
    "unrecognized action",
    "multiple actions",
    "modified bootstrap",
    "non-Node runtime",
  ] as const)(
    "leaves files and services unchanged for a Windows task with %s",
    async (scenario) => {
      const { entrypoint, other, metadata, action, invocations, run } = await fixture()
      const current = action(entrypoint)
      const encoded = current.Arguments.split(" ").at(-1) ?? ""
      const bootstrap = Buffer.from(encoded, "base64").toString("utf16le")
      const definition =
        scenario === "different installation"
          ? action(other)
          : scenario === "unrecognized action"
            ? { Execute: "cohall.cmd", Arguments: "device" }
            : scenario === "multiple actions"
              ? [current, action(other)]
              : {
                  ...current,
                  Arguments: current.Arguments.replace(
                    encoded,
                    Buffer.from(
                      scenario === "modified bootstrap"
                        ? `exit 0\r\n${bootstrap}`
                        : bootstrap.replace("node.exe", "other-runner.exe"),
                      "utf16le",
                    ).toString("base64"),
                  ),
                }
      await expect(run(definition)).rejects.toThrow(
        scenario === "different installation" ? "uses" : "Could not determine the executable",
      )
      expect(
        invocations.some(({ command }) => command === "npm" || command === "schtasks.exe"),
      ).toBe(false)
      expect(JSON.parse(await readFile(metadata, "utf8"))).toMatchObject({ version: "1.2.3" })
    },
  )

  it.skipIf(process.platform !== "win32").each(["npm", "pnpm"] as const)(
    "accepts Windows %s task paths with different letter casing",
    async (manager) => {
      const { entrypoint, action, run } = await fixture(manager)
      await expect(run(action(entrypoint.toUpperCase()))).resolves.toMatchObject({
        installed_version: "1.2.4",
      })
    },
  )

  it.each(["different installation", "unrecognized action"])(
    "preserves Windows restart recovery when the task uses a %s",
    async (scenario) => {
      const { entrypoint, other, metadata, statePath, action, invocations, run } = await fixture()
      await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version: "1.2.4" }))
      const receipt = JSON.stringify({
        version: "1.2.4",
        fromVersion: "1.2.3",
        packageManager: "npm",
        pendingServices: ["scheduled-task:Cohall Device"],
        restartedServices: [],
      })
      await writeFile(statePath, receipt)
      const definition =
        scenario === "different installation"
          ? action(other)
          : { Execute: "cohall.cmd", Arguments: "device" }

      await expect(run(definition, "1.2.4")).rejects.toThrow(
        scenario === "different installation" ? "uses" : "Could not determine the executable",
      )
      expect(
        invocations.some(({ command }) => command === "npm" || command === "schtasks.exe"),
      ).toBe(false)
      expect(await readFile(statePath, "utf8")).toBe(receipt)

      await expect(run(action(entrypoint), "1.2.4")).resolves.toMatchObject({
        installed_version: "1.2.4",
        services_restarted: ["scheduled-task:Cohall Device"],
        services_pending_restart: [],
      })
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    },
  )
})

describe("managed service upgrades", () => {
  it("orders relay restarts before the device daemon", () => {
    expect(serviceCandidates("linux", 1000).map((service) => service.id)).toEqual([
      "systemd-user:cohall-relay.service",
      "systemd-system:cohall-relay.service",
      "systemd-user:cohall-device.service",
    ])
    expect(serviceCandidates("darwin", 501).map((service) => service.id)).toEqual([
      "launchd:com.cohall.relay",
      "launchd:com.cohall.device",
    ])
  })

  it("installs the requested version and restarts only active services", async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, "lib", "node_modules", "@akshar5", "cohall", "bin", "cohall.js")
    const packageRoot = dirname(dirname(entrypoint))
    await mkdir(dirname(entrypoint), { recursive: true })
    await writeFile(entrypoint, "#!/usr/bin/env node\n")
    await npmGlobalCommand(entrypoint, "linux")
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "@akshar5/cohall", version: "1.2.2" }),
    )

    const invocations: Array<string> = []
    const restartReceipts: Array<string> = []
    const statePath = join(root, "upgrade-restart.json")
    const runner: CommandRunner = {
      run: async (command, arguments_) => {
        const invocation = [command, ...arguments_].join(" ")
        invocations.push(invocation)
        if (command === "npm") {
          await writeFile(
            join(packageRoot, "package.json"),
            JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }),
          )
        }
        if (invocation === "/usr/bin/systemctl is-active --quiet cohall-relay.service") {
          return { exitCode: 3, stdout: "", stderr: "" }
        }
        if (invocation.includes(" show --property=ExecStart --value ")) {
          return {
            exitCode: 0,
            stdout: `{ path=${entrypoint} ; argv[]=${entrypoint} device ; }`,
            stderr: "",
          }
        }
        if (invocation.includes(" restart ")) {
          restartReceipts.push(await readFile(statePath, "utf8"))
        }
        return success()
      },
    }

    const result = await upgrade({
      currentVersion: "1.2.2",
      target: "1.2.3",
      restart: true,
      dryRun: false,
      entrypoint,
      platform: "linux",
      uid: 1000,
      statePath,
      runner,
      resolveExecutable,
    })

    expect(result.installed_version).toBe("1.2.3")
    expect(result.services_restarted).toEqual([
      "systemd-user:cohall-relay.service",
      "systemd-user:cohall-device.service",
    ])
    expect(invocations).toContain(`npm install --global --prefix ${root} @akshar5/cohall@1.2.3`)
    expect(invocations.filter((invocation) => invocation.includes(" restart "))).toEqual([
      "/usr/bin/systemctl --user restart cohall-relay.service",
      "/usr/bin/systemctl --user restart cohall-device.service",
    ])
    expect(restartReceipts[0]).toContain('"restartingService": "systemd-user:cohall-relay.service"')
    expect(restartReceipts[1]).toContain(
      '"restartingService": "systemd-user:cohall-device.service"',
    )
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("restarts active services when the installed files are already current", async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, "lib", "node_modules", "@akshar5", "cohall", "bin", "cohall.js")
    const packageRoot = dirname(dirname(entrypoint))
    await mkdir(dirname(entrypoint), { recursive: true })
    await writeFile(entrypoint, "#!/usr/bin/env node\n")
    await npmGlobalCommand(entrypoint, "linux")
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }),
    )

    const invocations: Array<string> = []
    const runner: CommandRunner = {
      run: (command, arguments_) => {
        const invocation = [command, ...arguments_].join(" ")
        invocations.push(invocation)
        if (invocation === "/usr/bin/systemctl is-active --quiet cohall-relay.service") {
          return Promise.resolve({ exitCode: 3, stdout: "", stderr: "" })
        }
        if (invocation.includes(" show --property=ExecStart --value ")) {
          return Promise.resolve({
            exitCode: 0,
            stdout: `{ path=${entrypoint} ; argv[]=${entrypoint} device ; }`,
            stderr: "",
          })
        }
        return Promise.resolve(success())
      },
    }

    const result = await upgrade({
      currentVersion: "1.2.3",
      target: "1.2.3",
      restart: true,
      dryRun: false,
      delegated: true,
      entrypoint,
      platform: "linux",
      uid: 1000,
      statePath: join(root, "upgrade-restart.json"),
      runner,
      resolveExecutable,
    })

    expect(result.upgraded).toBe(false)
    expect(result.services_restarted).toEqual([
      "systemd-user:cohall-relay.service",
      "systemd-user:cohall-device.service",
    ])
    expect(invocations.filter((invocation) => invocation.includes(" restart "))).toEqual([
      "/usr/bin/systemctl --user restart cohall-relay.service",
      "/usr/bin/systemctl --user restart cohall-device.service",
    ])
    expect(invocations.some((invocation) => invocation.startsWith("npm install"))).toBe(false)
    await expect(readFile(join(root, "upgrade-restart.json"), "utf8")).resolves.toContain(
      '"restartingService": "systemd-user:cohall-device.service"',
    )
  })

  it("refuses to restart a service backed by a different installation", async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(
      root,
      "current",
      "lib",
      "node_modules",
      "@akshar5",
      "cohall",
      "bin",
      "cohall.js",
    )
    const serviceEntrypoint = join(
      root,
      "service",
      "lib",
      "node_modules",
      "@akshar5",
      "cohall",
      "bin",
      "cohall.js",
    )
    for (const path of [entrypoint, serviceEntrypoint]) {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, "#!/usr/bin/env node\n")
      await npmGlobalCommand(path, "linux")
      await writeFile(
        join(dirname(dirname(path)), "package.json"),
        JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }),
      )
    }
    const invocations: Array<string> = []
    const runner: CommandRunner = {
      run: (command, arguments_) => {
        const invocation = [command, ...arguments_].join(" ")
        invocations.push(invocation)
        if (invocation.includes("is-active") && !invocation.includes("cohall-device")) {
          return Promise.resolve({ exitCode: 3, stdout: "", stderr: "" })
        }
        if (invocation.includes(" show --property=ExecStart --value ")) {
          return Promise.resolve({
            exitCode: 0,
            stdout: `{ path=${serviceEntrypoint} ; argv[]=${serviceEntrypoint} device ; }`,
            stderr: "",
          })
        }
        return Promise.resolve(success())
      },
    }

    await expect(
      upgrade({
        currentVersion: "1.2.3",
        target: "1.2.3",
        restart: true,
        dryRun: false,
        entrypoint,
        platform: "linux",
        uid: 1000,
        statePath: join(root, "upgrade-restart.json"),
        runner,
      }),
    ).rejects.toThrow("uses")
    expect(invocations.some((invocation) => invocation.startsWith("npm install"))).toBe(false)
    expect(invocations.some((invocation) => invocation.includes(" restart "))).toBe(false)
  })

  it.each([true, false])(
    "verifies device restart recovery with delegated=%s",
    async (delegated) => {
      const root = await temporaryDirectory()
      const entrypoint = join(root, "lib/node_modules/@akshar5/cohall/bin/cohall.js")
      await mkdir(dirname(entrypoint), { recursive: true })
      await writeFile(entrypoint, "")
      await npmGlobalCommand(entrypoint, "linux")
      await writeFile(
        join(dirname(dirname(entrypoint)), "package.json"),
        JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }),
      )
      const statePath = join(root, "upgrade-restart.json")
      await writeFile(
        statePath,
        JSON.stringify({
          version: "1.2.3",
          fromVersion: "1.2.2",
          packageManager: "npm",
          pendingServices: ["systemd-user:cohall-device.service"],
          restartedServices: ["systemd-user:cohall-relay.service"],
          restartingService: "systemd-user:cohall-device.service",
        }),
      )
      const invocations: Array<string> = []
      const runner: CommandRunner = {
        run: (command, arguments_) => {
          invocations.push([command, ...arguments_].join(" "))
          if (arguments_.includes("show"))
            return Promise.resolve({
              exitCode: 0,
              stdout: `{ path=${entrypoint} ; argv[]=${entrypoint} device ; }`,
              stderr: "",
            })
          return Promise.resolve(success())
        },
      }

      const preview = await upgrade({
        currentVersion: "1.2.3",
        restart: true,
        dryRun: true,
        delegated,
        entrypoint,
        platform: "linux",
        uid: 1000,
        statePath,
        runner,
      })

      expect(preview.services_pending_restart).toEqual(["systemd-user:cohall-device.service"])
      expect(await readFile(statePath, "utf8")).toContain("systemd-user:cohall-device.service")
      invocations.length = 0

      const result = await upgrade({
        currentVersion: "1.2.3",
        restart: true,
        dryRun: false,
        delegated,
        entrypoint,
        platform: "linux",
        uid: 1000,
        statePath,
        runner,
      })

      expect(result.resumed_after_restart).toBe(true)
      expect(result.services_restarted).toEqual([
        "systemd-user:cohall-relay.service",
        "systemd-user:cohall-device.service",
      ])
      expect(invocations).toEqual([
        "/usr/bin/systemctl --user is-active --quiet cohall-device.service",
        "/usr/bin/systemctl --user show --property=ExecStart --value cohall-device.service",
        ...(delegated ? [] : ["/usr/bin/systemctl --user restart cohall-device.service"]),
      ])
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    },
  )

  it.each(["stopped worker", "changed installation"])(
    "keeps failed upgrade recovery intact after a %s",
    async (scenario) => {
      const root = await temporaryDirectory()
      const entrypoint = join(root, "current/lib/node_modules/@akshar5/cohall/bin/cohall.js")
      const other = join(root, "other/lib/node_modules/@akshar5/cohall/bin/cohall.js")
      for (const path of [entrypoint, other]) {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, "")
        await npmGlobalCommand(path, "linux")
        await writeFile(
          join(dirname(dirname(path)), "package.json"),
          JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }),
        )
      }
      const statePath = join(root, "receipt.json")
      const commands: Array<ReadonlyArray<string>> = []
      let running = true
      let serviceEntrypoint = entrypoint
      let failRestart = true
      const runner: CommandRunner = {
        run: async (command, arguments_) => {
          commands.push(arguments_)
          if (arguments_.includes("is-active"))
            return {
              exitCode: running && arguments_.includes("cohall-device.service") ? 0 : 3,
              stdout: "",
              stderr: "",
            }
          if (arguments_.includes("show"))
            return {
              exitCode: 0,
              stdout: `{ path=${serviceEntrypoint} ; argv[]=${serviceEntrypoint} device ; }`,
              stderr: "",
            }
          if (command === "npm")
            await writeFile(
              join(dirname(dirname(entrypoint)), "package.json"),
              JSON.stringify({ name: "@akshar5/cohall", version: "1.2.4" }),
            )
          if (arguments_.includes("restart") && failRestart) {
            if (scenario === "stopped worker") running = false
            return { exitCode: 1, stdout: "", stderr: "fixture restart failed" }
          }
          return success()
        },
      }
      const options = {
        currentVersion: "1.2.3",
        target: "1.2.4",
        restart: true,
        dryRun: false,
        entrypoint,
        platform: "linux" as const,
        uid: 1000,
        statePath,
        runner,
        resolveExecutable,
      }
      await expect(upgrade(options)).rejects.toThrow("fixture restart failed")
      const receipt = await readFile(statePath, "utf8")
      expect(JSON.parse(receipt)).toMatchObject({
        pendingServices: ["systemd-user:cohall-device.service"],
      })
      failRestart = false
      if (scenario === "changed installation") serviceEntrypoint = other
      commands.length = 0
      const retry = { ...options, currentVersion: "1.2.4" }

      if (scenario === "stopped worker") {
        for (const overrides of [{ dryRun: true }, { restart: false }, {}]) {
          await expect(upgrade({ ...retry, ...overrides })).resolves.toMatchObject({
            services_restarted: [],
            services_pending_restart: ["systemd-user:cohall-device.service"],
          })
          expect(await readFile(statePath, "utf8")).toBe(receipt)
        }
      } else {
        await expect(upgrade(retry)).rejects.toThrow("uses")
        expect(await readFile(statePath, "utf8")).toBe(receipt)
      }
      expect(
        commands.some(
          (arguments_) => arguments_.includes("restart") || arguments_.includes("install"),
        ),
      ).toBe(false)

      running = true
      serviceEntrypoint = entrypoint
      await expect(upgrade(retry)).resolves.toMatchObject({
        services_restarted: ["systemd-user:cohall-device.service"],
        services_pending_restart: [],
        resumed_after_restart: true,
      })
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    },
  )

  it.each([true, false])(
    "carries an unfinished device restart into a new target with restart=%s",
    async (restart) => {
      const root = await temporaryDirectory()
      const entrypoint = join(root, "lib/node_modules/@akshar5/cohall/bin/cohall.js")
      const metadata = join(dirname(dirname(entrypoint)), "package.json")
      const statePath = join(root, "receipt.json")
      await mkdir(dirname(entrypoint), { recursive: true })
      await writeFile(entrypoint, "")
      await npmGlobalCommand(entrypoint, "linux")
      await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }))
      const active = new Set(["cohall-relay.service", "cohall-device.service"])
      const restarts: Array<string> = []
      let failDeviceRestart = true
      const runner: CommandRunner = {
        run: async (command, arguments_) => {
          const service = arguments_.at(-1)
          if (arguments_.includes("is-active"))
            return {
              exitCode: arguments_.includes("--user") && active.has(service ?? "") ? 0 : 3,
              stdout: "",
              stderr: "",
            }
          if (arguments_.includes("show"))
            return {
              exitCode: 0,
              stdout: `{ path=${entrypoint} ; argv[]=${entrypoint} device ; }`,
              stderr: "",
            }
          if (command === "npm")
            await writeFile(
              metadata,
              JSON.stringify({
                name: "@akshar5/cohall",
                version: arguments_.at(-1)?.replace("@akshar5/cohall@", ""),
              }),
            )
          if (arguments_.includes("restart") && service !== undefined) {
            restarts.push(service)
            if (service === "cohall-device.service" && failDeviceRestart) {
              active.delete(service)
              return { exitCode: 1, stdout: "", stderr: "fixture restart failed" }
            }
          }
          return success()
        },
      }
      const options = {
        currentVersion: "1.2.3",
        target: "1.2.4",
        restart: true,
        dryRun: false,
        entrypoint,
        platform: "linux" as const,
        uid: 1000,
        statePath,
        runner,
        resolveExecutable,
      }
      await expect(upgrade(options)).rejects.toThrow("fixture restart failed")
      const previous = await readFile(statePath, "utf8")
      expect(JSON.parse(previous)).toMatchObject({
        pendingServices: ["systemd-user:cohall-device.service"],
        restartedServices: ["systemd-user:cohall-relay.service"],
      })
      failDeviceRestart = false
      restarts.length = 0
      const changedTarget = { ...options, currentVersion: "1.2.4", target: "1.2.5", restart }
      await expect(upgrade({ ...changedTarget, dryRun: true })).resolves.toMatchObject({
        requested_version: "1.2.5",
        services_pending_restart: [
          "systemd-user:cohall-device.service",
          "systemd-user:cohall-relay.service",
        ],
      })
      expect(await readFile(statePath, "utf8")).toBe(previous)

      const result = await upgrade(changedTarget)
      expect(result.installed_version).toBe("1.2.5")
      expect(result.services_pending_restart).toEqual([
        "systemd-user:cohall-device.service",
        ...(restart ? [] : ["systemd-user:cohall-relay.service"]),
      ])
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
        version: "1.2.5",
        pendingServices: result.services_pending_restart,
      })
      expect(restarts).toEqual(restart ? ["cohall-relay.service"] : [])
      expect(active.has("cohall-device.service")).toBe(false)

      active.add("cohall-device.service")
      restarts.length = 0
      await expect(
        upgrade({ ...changedTarget, currentVersion: "1.2.5", restart: true }),
      ).resolves.toMatchObject({ services_pending_restart: [] })
      expect(restarts).toEqual([
        ...(restart ? [] : ["cohall-relay.service"]),
        "cohall-device.service",
      ])
      await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    },
  )

  it("preserves recovery state during a preview or failed installation", async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, "lib/node_modules/@akshar5/cohall/bin/cohall.js")
    await mkdir(dirname(entrypoint), { recursive: true })
    await writeFile(entrypoint, "#!/usr/bin/env node\n")
    await npmGlobalCommand(entrypoint, "linux")
    await writeFile(
      join(dirname(dirname(entrypoint)), "package.json"),
      JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }),
    )
    const statePath = join(root, "upgrade-restart.json")
    const receipt = JSON.stringify({
      version: "1.2.2",
      fromVersion: "1.2.1",
      packageManager: "npm",
      pendingServices: ["systemd-user:cohall-device.service"],
      restartedServices: [],
    })
    await writeFile(statePath, receipt)
    const invocations: Array<string> = []
    const runner: CommandRunner = {
      run: async (command, arguments_) => {
        invocations.push([command, ...arguments_].join(" "))
        return { exitCode: 1, stdout: "", stderr: "Installation unavailable" }
      },
    }
    const options = {
      platform: "linux" as const,
      currentVersion: "1.2.3",
      target: "1.2.4",
      restart: true,
      entrypoint,
      statePath,
      runner,
      resolveExecutable,
    }

    const preview = await upgrade({ ...options, dryRun: true })
    expect(preview.requested_version).toBe("1.2.4")
    expect(invocations.some((invocation) => invocation.startsWith("npm install"))).toBe(false)
    expect(await readFile(statePath, "utf8")).toBe(receipt)

    await expect(upgrade({ ...options, dryRun: false })).rejects.toThrow("Installation unavailable")
    expect(await readFile(statePath, "utf8")).toBe(receipt)
  })

  it.each([undefined, "incomplete JSON"])(
    "repairs damaged package metadata during an upgrade: %s",
    async (content) => {
      const root = await temporaryDirectory()
      const entrypoint = join(root, "lib/node_modules/@akshar5/cohall/bin/cohall.js")
      const metadata = join(dirname(dirname(entrypoint)), "package.json")
      await mkdir(dirname(entrypoint), { recursive: true })
      await writeFile(entrypoint, "#!/usr/bin/env node\n")
      await npmGlobalCommand(entrypoint, "linux")
      if (content !== undefined) await writeFile(metadata, content)
      const runner: CommandRunner = {
        run: async (command) => {
          if (command !== "npm") return { exitCode: 3, stdout: "", stderr: "" }
          await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }))
          return success()
        },
      }

      const result = await upgrade({
        platform: "linux" as const,
        currentVersion: "1.2.3",
        target: "1.2.3",
        restart: false,
        dryRun: false,
        entrypoint,
        statePath: join(root, "upgrade-restart.json"),
        runner,
        resolveExecutable,
      })

      expect(result.installed_version).toBe("1.2.3")
      expect(JSON.parse(await readFile(metadata, "utf8"))).toEqual({
        name: "@akshar5/cohall",
        version: "1.2.3",
      })
    },
  )

  it.each([
    { target: "1.2.4", restart: true, delegated: false },
    { target: "latest", restart: false, delegated: false },
    { target: "latest", restart: false, delegated: true },
  ])(
    "upgrades $target with restart=$restart, delegated=$delegated",
    async ({ target, restart, delegated }) => {
      const root = await temporaryDirectory()
      const entrypoint = join(root, "lib/node_modules/@akshar5/cohall/bin/cohall.js")
      const metadata = join(dirname(dirname(entrypoint)), "package.json")
      await mkdir(dirname(entrypoint), { recursive: true })
      await writeFile(entrypoint, "#!/usr/bin/env node\n")
      await npmGlobalCommand(entrypoint, "linux")
      await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }))
      const statePath = join(root, "upgrade-restart.json")
      const receipt = JSON.stringify({
        version: "1.2.3",
        fromVersion: "1.2.2",
        packageManager: "npm",
        pendingServices: ["systemd-user:cohall-device.service"],
        restartedServices: [],
      })
      await writeFile(statePath, receipt)
      const invocations: Array<string> = []
      const runner: CommandRunner = {
        run: async (command, arguments_) => {
          invocations.push([command, ...arguments_].join(" "))
          if (command !== "npm") return { exitCode: 3, stdout: "", stderr: "" }
          if (arguments_.includes("view")) return { ...success(), stdout: JSON.stringify("1.2.4") }
          await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version: "1.2.4" }))
          return success()
        },
      }
      const options = {
        platform: "linux" as const,
        currentVersion: "1.2.3",
        restart,
        delegated,
        dryRun: false,
        entrypoint,
        statePath,
        runner,
        resolveExecutable,
      }

      await expect(upgrade({ ...options, target: "invalid" })).rejects.toThrow(
        "exact semantic version",
      )
      expect(invocations).toEqual([])
      expect(await readFile(statePath, "utf8")).toBe(receipt)

      await expect(upgrade({ ...options, target, dryRun: true })).resolves.toMatchObject({
        requested_version: target,
        services_pending_restart: ["systemd-user:cohall-device.service"],
      })
      expect(await readFile(statePath, "utf8")).toBe(receipt)
      expect(invocations.some((invocation) => invocation.startsWith("npm install"))).toBe(false)

      const result = await upgrade({ ...options, target })
      expect(result.requested_version).toBe(target)
      expect(result.installed_version).toBe("1.2.4")
      expect(result.resumed_after_restart).toBe(false)
      expect(invocations).toContain(`npm install --global --prefix ${root} @akshar5/cohall@1.2.4`)
      expect(result.services_pending_restart).toEqual(["systemd-user:cohall-device.service"])
      expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
        version: "1.2.4",
        pendingServices: ["systemd-user:cohall-device.service"],
      })
    },
  )
})

describe("pnpm service upgrades", () => {
  const fixture = async (
    layout: "classic" | "isolated" | "shared-store",
    customHome = false,
    separateGlobalDir = false,
  ) => {
    const root = await temporaryDirectory()
    const pnpmHome = join(root, customHome ? "custom tools" : "pnpm")
    const prefix = join(
      pnpmHome,
      separateGlobalDir ? "cohall packages" : "global",
      layout === "classic" ? "5" : "v11",
    )
    const installation = (version: string) =>
      layout === "classic" ? prefix : join(prefix, `install-${version}`)
    const packagePath = (version: string) =>
      layout === "shared-store"
        ? join(
            pnpmHome,
            separateGlobalDir ? "package cache" : "store",
            "v11",
            "links",
            version,
            "node_modules",
            "@akshar5",
            "cohall",
          )
        : join(
            installation(version),
            "node_modules",
            ".pnpm",
            `@akshar5+cohall@${version}`,
            "node_modules",
            "@akshar5",
            "cohall",
          )
    for (const version of ["1.2.3", "1.2.4"]) {
      const path = packagePath(version)
      await mkdir(join(path, "bin"), { recursive: true })
      await writeFile(join(path, "bin", "cohall.js"), "#!/usr/bin/env node\n")
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({ name: "@akshar5/cohall", version }),
      )
      if (layout !== "classic") {
        const packageLink = join(installation(version), "node_modules", "@akshar5", "cohall")
        await mkdir(dirname(packageLink), { recursive: true })
        await symlink(path, packageLink, "junction")
      }
    }
    const link =
      layout === "classic"
        ? join(prefix, "node_modules", "@akshar5", "cohall")
        : join(prefix, "package-slot")
    const destination = (version: string) =>
      layout === "classic" ? packagePath(version) : installation(version)
    await mkdir(dirname(link), { recursive: true })
    await symlink(destination("1.2.3"), link, "junction")
    const entrypoint =
      layout === "classic"
        ? join(link, "bin", "cohall.js")
        : join(link, "node_modules", "@akshar5", "cohall", "bin", "cohall.js")
    return {
      root,
      pnpmHome,
      entrypoint,
      pinned:
        layout === "classic"
          ? await realpath(entrypoint)
          : join(installation("1.2.3"), "node_modules", "@akshar5", "cohall", "bin", "cohall.js"),
      globalDir: dirname(prefix),
      globalRoot: prefix,
      replace: async () => {
        await rm(link)
        await symlink(destination("1.2.4"), link, "junction")
        await rm(layout === "classic" ? packagePath("1.2.3") : installation("1.2.3"), {
          recursive: true,
        })
      },
    }
  }

  it.each([
    { layout: "classic", delegated: false, customHome: false, separateGlobalDir: false },
    { layout: "classic", delegated: true, customHome: false, separateGlobalDir: false },
    { layout: "isolated", delegated: false, customHome: false, separateGlobalDir: false },
    { layout: "isolated", delegated: true, customHome: false, separateGlobalDir: false },
    { layout: "shared-store", delegated: false, customHome: false, separateGlobalDir: false },
    { layout: "shared-store", delegated: true, customHome: false, separateGlobalDir: false },
    { layout: "shared-store", delegated: true, customHome: true, separateGlobalDir: false },
    { layout: "shared-store", delegated: true, customHome: true, separateGlobalDir: true },
  ] as const)(
    "restarts the new package after a $layout upgrade, delegated=$delegated, customHome=$customHome, separateGlobalDir=$separateGlobalDir",
    async ({ layout, delegated, customHome, separateGlobalDir }) => {
      const setup = await fixture(layout, customHome, separateGlobalDir)
      vi.stubEnv("XDG_CONFIG_HOME", join(setup.root, "config"))
      const pnpmHome = separateGlobalDir ? join(setup.root, "actual command home") : setup.pnpmHome
      vi.stubEnv("PNPM_HOME", pnpmHome)
      const globalBin = separateGlobalDir
        ? join(setup.root, "user tools", "bin")
        : join(pnpmHome, "bin")
      const managerExecutable = join(pnpmHome, "bin", "pnpm")
      const store = join(setup.root, "custom store", "v10")
      const corepack = join(setup.root, "node", "pnpm")
      let corepackFirst = false
      const selectedExecutable = async (command: string) =>
        command === "pnpm"
          ? corepackFirst
            ? corepack
            : managerExecutable
          : resolveExecutable(command)
      const service = await installDeviceService({
        platform: "linux",
        entrypoint: layout === "classic" ? setup.entrypoint : setup.pinned,
        home: setup.root,
        resolveExecutable: selectedExecutable,
        runner: {
          run: async (_command, args, _timeout, environment) => {
            if (args.includes("store")) {
              expect(args).toEqual([
                "--dir",
                setup.globalRoot,
                "--ignore-workspace",
                "store",
                "path",
              ])
              return { ...success(), stdout: store }
            }
            if (args[0] === "bin") {
              expect(args).toEqual(["bin", "--global"])
              expect(environment).toEqual({ COREPACK_ENABLE_PROJECT_SPEC: "0" })
              return { ...success(), stdout: globalBin }
            }
            return args[0] === "root"
              ? {
                  ...success(),
                  stdout: separateGlobalDir
                    ? `Warning: this project pins a package manager\n${setup.globalRoot}\n`
                    : setup.globalRoot,
                }
              : success()
          },
        },
      })
      const unit = await readFile(service.installed, "utf8")
      expect(unit).toContain(join(pnpmHome, "bin").replaceAll("\\", "\\\\").replaceAll("%", "%%"))
      expect(unit).toContain("PNPM_HOME=")
      const executable = unit.match(/^ExecStart=(".+") device$/m)?.[1]
      if (executable === undefined) throw new Error("Missing service executable")
      const saved: unknown = JSON.parse(executable)
      if (typeof saved !== "string") throw new Error("Invalid service executable")
      const bootPath = saved.replaceAll("%%", "%")
      const managerEnvironment = unit.match(/^Environment=("COHALL_PNPM_EXECUTABLE=.+")$/m)?.[1]
      if (managerEnvironment === undefined) throw new Error("Missing saved pnpm executable")
      const managerSetting: unknown = JSON.parse(managerEnvironment)
      if (typeof managerSetting !== "string") throw new Error("Invalid saved pnpm executable")
      const savedManager = managerSetting
        .replaceAll("%%", "%")
        .slice("COHALL_PNPM_EXECUTABLE=".length)
      expect(savedManager).toBe(managerExecutable)
      for (const [name, expected] of [
        ["COHALL_PNPM_STORE_DIR", store],
        ["COHALL_PNPM_GLOBAL_DIR", setup.globalDir],
        ["COHALL_PNPM_GLOBAL_BIN_DIR", globalBin],
      ] as const) {
        const setting = unit.match(new RegExp(`^Environment=("${name}=.+")$`, "m"))?.[1]
        if (setting === undefined) throw new Error(`Missing ${name}`)
        const value: unknown = JSON.parse(setting)
        expect(value).toBe(`${name}=${expected}`.replaceAll("%", "%%"))
        if (delegated) vi.stubEnv(name, expected)
      }
      expect(unit).toContain(globalBin.replaceAll("\\", "\\\\").replaceAll("%", "%%"))
      if (delegated) {
        vi.stubEnv("COHALL_PNPM_EXECUTABLE", savedManager)
        corepackFirst = separateGlobalDir
      }
      const statePath = join(setup.root, "receipt.json")
      let restartedVersion: unknown
      const runner: CommandRunner = {
        run: async (command, args, _timeout, environment) => {
          if (command === managerExecutable)
            expect(environment).toEqual({
              COREPACK_ENABLE_PROJECT_SPEC: "0",
              ...(delegated
                ? {
                    npm_config_global_dir: setup.globalDir,
                    pnpm_config_global_dir: setup.globalDir,
                    npm_config_global_bin_dir: globalBin,
                    pnpm_config_global_bin_dir: globalBin,
                    npm_config_store_dir: store,
                    pnpm_config_store_dir: store,
                  }
                : {}),
            })
          if (args[0] === "root") {
            expect(args).toEqual(["root", "--global"])
            return {
              ...success(),
              stdout: separateGlobalDir
                ? `Warning: this project pins a package manager\n${setup.globalRoot}\n`
                : setup.globalRoot,
            }
          }
          if (args.includes("is-active"))
            return { ...success(), exitCode: args.includes("cohall-device.service") ? 0 : 3 }
          if (args.includes("show"))
            return { ...success(), stdout: `{ path=${bootPath} ; argv[]=${bootPath} device ; }` }
          if (command === corepack) throw new Error("Used the shadowing Corepack shim")
          if (command === managerExecutable) {
            expect(args[args.indexOf("--global-dir") + 1]).toBe(setup.globalDir)
            if (delegated) expect(args[args.indexOf("--global-bin-dir") + 1]).toBe(globalBin)
            await setup.replace()
          }
          if (args.includes("restart")) {
            const path = await realpath(bootPath)
            restartedVersion = JSON.parse(
              await readFile(join(dirname(dirname(path)), "package.json"), "utf8"),
            ).version
          }
          return success()
        },
      }
      const result = await upgrade({
        currentVersion: "1.2.3",
        target: "1.2.4",
        restart: true,
        dryRun: false,
        delegated,
        entrypoint: delegated ? bootPath : layout === "classic" ? setup.entrypoint : setup.pinned,
        platform: "linux",
        statePath,
        runner,
        resolveExecutable: selectedExecutable,
      })
      expect(result).toMatchObject({
        upgraded: true,
        installed_version: "1.2.4",
        services_restarted: ["systemd-user:cohall-device.service"],
        services_pending_restart: [],
      })
      expect(restartedVersion).toBe("1.2.4")
      if (delegated) {
        const resumed = await upgrade({
          currentVersion: "1.2.4",
          target: "1.2.4",
          restart: true,
          dryRun: false,
          delegated: true,
          entrypoint: bootPath,
          platform: "linux",
          statePath,
          runner,
          resolveExecutable: selectedExecutable,
        })
        expect(resumed.resumed_after_restart).toBe(true)
      }
      await expect(readFile(statePath)).rejects.toMatchObject({ code: "ENOENT" })
    },
  )

  it.each([
    { operation: "service install", conventionalPath: false },
    { operation: "upgrade", conventionalPath: false },
    { operation: "service install", conventionalPath: true },
    { operation: "upgrade", conventionalPath: true },
  ] as const)(
    "rejects project-local shared-store entrypoints before $operation, conventionalPath=$conventionalPath",
    async ({ operation, conventionalPath }) => {
      const setup = await fixture("shared-store")
      const projectPackage = join(
        setup.root,
        conventionalPath ? "project/global/5" : "project",
        "node_modules",
        "@akshar5",
        "cohall",
      )
      await mkdir(dirname(projectPackage), { recursive: true })
      await symlink(dirname(dirname(await realpath(setup.entrypoint))), projectPackage, "junction")
      const entrypoint = join(projectPackage, "bin", "cohall.js")
      const run = vi.fn(async (_command: string, args: ReadonlyArray<string>) =>
        args[0] === "root" ? { ...success(), stdout: setup.globalRoot } : success(),
      )
      const result =
        operation === "service install"
          ? installDeviceService({
              platform: "linux",
              home: setup.root,
              entrypoint,
              runner: { run },
              resolveExecutable,
            })
          : upgrade({
              currentVersion: "1.2.3",
              target: "1.2.4",
              restart: false,
              dryRun: false,
              entrypoint,
              statePath: join(setup.root, "receipt.json"),
              runner: { run },
              resolveExecutable,
            })
      await expect(result).rejects.toThrow("requires a global pnpm entrypoint")
      expect(run.mock.calls.every(([, args]) => args[0] === "root")).toBe(true)
    },
  )

  it.each([false, true])(
    "rejects a pinned service before updating packages, delegated=%s",
    async (delegated) => {
      const setup = await fixture("classic")
      const invocations: Array<string> = []
      const runner: CommandRunner = {
        run: async (command, args) => {
          invocations.push([command, ...args].join(" "))
          if (args[0] === "root") return { ...success(), stdout: setup.globalRoot }
          if (args.includes("is-active"))
            return { ...success(), exitCode: args.includes("cohall-device.service") ? 0 : 3 }
          if (args.includes("show"))
            return {
              ...success(),
              stdout: `{ path=${setup.pinned} ; argv[]=${setup.pinned} device ; }`,
            }
          return success()
        },
      }
      await expect(
        upgrade({
          currentVersion: "1.2.3",
          target: "1.2.4",
          restart: true,
          dryRun: false,
          delegated,
          entrypoint: delegated ? setup.pinned : setup.entrypoint,
          platform: "linux",
          statePath: join(setup.root, "receipt.json"),
          runner,
          resolveExecutable,
        }),
      ).rejects.toThrow("cohall service install")
      expect(
        invocations.some(
          (invocation) => invocation.startsWith("pnpm add ") || invocation.includes(" restart "),
        ),
      ).toBe(false)
      expect(
        JSON.parse(await readFile(join(dirname(dirname(setup.pinned)), "package.json"), "utf8"))
          .version,
      ).toBe("1.2.3")
    },
  )
})
