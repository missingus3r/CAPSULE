import { Agent as HttpAgent, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

/**
 * SOCKS5 transport for the CLI.
 *
 * Encryption keeps the relay from reading a capsule; it does nothing about the
 * address the relay sees. Sending the traffic through a SOCKS5 proxy — Tor's
 * local port is the obvious one — moves that observation point away from the
 * user's own connection. Hostnames are always resolved by the proxy (the
 * behaviour usually written `socks5h`), so the local resolver never learns
 * which relay is being contacted and `.onion` addresses work unchanged.
 *
 * This is not anonymity by itself: the proxy still sees the connection, and a
 * relay still sees timing and volume.
 */

export interface ProxyTarget {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export function parseProxyUrl(value: string): ProxyTarget {
  const url = new URL(value);
  if (url.protocol !== "socks5:" && url.protocol !== "socks5h:") {
    throw new Error("Only socks5:// and socks5h:// proxies are supported");
  }
  const port = Number(url.port || 1080);
  if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("The proxy port is invalid");
  }
  return {
    host: url.hostname,
    port,
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
  };
}

class SocketReader {
  private buffer = Buffer.alloc(0);
  private waiting:
    { size: number; resolve: (value: Buffer) => void } | undefined = undefined;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
  }

  read(size: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.waiting) {
        reject(new Error("Concurrent SOCKS reads are not supported"));
        return;
      }
      this.waiting = { size, resolve };
      const onError = (error: Error) => reject(error);
      const onClose = () =>
        reject(new Error("The SOCKS proxy closed the connection"));
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
      this.flush();
    });
  }

  private flush(): void {
    const waiting = this.waiting;
    if (!waiting || this.buffer.length < waiting.size) return;
    this.waiting = undefined;
    const value = this.buffer.subarray(0, waiting.size);
    this.buffer = this.buffer.subarray(waiting.size);
    waiting.resolve(Buffer.from(value));
  }
}

async function socksHandshake(
  socket: Socket,
  proxy: ProxyTarget,
  host: string,
  port: number,
): Promise<void> {
  const reader = new SocketReader(socket);
  const authenticated = proxy.username !== undefined;
  socket.write(
    authenticated
      ? Buffer.from([0x05, 0x02, 0x00, 0x02])
      : Buffer.from([0x05, 0x01, 0x00]),
  );

  const greeting = await reader.read(2);
  if (greeting[0] !== 0x05) throw new Error("The proxy is not SOCKS5");
  if (greeting[1] === 0x02) {
    if (!authenticated) throw new Error("The proxy requires authentication");
    const user = Buffer.from(proxy.username ?? "", "utf8");
    const password = Buffer.from(proxy.password ?? "", "utf8");
    socket.write(
      Buffer.concat([
        Buffer.from([0x01, user.length]),
        user,
        Buffer.from([password.length]),
        password,
      ]),
    );
    const result = await reader.read(2);
    if (result[1] !== 0x00)
      throw new Error("The proxy rejected the credentials");
  } else if (greeting[1] !== 0x00) {
    throw new Error("The proxy rejected every supported authentication method");
  }

  const hostname = Buffer.from(host, "utf8");
  if (hostname.length > 255)
    throw new Error("The hostname is too long for SOCKS5");
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(
    Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, hostname.length]),
      hostname,
      portBytes,
    ]),
  );

  const reply = await reader.read(4);
  if (reply[1] !== 0x00) {
    throw new Error(`The proxy refused the connection (code ${reply[1]})`);
  }
  const addressType = reply[3];
  if (addressType === 0x01) await reader.read(4 + 2);
  else if (addressType === 0x04) await reader.read(16 + 2);
  else if (addressType === 0x03) {
    const length = await reader.read(1);
    await reader.read((length[0] ?? 0) + 2);
  } else {
    throw new Error("The proxy returned an unknown address type");
  }
  socket.removeAllListeners("data");
}

function connectThroughProxy(
  proxy: ProxyTarget,
  host: string,
  port: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: proxy.host, port: proxy.port });
    socket.setTimeout(30_000, () => {
      socket.destroy(new Error("The SOCKS proxy timed out"));
    });
    socket.once("error", reject);
    socket.once("connect", () => {
      socksHandshake(socket, proxy, host, port).then(
        () => {
          socket.setTimeout(0);
          socket.removeListener("error", reject);
          resolve(socket);
        },
        (error: unknown) => {
          socket.destroy();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  });
}

function agentsFor(proxy: ProxyTarget): {
  http: HttpAgent;
  https: HttpsAgent;
} {
  const http = new HttpAgent({ keepAlive: false });
  (http as unknown as { createConnection: unknown }).createConnection = (
    options: { host?: string; port?: number },
    callback: (error: Error | null, socket?: Socket) => void,
  ) => {
    connectThroughProxy(proxy, options.host ?? "", options.port ?? 80).then(
      (socket) => callback(null, socket),
      (error: Error) => callback(error),
    );
  };

  const https = new HttpsAgent({ keepAlive: false });
  (https as unknown as { createConnection: unknown }).createConnection = (
    options: { host?: string; port?: number; servername?: string },
    callback: (error: Error | null, socket?: Socket) => void,
  ) => {
    connectThroughProxy(proxy, options.host ?? "", options.port ?? 443).then(
      (socket) => {
        const secure = tlsConnect({
          socket,
          servername: options.servername ?? options.host,
          ALPNProtocols: ["http/1.1"],
        });
        secure.once("error", (error) => callback(error));
        secure.once("secureConnect", () => callback(null, secure));
      },
      (error: Error) => callback(error),
    );
  };

  return { http, https };
}

function bodyToBuffer(body: BodyInit | null | undefined): Buffer | undefined {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof ArrayBuffer) return Buffer.from(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }
  throw new Error("This body type cannot be sent through the proxy");
}

function headersToObject(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const plain: Record<string, string> = {};
    headers.forEach((value, name) => {
      plain[name] = value;
    });
    return plain;
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

/** A `fetch` implementation that routes every request through a SOCKS5 proxy. */
export function createProxiedFetch(
  proxy: ProxyTarget,
): (input: string, init?: RequestInit) => Promise<Response> {
  const agents = agentsFor(proxy);

  return (input, init = {}) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(input);
      const secure = url.protocol === "https:";
      const send = secure ? httpsRequest : httpRequest;
      const payload = bodyToBuffer(init.body);
      const headers = headersToObject(init.headers);
      if (payload) headers["content-length"] = String(payload.byteLength);

      const request = send(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (secure ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: init.method ?? "GET",
          headers,
          agent: secure ? agents.https : agents.http,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (typeof value === "string") responseHeaders.set(name, value);
              else if (Array.isArray(value)) {
                for (const entry of value) responseHeaders.append(name, entry);
              }
            }
            const status = response.statusCode ?? 502;
            const body =
              status === 204 || status === 304
                ? null
                : new Uint8Array(Buffer.concat(chunks));
            resolve(
              new Response(body, {
                status,
                statusText: response.statusMessage ?? "",
                headers: responseHeaders,
              }),
            );
          });
          response.on("error", reject);
        },
      );

      const signal = init.signal;
      if (signal) {
        if (signal.aborted) {
          request.destroy(new Error("The request was aborted"));
        } else {
          signal.addEventListener(
            "abort",
            () => request.destroy(new Error("The request was aborted")),
            { once: true },
          );
        }
      }

      request.on("error", reject);
      if (payload) request.write(payload);
      request.end();
    });
}
