const commands = [
  ["bun", "--watch", "apps/relay/src/main.ts"],
  ["bun", "--watch", "apps/device/src/main.ts", "device"],
  ["bun", "--cwd", "apps/web", "dev"],
]

const processes = commands.map((command) =>
  Bun.spawn(command, {
    cwd: process.cwd(),
    env: Bun.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }),
)

const shutdown = (): void => {
  for (const child of processes) {
    child.kill("SIGTERM")
  }
}

process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)

const codes = await Promise.all(processes.map((child) => child.exited))
process.exit(codes.find((code) => code !== 0) ?? 0)
