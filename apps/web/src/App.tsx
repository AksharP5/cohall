import {
  Activity,
  Archive,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  Command,
  Cpu,
  Hash,
  Laptop,
  Menu,
  MessageSquareText,
  Monitor,
  MoreHorizontal,
  PanelLeftClose,
  Plus,
  Search,
  Server,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  X,
} from "lucide-react"
import {
  TaskStatus,
  type Device,
  type DeviceId,
  type Message,
  type Task,
  type ThreadId,
} from "@cohall/protocol"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react"
import { useCohall } from "./useCohall.ts"

const relativeTime = (timestamp: string): string => {
  const seconds = Math.max(0, (Date.now() - new Date(timestamp).getTime()) / 1_000)
  if (seconds < 60) {
    return "now"
  }
  if (seconds < 3_600) {
    return `${Math.floor(seconds / 60)}m`
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3_600)}h`
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(timestamp))
}

const deviceIcon = (device: Device) => {
  if (device.platform === "darwin") {
    return Laptop
  }
  if (device.name.toLowerCase().includes("vps")) {
    return Server
  }
  return Monitor
}

const deviceColor = (device: Device): string => {
  if (device.platform === "darwin") {
    return "violet"
  }
  if (device.name.toLowerCase().includes("vps")) {
    return "blue"
  }
  return "lime"
}

const taskLabel: Record<TaskStatus, string> = {
  queued: "Queued",
  assigned: "Sent",
  running: "Working",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
}

function Mark() {
  return (
    <span className="mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}

function Avatar({ name, agent = false }: { readonly name: string; readonly agent?: boolean }) {
  return (
    <span className={`avatar ${agent ? "avatar-agent" : ""}`}>
      {agent ? <Mark /> : name.slice(0, 1).toUpperCase()}
    </span>
  )
}

function DeviceRow({
  device,
  selected,
  onSelect,
}: {
  readonly device: Device
  readonly selected: boolean
  readonly onSelect: () => void
}) {
  const Icon = deviceIcon(device)
  return (
    <button className={`device-row ${selected ? "selected" : ""}`} onClick={onSelect} type="button">
      <span className={`device-icon ${deviceColor(device)}`}>
        <Icon size={14} strokeWidth={2} />
        <span className={`presence ${device.status}`} />
      </span>
      <span className="device-copy">
        <span>{device.name}</span>
        <small>
          {device.status === "offline"
            ? `Last seen ${relativeTime(device.lastSeenAt)}`
            : device.status}
        </small>
      </span>
      {selected ? <Check className="row-check" size={14} /> : null}
    </button>
  )
}

function TaskPill({ task, device }: { readonly task: Task; readonly device?: Device | undefined }) {
  return (
    <div className={`task-pill ${task.status}`}>
      {task.status === "running" ? (
        <span className="working-dot" />
      ) : task.status === "completed" ? (
        <Check size={12} />
      ) : task.status === "failed" ? (
        <X size={12} />
      ) : (
        <Activity size={12} />
      )}
      <span>{device?.name ?? "Device"}</span>
      <span className="task-divider" />
      <span>{taskLabel[task.status]}</span>
    </div>
  )
}

function MessageItem({
  message,
  task,
  device,
}: {
  readonly message: Message
  readonly task?: Task | undefined
  readonly device?: Device | undefined
}) {
  if (message.kind === "reasoning") {
    return (
      <details className="reasoning-message">
        <summary>
          <Sparkles size={13} />
          Reasoning on {device?.name ?? "device"}
          <ChevronDown size={13} />
        </summary>
        <div>{message.content}</div>
      </details>
    )
  }
  if (message.kind === "tool" || message.kind === "status") {
    return (
      <div className="tool-message">
        <span className="tool-rail">
          <Command size={13} />
        </span>
        <span className="tool-copy">{message.content}</span>
        <span className="message-time">{relativeTime(message.createdAt)}</span>
      </div>
    )
  }

  const human = message.role === "human"
  return (
    <article className={`message ${human ? "human" : "agent"}`}>
      <Avatar name={message.authorName} agent={!human} />
      <div className="message-body">
        <div className="message-meta">
          <strong>{message.authorName}</strong>
          {device !== undefined ? <span className="device-tag">{device.name}</span> : null}
          <time>{relativeTime(message.createdAt)}</time>
        </div>
        <div className={`message-content ${message.kind === "error" ? "error" : ""}`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        </div>
        {task !== undefined ? <TaskPill task={task} device={device} /> : null}
      </div>
    </article>
  )
}

function EmptyThread({ hasDevices }: { readonly hasDevices: boolean }) {
  return (
    <div className="empty-thread">
      <div className="empty-mark">
        <Mark />
      </div>
      <h2>Bring the right device into the room.</h2>
      <p>
        Ask naturally. Cohall hands work to the agent with the local workspace, tools, and signed-in
        state it needs.
      </p>
      <div className="example-grid">
        <div>
          <Laptop size={16} />
          <span>Use my Mac to research these videos in my signed-in browser.</span>
        </div>
        <div>
          <Monitor size={16} />
          <span>Send the findings to Linux and update the project.</span>
        </div>
      </div>
      {!hasDevices ? (
        <div className="empty-warning">
          No devices are connected yet. Start the device daemon to begin.
        </div>
      ) : null}
    </div>
  )
}

function Composer({
  devices,
  selectedDevice,
  onDevice,
  onSubmit,
  sending,
}: {
  readonly devices: ReadonlyArray<Device>
  readonly selectedDevice?: DeviceId | undefined
  readonly onDevice: (deviceId: DeviceId | undefined) => void
  readonly onSubmit: (content: string) => Promise<void>
  readonly sending: boolean
}) {
  const [content, setContent] = useState("")
  const [open, setOpen] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const target = devices.find((device) => device.id === selectedDevice)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const prompt = content.trim()
    if (prompt.length === 0 || sending) {
      return
    }
    setContent("")
    void onSubmit(prompt).catch(() => setContent(prompt))
  }

  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        ref={input}
        rows={1}
        value={content}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault()
            event.currentTarget.form?.requestSubmit()
          }
        }}
        placeholder="Message Cohall"
        aria-label="Message Cohall"
      />
      <div className="composer-actions">
        <div className="target-wrap">
          <button
            type="button"
            className="target-button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
          >
            <Cpu size={14} />
            {target === undefined ? "Choose automatically" : `@${target.name}`}
            <ChevronDown size={13} />
          </button>
          {open ? (
            <div className="target-popover">
              <button
                type="button"
                onClick={() => {
                  onDevice(undefined)
                  setOpen(false)
                }}
              >
                <span className="device-icon neutral">
                  <Sparkles size={14} />
                </span>
                <span>
                  <strong>Choose automatically</strong>
                  <small>Route to an available capable device</small>
                </span>
                {selectedDevice === undefined ? <Check size={14} /> : null}
              </button>
              {devices.map((device) => {
                const Icon = deviceIcon(device)
                return (
                  <button
                    type="button"
                    key={device.id}
                    onClick={() => {
                      onDevice(device.id)
                      setOpen(false)
                    }}
                  >
                    <span className={`device-icon ${deviceColor(device)}`}>
                      <Icon size={14} />
                      <span className={`presence ${device.status}`} />
                    </span>
                    <span>
                      <strong>@{device.name}</strong>
                      <small>
                        {device.platform} · {device.status}
                      </small>
                    </span>
                    {selectedDevice === device.id ? <Check size={14} /> : null}
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
        <span className="composer-hint">Shift ↵ for new line</span>
        <button
          type="submit"
          className="send-button"
          disabled={sending || content.trim().length === 0}
          aria-label="Send message"
        >
          {sending ? <Square size={13} fill="currentColor" /> : <ArrowUp size={17} />}
        </button>
      </div>
    </form>
  )
}

function ConnectionDialog({
  url,
  token,
  onClose,
  onSave,
}: {
  readonly url: string
  readonly token: string
  readonly onClose: () => void
  readonly onSave: (url: string, token: string) => void
}) {
  const [nextUrl, setUrl] = useState(url)
  const [nextToken, setToken] = useState(token)
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div>
            <h2 id="connection-title">Relay connection</h2>
            <p>Point Cohall at the relay on your VPS or local machine.</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <label>
          Relay URL
          <input value={nextUrl} onChange={(event) => setUrl(event.target.value)} />
        </label>
        <label>
          Access token
          <input
            type="password"
            value={nextToken}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => onSave(nextUrl.trim(), nextToken)}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  )
}

export function App() {
  const cohall = useCohall()
  const [selectedThreadId, setSelectedThreadId] = useState<ThreadId>()
  const [selectedDeviceId, setSelectedDeviceId] = useState<DeviceId>()
  const [search, setSearch] = useState("")
  const [sending, setSending] = useState(false)
  const [settings, setSettings] = useState(false)
  const [mobileSidebar, setMobileSidebar] = useState(false)
  const scroll = useRef<HTMLDivElement>(null)

  const threads = useMemo(
    () =>
      [...cohall.data.threads]
        .filter((thread) => thread.title.toLowerCase().includes(search.trim().toLowerCase()))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [cohall.data.threads, search],
  )
  const selectedThread = cohall.data.threads.find((thread) => thread.id === selectedThreadId)
  const messages = cohall.data.messages.filter((message) => message.threadId === selectedThreadId)
  const tasks = cohall.data.tasks.filter((task) => task.threadId === selectedThreadId)
  const active = tasks.filter((task) => !["completed", "failed", "cancelled"].includes(task.status))
  const participantCount = Math.max(1, new Set(tasks.map((task) => task.targetDeviceId)).size)

  useEffect(() => {
    if (selectedThreadId === undefined && cohall.data.threads[0] !== undefined) {
      setSelectedThreadId(cohall.data.threads[0].id)
    }
  }, [cohall.data.threads, selectedThreadId])

  useEffect(() => {
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight })
  }, [messages.length, tasks.length])

  const submit = async (prompt: string): Promise<void> => {
    setSending(true)
    await cohall
      .createTask({
        prompt,
        ...(selectedThreadId === undefined ? {} : { threadId: selectedThreadId }),
        ...(selectedDeviceId === undefined ? {} : { targetDeviceId: selectedDeviceId }),
      })
      .then((task) => setSelectedThreadId(task.threadId))
      .finally(() => setSending(false))
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileSidebar ? "mobile-open" : ""}`}>
        <div className="brand-row">
          <div className="brand">
            <Mark />
            <span>Cohall</span>
          </div>
          <button
            className="icon-button sidebar-close"
            type="button"
            onClick={() => setMobileSidebar(false)}
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
        <button
          className="new-thread"
          type="button"
          onClick={() => {
            setSelectedThreadId(undefined)
            setMobileSidebar(false)
          }}
        >
          <Plus size={15} />
          New conversation
          <kbd>⌘ N</kbd>
        </button>
        <label className="search">
          <Search size={14} />
          <input
            placeholder="Search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <div className="sidebar-scroll">
          <section className="sidebar-section">
            <div className="section-label">
              <span>Devices</span>
              <span>
                {cohall.data.devices.filter((device) => device.status !== "offline").length} online
              </span>
            </div>
            <button
              className={`device-row ${selectedDeviceId === undefined ? "selected" : ""}`}
              type="button"
              onClick={() => setSelectedDeviceId(undefined)}
            >
              <span className="device-icon neutral">
                <Sparkles size={14} />
              </span>
              <span className="device-copy">
                <span>Any device</span>
                <small>Automatic routing</small>
              </span>
              {selectedDeviceId === undefined ? <Check className="row-check" size={14} /> : null}
            </button>
            {cohall.data.devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                selected={device.id === selectedDeviceId}
                onSelect={() => setSelectedDeviceId(device.id)}
              />
            ))}
          </section>

          <section className="sidebar-section conversations">
            <div className="section-label">
              <span>Conversations</span>
              <Archive size={13} />
            </div>
            {threads.map((thread) => {
              const threadTasks = cohall.data.tasks.filter((task) => task.threadId === thread.id)
              const working = threadTasks.some((task) => task.status === "running")
              return (
                <button
                  type="button"
                  key={thread.id}
                  className={`thread-row ${thread.id === selectedThreadId ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedThreadId(thread.id)
                    setMobileSidebar(false)
                  }}
                >
                  <span className="thread-glyph">
                    <MessageSquareText size={14} />
                    {working ? <span className="working-dot" /> : null}
                  </span>
                  <span>
                    <strong>{thread.title}</strong>
                    <small>{relativeTime(thread.updatedAt)}</small>
                  </span>
                </button>
              )
            })}
            {threads.length === 0 ? <p className="sidebar-empty">No conversations yet.</p> : null}
          </section>
        </div>

        <div className="sidebar-footer">
          <button type="button" onClick={() => setSettings(true)}>
            <Settings size={15} />
            Settings
          </button>
          <button type="button">
            <CircleHelp size={15} />
            Help
          </button>
          <div className="relay-status">
            <span className={cohall.status} />
            Relay {cohall.status}
          </div>
        </div>
      </aside>

      {mobileSidebar ? (
        <button
          className="mobile-scrim"
          aria-label="Close sidebar"
          onClick={() => setMobileSidebar(false)}
        />
      ) : null}

      <main className="workspace">
        <header className="workspace-header">
          <div className="header-title">
            <button
              type="button"
              className="icon-button mobile-menu"
              onClick={() => setMobileSidebar(true)}
            >
              <Menu size={17} />
            </button>
            <div>
              <div className="header-eyebrow">
                <Hash size={12} />
                conversation
              </div>
              <h1>{selectedThread?.title ?? "New conversation"}</h1>
            </div>
          </div>
          <div className="header-actions">
            {active.length > 0 ? (
              <span className="active-agents">
                <span className="working-dot" />
                {active.length} {active.length === 1 ? "agent" : "agents"} working
              </span>
            ) : null}
            <button type="button" className="icon-button" title="Thread details">
              <SlidersHorizontal size={15} />
            </button>
            <button type="button" className="icon-button" title="More">
              <MoreHorizontal size={17} />
            </button>
          </div>
        </header>

        {cohall.error !== undefined ? (
          <div className="error-banner">
            <span>{cohall.error}</span>
            <button type="button" onClick={() => setSettings(true)}>
              Check connection
            </button>
          </div>
        ) : null}

        <div className="thread-scroll" ref={scroll}>
          {selectedThread === undefined || messages.length === 0 ? (
            <EmptyThread hasDevices={cohall.data.devices.length > 0} />
          ) : (
            <div className="message-list">
              <div className="thread-intro">
                <div className="intro-icon">
                  <Bot size={18} />
                </div>
                <div>
                  <h2>{selectedThread.title}</h2>
                  <p>
                    Shared work across {participantCount} device
                    {participantCount === 1 ? "" : "s"}.
                  </p>
                </div>
              </div>
              {messages.map((message) => {
                const task = cohall.data.tasks.find((candidate) => candidate.id === message.taskId)
                const device = cohall.data.devices.find(
                  (candidate) => candidate.id === (message.deviceId ?? task?.targetDeviceId),
                )
                return (
                  <MessageItem key={message.id} message={message} task={task} device={device} />
                )
              })}
              {active.map((task) => {
                const device = cohall.data.devices.find(
                  (candidate) => candidate.id === task.targetDeviceId,
                )
                const alreadyShown = messages.some(
                  (message) => message.taskId === task.id && message.role === "agent",
                )
                return alreadyShown ? null : (
                  <div className="pending-agent" key={task.id}>
                    <Avatar name="Codex" agent />
                    <div>
                      <strong>{device?.name ?? "Device agent"}</strong>
                      <TaskPill task={task} device={device} />
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="composer-dock">
          <Composer
            devices={cohall.data.devices}
            selectedDevice={selectedDeviceId}
            onDevice={setSelectedDeviceId}
            onSubmit={submit}
            sending={sending}
          />
          <p className="composer-footnote">
            Cohall sends only the task and context you provide to the selected device.
          </p>
        </div>
      </main>

      {settings ? (
        <ConnectionDialog
          url={cohall.connection.url}
          token={cohall.connection.token}
          onClose={() => setSettings(false)}
          onSave={(url, token) => {
            cohall.setConnection({ url, token })
            setSettings(false)
          }}
        />
      ) : null}
    </div>
  )
}
