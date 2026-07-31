import {
  Bootstrap,
  SocketEvent,
  decodeSocketEvent,
  type DeviceId,
  type Task,
  type ThreadId,
} from "@cohall/protocol"
import { RelayClient, exchangePairing } from "@cohall/client"
import { Effect } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  desktop,
  disconnectDesktop,
  initialConnection,
  loadDesktop,
  notify,
  saveConnection,
  saveDesktopConfig,
  setDeviceRunning,
  type Connection,
  type DesktopSnapshot,
  type DeviceRuntime,
} from "./runtime.ts"

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
  return url.toString()
}

export const useCohall = () => {
  const [connection, setConnectionState] = useState(initialConnection)
  const [desktopState, setDesktopState] = useState<DesktopSnapshot>()
  const [ready, setReady] = useState(!desktop)
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

  useEffect(() => {
    if (!desktop) {
      return
    }
    void loadDesktop()
      .then((snapshot) => {
        if (snapshot !== undefined) {
          setDesktopState(snapshot)
          if (snapshot.connection !== undefined) {
            setConnectionState(snapshot.connection)
          }
        }
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => setReady(true))
  }, [])

  useEffect(() => {
    if (!desktop) {
      return
    }
    let unlisten: (() => void) | undefined
    let disposed = false
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<DeviceRuntime>("cohall://device-status", (event) => {
          setDesktopState((current) =>
            current === undefined ? current : { ...current, runtime: event.payload },
          )
        }),
      )
      .then((cleanup) => {
        if (disposed) {
          cleanup()
          return
        }
        unlisten = cleanup
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

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
    if (!ready) {
      return
    }
    if (connection.token.trim().length === 0) {
      setStatus("offline")
      setError(desktop ? "Pair this desktop with your Cohall relay" : "Enter the relay token")
      return
    }
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
        next.send(
          JSON.stringify(
            SocketEvent.make({
              _tag: "Authenticate",
              token: connection.token,
              role: "client",
            }),
          ),
        )
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
            if (event._tag === "Connected") {
              setStatus("online")
              void refresh()
              return
            }
            if (event._tag === "Error") {
              setError(event.message)
              return
            }
            if (
              event._tag === "TaskChanged" &&
              (event.task.status === "completed" || event.task.status === "failed")
            ) {
              void notify(
                event.task.status === "completed" ? "Cohall task completed" : "Cohall task failed",
                event.task.prompt.slice(0, 120),
              )
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
  }, [connection, ready, refresh])

  const setConnection = async (next: Connection): Promise<void> => {
    const snapshot = await saveConnection(next)
    if (snapshot !== undefined) {
      setDesktopState(snapshot)
    }
    setConnectionState(next)
  }

  const pair = async (url: string, token: string): Promise<void> => {
    const result = await Effect.runPromise(
      exchangePairing(url, {
        token,
        ...(desktopState?.config?.deviceId === undefined
          ? {}
          : { deviceId: desktopState.config.deviceId }),
      }),
    )
    await setConnection({ url, token: result.token })
  }

  const configureDesktop = async (
    config: NonNullable<DesktopSnapshot["config"]>,
  ): Promise<void> => {
    setDesktopState(await saveDesktopConfig(config))
  }

  const disconnect = async (): Promise<void> => {
    if (!desktop) {
      await setConnection({ url: connection.url, token: "" })
      return
    }
    const snapshot = await disconnectDesktop()
    setDesktopState(snapshot)
    setConnectionState({ url: snapshot.config?.relayUrl ?? connection.url, token: "" })
  }

  const setDevice = async (running: boolean): Promise<void> => {
    const runtime = await setDeviceRunning(running)
    setDesktopState((current) => (current === undefined ? current : { ...current, runtime }))
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
    configureDesktop,
    createTask,
    data,
    desktop: desktopState,
    disconnect,
    error,
    pair,
    ready,
    refresh,
    setConnection,
    setDevice,
    status,
  }
}
