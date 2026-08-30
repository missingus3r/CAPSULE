import { startLanBeacon, localAddresses } from "@capsule/lan";
import { loadRelayConfig } from "./config.js";
import { buildRelayServer } from "./server.js";

const config = loadRelayConfig();
const app = await buildRelayServer(config, {
  logger: {
    level: process.env.CAPSULE_LOG_LEVEL?.trim() || "info",
    redact: ["req.headers.authorization"],
  },
});

let beacon: { close(): void } | undefined;

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "Shutting down CAPSULE relay");
  try {
    beacon?.close();
    await app.close();
    process.exitCode = 0;
  } catch (error) {
    app.log.error({ err: error }, "Relay shutdown failed");
    process.exitCode = 1;
  }
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    {
      relayId: app.capsuleIdentity.relayId,
      publicUrl: config.publicUrl ?? null,
      peers: app.capsulePeers.size,
      persistentCapsules: config.allowPersistentCapsules,
    },
    config.publicUrl
      ? "CAPSULE relay is reachable and announcing itself to the network"
      : "CAPSULE relay started without CAPSULE_PUBLIC_URL: it can discover peers but cannot be announced to them",
  );
  if (config.lanBeacon) {
    const address = app.server.address();
    const port =
      typeof address === "object" && address ? address.port : config.port;
    const host = localAddresses()[0];
    if (host) {
      beacon = startLanBeacon({
        relayId: app.capsuleIdentity.relayId,
        url: `http://${host}:${port}`,
        software: "capsule-relay/1.2.0",
        sites: config.sitesEnabled,
        mix: config.mixEnabled,
      });
      app.log.info(
        { url: `http://${host}:${port}` },
        "Announcing this relay on the local network. Anyone on this network can see it.",
      );
    } else {
      app.log.warn(
        "CAPSULE_LAN is on but this machine has no local network address",
      );
    }
  }

  if (app.capsuleBridge) {
    const address = app.server.address();
    const port =
      typeof address === "object" && address ? address.port : config.port;
    const host =
      (process.env.CAPSULE_BRIDGE_HOST ?? "").trim() ||
      (config.publicUrl ? new URL(config.publicUrl).hostname : config.host);
    const tls = (config.publicUrl ?? "").startsWith("https://");
    // Printed rather than logged as structured data: it is meant to be copied
    // once by a person, not collected by anything.
    process.stdout.write(
      [
        "",
        "This relay is running as a bridge. It announces nothing and answers",
        "every other request like an ordinary web server.",
        "",
        `  ${app.capsuleBridge.line(host, port, tls)}`,
        "",
        "Give that line only to people you mean to give it to. Anyone who has",
        "it can use this bridge, and anyone who collects it can block it.",
        tls
          ? ""
          : "Warning: no HTTPS. Without TLS the traffic is recognisable on the wire and this hides nothing.\n",
      ].join("\n"),
    );
  }

  if (config.publicUrl && config.corsOrigins !== "*") {
    app.log.warn(
      { corsOrigins: config.corsOrigins },
      "This relay is public but only accepts browser requests from the listed origins. Web apps hosted elsewhere will be refused; set CAPSULE_CORS_ORIGIN=* to serve any of them (capabilities are bearer tokens, not cookies, so the relay holds no ambient authority to abuse).",
    );
  }
} catch (error) {
  app.log.error({ err: error }, "Unable to start CAPSULE relay");
  process.exitCode = 1;
  await app.close();
}
