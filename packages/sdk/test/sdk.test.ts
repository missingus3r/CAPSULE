import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CapsuleRelayClient, uploadCapsule } from "../src/index.js";

let server: Server | undefined;

afterEach(
  () =>
    new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server = undefined;
    }),
);

describe("CapsuleRelayClient", () => {
  it("does not place bearer capabilities in request URLs", async () => {
    let observedUrl = "";
    let observedAuthorization = "";
    server = createServer((request, response) => {
      observedUrl = request.url ?? "";
      observedAuthorization = request.headers.authorization ?? "";
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.end(Buffer.from([1, 2, 3]));
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Unexpected server address");

    const client = new CapsuleRelayClient(`http://127.0.0.1:${address.port}`);
    await client.manifest("capsule-id", "read-secret");

    expect(observedUrl).toBe("/v1/capsules/capsule-id/manifest");
    expect(observedAuthorization).toBe("Bearer read-secret");
  });

  it("discovers limits and rejects oversized capsules before reserving storage", async () => {
    let reservationRequests = 0;
    server = createServer((request, response) => {
      if (request.url === "/v1/config") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            version: 1,
            maxCapsuleBytes: 64,
            maxChunkBytes: 48,
            maxManifestBytes: 1024,
            maxChunkCount: 8,
            defaultTtlSeconds: 60,
            maxTtlSeconds: 3600,
          }),
        );
        return;
      }
      if (request.url === "/v1/capsules") reservationRequests += 1;
      response.writeHead(500).end();
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Unexpected server address");

    await expect(
      uploadCapsule({
        data: new Blob([new Uint8Array(65)]),
        filename: "too-large.bin",
        ttlSeconds: 60,
        relayUrl: `http://127.0.0.1:${address.port}`,
        appUrl: "https://capsule.test/",
      }),
    ).rejects.toThrow(/exceeds the relay limit/u);
    expect(reservationRequests).toBe(0);
  });
});
