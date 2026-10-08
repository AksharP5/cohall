import { RelayDecodeError, RelayRequestError, type Interface as RelayClient } from "@cohall/client"
import type { DeviceOverview } from "@cohall/protocol"
import { Effect, Schedule } from "effect"

export type DeviceWatchUpdate =
  | { readonly devices: ReadonlyArray<DeviceOverview>; readonly updatedAt: number }
  | { readonly error: string }

const attention = (device: DeviceOverview, localVersion: string): number => {
  if (
    device.status === "offline" &&
    device.queued + device.active + device.needsInput + device.cancelling > 0
  )
    return 0
  if (device.needsInput > 0) return 1
  if (device.cancelling > 0) return 2
  if (device.version !== localVersion) return 3
  return 4
}

const cell = (value: string | number, width: number): string => {
  // oxlint-disable-next-line no-control-regex -- Device metadata must not execute terminal controls.
  const characters = [...String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")]
  const text =
    characters.length <= width ? characters.join("") : `${characters.slice(0, width - 1).join("")}~`
  return text.padEnd(width)
}

const age = (timestamp: string | undefined, time: number): string => {
  if (timestamp === undefined) return "-"
  const seconds = Math.max(0, Math.floor((time - Date.parse(timestamp)) / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

export const renderDeviceWatch = (update: DeviceWatchUpdate, localVersion: string): string => {
  if ("error" in update)
    return `Cohall devices\n\nUnable to refresh: ${cell(update.error, 160).trimEnd()}\n`
  const devices = [...update.devices].sort(
    (left, right) =>
      attention(left, localVersion) - attention(right, localVersion) ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  )
  const row = (values: ReadonlyArray<string | number>) =>
    values
      .map((value, index) => cell(value, [19, 8, 7, 5, 6, 5, 6, 6, 10][index] ?? 10))
      .join(" ")
      .trimEnd()
  const rows = devices.flatMap((device) => [
    row([
      device.name,
      device.id.slice(0, 8),
      device.status,
      device.queued,
      device.active,
      device.needsInput,
      device.cancelling,
      age(device.oldestQueuedAt, update.updatedAt),
      `${device.version === localVersion ? "" : "*"}${device.version}`,
    ]),
    ...(device.description === undefined || device.description.length === 0
      ? []
      : [`  ${cell(device.description, 76).trimEnd()}`]),
  ])
  return [
    `Cohall devices | ${new Date(update.updatedAt).toISOString()} | Ctrl-C to exit`,
    "",
    ...(devices.length === 0
      ? ["No devices are registered."]
      : [
          row(["Device", "ID", "State", "Queue", "Active", "Input", "Cancel", "Oldest", "Version"]),
          ...rows,
        ]),
    "",
    `Input: waiting for an answer. Oldest: queued wait. * differs from CLI ${localVersion}.`,
    "",
  ].join("\n")
}

export const watchDevices = Effect.fn("Cohall.watchDevices")(function* (
  client: Pick<RelayClient, "deviceOverview">,
  intervalSeconds: number,
  onUpdate: (update: DeviceWatchUpdate) => void,
) {
  yield* client.deviceOverview().pipe(
    Effect.matchEffect({
      onSuccess: (devices) => Effect.sync(() => onUpdate({ devices, updatedAt: Date.now() })),
      onFailure: (cause) =>
        Effect.sync(() => onUpdate({ error: cause.message })).pipe(
          Effect.andThen(
            cause instanceof RelayDecodeError ||
              (cause instanceof RelayRequestError &&
                cause.status !== undefined &&
                [401, 403, 404].includes(cause.status))
              ? Effect.fail(cause)
              : Effect.void,
          ),
        ),
    }),
    Effect.repeat(Schedule.spaced(intervalSeconds * 1000)),
  )
})
