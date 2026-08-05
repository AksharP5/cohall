import { RelayClient } from "@cohall/client"
import { TaskId, ThreadId, version } from "@cohall/protocol"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Effect } from "effect"
import * as z from "zod/v4"
import type { ClientConfiguration } from "./config.ts"
import { createDelegation, taskResult, threadContext, waitForTask } from "./delegation.ts"

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
    "delegate",
    {
      title: "Delegate work to another device",
      description:
        "Send focused work to another Cohall device. Include only relevant context; Cohall cannot read the host transcript. Reuse thread_id for related follow-ups.",
      inputSchema: {
        prompt: z.string().min(1).max(131_072),
        target: z.string().optional().describe("Device name, @name, hostname, or ID"),
        provider: z.enum(["codex", "claude-code", "opencode"]).default("codex"),
        context: z.string().max(131_072).optional(),
        thread_id: z.string().uuid().optional(),
        workspace: z.string().max(4096).optional(),
        wait: z.boolean().default(true),
        timeout_seconds: z.number().int().min(5).max(86_400).default(900),
      },
    },
    async ({ prompt, target, provider, context, thread_id, workspace, wait, timeout_seconds }) => {
      const task = await Effect.runPromise(
        createDelegation(client, configuration, {
          prompt,
          provider,
          ...(target === undefined ? {} : { target }),
          ...(context === undefined ? {} : { context }),
          ...(thread_id === undefined ? {} : { threadId: ThreadId.make(thread_id) }),
          ...(workspace === undefined ? {} : { workspace }),
        }),
      )
      return output(
        taskResult(
          wait ? await Effect.runPromise(waitForTask(client, task, timeout_seconds)) : task,
        ),
      )
    },
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
      description: "Request cancellation and return its acknowledged or pending state.",
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
