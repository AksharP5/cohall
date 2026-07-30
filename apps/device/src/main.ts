import { Effect } from "effect";
import { loadConfiguration } from "./config.ts";
import { runDaemon } from "./daemon.ts";
import { runMcp } from "./mcp.ts";

const command = process.argv[2] ?? "device";
const configuration = await Effect.runPromise(loadConfiguration);

if (command === "mcp") {
  await runMcp(configuration);
} else if (command === "doctor") {
  const response = await fetch(`${configuration.relayUrl}/api/health`);
  console.log(
    JSON.stringify(
      {
        relay: response.ok ? "reachable" : "unhealthy",
        device: configuration.name,
        id: configuration.id,
        workspaces: configuration.workspaces,
        codex: Bun.which("codex") ?? "not found",
      },
      null,
      2,
    ),
  );
} else {
  console.log(`Starting Cohall device ${configuration.name}`);
  await Effect.runPromise(runDaemon(configuration));
}
