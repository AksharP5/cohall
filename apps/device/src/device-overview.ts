import type { Device } from "@cohall/protocol"

export const deviceVersions = (devices: ReadonlyArray<Device>, localVersion: string) => ({
  local_version: localVersion,
  current: devices.filter((device) => device.version === localVersion).length,
  different: devices.filter((device) => device.version !== localVersion).length,
  devices: devices.map((device) => ({
    id: device.id,
    name: device.name,
    status: device.status,
    version: device.version,
    current: device.version === localVersion,
  })),
})

export const allDeviceHealth = (devices: ReadonlyArray<Device>, localVersion: string) => {
  const summaries = devices.map((device) => {
    const warnings = [
      ...(device.status === "offline" ? ["Device is offline"] : []),
      ...(device.providers.length === 0 ? ["No provider executable is available"] : []),
      ...(device.version === localVersion
        ? []
        : [`Running Cohall ${device.version}; local CLI is ${localVersion}`]),
    ]
    return {
      id: device.id,
      name: device.name,
      hostname: device.hostname,
      platform: device.platform,
      architecture: device.architecture,
      status: device.status,
      version: device.version,
      providers: device.providers,
      workspaces: device.workspaces.map((workspace) => workspace.path),
      last_seen_at: device.lastSeenAt,
      warnings,
    }
  })
  return {
    healthy: summaries.length > 0 && summaries.every((device) => device.warnings.length === 0),
    total: devices.length,
    online: devices.filter((device) => device.status === "online").length,
    busy: devices.filter((device) => device.status === "busy").length,
    offline: devices.filter((device) => device.status === "offline").length,
    warnings: summaries.length === 0 ? ["No Cohall devices are registered"] : [],
    devices: summaries,
  }
}
