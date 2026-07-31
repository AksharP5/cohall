import type { DeviceId } from "@cohall/protocol"
import { invoke, isTauri } from "@tauri-apps/api/core"

export interface Connection {
  readonly url: string
  readonly token: string
}

export interface DesktopConfig {
  readonly relayUrl: string
  readonly deviceId: DeviceId
  readonly deviceName: string
  readonly workspaces: ReadonlyArray<string>
}

export interface DeviceRuntime {
  readonly status: string
  readonly pid?: number | undefined
  readonly lastError?: string | undefined
  readonly logs: ReadonlyArray<string>
}

export interface DesktopSnapshot {
  readonly desktop: true
  readonly version: string
  readonly connection?: Connection | undefined
  readonly config?: DesktopConfig | undefined
  readonly runtime: DeviceRuntime
}

export interface AvailableUpdate {
  readonly version: string
  readonly notes?: string | undefined
}

const storageKey = "cohall.connection"

export const desktop = isTauri()

const parseJson = (value: string): unknown | undefined => {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const browserConnection = (): Connection => {
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
    token: "",
  }
}

export const initialConnection = (): Connection =>
  desktop ? { url: "http://127.0.0.1:8787", token: "" } : browserConnection()

export const loadDesktop = (): Promise<DesktopSnapshot | undefined> =>
  desktop ? invoke<DesktopSnapshot>("desktop_snapshot") : Promise.resolve(undefined)

export const saveConnection = async (
  connection: Connection,
): Promise<DesktopSnapshot | undefined> => {
  if (!desktop) {
    localStorage.setItem(storageKey, JSON.stringify(connection))
    return undefined
  }
  return invoke<DesktopSnapshot>("save_desktop_connection", {
    relayUrl: connection.url,
    token: connection.token,
  })
}

export const saveDesktopConfig = (config: DesktopConfig): Promise<DesktopSnapshot> =>
  invoke<DesktopSnapshot>("update_desktop_config", { config })

export const disconnectDesktop = (): Promise<DesktopSnapshot> =>
  invoke<DesktopSnapshot>("disconnect_desktop")

export const setDeviceRunning = (running: boolean): Promise<DeviceRuntime> =>
  invoke<DeviceRuntime>(running ? "start_desktop_device" : "stop_desktop_device")

export const openDesktopLogs = (): Promise<void> => invoke("open_desktop_logs")

export const launchAtLogin = async (): Promise<boolean> => {
  if (!desktop) {
    return false
  }
  const autostart = await import("@tauri-apps/plugin-autostart")
  return autostart.isEnabled()
}

export const setLaunchAtLogin = async (enabled: boolean): Promise<void> => {
  const autostart = await import("@tauri-apps/plugin-autostart")
  if (enabled) {
    await autostart.enable()
    return
  }
  await autostart.disable()
}

export const notify = async (title: string, body: string): Promise<void> => {
  if (!desktop) {
    return
  }
  const notifications = await import("@tauri-apps/plugin-notification")
  let granted = await notifications.isPermissionGranted()
  if (!granted) {
    granted = (await notifications.requestPermission()) === "granted"
  }
  if (granted) {
    notifications.sendNotification({ title, body })
  }
}

export const checkForUpdate = async (): Promise<AvailableUpdate | undefined> => {
  if (!desktop) {
    return undefined
  }
  const updater = await import("@tauri-apps/plugin-updater")
  const update = await updater.check()
  if (update === null) {
    return undefined
  }
  return {
    version: update.version,
    ...(update.body === undefined ? {} : { notes: update.body }),
  }
}

export const installUpdate = async (): Promise<void> => {
  const [{ check }, process] = await Promise.all([
    import("@tauri-apps/plugin-updater"),
    import("@tauri-apps/plugin-process"),
  ])
  const update = await check()
  if (update === null) {
    return
  }
  await update.downloadAndInstall()
  await process.relaunch()
}
