import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  deviceVersionWarning,
  normalizeUpgradeTarget,
  packageInstallCommand,
  packageInstallation,
  serviceCandidates,
  upgrade,
  type CommandResult,
  type CommandRunner,
} from "./upgrade.ts"

const temporaryDirectories: Array<string> = []

const temporaryDirectory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "cohall-upgrade-"))
  temporaryDirectories.push(path)
  return path
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

const success = (): CommandResult => ({ exitCode: 0, stdout: "", stderr: "" })

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
})

describe("package installation", () => {
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
      JSON.stringify({ name: "@akshar5/cohall", version: "1.2.3" }),
    )

    const invocations: Array<string> = []
    const restartReceipts: Array<string> = []
    const statePath = join(root, "upgrade-restart.json")
    const runner: CommandRunner = {
      run: async (command, arguments_) => {
        const invocation = [command, ...arguments_].join(" ")
        invocations.push(invocation)
        if (invocation === "systemctl is-active --quiet cohall-relay.service") {
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
    })

    expect(result.installed_version).toBe("1.2.3")
    expect(result.services_restarted).toEqual([
      "systemd-user:cohall-relay.service",
      "systemd-user:cohall-device.service",
    ])
    expect(invocations).toContain(`npm install --global --prefix ${root} @akshar5/cohall@1.2.3`)
    expect(invocations.filter((invocation) => invocation.includes(" restart "))).toEqual([
      "systemctl --user restart cohall-relay.service",
      "systemctl --user restart cohall-device.service",
    ])
    expect(restartReceipts[0]).toContain('"restartingService": "systemd-user:cohall-relay.service"')
    expect(restartReceipts[1]).toContain(
      '"restartingService": "systemd-user:cohall-device.service"',
    )
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
        if (invocation === "systemctl is-active --quiet cohall-relay.service") {
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
      entrypoint,
      platform: "linux",
      uid: 1000,
      statePath: join(root, "upgrade-restart.json"),
      runner,
    })

    expect(result.upgraded).toBe(false)
    expect(result.services_restarted).toEqual([
      "systemd-user:cohall-relay.service",
      "systemd-user:cohall-device.service",
    ])
    expect(invocations.filter((invocation) => invocation.includes(" restart "))).toEqual([
      "systemctl --user restart cohall-relay.service",
      "systemctl --user restart cohall-device.service",
    ])
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
    expect(invocations).toEqual(["systemctl --user is-active --quiet cohall-device.service"])
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })
})
