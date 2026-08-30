import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import {
  CATALOGUES,
  I18nProvider,
  LOCALES,
  detectLocale,
  format,
  useI18n,
  type MessageKey,
} from ".";
import { en } from "./en";

function Probe() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="line">{t("action.encrypt")}</span>
      <button type="button" onClick={() => setLocale("pt")}>
        pt
      </button>
    </div>
  );
}

describe("translation", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("carries every English key in every language, with something in it", () => {
    const keys = Object.keys(en);
    for (const locale of LOCALES) {
      const catalogue = CATALOGUES[locale] as Record<string, string>;
      expect(Object.keys(catalogue).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        expect(catalogue[key]?.trim()).toBeTruthy();
      }
    }
  });

  it("keeps the placeholders a line promises", () => {
    const placeholders = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
    for (const locale of LOCALES) {
      for (const [key, text] of Object.entries(en) as [MessageKey, string][]) {
        expect({
          locale,
          key,
          at: placeholders(CATALOGUES[locale][key]),
        }).toEqual({ locale, key, at: placeholders(text) });
      }
    }
  });

  it("fills placeholders and leaves unknown ones alone", () => {
    expect(format("Stored on {count} relays", { count: 3 })).toBe(
      "Stored on 3 relays",
    );
    expect(format("Stored on {count} relays")).toBe("Stored on {count} relays");
  });

  it("reads the browser's preference, then falls back to English", () => {
    expect(detectLocale(["pt-BR", "en"])).toBe("pt");
    expect(detectLocale(["es-UY"])).toBe("es");
    expect(detectLocale(["de-DE", "fr"])).toBe("en");
    expect(detectLocale([])).toBe("en");
  });

  it("remembers a change of language without asking a server", async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );

    expect(screen.getByTestId("line")).toHaveTextContent(
      "Encrypt and create link",
    );
    await user.click(screen.getByRole("button", { name: "pt" }));

    expect(screen.getByTestId("locale")).toHaveTextContent("pt");
    expect(screen.getByTestId("line")).toHaveTextContent("Cifrar e criar link");
    expect(window.localStorage.getItem("capsule.locale")).toBe("pt");
    expect(document.documentElement.lang).toBe("pt");
  });
});
