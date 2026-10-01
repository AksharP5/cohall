import { RelayClient } from "@cohall/client"
import {
  AttachmentDirection,
  AttachmentName,
  Provider,
  TaskId,
  TaskDeadline,
  TaskProgressInput,
  TaskRunId,
  TaskRequestId,
  RequestTaskInput,
  AnswerTaskInput,
  maxClarificationBytes,
  maxProgressNoteBytes,
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
  requestInput,
} from "./delegation.ts"
import { readInputAttachments } from "./task-attachments.ts"
import { createMcpBuildNotice } from "./mcp-build-notice.ts"

export const runMcp = async (configuration: ClientConfiguration): Promise<void> => {
  const buildNotice = await createMcpBuildNotice(process.argv[1], version)
  const output = (value: unknown) =>
    buildNotice({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] })
  const client = RelayClient.make({
    baseUrl: configuration.relayUrl,
    token: configuration.token,
  })
  const server = new McpServer({ name: "cohall", version })

  server.registerTool(
    "task_request_input",
    {
      title: "Ask for task clarification",
      description:
        "Ask the original sender for essential missing information. After this succeeds, end the current worker turn immediately. Cohall pauses when the turn exits and resumes the same task after an answer. Inherits the delegated task and turn when omitted.",
      inputSchema: {
        task_id: z.string().uuid().optional(),
        run_id: z.string().uuid().optional(),
        question: z.string().min(1).max(maxClarificationBytes),
      },
    },
    async ({ task_id, run_id, question }) =>
      output(
        await Effect.runPromise(
          requestInput(
            client,
            configuration,
            Schema.decodeUnknownSync(RequestTaskInput.fields.question)(question),
            task_id === undefined ? undefined : Schema.decodeUnknownSync(TaskId)(task_id),
            run_id === undefined ? undefined : Schema.decodeUnknownSync(TaskRunId)(run_id),
          ),
        ),
      ),
  )

  server.registerTool(
    "task_answer",
    {
      title: "Answer a worker's question",
      description:
        "Answer the current clarification and resume the same task. Use input_request.id from task_status or delegate as request_id, or inputRequest.id from completion_inbox. Only the original requester or relay owner can answer. Use wait_task to collect the resumed result.",
      inputSchema: {
        task_id: z.string().uuid(),
        request_id: z.string().uuid(),
        answer: z.string().min(1).max(maxClarificationBytes),
      },
    },
    async ({ task_id, request_id, answer }) =>
      output(
        taskResult(
          await Effect.runPromise(
            client.answerTaskInput(
              Schema.decodeUnknownSync(TaskId)(task_id),
              Schema.decodeUnknownSync(AnswerTaskInput)({ requestId: request_id, answer }),
            ),
          ),
        ),
      ),
  )

  server.registerTool(
    "task_progress",
    {
      title: "Report task progress",
      description: `Replace the latest progress note for a running task on this device. Use brief milestones, up to ${maxProgressNoteBytes} UTF-8 bytes. Inherits the delegated task ID when omitted.`,
      inputSchema: {
        task_id: z.string().uuid().optional(),
        note: z.string().min(1).max(maxProgressNoteBytes),
      },
    },
    async ({ task_id, note }) => {
      const id = task_id ?? configuration.mcpTaskId
      if (id === undefined) throw new Error("Task id is required outside delegated work")
      const input = Schema.decodeUnknownSync(TaskProgressInput)({ note })
      return output(
        await Effect.runPromise(
          client.reportTaskProgress(Schema.decodeUnknownSync(TaskId)(id), input),
        ),
      )
    },
  )

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
        request_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "A UUID v4 generated before submitting. Reuse with identical input and the same client credential after a lost response to recover the original task. Use stable device IDs or device/bot IDs for retries. For thread follow-ups, select a target or provider explicitly; select Bots explicitly.",
          ),
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
        deadline: z
          .string()
          .optional()
          .describe(
            "Absolute ISO-8601 UTC deadline for coding work, preserved through clarification. Overdue work stops; timeout_seconds only limits waiting.",
          ),
      },
    },
    async (
      {
        prompt,
        request_id,
        target,
        provider,
        context,
        thread_id,
        parent_task_id,
        workspace,
        attachment_paths,
        wait,
        timeout_seconds,
        deadline,
      },
      { signal },
    ) => {
      const attachments = await readInputAttachments(attachment_paths ?? [])
      const task = await Effect.runPromise(
        createDelegation(client, configuration, {
          prompt,
          ...(request_id === undefined
            ? {}
            : { requestId: Schema.decodeUnknownSync(TaskRequestId)(request_id) }),
          ...(provider === undefined ? {} : { provider }),
          ...(target === undefined ? {} : { target }),
          ...(context === undefined ? {} : { context }),
          ...(thread_id === undefined ? {} : { threadId: ThreadId.make(thread_id) }),
          ...(parent_task_id === undefined ? {} : { parentTaskId: TaskId.make(parent_task_id) }),
          ...(workspace === undefined ? {} : { workspace }),
          ...(attachments.length === 0 ? {} : { attachments }),
          ...(deadline === undefined
            ? {}
            : { expiresAt: Schema.decodeUnknownSync(TaskDeadline)(deadline) }),
        }),
        { signal },
      )
      const completed = wait
        ? await Effect.runPromise(waitForTask(client, task, timeout_seconds), { signal })
        : task
      return output(
        wait ? await acknowledgedTaskResult(client, completed, signal) : taskResult(completed),
      )
    },
  )

  server.registerTool(
    "completion_inbox",
    {
      title: "List pending questions and completed work",
      description:
        "List up to 20 unanswered clarification requests and unacknowledged completed tasks sent by this client. hasMore signals additional entries. Answer questions with task_answer; use task_status for full results and acknowledge only handled completions.",
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
        "Read the relay and device lifecycle and latest worker progress note for troubleshooting a Cohall task.",
      inputSchema: { task_id: z.string().uuid() },
    },
    async ({ task_id }) => output(await Effect.runPromise(client.traceTask(TaskId.make(task_id)))),
  )

  server.registerTool(
    "wait_task",
    {
      title: "Wait for delegated work",
      description:
        "Wait for a Cohall task to finish or need input. Answer a needs_input result with task_answer, then wait again.",
      inputSchema: {
        task_id: z.string().uuid(),
        timeout_seconds: z.number().int().min(5).max(86_400).default(900),
      },
    },
    async ({ task_id, timeout_seconds }, { signal }) => {
      const task = await Effect.runPromise(client.getTask(TaskId.make(task_id)), { signal })
      return output(
        taskResult(await Effect.runPromise(waitForTask(client, task, timeout_seconds), { signal })),
      )
    },
  )

  server.registerTool(
    "cancel_task",
    {
      title: "Cancel delegated work",
      description:
        "Cancel coding work, a paused task, or a Bot task that has never been dispatched. Active Grok Bot tasks must be stopped in Grok Bot.",
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
