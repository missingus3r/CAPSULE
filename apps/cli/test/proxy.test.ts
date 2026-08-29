import { createServer as createHttpServer, type Server } from "node:http";
import {
  createServer as createTcpServer,
  connect,
  type Server as TcpServer,
} from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createProxiedFetch, parseProxyUrl } from "../src/proxy.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function track(server: Server | TcpServer): void {
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
}

async function listen(server: Server | TcpServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unexpected address");
  }
  track(server);
  return address.port;
}

/** A SOCKS5 server that only does what the CLI needs: no auth, CONNECT, pipe. */
function startSocksServer(): { server: TcpServer; requested: string[] } {
  const requested: string[] = [];
  const server = createTcpServer((socket) => {
    let stage: "greeting" | "connect" | "piping" = "greeting";
    let buffer = Buffer.alloc(0);

    socket.on("data", (chunk: Buffer) => {
      if (stage === "piping") return;
      buffer = Buffer.concat([buffer, chunk]);

      if (stage === "greeting") {
        if (buffer.length < 2) return;
        const methods = buffer[1] ?? 0;
        if (buffer.length < 2 + methods) return;
        buffer = buffer.subarray(2 + methods);
        socket.write(Buffer.from([0x05, 0x00]));
        stage = "connect";
      }

      if (stage === "connect") {
        if (buffer.length < 5) return;
        const addressType = buffer[3];
        if (addressType !== 0x03) {
          socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const hostLength = buffer[4] ?? 0;
        if (buffer.length < 5 + hostLength + 2) return;
        const host = buffer.subarray(5, 5 + hostLength).toString("utf8");
        const port = buffer.readUInt16BE(5 + hostLength);
        buffer = buffer.subarray(5 + hostLength + 2);
        requested.push(`${host}:${port}`);

        const upstream = connect({ host, port }, () => {
          socket.write(
            Buffer.concat([
              Buffer.from([0x05, 0x00, 0x00, 0x01]),
              Buffer.from([127, 0, 0, 1]),
              Buffer.from([0x00, 0x00]),
            ]),
          );
          stage = "piping";
          if (buffer.length > 0) upstream.write(buffer);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on("error", () => socket.destroy());
      }
    });
    socket.on("error", () => undefined);
  });
  return { server, requested };
}

describe("SOCKS5 transport", () => {
  it("parses proxy URLs and refuses schemes it cannot honour", () => {
    expect(parseProxyUrl("socks5h://127.0.0.1:9050")).toEqual({
      host: "127.0.0.1",
      port: 9050,
    });
    expect(parseProxyUrl("socks5://proxy.local")).toEqual({
      host: "proxy.local",
      port: 1080,
    });
    expect(() => parseProxyUrl("http://127.0.0.1:8080")).toThrow("Only socks5");
  });

  it("sends relay requests through the proxy, resolving the host at the proxy", async () => {
    const seen: Array<{ method: string; url: string; body: string }> = [];
    const origin = createHttpServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          method: request.method ?? "",
          url: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    const originPort = await listen(origin);

    const socks = startSocksServer();
    const socksPort = await listen(socks.server);

    const proxied = createProxiedFetch({ host: "127.0.0.1", port: socksPort });
    const response = await proxied(
      `http://127.0.0.1:${originPort}/v1/capsules`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chunkCount: 1 }),
      },
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ok: true });
    // The hostname travelled to the proxy, not to the local resolver.
    expect(socks.requested).toEqual([`127.0.0.1:${originPort}`]);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe("/v1/capsules");
    expect(seen[0]?.body).toBe(JSON.stringify({ chunkCount: 1 }));
  });

  it("returns binary bodies unchanged so ciphertext survives the proxy", async () => {
    const ciphertext = Buffer.from([0, 1, 2, 250, 251, 255]);
    const origin = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(ciphertext);
    });
    const originPort = await listen(origin);
    const socks = startSocksServer();
    const socksPort = await listen(socks.server);

    const proxied = createProxiedFetch({ host: "127.0.0.1", port: socksPort });
    const response = await proxied(`http://127.0.0.1:${originPort}/chunk`);

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array(ciphertext),
    );
  });

  it("fails loudly when the proxy is not reachable", async () => {
    const proxied = createProxiedFetch({ host: "127.0.0.1", port: 1 });
    await expect(proxied("http://127.0.0.1:9/health")).rejects.toThrow();
  });
});
