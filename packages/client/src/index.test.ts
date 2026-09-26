import { createServer } from "node:http"
import { type AddressInfo } from "node:net"
import { Effect } from "effect"
import { expect, it } from "vitest"
import { make } from "./index.ts"

it("rejects files before submitting to a relay without attachment support", async () => {
  let created = false
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json")
    if (request.url === "/api/health") {
      response.end(JSON.stringify({ ok: true, version: "0.6.2" }))
      return
    }
    created = true
    response.writeHead(500).end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const port = (server.address() as AddressInfo).port
    const client = make({ baseUrl: `http://127.0.0.1:${port}`, token: "test" })
    await expect(
      Effect.runPromise(
        client.createTask({
          prompt: "Inspect",
          attachments: [{ name: "image.png", data: Buffer.from("image").toString("base64") }],
        }),
      ),
    ).rejects.toMatchObject({ message: "Upgrade the Cohall relay before sending file attachments" })
    expect(created).toBe(false)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
