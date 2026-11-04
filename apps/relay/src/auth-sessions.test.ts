import { Effect, ManagedRuntime } from "effect"
import { afterEach, expect, it, onTestFinished, vi } from "vitest"
import { RelayStore } from "./store.ts"

afterEach(() => vi.useRealTimers())

const pairedStore = async () => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime("2030-01-01T00:00:00.000Z")
  const runtime = ManagedRuntime.make(RelayStore.layer(":memory:"))
  onTestFinished(() => runtime.dispose())
  const store = await runtime.runPromise(RelayStore.Service)
  const invite = await Effect.runPromise(
    store.createPairing({ label: "Worker", roles: ["client", "device"] }),
  )
  const paired = await Effect.runPromise(store.exchangePairing(invite.token))
  const client = paired.credentials.find(({ session }) => session.role === "client")
  const device = paired.credentials.find(({ session }) => session.role === "device")
  if (client === undefined || device === undefined) throw new Error("Expected paired credentials")
  return { store, client, device }
}

it("keeps active client credentials valid beyond their original expiry without changing identity", async () => {
  const { store, client, device } = await pairedStore()
  expect(client.session.expiresAt).toBe("2030-04-01T00:00:00.000Z")

  vi.setSystemTime("2030-03-31T00:00:00.000Z")
  const renewed = await Effect.runPromise(store.authenticateSession(client.token, "client"))
  expect(renewed).toMatchObject({
    id: client.session.id,
    deviceId: client.session.deviceId,
    createdAt: client.session.createdAt,
    lastSeenAt: "2030-03-31T00:00:00.000Z",
    expiresAt: "2030-06-29T00:00:00.000Z",
  })

  vi.setSystemTime("2030-04-02T00:00:00.000Z")
  expect(await Effect.runPromise(store.authenticateSession(client.token, "client"))).toMatchObject({
    id: client.session.id,
    expiresAt: "2030-07-01T00:00:00.000Z",
  })
  expect(await Effect.runPromise(store.authenticateSession(device.token, "device"))).toBeUndefined()
})

it("renews an authenticated worker session without changing its device binding", async () => {
  const { store, device } = await pairedStore()
  vi.setSystemTime("2030-03-31T00:00:00.000Z")
  expect(await Effect.runPromise(store.renewAuthSession(device.session.id))).toMatchObject({
    id: device.session.id,
    deviceId: device.session.deviceId,
    expiresAt: "2030-06-29T00:00:00.000Z",
  })
  vi.setSystemTime("2030-04-02T00:00:00.000Z")
  expect(await Effect.runPromise(store.authenticateSession(device.token, "device"))).toMatchObject({
    id: device.session.id,
    deviceId: device.session.deviceId,
  })
})

it.each(["expired", "revoked"] as const)("never renews %s credentials", async (state) => {
  const { store, client, device } = await pairedStore()
  if (state === "expired") vi.setSystemTime("2030-04-01T00:00:00.000Z")
  for (const credential of [client, device]) {
    if (state === "revoked") {
      await Effect.runPromise(store.revokeAuthSession(credential.session.id))
    }
    expect(
      await Effect.runPromise(store.authenticateSession(credential.token, credential.session.role)),
    ).toBeUndefined()
    expect(await Effect.runPromise(store.renewAuthSession(credential.session.id))).toBeUndefined()
  }
  for (const session of await Effect.runPromise(store.listAuthSessions())) {
    expect(session.expiresAt).toBe("2030-04-01T00:00:00.000Z")
    expect(session.lastSeenAt).toBe("2030-01-01T00:00:00.000Z")
  }
})

it("does not renew credentials used with the wrong role", async () => {
  const { store, client } = await pairedStore()
  vi.setSystemTime("2030-03-31T00:00:00.000Z")
  expect(await Effect.runPromise(store.authenticateSession(client.token, "device"))).toBeUndefined()
  vi.setSystemTime("2030-04-01T00:00:00.000Z")
  expect(await Effect.runPromise(store.authenticateSession(client.token, "client"))).toBeUndefined()
})
