import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { I18nProvider } from "./i18n";

/**
 * The app talks to a relay as soon as it mounts. These tests are about the
 * copy, so the relay is a stub: what matters is that every visible string
 * comes from a dictionary rather than from the source.
 */
function renderApp() {
  return render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  );
}

describe("App copy", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // A promise that never settles, so no relay answer lands after a test has
    // been torn down. What the relay says does not change the copy.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the send form in English by default", async () => {
    renderApp();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Send a file" }),
    ).toBeInTheDocument();
    expect(screen.getByText("What to send")).toBeInTheDocument();
    expect(screen.getByText("Encrypt and create link")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
  });

  it("switches the whole page to another language", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "Español" }));

    expect(
      screen.getByRole("heading", { level: 1, name: "Enviar un archivo" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Cifrar y crear enlace")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Português" }));

    expect(
      screen.getByRole("heading", { level: 1, name: "Enviar um arquivo" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Cifrar e criar link")).toBeInTheDocument();
  });

  it("says it is still looking before it says it failed", async () => {
    // The stubbed fetch never settles, so this is the state a real page is in
    // for the first moment. Telling somebody they are disconnected there would
    // be a lie that corrects itself a second later.
    renderApp();
    expect(await screen.findByText("Looking for a relay…")).toBeInTheDocument();
    expect(screen.queryByText("Not connected to any relay")).toBeNull();
  });

  it(
    "says plainly when no relay answered, and why it matters",
    { timeout: 20_000 },
    async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new Error("refused"))),
      );
      renderApp();

      // The SDK retries with backoff before giving up, so the failed state
      // arrives seconds after the first refusal rather than immediately.
      expect(
        await screen.findByText("Not connected to any relay", undefined, {
          timeout: 15_000,
        }),
      ).toBeInTheDocument();
      // The consequence, not just the state: somebody should not pick a file
      // first and find out afterwards.
      expect(
        screen.getByText(/Nothing can be sent or opened/u),
      ).toBeInTheDocument();
    },
  );

  it("offers mix routing, and says when no relay can carry it", async () => {
    renderApp();

    // The stubbed relay never answers, so the directory stays empty and there
    // is nothing to route through. The switch has to say that rather than let
    // somebody arm a protection that is not there.
    const toggle = await screen.findByRole("checkbox", {
      name: /Mix routing/,
    });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText(/No relay in reach forwards for others/),
    ).toBeInTheDocument();
  });

  it("keeps the copy the reader was asked to lose out of the page", () => {
    renderApp();
    const text = document.body.textContent ?? "";

    for (const gone of [
      "Compartí sin dejarlo para siempre",
      "Privado por diseño",
      "Un archivo. Un enlace.",
      "sin letra chica",
    ]) {
      expect(text).not.toContain(gone);
    }
  });
});
