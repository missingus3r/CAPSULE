import {
  CapsuleRelayClient,
  discoverRelays,
  downloadCapsule,
  selectRelays,
  uploadCapsule,
  type AnonymityReport,
  type MirrorFailure,
  type RelayInfo,
  type RelayPublicConfig,
} from "@capsule/sdk";
import {
  buildMixNetwork,
  type MixNetwork,
  type MixNetworkStrength,
} from "@capsule/mixnet";
import {
  DEFAULT_INDEX_SITE,
  defaultSeedOrigins,
  decodeShareCapability,
  encodeOwnerCapability,
  isPublicRelayOrigin,
  parseSiteName,
  wrapWithPassphrase,
} from "@capsule/protocol";
import QRCode from "qrcode";
import {
  ArrowDownToLine,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clock3,
  Copy,
  Download,
  EyeOff,
  FileCheck2,
  Infinity as InfinityIcon,
  KeyRound,
  Layers,
  Link2,
  Loader2,
  LockKeyhole,
  Globe,
  PackageOpen,
  Puzzle,
  RotateCcw,
  Search,
  Send,
  Server,
  Shuffle,
  TriangleAlert,
  Waypoints,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { discoverySeeds, rememberRelays } from "./lib/seeds";
import { DropZone } from "./components/DropZone";
import { PublishSite } from "./components/PublishSite";
import { ProgressState } from "./components/ProgressState";
import { CATALOGUES, LOCALES, useI18n, useT, type MessageKey } from "./i18n";
import {
  copyText,
  errorKey,
  extractCapability,
  formatBytes,
  formatDate,
  mimeTypeKey,
  normalizeMetadata,
  normalizeProgress,
  type DisplayMetadata,
} from "./lib/ui";

type Mode = "send" | "receive" | "publish";
type SendStage = "form" | "uploading" | "success" | "error";
type ReceiveStage = "empty" | "downloading" | "ready" | "error";

interface ExpiryOption {
  labelKey: MessageKey;
  shortKey: MessageKey;
  /** `null` asks the relay to keep the capsule until it is deleted. */
  seconds: number | null;
}

interface SharedCapsule {
  shareUrl: string;
  ownerCapability: string;
  metadata: DisplayMetadata;
  relayUrls: string[];
  mirrorFailures: MirrorFailure[];
  anonymity: AnonymityReport;
  sharding?: { k: number; n: number };
  qrDataUrl?: string;
}

interface ReceivedCapsule {
  metadata: DisplayMetadata;
  blob: Blob;
}

const EXPIRY_OPTIONS: ExpiryOption[] = [
  { labelKey: "expiry.hour", shortKey: "expiry.hour.short", seconds: 60 * 60 },
  {
    labelKey: "expiry.day",
    shortKey: "expiry.day.short",
    seconds: 24 * 60 * 60,
  },
  {
    labelKey: "expiry.week",
    shortKey: "expiry.week.short",
    seconds: 7 * 24 * 60 * 60,
  },
  { labelKey: "expiry.never", shortKey: "expiry.never.short", seconds: null },
];

/**
 * Where this app stores capsules when nobody configured anything.
 *
 * The genesis relay, so a fresh checkout works without also running one. A
 * relay of your own is better and `VITE_RELAY_URL` is how you say so: this one
 * sees the address, the timing and the size of everything sent through it,
 * which is exactly what running your own avoids.
 */
const DEFAULT_RELAY_URL = defaultSeedOrigins()[0] ?? "http://localhost:8787";

/**
 * Mix routing defaults, matching what the CLI uses without a flag.
 *
 * The delay is the whole point rather than a cost to tune away: a hop that
 * forwards immediately is a hop an observer can pair up by timing. Three hops
 * at two seconds each way is minutes, not milliseconds, and the interface says
 * so before the transfer starts.
 */
const MIX_HOPS = 3;
const MIX_MEAN_DELAY_MS = 2_000;

/**
 * Where the extension is explained and built. It is deliberately the project's
 * own install instructions rather than a store: the extension is loaded
 * unpacked, and pointing at a listing that does not exist would be a lie the
 * reader only discovers after clicking.
 */
const EXTENSION_INSTALL_URL =
  "https://github.com/missingus3r/CAPSULE#read-one-in-any-chromium-browser";

/**
 * The `.capsule` name of a directory of sites, when whoever deployed this app
 * runs one. Empty by default and hidden when empty: an index is somebody's
 * decision to operate, and a link to an address that resolves to nothing is
 * worse than no link.
 */
const CAPSULE_INDEX_NAME =
  import.meta.env.VITE_CAPSULE_INDEX?.trim() || DEFAULT_INDEX_SITE;

function getPublicAppUrl(): string {
  const configured = import.meta.env.VITE_PUBLIC_APP_URL?.trim();
  if (configured) return configured;
  const url = new URL(window.location.href);
  url.hash = "";
  url.search = "";
  return url.toString();
}

function Brand() {
  return (
    <div className="brand" aria-label="CAPSULE">
      <span className="brand-mark" aria-hidden="true">
        <span />
      </span>
      <span>CAPSULE</span>
    </div>
  );
}

/**
 * Renders a translated line carrying one placeholder that belongs in a
 * `<code>` element. Splitting it here keeps markup out of the dictionaries,
 * where a translator would have to copy tags around by hand.
 */
function WithCode({
  text,
  name,
  value,
}: {
  text: string;
  name: string;
  value: string;
}) {
  const [before = "", after = ""] = text.split(`{${name}}`);
  return (
    <>
      {before}
      <code>{value}</code>
      {after}
    </>
  );
}

/** Each language is offered in its own name, not translated into the current one. */
function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div
      className="language-switcher"
      role="group"
      aria-label={t("lang.switch")}
    >
      {LOCALES.map((option) => (
        <button
          key={option}
          type="button"
          lang={option}
          aria-pressed={option === locale}
          className={option === locale ? "active" : ""}
          aria-label={CATALOGUES[option]["lang.name"]}
          title={CATALOGUES[option]["lang.name"]}
          onClick={() => setLocale(option)}
        >
          {option.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

/**
 * Whether this browser can reach the network, said plainly.
 *
 * Somebody who cannot send a file needs to know that before they pick one, not
 * after the upload fails, and somebody reaching exactly one relay should know
 * that mixing has nothing to mix through. Three states rather than two: asking
 * is not the same as failing, and telling somebody they are disconnected while
 * the first request is still open would be a lie that fixes itself.
 */
function ConnectionStatus({
  reachable,
  relayCount,
  relayUrl,
}: {
  reachable: boolean | undefined;
  relayCount: number;
  relayUrl: string;
}) {
  const t = useT();
  const host = (() => {
    try {
      return new URL(relayUrl).host;
    } catch {
      return relayUrl;
    }
  })();

  if (reachable === undefined) {
    return (
      <div className="connection is-checking" role="status">
        <Loader2 size={16} className="spin" aria-hidden="true" />
        <span>
          <strong>{t("conn.checking")}</strong>
        </span>
      </div>
    );
  }

  if (!reachable) {
    return (
      <div className="connection is-offline" role="alert">
        <WifiOff size={16} aria-hidden="true" />
        <span>
          <strong>{t("conn.offline")}</strong>
          <small>{t("conn.offlineDetail", { host })}</small>
        </span>
      </div>
    );
  }

  const alone = relayCount <= 1;
  return (
    <div
      className={alone ? "connection is-alone" : "connection is-online"}
      role="status"
    >
      <Server size={16} aria-hidden="true" />
      <span>
        <strong>
          {alone ? t("conn.one") : t("conn.many", { count: relayCount })}
        </strong>
        <small>
          {alone ? t("conn.oneDetail", { host }) : t("conn.manyDetail")}
        </small>
      </span>
    </div>
  );
}

function NetworkPanel({
  relays,
  relayUrl,
}: {
  relays: RelayInfo[];
  relayUrl: string;
}) {
  const t = useT();
  const known = relays.length > 0 ? relays : null;
  return (
    <section className="network-panel" aria-labelledby="network-title">
      <div className="aside-eyebrow">{t("network.eyebrow")}</div>
      <h3 id="network-title">{t("network.title")}</h3>
      <p>
        <WithCode
          text={t("network.body")}
          name="host"
          value={new URL(relayUrl).host}
        />
      </p>
      {known ? (
        <ul className="relay-list">
          {known.map((relay) => (
            <li key={relay.relayId}>
              <strong>{relay.nickname ?? new URL(relay.url).host}</strong>
              <span>
                {relay.persistentCapsules
                  ? t("network.persistent")
                  : t("network.temporary")}{" "}
                · {t("network.peers", { count: relay.peerCount })}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="relay-empty">{t("network.empty")}</p>
      )}
    </section>
  );
}

function PrivacyAside({
  relays,
  relayUrl,
}: {
  relays: RelayInfo[];
  relayUrl: string;
}) {
  const t = useT();
  const steps = [1, 2, 3] as const;
  return (
    <aside className="privacy-aside" aria-labelledby="privacy-title">
      <div className="aside-eyebrow">{t("privacy.eyebrow")}</div>
      <h2 id="privacy-title">{t("privacy.title")}</h2>
      <div className="privacy-steps" aria-label={t("privacy.steps")}>
        {steps.map((step) => (
          <div key={step}>
            <span>{step}</span>
            <p>
              <strong>{t(`privacy.step${step}.title` as MessageKey)}</strong>
              {t(`privacy.step${step}.detail` as MessageKey)}
            </p>
          </div>
        ))}
      </div>
      <details>
        <summary>{t("privacy.details.summary")}</summary>
        <p>
          <WithCode
            text={t("privacy.details.body")}
            name="flag"
            value="--tor"
          />
        </p>
      </details>
      <NetworkPanel relays={relays} relayUrl={relayUrl} />
      <ExtensionPanel />
    </aside>
  );
}

/**
 * The other half of the network, which this page cannot reach on its own.
 *
 * A `.capsule` address resolves nowhere in DNS, so reading one needs the
 * extension. There is no store listing to link to — it is loaded unpacked from
 * a build you make yourself — and the link says that rather than implying a
 * one-click install that does not exist.
 */
function ExtensionPanel() {
  const t = useT();
  return (
    <section className="extension-panel" aria-labelledby="extension-title">
      <div className="aside-eyebrow">{t("extension.eyebrow")}</div>
      <h3 id="extension-title">{t("extension.title")}</h3>
      <p>{t("extension.body")}</p>
      <a
        className="extension-link"
        href={EXTENSION_INSTALL_URL}
        target="_blank"
        rel="noreferrer noopener"
      >
        <Puzzle size={15} aria-hidden="true" />
        {t("extension.cta")}
      </a>
      <small>{t("extension.note")}</small>
    </section>
  );
}

function MetadataCard({
  metadata,
  received = false,
}: {
  metadata: DisplayMetadata;
  received?: boolean;
}) {
  const { locale, t } = useI18n();
  const typeKey = mimeTypeKey(metadata.mimeType);
  return (
    <div className="metadata-card">
      <div className="metadata-file-icon" aria-hidden="true">
        {received ? <PackageOpen size={23} /> : <FileCheck2 size={23} />}
      </div>
      <div className="metadata-main">
        <strong title={metadata.filename}>{metadata.filename}</strong>
        <span>
          {formatBytes(metadata.byteLength, locale) || t("size.unknown")} ·{" "}
          {typeKey ? t(typeKey) : metadata.mimeType}
        </span>
      </div>
      {metadata.persistent ? (
        <div className="metadata-expiry">
          <InfinityIcon size={14} />
          <span>
            {t("metadata.noExpiry")}
            <strong>{t("metadata.noExpiryDetail")}</strong>
          </span>
        </div>
      ) : metadata.expiresAt ? (
        <div className="metadata-expiry">
          <Clock3 size={14} />
          <span>
            {t("metadata.expires")}
            <strong>{formatDate(metadata.expiresAt, locale)}</strong>
          </span>
        </div>
      ) : null}
      {metadata.note ? (
        <blockquote>
          <span>{t("metadata.note")}</span>
          {metadata.note}
        </blockquote>
      ) : null}
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState<Mode>("send");
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [ttlSeconds, setTtlSeconds] = useState<number | null>(
    EXPIRY_OPTIONS[1]!.seconds,
  );
  const [anonymous, setAnonymous] = useState(false);
  /**
   * On unless the sender turns it off.
   *
   * The protection worth defaulting to is the one that holds even in a small
   * network: the relay storing the capsule does not learn who sent it. That is
   * true with three nodes, and it is the guarantee somebody who never opens
   * this panel should still get. It costs minutes rather than seconds, which
   * the switch says out loud, and it turns itself off when no relay in reach
   * forwards for others.
   */
  const [mixEnabled, setMixEnabled] = useState(true);
  const [mirrorCount, setMirrorCount] = useState(0);
  const [splitAcrossRelays, setSplitAcrossRelays] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [recovery, setRecovery] = useState("");
  const [protecting, setProtecting] = useState(false);
  const [recoveryError, setRecoveryError] = useState<MessageKey | null>(null);
  const [relayConfig, setRelayConfig] = useState<RelayPublicConfig | null>(
    null,
  );
  /**
   * Whether the configured relay answered.
   *
   * Separate from `relayConfig` because that starts null and stays null on
   * failure, so it cannot tell "still asking" from "did not answer" — and
   * showing somebody "not connected" while the first request is in flight is
   * its own kind of wrong.
   */
  const [reachable, setReachable] = useState<boolean | undefined>(undefined);
  const [network, setNetwork] = useState<RelayInfo[]>([]);
  const [sendStage, setSendStage] = useState<SendStage>("form");
  const [sendProgress, setSendProgress] = useState(0);
  const [sendError, setSendError] = useState<MessageKey | null>(null);
  const [shared, setShared] = useState<SharedCapsule | null>(null);
  const [copied, setCopied] = useState<"share" | "owner" | "recovery" | null>(
    null,
  );

  const [receiveInput, setReceiveInput] = useState("");
  const [capability, setCapability] = useState<string | null>(null);
  const [receiveStage, setReceiveStage] = useState<ReceiveStage>("empty");
  const [receiveProgress, setReceiveProgress] = useState(0);
  const [receiveError, setReceiveError] = useState<MessageKey | null>(null);
  const [received, setReceived] = useState<ReceivedCapsule | null>(null);
  const activeDownload = useRef<string | null>(null);
  const { locale, t } = useI18n();

  const relayUrl = useMemo(
    () => import.meta.env.VITE_RELAY_URL?.trim() || DEFAULT_RELAY_URL,
    [],
  );

  // The relay tells the app what it accepts, and which other relays it knows.
  // Nothing here is hardcoded: point VITE_RELAY_URL at any relay and the app
  // adapts to that relay's limits and to the network reachable from it.
  useEffect(() => {
    let cancelled = false;
    new CapsuleRelayClient(relayUrl)
      .config()
      .then((config) => {
        if (cancelled) return;
        setRelayConfig(config);
        setReachable(true);
      })
      .catch(() => {
        if (cancelled) return;
        setRelayConfig(null);
        setReachable(false);
      });
    discoverRelays({
      // The configured relay first, then ones remembered from earlier visits,
      // then whatever seeds shipped. A pinned seed has to prove it holds the
      // identity it was pinned to before any of its answers count.
      seeds: discoverySeeds(relayUrl),
      maxRelays: 12,
      // A relay can put anything in its peer list. Following it into the
      // visitor's own network is only acceptable when this app is already
      // pointed at a local relay, which means a local setup.
      ...(isPublicRelayOrigin(relayUrl) ? {} : { allowPrivateRelays: true }),
    })
      .then((relays) => {
        if (cancelled) return;
        setNetwork(relays);
        rememberRelays(relays);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [relayUrl]);

  const persistentAllowed = relayConfig?.persistentCapsules ?? false;
  const mirrorCandidates = useMemo(
    () => network.filter((relay) => relay.url !== relayUrl),
    [network, relayUrl],
  );

  // Relays that will forward for others. A mix path needs several, and the
  // network is whatever the directory happens to hold right now.
  const mixCandidates = useMemo(
    () => network.filter((relay) => relay.mixPublicKey),
    [network],
  );

  /**
   * The mix network, rebuilt whenever the directory changes.
   *
   * Building it is arithmetic over the relay list, not a connection, so there
   * is nothing to tear down when it is replaced. `strength` is what the toggle
   * shows: a three-node network is not a secret to keep from the person
   * relying on it.
   */
  const mixNetwork = useMemo<MixNetwork | undefined>(() => {
    if (!mixEnabled || mixCandidates.length === 0) return undefined;
    try {
      return buildMixNetwork({
        relays: mixCandidates,
        pathLength: MIX_HOPS,
        meanDelayMs: MIX_MEAN_DELAY_MS,
        timeoutMs: Math.max(120_000, MIX_MEAN_DELAY_MS * MIX_HOPS * 8),
      });
    } catch {
      // Not enough usable relays to lay a path. The toggle says so rather
      // than the upload failing later.
      return undefined;
    }
  }, [mixCandidates, mixEnabled]);

  const mixStrength: MixNetworkStrength | undefined = mixNetwork?.strength;

  // Memoised because `beginDownload` depends on it and that callback is itself
  // an effect dependency: a fresh object every render would restart a download
  // that is already running.
  const mixTransport = useMemo(
    () => (mixNetwork ? { transport: mixNetwork.transportFor } : undefined),
    [mixNetwork],
  );

  useEffect(() => {
    if (ttlSeconds === null && relayConfig && !persistentAllowed) {
      setTtlSeconds(EXPIRY_OPTIONS[1]!.seconds);
    }
  }, [persistentAllowed, relayConfig, ttlSeconds]);

  const resetSend = () => {
    setFile(null);
    setNote("");
    setTtlSeconds(EXPIRY_OPTIONS[1]!.seconds);
    setAnonymous(false);
    setMixEnabled(true);
    setMirrorCount(0);
    setSplitAcrossRelays(false);
    setPassphrase("");
    setRecovery("");
    setRecoveryError(null);
    setSendStage("form");
    setSendProgress(0);
    setSendError(null);
    setShared(null);
    setCopied(null);
  };

  const selectMode = (nextMode: Mode) => {
    setMode(nextMode);
    if (nextMode === "receive" && capability) return;
    if (nextMode === "receive") setReceiveStage("empty");
  };

  const beginDownload = useCallback(
    async (nextCapability: string) => {
      activeDownload.current = nextCapability;
      setCapability(nextCapability);
      setReceiveStage("downloading");
      setReceiveProgress(0.02);
      setReceiveError(null);
      setReceived(null);

      try {
        const result = await downloadCapsule({
          capability: decodeShareCapability(nextCapability),
          ...(mixTransport ?? {}),
          onProgress: (progress: unknown) => {
            if (activeDownload.current === nextCapability) {
              setReceiveProgress(Math.max(0.02, normalizeProgress(progress)));
            }
          },
        });
        if (activeDownload.current !== nextCapability) return;
        setReceiveProgress(1);
        setReceived({
          metadata: normalizeMetadata(result.metadata, result.blob),
          blob: result.blob,
        });
        setReceiveStage("ready");
      } catch (error) {
        if (activeDownload.current !== nextCapability) return;
        setReceiveError(errorKey(error, "download"));
        setReceiveStage("error");
      }
    },
    [mixTransport],
  );

  useEffect(() => {
    const detectHash = () => {
      const detected = extractCapability(window.location.hash);
      if (!detected || activeDownload.current === detected) return;
      setMode("receive");
      setReceiveInput(window.location.href);
      void beginDownload(detected);
    };

    detectHash();
    window.addEventListener("hashchange", detectHash);
    return () => window.removeEventListener("hashchange", detectHash);
  }, [beginDownload]);

  const handleUpload = async () => {
    if (!file) return;
    setSendStage("uploading");
    setSendProgress(0.02);
    setSendError(null);
    setShared(null);

    try {
      const mirrorRelayUrls =
        mirrorCount > 0
          ? selectRelays(mirrorCandidates, {
              count: mirrorCount,
              ciphertextBytes: file.size + 1024 * 1024,
              chunkCount: Math.max(1, Math.ceil(file.size / (1024 * 1024))),
              persistent: ttlSeconds === null,
              ...(ttlSeconds !== null ? { ttlSeconds } : {}),
              exclude: [relayUrl],
            }).map((relay) => relay.url)
          : [];

      const result = await uploadCapsule({
        data: file,
        ...(mixTransport ?? {}),
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        ...(note.trim() ? { note: note.trim() } : {}),
        ttlSeconds,
        relayUrl,
        appUrl: getPublicAppUrl(),
        ...(mirrorRelayUrls.length > 0 ? { mirrorRelayUrls } : {}),
        ...(splitAcrossRelays && mirrorRelayUrls.length >= 2
          ? { replication: { mode: "shards" as const } }
          : {}),
        anonymity: anonymous
          ? {
              padding: true,
              scrubMetadata: true,
              hideFilename: true,
              jitterMs: 600,
            }
          : {},
        onProgress: (progress: unknown) =>
          setSendProgress(Math.max(0.02, normalizeProgress(progress))),
      });

      setSendProgress(1);
      let qrDataUrl: string | undefined;
      try {
        qrDataUrl = await QRCode.toDataURL(result.shareUrl, {
          width: 320,
          margin: 1,
          color: { dark: "#183f37", light: "#fffdf8" },
          errorCorrectionLevel: "M",
        });
      } catch {
        // Sharing the link still works if QR generation is unavailable.
      }
      setShared({
        shareUrl: result.shareUrl,
        ownerCapability: encodeOwnerCapability(result.ownerCapability),
        metadata: normalizeMetadata(result.metadata, file, file.name),
        relayUrls: result.relayUrls,
        mirrorFailures: result.mirrorFailures,
        anonymity: result.anonymity,
        ...(result.sharding
          ? { sharding: { k: result.sharding.k, n: result.sharding.n } }
          : {}),
        ...(qrDataUrl ? { qrDataUrl } : {}),
      });
      setSendStage("success");
    } catch (error) {
      setSendError(errorKey(error, "upload"));
      setSendStage("error");
    }
  };

  const handleCopy = async (kind: "share" | "owner" | "recovery") => {
    if (!shared) return;
    const value =
      kind === "share"
        ? shared.shareUrl
        : kind === "owner"
          ? shared.ownerCapability
          : recovery;
    if (!value) return;
    const ok = await copyText(value);
    setCopied(ok ? kind : null);
    if (ok) window.setTimeout(() => setCopied(null), 2200);
  };

  const handleProtect = async () => {
    if (!shared || passphrase.length < 8) return;
    setProtecting(true);
    setRecoveryError(null);
    try {
      // Deriving the key deliberately takes a moment: that cost is what a
      // guessing attacker pays for every attempt.
      const blob = await wrapWithPassphrase(
        shared.ownerCapability,
        passphrase,
        { label: shared.metadata.filename },
      );
      setRecovery(blob);
      setPassphrase("");
    } catch {
      setRecoveryError("error.protectFailed");
    } finally {
      setProtecting(false);
    }
  };

  /**
   * One field for both kinds of address somebody can be handed.
   *
   * A capsule link carries its key in the fragment and is opened here, on the
   * device. A `.capsule` name is a site, which this page cannot render at all
   * — it has to be handed to the extension, which is what navigating to the
   * address does. Asking which of the two it is would be asking somebody to
   * classify a string they were just given.
   */
  const handleReceiveSubmit = () => {
    const nextCapability = extractCapability(receiveInput);
    if (nextCapability) {
      setMode("receive");
      void beginDownload(nextCapability);
      return;
    }

    void parseSiteName(receiveInput.trim()).then((site) => {
      if (!site) {
        setReceiveError("error.badLink");
        setReceiveStage("error");
        return;
      }
      // A new tab, because leaving the page would lose a capsule that may be
      // open behind it, and because the address needs the extension: a
      // visitor without it should land on the failure in a tab of its own.
      window.open(`http://${site.name}/`, "_blank", "noreferrer");
    });
  };

  const saveReceivedFile = () => {
    if (!received) return;
    const url = URL.createObjectURL(received.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = received.metadata.filename;
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const clearReceived = () => {
    activeDownload.current = null;
    setCapability(null);
    setReceived(null);
    setReceiveInput("");
    setReceiveError(null);
    setReceiveProgress(0);
    setReceiveStage("empty");
    history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  };

  const isSending = sendStage === "uploading";

  return (
    <div className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="site-header">
        <Brand />
        <p>{t("app.tagline")}</p>
        <LanguageSwitcher />
      </header>

      <main className="workspace">
        <section className="main-panel" aria-labelledby="main-title">
          <div className="panel-intro">
            <h1 id="main-title">{t(`${mode}.title` as MessageKey)}</h1>
            <p>{t(`${mode}.sub` as MessageKey)}</p>
          </div>

          <ConnectionStatus
            reachable={reachable}
            relayCount={network.length}
            relayUrl={relayUrl}
          />

          <div
            className="mode-tabs"
            role="tablist"
            aria-label={t("mode.choose")}
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "send"}
              className={mode === "send" ? "active" : ""}
              onClick={() => selectMode("send")}
            >
              <Send size={17} />
              {t("mode.send")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "receive"}
              className={mode === "receive" ? "active" : ""}
              onClick={() => selectMode("receive")}
            >
              <ArrowDownToLine size={17} />
              {t("mode.receive")}
              {capability ? (
                <span
                  className="tab-dot"
                  aria-label={t("mode.capsuleDetected")}
                />
              ) : null}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "publish"}
              className={mode === "publish" ? "active" : ""}
              onClick={() => selectMode("publish")}
            >
              <Globe size={17} />
              {t("mode.publish")}
            </button>
            {CAPSULE_INDEX_NAME ? (
              // Not a tab: it leaves this app for an address only the
              // extension can open, and the title says so before the click.
              <a
                className="mode-link"
                href={`http://${CAPSULE_INDEX_NAME}/`}
                title={t("mode.searchNeedsExtension")}
                target="_blank"
                rel="noreferrer noopener"
              >
                <Search size={17} aria-hidden="true" />
                {t("mode.search")}
                <span className="mode-link-note">
                  {t("mode.searchNeedsExtensionShort")}
                </span>
              </a>
            ) : null}
          </div>

          {mode === "publish" ? (
            <PublishSite
              relayUrl={relayUrl}
              ttlSeconds={ttlSeconds}
              {...(mixTransport?.transport
                ? { transport: mixTransport.transport }
                : {})}
            />
          ) : null}

          {mode === "send" ? (
            <div className="flow" role="tabpanel">
              {sendStage === "success" && shared ? (
                <div className="success-view">
                  <div className="success-heading">
                    <span className="success-icon" aria-hidden="true">
                      <CheckCircle2 size={29} />
                    </span>
                    <div>
                      <span>{t("success.eyebrow")}</span>
                      <h2>{t("success.title")}</h2>
                    </div>
                  </div>

                  <MetadataCard metadata={shared.metadata} />

                  <ul className="delivery-summary">
                    <li>
                      <Server size={14} aria-hidden="true" />
                      {t(
                        shared.relayUrls.length === 1
                          ? "summary.storedOn"
                          : "summary.storedOn.plural",
                        {
                          count: shared.relayUrls.length,
                          hosts: shared.relayUrls
                            .map((url) => new URL(url).host)
                            .join(", "),
                        },
                      )}
                    </li>
                    {shared.anonymity.padded ? (
                      <li>
                        <EyeOff size={14} aria-hidden="true" />
                        {t("summary.padded", {
                          bytes: formatBytes(
                            shared.anonymity.paddingBytes,
                            locale,
                          ),
                        })}
                      </li>
                    ) : null}
                    {shared.anonymity.removedMetadata.length > 0 ? (
                      <li>
                        <EyeOff size={14} aria-hidden="true" />
                        {t("summary.scrubbed", {
                          items: shared.anonymity.removedMetadata.join(", "),
                        })}
                      </li>
                    ) : null}
                    {anonymous && !shared.anonymity.metadataScrubbed ? (
                      <li>
                        <TriangleAlert size={14} aria-hidden="true" />
                        {t("summary.notScrubbed")}
                      </li>
                    ) : null}
                    {shared.sharding ? (
                      <li>
                        <Shuffle size={14} aria-hidden="true" />
                        {t("summary.sharded", {
                          k: shared.sharding.k,
                          n: shared.sharding.n,
                        })}
                      </li>
                    ) : null}
                    {shared.anonymity.remainingMetadata.map((entry) => (
                      <li key={entry}>
                        <TriangleAlert size={14} aria-hidden="true" />
                        {t("summary.remaining", { item: entry })}
                      </li>
                    ))}
                    {shared.mirrorFailures.map((failure) => (
                      <li key={failure.relayUrl}>
                        <TriangleAlert size={14} aria-hidden="true" />
                        {t("summary.mirrorFailed", {
                          host: new URL(failure.relayUrl).host,
                        })}
                      </li>
                    ))}
                  </ul>

                  <div className="share-layout">
                    <div className="share-link-block">
                      <label htmlFor="share-url">{t("share.label")}</label>
                      <div className="share-field">
                        <Link2 size={18} aria-hidden="true" />
                        <input
                          id="share-url"
                          readOnly
                          value={shared.shareUrl}
                          onFocus={(event) => event.target.select()}
                        />
                        <button
                          type="button"
                          onClick={() => void handleCopy("share")}
                          className={copied === "share" ? "copied" : ""}
                        >
                          {copied === "share" ? (
                            <Check size={17} />
                          ) : (
                            <Copy size={17} />
                          )}
                          {copied === "share"
                            ? t("share.copied")
                            : t("share.copy")}
                        </button>
                      </div>
                      <p>{t("share.containsKey")}</p>
                    </div>
                    {shared.qrDataUrl ? (
                      <div className="qr-card">
                        <img src={shared.qrDataUrl} alt={t("share.qrAlt")} />
                        <span>{t("share.qrScan")}</span>
                      </div>
                    ) : null}
                  </div>

                  <div className="owner-key-block">
                    <div>
                      <KeyRound size={17} aria-hidden="true" />
                      <p>
                        <strong>{t("owner.title")}</strong>
                        {t("owner.detail")}
                      </p>
                    </div>
                    <div className="share-field">
                      <KeyRound size={18} aria-hidden="true" />
                      <input
                        aria-label={t("owner.inputLabel")}
                        readOnly
                        value={shared.ownerCapability}
                        onFocus={(event) => event.target.select()}
                      />
                      <button
                        type="button"
                        onClick={() => void handleCopy("owner")}
                        className={copied === "owner" ? "copied" : ""}
                      >
                        {copied === "owner" ? (
                          <Check size={17} />
                        ) : (
                          <Copy size={17} />
                        )}
                        {copied === "owner"
                          ? t("share.copied")
                          : t("share.copy")}
                      </button>
                    </div>
                    <small>{t("owner.warning")}</small>

                    <div className="recovery-block">
                      <strong>{t("recovery.title")}</strong>
                      <small>{t("recovery.detail")}</small>
                      {recovery ? (
                        <div className="share-field">
                          <KeyRound size={18} aria-hidden="true" />
                          <input
                            aria-label={t("recovery.label")}
                            readOnly
                            value={recovery}
                            onFocus={(event) => event.target.select()}
                          />
                          <button
                            type="button"
                            onClick={() => void handleCopy("recovery")}
                            className={copied === "recovery" ? "copied" : ""}
                          >
                            {copied === "recovery" ? (
                              <Check size={17} />
                            ) : (
                              <Copy size={17} />
                            )}
                            {copied === "recovery"
                              ? t("share.copied")
                              : t("share.copy")}
                          </button>
                        </div>
                      ) : (
                        <div className="recovery-form">
                          <input
                            type="password"
                            autoComplete="new-password"
                            placeholder={t("recovery.placeholder")}
                            value={passphrase}
                            disabled={protecting}
                            onChange={(event) => {
                              setPassphrase(event.target.value);
                              setRecoveryError(null);
                            }}
                          />
                          <button
                            type="button"
                            disabled={protecting || passphrase.length < 8}
                            onClick={() => void handleProtect()}
                          >
                            {protecting
                              ? t("recovery.protecting")
                              : t("recovery.protect")}
                          </button>
                        </div>
                      )}
                      {recoveryError ? (
                        <span className="recovery-error" role="alert">
                          {t(recoveryError)}
                        </span>
                      ) : null}
                      {!recovery &&
                      passphrase.length > 0 &&
                      passphrase.length < 8 ? (
                        <span className="recovery-error">
                          {t("error.passphraseShort")}
                        </span>
                      ) : null}
                    </div>
                  </div>

                  <button
                    className="secondary-action"
                    type="button"
                    onClick={resetSend}
                  >
                    <RotateCcw size={17} />
                    {t("action.createAnother")}
                  </button>
                </div>
              ) : (
                <>
                  <div className="field-group">
                    <div className="field-label">
                      <span>1</span>
                      <div>
                        <label htmlFor="capsule-file">
                          {t("send.step1.label")}
                        </label>
                        <small>{t("send.step1.hint")}</small>
                      </div>
                    </div>
                    <DropZone
                      file={file}
                      disabled={isSending}
                      onFile={setFile}
                    />
                  </div>

                  <div className="form-grid">
                    <div className="field-group">
                      <div className="field-label">
                        <span>2</span>
                        <div>
                          <label>{t("send.step2.label")}</label>
                        </div>
                      </div>
                      <div
                        className="expiry-options"
                        role="radiogroup"
                        aria-label={t("expiry.group")}
                      >
                        {EXPIRY_OPTIONS.map((option) => {
                          const unavailable =
                            option.seconds === null && !persistentAllowed;
                          return (
                            <button
                              key={option.seconds ?? "persistent"}
                              type="button"
                              role="radio"
                              aria-checked={ttlSeconds === option.seconds}
                              className={
                                ttlSeconds === option.seconds ? "selected" : ""
                              }
                              disabled={isSending || unavailable}
                              title={
                                unavailable
                                  ? t("expiry.unavailable")
                                  : t(option.labelKey)
                              }
                              onClick={() => setTtlSeconds(option.seconds)}
                            >
                              <span>{t(option.shortKey)}</span>
                              {unavailable ? (
                                <small>{t("expiry.unavailable")}</small>
                              ) : null}
                              {ttlSeconds === option.seconds ? (
                                <Check size={15} aria-hidden="true" />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                      {ttlSeconds === null ? (
                        <p className="inline-warning">
                          <InfinityIcon size={14} aria-hidden="true" />
                          {t("expiry.neverWarning")}
                        </p>
                      ) : null}
                    </div>

                    <div className="field-group">
                      <div className="field-label">
                        <span>3</span>
                        <div>
                          <label htmlFor="capsule-note">
                            {t("send.step3.label")}
                          </label>
                          <small>{t("send.step3.hint")}</small>
                        </div>
                      </div>
                      <div className="note-field">
                        <textarea
                          id="capsule-note"
                          maxLength={280}
                          rows={3}
                          value={note}
                          disabled={isSending}
                          placeholder={t("send.step3.placeholder")}
                          onChange={(event) => setNote(event.target.value)}
                        />
                        <span>{note.length}/280</span>
                      </div>
                    </div>
                  </div>

                  <div className="field-group">
                    <div className="field-label">
                      <span>4</span>
                      <div>
                        <label>{t("send.step4.label")}</label>
                        <small>{t("send.step4.hint")}</small>
                      </div>
                    </div>
                    <div className="option-stack">
                      <label className="switch-row">
                        <input
                          type="checkbox"
                          checked={anonymous}
                          disabled={isSending}
                          onChange={(event) =>
                            setAnonymous(event.target.checked)
                          }
                        />
                        <span className="switch-copy">
                          <strong>
                            <EyeOff size={15} aria-hidden="true" />
                            {t("anon.title")}
                          </strong>
                          <small>{t("anon.detail")}</small>
                        </span>
                      </label>

                      <label
                        className={
                          mixCandidates.length === 0
                            ? "switch-row is-unavailable"
                            : "switch-row"
                        }
                      >
                        <input
                          type="checkbox"
                          checked={mixEnabled}
                          disabled={isSending || mixCandidates.length === 0}
                          onChange={(event) =>
                            setMixEnabled(event.target.checked)
                          }
                        />
                        <span className="switch-copy">
                          <strong>
                            <Waypoints size={15} aria-hidden="true" />
                            {t("mix.title")}
                          </strong>
                          <small>
                            {mixCandidates.length === 0
                              ? t("mix.unavailable")
                              : t("mix.detail")}
                          </small>
                          {/* What the network can actually offer, not what
                              the feature is called. A small network is not a
                              secret to keep from whoever is relying on it. */}
                          {mixStrength ? (
                            <small className="mix-strength">
                              {t(`mix.verdict.${mixStrength.verdict}`, {
                                mixes: mixStrength.mixCount,
                                operators: mixStrength.operatorCount,
                                hops: mixStrength.pathLength,
                              })}
                            </small>
                          ) : null}
                        </span>
                      </label>

                      {mirrorCandidates.length > 0 ? (
                        <div className="switch-row as-static">
                          <Layers size={15} aria-hidden="true" />
                          <span className="switch-copy">
                            <strong>{t("mirror.title")}</strong>
                            <small>{t("mirror.detail")}</small>
                            <span
                              className="mirror-options"
                              role="radiogroup"
                              aria-label={t("mirror.count")}
                            >
                              {[
                                0,
                                ...Array.from(
                                  {
                                    length: Math.min(
                                      3,
                                      mirrorCandidates.length,
                                    ),
                                  },
                                  (_unused, index) => index + 1,
                                ),
                              ].map((count) => (
                                <button
                                  key={count}
                                  type="button"
                                  role="radio"
                                  aria-checked={mirrorCount === count}
                                  className={
                                    mirrorCount === count ? "selected" : ""
                                  }
                                  disabled={isSending}
                                  onClick={() => setMirrorCount(count)}
                                >
                                  {count === 0 ? t("mirror.one") : `+${count}`}
                                </button>
                              ))}
                            </span>
                            {mirrorCount >= 2 ? (
                              <label className="nested-switch">
                                <input
                                  type="checkbox"
                                  checked={splitAcrossRelays}
                                  disabled={isSending}
                                  onChange={(event) =>
                                    setSplitAcrossRelays(event.target.checked)
                                  }
                                />
                                <span>
                                  <Shuffle size={13} aria-hidden="true" />
                                  {t("mirror.split")}
                                </span>
                              </label>
                            ) : null}
                          </span>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {sendStage === "uploading" ? (
                    <ProgressState
                      progress={sendProgress}
                      title={
                        sendProgress < 0.18
                          ? t("progress.encrypting")
                          : t("progress.uploading")
                      }
                      detail={t("progress.keepOpen")}
                    />
                  ) : null}

                  {sendStage === "error" ? (
                    <div className="error-banner" role="alert">
                      <TriangleAlert size={19} />
                      <div>
                        <strong>{t("sendError.title")}</strong>
                        <span>{sendError ? t(sendError) : null}</span>
                      </div>
                    </div>
                  ) : null}

                  <button
                    className="primary-action"
                    type="button"
                    disabled={!file || isSending}
                    onClick={handleUpload}
                  >
                    {isSending ? (
                      t("action.preparing")
                    ) : (
                      <>
                        <LockKeyhole size={18} />
                        {t("action.encrypt")}
                        <Send size={17} />
                      </>
                    )}
                  </button>
                  <p className="action-note">{t("action.originalUntouched")}</p>
                </>
              )}
            </div>
          ) : mode === "receive" ? (
            <div className="flow receive-flow" role="tabpanel">
              {receiveStage === "downloading" ? (
                <div className="receive-state centered-state">
                  <span className="large-state-icon" aria-hidden="true">
                    <PackageOpen size={31} />
                  </span>
                  <h2>{t("receive.opening")}</h2>
                  <p>{t("receive.openingDetail")}</p>
                  <ProgressState
                    progress={receiveProgress}
                    title={
                      receiveProgress < 0.82
                        ? t("receive.downloading")
                        : t("receive.verifying")
                    }
                    detail={t("receive.keyNotSent")}
                  />
                </div>
              ) : receiveStage === "ready" && received ? (
                <div className="receive-state ready-state">
                  <div className="success-heading">
                    <span className="success-icon" aria-hidden="true">
                      <CheckCircle2 size={29} />
                    </span>
                    <div>
                      <span>{t("receive.readyEyebrow")}</span>
                      <h2>{t("receive.readyTitle")}</h2>
                    </div>
                  </div>
                  <MetadataCard metadata={received.metadata} received />
                  <button
                    className="primary-action"
                    type="button"
                    onClick={saveReceivedFile}
                  >
                    <Download size={19} />
                    {t("receive.save", {
                      filename: received.metadata.filename,
                    })}
                  </button>
                  <button
                    className="text-action"
                    type="button"
                    onClick={clearReceived}
                  >
                    <ArrowLeft size={16} />
                    {t("receive.close")}
                  </button>
                </div>
              ) : (
                <div className="receive-state receive-empty">
                  <span className="receive-illustration" aria-hidden="true">
                    <PackageOpen size={33} />
                    <span>
                      <KeyRound size={15} />
                    </span>
                  </span>
                  <h2>
                    {receiveStage === "error"
                      ? t("receive.errorTitle")
                      : t("receive.emptyTitle")}
                  </h2>
                  <p>{t("receive.emptyDetail")}</p>
                  <div className="receive-input">
                    <label htmlFor="receive-link">
                      {t("receive.linkLabel")}
                    </label>
                    <div>
                      <Link2 size={18} aria-hidden="true" />
                      <input
                        id="receive-link"
                        type="text"
                        value={receiveInput}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="https://…/#capsule=…  ·  ….capsule"
                        onChange={(event) =>
                          setReceiveInput(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") handleReceiveSubmit();
                        }}
                      />
                    </div>
                  </div>
                  {receiveStage === "error" ? (
                    <div className="error-banner compact" role="alert">
                      <TriangleAlert size={18} />
                      <span>{receiveError ? t(receiveError) : null}</span>
                    </div>
                  ) : null}
                  <button
                    className="primary-action"
                    type="button"
                    disabled={!receiveInput.trim()}
                    onClick={handleReceiveSubmit}
                  >
                    <PackageOpen size={19} />
                    {t("receive.open")}
                  </button>
                  <div className="hash-explainer">
                    <KeyRound size={16} />
                    <p>
                      <WithCode
                        text={t("receive.hashExplainer")}
                        name="fragment"
                        value="#capsule="
                      />
                    </p>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </section>

        <PrivacyAside relays={network} relayUrl={relayUrl} />
      </main>

      <footer>
        <Brand />
        <span>{t("footer.noTracking")}</span>
      </footer>
    </div>
  );
}
