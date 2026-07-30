import { ProviderEvent } from "@cohall/protocol";
import { Effect, Schema } from "effect";

export class CodexUnavailableError extends Schema.TaggedErrorClass<CodexUnavailableError>()(
  "CodexProvider.Unavailable",
  {
    message: Schema.String,
  },
) {}

export class CodexRunError extends Schema.TaggedErrorClass<CodexRunError>()(
  "CodexProvider.RunError",
  {
    message: Schema.String,
    exitCode: Schema.optionalKey(Schema.Number),
  },
) {}

export type CodexError = CodexUnavailableError | CodexRunError;

export interface RunOptions {
  readonly prompt: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  readonly onEvent: (event: ProviderEvent) => void | Promise<void>;
}

export interface RunResult {
  readonly result: string;
  readonly sessionId?: string;
}

type JsonRecord = Readonly<Record<string, unknown>>;

const record = (value: unknown): JsonRecord | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const number = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const eventType = (event: JsonRecord): string | undefined => text(event.type) ?? text(event.method);

const itemType = (item: JsonRecord): string | undefined =>
  text(item.type)?.replaceAll("_", "").toLowerCase();

const summary = (item: JsonRecord): string => {
  const command = text(item.command);
  if (command !== undefined) {
    return command;
  }
  const tool = text(item.tool) ?? text(item.name);
  if (tool !== undefined) {
    return tool;
  }
  return "Codex tool";
};

const emitItem = async (
  item: JsonRecord,
  onEvent: RunOptions["onEvent"],
): Promise<string | undefined> => {
  switch (itemType(item)) {
    case "agentmessage": {
      const content = text(item.text) ?? text(item.content);
      if (content === undefined) {
        return undefined;
      }
      await onEvent(ProviderEvent.make({ _tag: "AssistantMessage", content }));
      return content;
    }
    case "reasoning": {
      const content =
        text(item.text) ??
        (Array.isArray(item.summary)
          ? item.summary.filter((part): part is string => typeof part === "string").join("\n")
          : undefined);
      if (content !== undefined && content.length > 0) {
        await onEvent(ProviderEvent.make({ _tag: "Reasoning", content }));
      }
      return undefined;
    }
    case "commandexecution": {
      const output = text(item.aggregated_output) ?? text(item.aggregatedOutput);
      await onEvent(
        ProviderEvent.make({
          _tag: "ToolCompleted",
          tool: "shell",
          summary: summary(item),
          success:
            text(item.status) === "completed" &&
            (number(item.exit_code) ?? number(item.exitCode) ?? 0) === 0,
        }),
      );
      if (output !== undefined && output.length > 0) {
        await onEvent(ProviderEvent.make({ _tag: "CommandOutput", content: output }));
      }
      return undefined;
    }
    case "filechange": {
      await onEvent(
        ProviderEvent.make({
          _tag: "ToolCompleted",
          tool: "files",
          summary: "Applied file changes",
          success: text(item.status) !== "failed",
        }),
      );
      return undefined;
    }
    case "mcptoolcall":
    case "dynamictoolcall": {
      await onEvent(
        ProviderEvent.make({
          _tag: "ToolCompleted",
          tool: text(item.tool) ?? "MCP",
          summary: summary(item),
          success: text(item.status) !== "failed" && item.success !== false,
        }),
      );
      return undefined;
    }
    default:
      return undefined;
  }
};

const args = (options: RunOptions): Array<string> => {
  const common = [
    "--json",
    "-c",
    'approval_policy="never"',
    ...(options.model === undefined ? [] : ["--model", options.model]),
    ...(options.sandbox === undefined ? [] : ["--sandbox", options.sandbox]),
  ];
  if (options.sessionId !== undefined) {
    return ["codex", "exec", "resume", ...common, options.sessionId, "-"];
  }
  return ["codex", "exec", ...common, "-"];
};

export const available = (): boolean => Bun.which("codex") !== null;

export const run = (options: RunOptions): Effect.Effect<RunResult, CodexError> =>
  Effect.tryPromise({
    try: async (signal) => {
      if (!available()) {
        throw new CodexUnavailableError({
          message: "The codex executable is not available on this device",
        });
      }

      const process = Bun.spawn(args(options), {
        cwd: options.cwd,
        env: {
          ...Bun.env,
          COHALL_PROVIDER: "codex",
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      const cancel = (): void => {
        process.kill("SIGTERM");
      };
      signal.addEventListener("abort", cancel, { once: true });
      process.stdin.write(options.prompt);
      process.stdin.end();

      const stderr = new Response(process.stderr).text();
      const reader = process.stdout.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      let result = "";
      let sessionId = options.sessionId;

      const consume = async (line: string): Promise<void> => {
        if (line.trim().length === 0) {
          return;
        }
        const parsed: unknown = JSON.parse(line);
        const event = record(parsed);
        if (event === undefined) {
          return;
        }
        const kind = eventType(event);
        if (kind === "thread.started" || kind === "thread/started") {
          sessionId = text(event.thread_id) ?? text(record(event.params)?.threadId) ?? sessionId;
          if (sessionId !== undefined) {
            await options.onEvent(ProviderEvent.make({ _tag: "SessionStarted", sessionId }));
          }
          return;
        }
        if (kind === "item.started" || kind === "item/started") {
          const item = record(event.item) ?? record(record(event.params)?.item);
          if (item !== undefined) {
            const type = itemType(item);
            if (
              type === "commandexecution" ||
              type === "filechange" ||
              type === "mcptoolcall" ||
              type === "dynamictoolcall"
            ) {
              await options.onEvent(
                ProviderEvent.make({
                  _tag: "ToolStarted",
                  tool: type === "commandexecution" ? "shell" : (text(item.tool) ?? type ?? "tool"),
                  summary: summary(item),
                }),
              );
            }
          }
          return;
        }
        if (kind === "item.completed" || kind === "item/completed") {
          const item = record(event.item) ?? record(record(event.params)?.item);
          if (item !== undefined) {
            result = (await emitItem(item, options.onEvent)) ?? result;
          }
          return;
        }
        if (kind === "turn.completed" || kind === "turn/completed") {
          const usage = record(event.usage) ?? record(record(event.params)?.usage);
          if (usage !== undefined) {
            const inputTokens = number(usage.input_tokens) ?? number(usage.inputTokens) ?? 0;
            const outputTokens = number(usage.output_tokens) ?? number(usage.outputTokens) ?? 0;
            await options.onEvent(
              ProviderEvent.make({
                _tag: "Usage",
                inputTokens,
                outputTokens,
              }),
            );
          }
        }
      };

      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        pending += decoder.decode(chunk.value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          await consume(line);
        }
      }
      pending += decoder.decode();
      if (pending.trim().length > 0) {
        await consume(pending);
      }

      const exitCode = await process.exited;
      signal.removeEventListener("abort", cancel);
      const errorOutput = await stderr;
      if (exitCode !== 0) {
        throw new CodexRunError({
          message: errorOutput.trim() || `Codex exited with status ${exitCode}`,
          exitCode,
        });
      }
      return {
        result: result || "Codex completed the task without a text response.",
        ...(sessionId === undefined ? {} : { sessionId }),
      };
    },
    catch: (cause) => {
      if (cause instanceof CodexUnavailableError || cause instanceof CodexRunError) {
        return cause;
      }
      return new CodexRunError({
        message: cause instanceof Error ? cause.message : String(cause),
      });
    },
  });
