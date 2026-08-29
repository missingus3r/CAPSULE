import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * The page talks to relays, and which relays is not known at build time. In a
 * production build it may reach HTTPS origins only: a relay discovered through
 * gossip is never allowed to aim the page at the visitor's own machine. The
 * development server adds loopback, because that is where the local relay is.
 */
function contentSecurityPolicy() {
  return {
    name: "capsule-csp",
    transformIndexHtml(html: string, context: { server?: unknown }) {
      const local = context.server
        ? " http://localhost:* http://127.0.0.1:*"
        : "";
      return html.replace("__CONNECT_SRC__", `'self' https:${local}`);
    },
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    headers: {
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    headers: {
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    css: true,
  },
});
