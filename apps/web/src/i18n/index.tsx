import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { en, type MessageKey, type Messages } from "./en";
import { es } from "./es";
import { pt } from "./pt";

/**
 * Translation, without a dependency.
 *
 * A library would bring plural rules, contexts, lazy catalogues and a
 * loader — none of which this app has a use for, and all of which would run
 * inside the page that handles the decryption key. Three flat dictionaries and
 * a lookup are the whole requirement.
 *
 * The dictionaries are typed against English, so a key added there and missed
 * elsewhere fails the build rather than falling back at runtime in front of
 * somebody who cannot read the fallback.
 */

export const LOCALES = ["en", "es", "pt"] as const;
export type Locale = (typeof LOCALES)[number];

const CATALOGUES: Record<Locale, Messages> = { en, es, pt };
const STORAGE_KEY = "capsule.locale";

function isLocale(value: string | null): value is Locale {
  return value !== null && (LOCALES as readonly string[]).includes(value);
}

/**
 * The browser's preference, then English. Nothing is sent anywhere to work
 * this out and nothing about the choice leaves the device.
 */
export function detectLocale(
  languages: readonly string[] = navigator.languages ?? [navigator.language],
): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (isLocale(base ?? null)) return base as Locale;
  }
  return "en";
}

function readStored(): Locale | undefined {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isLocale(stored) ? stored : undefined;
  } catch {
    // Storage can be denied outright; a language preference is not worth
    // failing over.
    return undefined;
  }
}

export type Translate = (
  key: MessageKey,
  values?: Record<string, string | number>,
) => string;

interface I18n {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: Translate;
}

const I18nContext = createContext<I18n | null>(null);

/** Replaces `{name}` placeholders. Absent values are left as written. */
export function format(
  template: string,
  values?: Record<string, string | number>,
): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/gu, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(
    () => readStored() ?? detectLocale(),
  );

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = CATALOGUES[locale]["app.documentTitle"];
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice still applies for this visit.
    }
  }, []);

  const t = useCallback<Translate>(
    (key, values) => format(CATALOGUES[locale][key], values),
    [locale],
  );

  const value = useMemo<I18n>(
    () => ({ locale, setLocale, t }),
    [locale, setLocale, t],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside an I18nProvider");
  return value;
}

export function useT(): Translate {
  return useI18n().t;
}

export { CATALOGUES };
export type { MessageKey, Messages };
