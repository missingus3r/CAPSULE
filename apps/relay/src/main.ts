import { loadRelayConfig } from "./config.js";
import { buildRelayServer } from "./server.js";

const config = loadRelayConfig();
const app = await buildRelayServer(config, {
  logger: {
    level: process.env.CAPSULE_LOG_LEVEL?.trim() || "info",
    redact: ["req.headers.authorization"],
  },
});

let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "Shutting down CAPSULE relay");
  try {
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
