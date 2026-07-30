import {
  Bootstrap,
  SocketEvent,
  decodeSocketEvent,
  type DeviceId,
  type Task,
  type ThreadId,
} from "@cohall/protocol"
import { RelayClient } from "@cohall/client"
import { Effect } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

const storageKey = "cohall.connection"

interface Connection {
  readonly url: string
  readonly token: string
}

const parseJson = (value: string): unknown | undefined => {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const initialConnection = (): Connection => {
  const stored = localStorage.getItem(storageKey)
  if (stored !== null) {
    const parsed = parseJson(stored)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "url" in parsed &&
      "token" in parsed &&
      typeof parsed.url === "string" &&
      typeof parsed.token === "string"
    ) {
      return { url: parsed.url, token: parsed.token }
    }
  }
  return {
    url: window.location.port === "5173" ? "http://127.0.0.1:8787" : window.location.origin,
    token: "cohall-local-dev",
  }
}

const empty = Bootstrap.make({
  devices: [],
  threads: [],
  messages: [],
  tasks: [],
  artifacts: [],
})

const upsert = <T extends { readonly id: string }>(
  values: ReadonlyArray<T>,
  value: T,
): ReadonlyArray<T> => {
  const index = values.findIndex((candidate) => candidate.id === value.id)
  if (index === -1) {
    return [...values, value]
  }
  return values.map((candidate) => (candidate.id === value.id ? value : candidate))
}

const applyEvent = (state: Bootstrap, event: SocketEvent): Bootstrap => {
  switch (event._tag) {
    case "DeviceChanged":
      return Bootstrap.make({
        ...state,
        devices: upsert(state.devices, event.device),
      })
    case "ThreadChanged":
      return Bootstrap.make({
        ...state,
        threads: upsert(state.threads, event.thread),
      })
    case "MessageCreated":
      return Bootstrap.make({
        ...state,
        messages: upsert(state.messages, event.message),
      })
    case "TaskChanged":
      return Bootstrap.make({
        ...state,
        tasks: upsert(state.tasks, event.task),
      })
    case "ArtifactCreated":
      return Bootstrap.make({
        ...state,
        artifacts: upsert(state.artifacts, event.artifact),
      })
    default:
      return state
  }
}

const websocketUrl = (connection: Connection): string => {
  const url = new URL(connection.url)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.pathname = "/ws"
  url.search = ""
  url.searchParams.set("role", "client")
  url.searchParams.set("token", connection.token)
  return url.toString()
}

export const useCohall = () => {
  const [connection, setConnectionState] = useState(initialConnection)
  const [data, setData] = useState<Bootstrap>(empty)
  const [status, setStatus] = useState<"connecting" | "online" | "offline">("connecting")
  const [error, setError] = useState<string>()
  const socket = useRef<WebSocket | undefined>(undefined)

  const client = useMemo(
    () =>
      RelayClient.make({
        baseUrl: connection.url,
        token: connection.token,
      }),
    [connection],
  )

  const refresh = useCallback(async () => {
    setError(undefined)
    const snapshot = await Effect.runPromise(client.bootstrap()).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause))
      return undefined
    })
    if (snapshot !== undefined) {
      setData(snapshot)
    }
  }, [client])

  useEffect(() => {
    let disposed = false
    let reconnect: ReturnType<typeof setTimeout> | undefined

    const open = (): void => {
      if (disposed) {
        return
      }
      setStatus("connecting")
      const next = new WebSocket(websocketUrl(connection))
      socket.current = next
      next.addEventListener("open", () => {
        setStatus("online")
        void refresh()
      })
      next.addEventListener("message", (message) => {
        if (typeof message.data !== "string") {
          return
        }
        void Effect.runPromise(
          Effect.try({
            try: () => JSON.parse(message.data) as unknown,
            catch: () => new Error("Relay sent invalid JSON"),
          }).pipe(Effect.flatMap(decodeSocketEvent)),
        )
          .then((event) => {
            if (event._tag === "Error") {
              setError(event.message)
              return
            }
            setData((current) => applyEvent(current, event))
          })
          .catch(() => undefined)
      })
      next.addEventListener("close", () => {
        setStatus("offline")
        if (!disposed) {
          reconnect = setTimeout(open, 2_000)
        }
      })
      next.addEventListener("error", () => next.close())
    }

    void refresh()
    open()
    return () => {
      disposed = true
      if (reconnect !== undefined) {
        clearTimeout(reconnect)
      }
      socket.current?.close()
    }
  }, [connection, refresh])

  const setConnection = (next: Connection): void => {
    localStorage.setItem(storageKey, JSON.stringify(next))
    setConnectionState(next)
  }

  const createTask = async (input: {
    readonly prompt: string
    readonly threadId?: ThreadId
    readonly targetDeviceId?: DeviceId
    readonly workspace?: string
  }): Promise<Task> => {
    const task = await Effect.runPromise(
      client.createTask({
        prompt: input.prompt,
        ...(input.threadId === undefined
          ? { title: input.prompt.slice(0, 72) }
          : { threadId: input.threadId }),
        ...(input.targetDeviceId === undefined ? {} : { targetDeviceId: input.targetDeviceId }),
        ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      }),
    )
    setData((current) =>
      Bootstrap.make({
        ...current,
        tasks: upsert(current.tasks, task),
      }),
    )
    return task
  }

  return {
    client,
    connection,
    createTask,
    data,
    error,
    refresh,
    setConnection,
    status,
  }
}
