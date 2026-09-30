import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { once } from "node:events"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { execa } from "execa"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DeviceId, DeviceOperation, OperationId, now } from "@cohall/protocol"
import { performDeviceOperation } from "./daemon.ts"
import {
  deviceVersionWarning,
  isTrustedGroupWritablePath,
  isTrustedSystemPath,
  normalizeUpgradeTarget,
  packageInstallCommand,
  packageInstallation,
  serviceCandidates,
  trustedExecutable,
  upgrade,
  type CommandResult,
  type CommandRunner,
  type PackageManager,
} from "./upgrade.ts"

const temporaryDirectories: Array<string> = []

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "cohall-upgrade-"))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

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
  const installation = async (version: string, manager: PackageManager = "npm") => {
    const root = await temporaryDirectory()
    const prefix =
      manager === "bun"
        ? join(root, ".bun", "install", "global")
        : manager === "pnpm"
          ? join(root, "pnpm", "global", "5")
          : join(root, "lib")
    const entrypoint = join(prefix, "node_modules", "@akshar5", "cohall", "bin", "cohall.js")
    const metadata = join(dirname(dirname(entrypoint)), "package.json")
    await mkdir(dirname(entrypoint), { recursive: true })
    await writeFile(entrypoint, "#!/usr/bin/env node\n")
    await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version }))
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
    const { root, entrypoint, metadata } = await installation(currentVersion)
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

  it.each(["npm", "bun", "pnpm"] as const)(
    "pins a newer latest version before installing with %s",
    async (manager) => {
      const { root, entrypoint, metadata } = await installation("1.2.3-rc.1", manager)
      const invocations: Array<string> = []
      const runner: CommandRunner = {
        run: async (command, arguments_) => {
          const invocation = [command, ...arguments_].join(" ")
          invocations.push(invocation)
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
        packageInstallation(await realpath(entrypoint)),
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
  })
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

  it("finishes a delegated upgrade after its device daemon restarts", async () => {
    const root = await temporaryDirectory()
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
        return Promise.resolve(success())
      },
    }

    const preview = await upgrade({
      currentVersion: "1.2.3",
      restart: true,
      dryRun: true,
      delegated: true,
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
      delegated: true,
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
    ])
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("preserves recovery state during a preview or failed installation", async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, "lib/node_modules/@akshar5/cohall/bin/cohall.js")
    await mkdir(dirname(entrypoint), { recursive: true })
    await writeFile(entrypoint, "#!/usr/bin/env node\n")
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
      if (content !== undefined) await writeFile(metadata, content)
      const runner: CommandRunner = {
        run: async (command) => {
          if (command !== "npm") return { exitCode: 3, stdout: "", stderr: "" }
          await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }))
          return success()
        },
      }

      const result = await upgrade({
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

  it("validates and honors a new target when an older restart receipt exists", async () => {
    const root = await temporaryDirectory()
    const entrypoint = join(root, "lib/node_modules/@akshar5/cohall/bin/cohall.js")
    const metadata = join(dirname(dirname(entrypoint)), "package.json")
    await mkdir(dirname(entrypoint), { recursive: true })
    await writeFile(entrypoint, "#!/usr/bin/env node\n")
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
        await writeFile(metadata, JSON.stringify({ name: "@akshar5/cohall", version: "1.2.4" }))
        return success()
      },
    }
    const options = {
      currentVersion: "1.2.3",
      restart: true,
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

    const result = await upgrade({ ...options, target: "1.2.4" })
    expect(result.requested_version).toBe("1.2.4")
    expect(result.installed_version).toBe("1.2.4")
    expect(result.resumed_after_restart).toBe(false)
    expect(invocations).toContain(`npm install --global --prefix ${root} @akshar5/cohall@1.2.4`)
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })
})
