import { describe, expect, it } from "vitest"
import { relayListenOptions } from "./main.ts"

const configuration = { host: "127.0.0.1", port: 8787 }

describe("relay listener", () => {
  it("uses the configured host and port without socket activation", () => {
    expect(relayListenOptions(configuration, {}, 100)).toEqual(configuration)
    expect(relayListenOptions(configuration, { LISTEN_PID: "99", LISTEN_FDS: "1" }, 100)).toEqual(
      configuration,
    )
  })

  it("accepts the systemd socket while the relay service restarts", () => {
    expect(
      relayListenOptions(
        configuration,
        { LISTEN_PID: "100", LISTEN_FDS: "1", LISTEN_FDNAMES: "cohall-relay" },
        100,
      ),
    ).toEqual({ fd: 3 })
    expect(
      relayListenOptions(
        configuration,
        {
          LISTEN_PID: "100",
          LISTEN_FDS: "2",
          LISTEN_FDNAMES: "metrics:cohall-relay",
        },
        100,
      ),
    ).toEqual({ fd: 4 })
  })

  it("rejects an ambiguous set of inherited sockets", () => {
    expect(() =>
      relayListenOptions(
        configuration,
        { LISTEN_PID: "100", LISTEN_FDS: "2", LISTEN_FDNAMES: "one:two" },
        100,
      ),
    ).toThrow("none was named cohall-relay")
  })
})
