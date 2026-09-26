import { RelayClient } from "@cohall/client"
import {
  AttachmentDirection,
  AttachmentName,
  Provider,
  TaskId,
  ThreadId,
  version,
} from "@cohall/protocol"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Effect, Schema } from "effect"
import * as z from "zod/v4"
import { writeFile } from "node:fs/promises"
import type { ClientConfiguration } from "./config.ts"
import {
  acknowledgedTaskResult,
  createDelegation,
  listBots,
  taskResult,
  threadContext,
  waitForTask,
} from "./delegation.ts"
import { readInputAttachments } from "./task-attachments.ts"

const output = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
})

export const runMcp = async (configuration: ClientConfiguration): Promise<void> => {
  const client = RelayClient.make({
    baseUrl: configuration.relayUrl,
    token: configuration.token,
  })
  const server = new McpServer({ name: "cohall", version })

  server.registerTool(
    "list_devices",
    {
      title: "List Cohall devices",
      description:
        "List devices, their availability, local providers, capabilities, and allowed workspaces.",
      inputSchema: {},
    },
    async () => output(await Effect.runPromise(client.devices())),
  )

  server.registerTool(
    "list_bots",
    {
      title: "List Cohall bots",
      description:
        "List named Grok Bots on paired devices, their host availability, and unambiguous targets for delegate. Bot names can also be used when unique.",
      inputSchema: {},
    },
    async () => output(listBots(await Effect.runPromise(client.devices()))),
  )

  server.registerTool(
    "delegate",
    {
      title: "Send work to a device or bot",
      description:
        "Send focused work to a Cohall device or named Grok Bot. When the request depends on the current conversation, distill its motivation, relevant facts, prior findings, constraints, and desired decision into context; Cohall cannot read the host transcript. Never forward unrelated transcript content. Reuse thread_id for related follow-ups. Grok Bots use their existing conversation; a Cohall thread does not isolate it.",
      inputSchema: {
        prompt: z.string().min(1).max(131_072),
        target: z
          .string()
          .optional()
          .describe(
            "Device name, hostname or ID; @BotName; or @device/BotName. Use list_bots targets to disambiguate.",
          ),
        provider: z
          .enum(Provider.literals)
          .optional()
          .describe("Inferred as grok-bot for a bot target; otherwise defaults to codex."),
        context: z
          .string()
          .max(131_072)
          .optional()
          .describe(
            "Distilled context the target needs: why the user is asking, relevant facts and prior findings, constraints, and the intended decision. The calling agent must supply this when the prompt depends on its conversation; omit it only for a self-contained task.",
          ),
        thread_id: z.string().uuid().optional(),
        parent_task_id: z
          .string()
          .uuid()
          .optional()
          .describe("The task delegating this work. Inherited from COHALL_TASK_ID when present."),
        workspace: z
          .string()
          .max(4096)
          .optional()
          .describe("Coding provider workspace. Omit for named Grok Bots."),
        attachment_paths: z
          .array(z.string())
          .max(2)
          .optional()
          .describe(
            "Local files to send with the task, up to 2 files of 256 KiB each. Coding providers only.",
          ),
        wait: z.boolean().default(true),
        timeout_seconds: z.number().int().min(5).max(86_400).default(900),
      },
    },
    async ({
      prompt,
      target,
      provider,
      context,
      thread_id,
      parent_task_id,
      workspace,
      attachment_paths,
      wait,
      timeout_seconds,
    }) => {
      const attachments = await readInputAttachments(attachment_paths ?? [])
      const task = await Effect.runPromise(
        createDelegation(client, configuration, {
          prompt,
          ...(provider === undefined ? {} : { provider }),
          ...(target === undefined ? {} : { target }),
          ...(context === undefined ? {} : { context }),
          ...(thread_id === undefined ? {} : { threadId: ThreadId.make(thread_id) }),
          ...(parent_task_id === undefined ? {} : { parentTaskId: TaskId.make(parent_task_id) }),
          ...(workspace === undefined ? {} : { workspace }),
          ...(attachments.length === 0 ? {} : { attachments }),
        }),
      )
      const completed = wait
        ? await Effect.runPromise(waitForTask(client, task, timeout_seconds))
        : task
      return output(wait ? await acknowledgedTaskResult(client, completed) : taskResult(completed))
    },
  )

  server.registerTool(
    "completion_inbox",
    {
      title: "List completed work",
      description:
        "List up to 20 unacknowledged completed tasks sent by this client. hasMore signals additional entries. Use task_status for a full result, then acknowledge the task after handling it.",
      inputSchema: {},
    },
    async () => output(await Effect.runPromise(client.inbox())),
  )

  server.registerTool(
    "acknowledge_completion",
    {
      title: "Acknowledge completed work",
      description: "Remove a handled task from this client's completion inbox.",
      inputSchema: { task_id: z.string().uuid() },
    },
    async ({ task_id }) =>
      output(await Effect.runPromise(client.acknowledgeCompletion(TaskId.make(task_id)))),
  )

  server.registerTool(
    "task_status",
    {
      title: "Get delegated task status",
      description: "Read the current state and result of a Cohall task.",
      inputSchema: { task_id: z.string().uuid() },
    },
    async ({ task_id }) =>
      output(taskResult(await Effect.runPromise(client.getTask(TaskId.make(task_id))))),
  )

  server.registerTool(
    "list_task_attachments",
    {
      title: "List task files",
      description: "List input and output files retained with a delegated task.",
      inputSchema: { task_id: z.string().uuid() },
    },
    async ({ task_id }) =>
      output(await Effect.runPromise(client.listAttachments(TaskId.make(task_id)))),
  )

  server.registerTool(
    "download_task_attachment",
    {
      title: "Download a task file",
      description: "Save one task file to a new local path. Existing files are never overwritten.",
      inputSchema: {
        task_id: z.string().uuid(),
        name: z.string(),
        output_path: z.string(),
        direction: z.enum(["input", "output"]).optional(),
      },
    },
    async ({ task_id, name, output_path, direction }) => {
      const safeName = Schema.decodeUnknownSync(AttachmentName)(name)
      const safeDirection =
        direction === undefined
          ? undefined
          : Schema.decodeUnknownSync(AttachmentDirection)(direction)
      const data = await Effect.runPromise(
        client.readAttachment(TaskId.make(task_id), safeName, safeDirection),
      )
      await writeFile(output_path, data, { flag: "wx", mode: 0o600 })
      return output({ task_id, name: safeName, output_path, bytes: data.length })
    },
  )

  server.registerTool(
    "task_trace",
    {
      title: "Trace a delegated task",
      description:
        "Read the redacted relay and device lifecycle for troubleshooting a Cohall task.",
      inputSchema: { task_id: z.string().uuid() },
    },
    async ({ task_id }) => output(await Effect.runPromise(client.traceTask(TaskId.make(task_id)))),
  )

  server.registerTool(
    "wait_task",
    {
      title: "Wait for delegated work",
      description: "Wait for a Cohall task to finish and return its final result.",
      inputSchema: {
        task_id: z.string().uuid(),
        timeout_seconds: z.number().int().min(5).max(86_400).default(900),
      },
    },
    async ({ task_id, timeout_seconds }) => {
      const task = await Effect.runPromise(client.getTask(TaskId.make(task_id)))
      return output(taskResult(await Effect.runPromise(waitForTask(client, task, timeout_seconds))))
    },
  )

  server.registerTool(
    "cancel_task",
    {
      title: "Cancel delegated work",
      description:
        "Request cancellation of coding work or a queued Bot task. Active Grok Bot tasks must be stopped in Grok Bot.",
      inputSchema: { task_id: z.string().uuid() },
    },
    async ({ task_id }) =>
      output(taskResult(await Effect.runPromise(client.cancelTask(TaskId.make(task_id))))),
  )

  server.registerTool(
    "thread_context",
    {
      title: "Read a Cohall thread",
      description: "Read shared task prompts and final results for a cross-device thread.",
      inputSchema: { thread_id: z.string().uuid() },
    },
    async ({ thread_id }) =>
      output(await Effect.runPromise(threadContext(client, ThreadId.make(thread_id)))),
  )

  await server.connect(new StdioServerTransport())
}
