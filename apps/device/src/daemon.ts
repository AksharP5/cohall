import {
  Device,
  SocketEvent,
  decodeSocketEvent,
  now,
  type ProviderEvent,
  type Task,
  type TaskId,
} from "@cohall/protocol";
import * as Codex from "@cohall/provider-codex";
import { Effect, Schedule, Schema } from "effect";
import { arch, hostname, platform } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { DeviceConfiguration } from "./config.ts";

export class DeviceConnectionError extends Schema.TaggedErrorClass<DeviceConnectionError>()(
  "Device.ConnectionError",
  {
    message: Schema.String,
  },
) {}

interface State {
  socket: WebSocket | undefined;
  readonly pending: Array<string>;
  readonly tasks: Map<TaskId, AbortController>;
}

const socketUrl = (configuration: DeviceConfiguration): string => {
  const url = new URL(configuration.relayUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.searchParams.set("role", "device");
  url.searchParams.set("token", configuration.token);
  return url.toString();
};

const capabilities = (): Device["capabilities"] => {
  const values: Array<Device["capabilities"][number]> = [];
  if (Codex.available()) {
    values.push({
      id: "codex",
      label: "Codex",
      detail: "Uses the device's local Codex login and tools",
    });
  }
  if (
    Bun.which("google-chrome") !== null ||
    Bun.which("chromium") !== null ||
    platform() === "darwin"
  ) {
    values.push({
      id: "browser-session",
      label: "Signed-in browser",
      detail: "Local browser state can be used by configured Codex tools",
    });
  }
  if (Bun.which("xcodebuild") !== null) {
    values.push({
      id: "xcode",
      label: "Xcode",
      detail: "Build and test Apple platform projects",
    });
  }
  if (Bun.which("docker") !== null) {
    values.push({ id: "docker", label: "Docker" });
  }
  return values;
};

const device = (
  configuration: DeviceConfiguration,
  status: "online" | "busy" = "online",
): Device => {
  const operatingSystem = platform();
  const platformName =
    operatingSystem === "darwin" || operatingSystem === "linux"
      ? operatingSystem
      : operatingSystem === "win32"
        ? "windows"
        : "unknown";

  return Device.make({
    id: configuration.id,
    name: configuration.name,
    hostname: hostname(),
    platform: platformName,
    architecture: arch(),
    status,
    providers: Codex.available() ? ["codex"] : [],
    capabilities: capabilities(),
    workspaces: configuration.workspaces.map((path) => ({
      path,
      label: path.split("/").at(-1) ?? path,
    })),
    version: "0.1.0",
    lastSeenAt: now(),
  });
};

const allowedWorkspace = (
  configuration: DeviceConfiguration,
  requested: string | undefined,
): string => {
  if (requested === undefined) {
    const first = configuration.workspaces[0];
    if (first === undefined) {
      throw new Error("No workspace is configured on this device");
    }
    return first;
  }
  const candidate = resolve(requested);
  const allowed = configuration.workspaces.some((root) => {
    const child = relative(root, candidate);
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
  });
  if (!allowed) {
    throw new Error(`Workspace ${candidate} is outside this device's configured workspace roots`);
  }
  return candidate;
};

const promptFor = (task: Task, deviceName: string): string => {
  const context =
    task.context === undefined
      ? ""
      : `\n\nRelevant context supplied by the sending agent:\n${task.context}`;
  return [
    `You are the Cohall agent running on ${deviceName}.`,
    "Complete the delegated task using this device's local workspace, tools, credentials, and signed-in services.",
    "Do not ask the human to copy information between devices. Return a concise but complete result that the sending agent can act on.",
    `\nTask:\n${task.prompt}${context}`,
  ].join("\n");
};

const send = (state: State, event: SocketEvent): void => {
  const payload = JSON.stringify(event);
  if (state.socket?.readyState === WebSocket.OPEN) {
    state.socket.send(payload);
    return;
  }
  state.pending.push(payload);
};

const execute = (configuration: DeviceConfiguration, state: State, task: Task): void => {
  if (state.tasks.has(task.id)) {
    return;
  }
  const controller = new AbortController();
  state.tasks.set(task.id, controller);
  send(
    state,
    SocketEvent.make({
      _tag: "TaskAccepted",
      taskId: task.id,
      acceptedAt: now(),
    }),
  );

  const onEvent = (event: ProviderEvent): void => {
    send(
      state,
      SocketEvent.make({
        _tag: "TaskProgress",
        taskId: task.id,
        event,
        sentAt: now(),
      }),
    );
  };

  const workflow = Effect.gen(function* () {
    const cwd = yield* Effect.try({
      try: () => allowedWorkspace(configuration, task.workspace),
      catch: (cause) =>
        new Codex.CodexRunError({
          message: cause instanceof Error ? cause.message : String(cause),
        }),
    });
    return yield* Codex.run({
      prompt: promptFor(task, configuration.name),
      cwd,
      onEvent,
      ...(task.providerSessionId === undefined ? {} : { sessionId: task.providerSessionId }),
      ...(configuration.model === undefined ? {} : { model: configuration.model }),
      ...(configuration.sandbox === undefined ? {} : { sandbox: configuration.sandbox }),
    });
  });

  void Effect.runPromise(workflow, { signal: controller.signal })
    .then((result) => {
      send(
        state,
        SocketEvent.make({
          _tag: "TaskFinished",
          taskId: task.id,
          result: result.result,
          finishedAt: now(),
          ...(result.sessionId === undefined ? {} : { providerSessionId: result.sessionId }),
        }),
      );
    })
    .catch((cause: unknown) => {
      if (controller.signal.aborted) {
        send(
          state,
          SocketEvent.make({
            _tag: "TaskCancelled",
            taskId: task.id,
            cancelledAt: now(),
          }),
        );
        return;
      }
      send(
        state,
        SocketEvent.make({
          _tag: "TaskFailed",
          taskId: task.id,
          error: cause instanceof Error ? cause.message : String(cause),
          finishedAt: now(),
        }),
      );
    })
    .finally(() => {
      state.tasks.delete(task.id);
    });
};

const connect = (
  configuration: DeviceConfiguration,
  state: State,
): Effect.Effect<void, DeviceConnectionError> =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<void>((complete) => {
        const socket = new WebSocket(socketUrl(configuration));
        const heartbeat = setInterval(() => {
          send(
            state,
            SocketEvent.make({
              _tag: "DeviceHeartbeat",
              deviceId: configuration.id,
              status: state.tasks.size > 0 ? "busy" : "online",
              sentAt: now(),
            }),
          );
        }, 15_000);

        const close = (): void => {
          clearInterval(heartbeat);
          if (state.socket === socket) {
            state.socket = undefined;
          }
          complete();
        };

        signal.addEventListener(
          "abort",
          () => {
            socket.close();
            close();
          },
          { once: true },
        );
        socket.addEventListener("open", () => {
          state.socket = socket;
          socket.send(
            JSON.stringify(
              SocketEvent.make({
                _tag: "DeviceHello",
                device: device(configuration, state.tasks.size > 0 ? "busy" : "online"),
              }),
            ),
          );
          for (const payload of state.pending.splice(0)) {
            socket.send(payload);
          }
          console.log(`Connected ${configuration.name} to ${configuration.relayUrl}`);
        });
        socket.addEventListener("message", (message) => {
          if (typeof message.data !== "string") {
            return;
          }
          void Effect.runPromise(
            Effect.try({
              try: () => JSON.parse(message.data) as unknown,
              catch: () =>
                new DeviceConnectionError({
                  message: "Relay sent invalid JSON",
                }),
            }).pipe(Effect.flatMap(decodeSocketEvent)),
          )
            .then((event) => {
              if (event._tag === "TaskAssigned") {
                execute(configuration, state, event.task);
                return;
              }
              if (event._tag === "CancelTask") {
                state.tasks.get(event.taskId)?.abort();
                return;
              }
              if (event._tag === "Error") {
                console.error(`Relay error: ${event.message}`);
              }
            })
            .catch((cause: unknown) => {
              console.error(
                `Ignored invalid relay event: ${cause instanceof Error ? cause.message : String(cause)}`,
              );
            });
        });
        socket.addEventListener("close", close, { once: true });
        socket.addEventListener("error", () => {
          socket.close();
        });
      }),
    catch: (cause) =>
      new DeviceConnectionError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export const runDaemon = (
  configuration: DeviceConfiguration,
): Effect.Effect<void, DeviceConnectionError> => {
  const state: State = {
    socket: undefined,
    pending: [],
    tasks: new Map(),
  };
  return connect(configuration, state).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
    }),
  );
};
