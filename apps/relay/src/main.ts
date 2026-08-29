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
} catch (error) {
  app.log.error({ err: error }, "Unable to start CAPSULE relay");
  process.exitCode = 1;
  await app.close();
}
