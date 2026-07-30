import { TaskId, ThreadId } from "@cohall/protocol"
import { RelayClient } from "@cohall/client"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Effect } from "effect"
import * as z from "zod/v4"
import type { DeviceConfiguration } from "./config.ts"
import { createDelegation, taskResult, threadContext, waitForTask } from "./delegation.ts"

const output = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(value, null, 2),
    },
  ],
})

export const runMcp = async (configuration: DeviceConfiguration): Promise<void> => {
  const client = RelayClient.make({
    baseUrl: configuration.relayUrl,
    token: configuration.token,
  })
  const server = new McpServer({
    name: "cohall",
    version: "0.1.0",
  })

  server.registerTool(
    "list_devices",
    {
      title: "List Cohall devices",
      description:
        "List connected and known devices, their local workspaces, providers, and capabilities. Use this before delegating when the best target is not obvious.",
      inputSchema: {},
    },
    async () =>
      output(
        (await Effect.runPromise(client.devices())).map((device) => ({
          id: device.id,
          name: device.name,
          hostname: device.hostname,
          platform: device.platform,
          status: device.status,
          providers: device.providers,
          capabilities: device.capabilities,
          workspaces: device.workspaces,
        })),
      ),
  )

  server.registerTool(
    "delegate",
    {
      title: "Delegate work to another device",
      description:
        "Send work to a Cohall device agent. Include the relevant context from this conversation in context; Cohall cannot read hidden host transcript state. Reuse thread_id from an earlier result to keep a shared Cohall conversation. The target may be a device name, @name, hostname, or id.",
      inputSchema: {
        prompt: z.string().min(1).describe("The task for the remote device agent"),
        target: z
          .string()
          .optional()
          .describe("Device name, @name, hostname, or id; omitted selects an online device"),
        context: z
          .string()
          .optional()
          .describe("Only the conversation context the remote agent needs"),
        thread_id: z.string().uuid().optional().describe("Existing Cohall thread id to continue"),
        workspace: z
          .string()
          .optional()
          .describe("A workspace path advertised by the target device"),
        wait: z.boolean().default(true).describe("Wait for the remote agent's final result"),
        timeout_seconds: z
          .number()
          .int()
          .min(5)
          .max(3600)
          .default(900)
          .describe("Maximum wait when wait is true"),
      },
    },
    async ({ prompt, target, context, thread_id, workspace, wait, timeout_seconds }) => {
      const task = await Effect.runPromise(
        createDelegation(client, configuration, {
          prompt,
          ...(target === undefined ? {} : { target }),
          ...(context === undefined ? {} : { context }),
          ...(thread_id === undefined ? {} : { threadId: ThreadId.make(thread_id) }),
          ...(workspace === undefined ? {} : { workspace }),
        }),
      )
      if (!wait) {
        return output(taskResult(task))
      }

      const completed = await Effect.runPromise(waitForTask(client, task, timeout_seconds))
      return output(taskResult(completed))
    },
  )

  server.registerTool(
    "task_status",
    {
      title: "Get delegated task status",
      description: "Read the current state and result of a Cohall task.",
      inputSchema: {
        task_id: z.string().uuid(),
      },
    },
    async ({ task_id }) =>
      output(taskResult(await Effect.runPromise(client.getTask(TaskId.make(task_id))))),
  )

  server.registerTool(
    "cancel_task",
    {
      title: "Cancel delegated work",
      description: "Cancel a queued or running Cohall task.",
      inputSchema: {
        task_id: z.string().uuid(),
      },
    },
    async ({ task_id }) =>
      output(taskResult(await Effect.runPromise(client.cancelTask(TaskId.make(task_id))))),
  )

  server.registerTool(
    "thread_context",
    {
      title: "Read a Cohall thread",
      description:
        "Read shared messages and tasks for a Cohall thread when continuing cross-device work.",
      inputSchema: {
        thread_id: z.string().uuid(),
      },
    },
    async ({ thread_id }) => {
      const id = ThreadId.make(thread_id)
      return output(await Effect.runPromise(threadContext(client, id)))
    },
  )

  await server.connect(new StdioServerTransport())
}
