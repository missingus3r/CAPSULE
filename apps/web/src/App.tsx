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
  decodeShareCapability,
  encodeOwnerCapability,
  isPublicRelayOrigin,
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
  LockKeyhole,
  PackageOpen,
  RotateCcw,
  Send,
  Server,
  ShieldCheck,
  Shuffle,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DropZone } from "./components/DropZone";
import { ProgressState } from "./components/ProgressState";
import {
  copyText,
  extractCapability,
  formatBytes,
  formatDate,
  formatMimeType,
  friendlyError,
  normalizeMetadata,
  normalizeProgress,
  type DisplayMetadata,
} from "./lib/ui";

type Mode = "send" | "receive";
type SendStage = "form" | "uploading" | "success" | "error";
type ReceiveStage = "empty" | "downloading" | "ready" | "error";

interface ExpiryOption {
  label: string;
  shortLabel: string;
  detail: string;
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
  {
    label: "Una hora",
    shortLabel: "1 h",
    detail: "Para pasar algo ahora",
    seconds: 60 * 60,
  },
  {
    label: "Un día",
    shortLabel: "24 h",
    detail: "La opción más práctica",
    seconds: 24 * 60 * 60,
  },
  {
    label: "Siete días",
    shortLabel: "7 días",
    detail: "Para dar más tiempo",
    seconds: 7 * 24 * 60 * 60,
  },
  {
    label: "Sin vencimiento",
    shortLabel: "Sin límite",
    detail: "Queda hasta que la borres",
    seconds: null,
  },
];

const DEFAULT_RELAY_URL = "http://localhost:8787";

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

function NetworkPanel({
  relays,
  relayUrl,
}: {
  relays: RelayInfo[];
  relayUrl: string;
}) {
  const known = relays.length > 0 ? relays : null;
  return (
    <section className="network-panel" aria-labelledby="network-title">
      <div className="aside-eyebrow">
        <Server size={16} />
        La red
      </div>
      <h3 id="network-title">Cualquiera puede levantar un relay</h3>
      <p>
        No hay registro ni permiso: se levanta un relay, se lo apunta a otro que
        ya conozcas y ambos se presentan. Esta app usa{" "}
        <code>{new URL(relayUrl).host}</code> y descubre el resto desde ahí.
      </p>
      {known ? (
        <ul className="relay-list">
          {known.map((relay) => (
            <li key={relay.relayId}>
              <strong>{relay.nickname ?? new URL(relay.url).host}</strong>
              <span>
                {relay.persistentCapsules ? "sin vencimiento" : "sólo temporal"}{" "}
                · {relay.peerCount} vecinos
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="relay-empty">
          Todavía no respondió ningún relay de la red.
        </p>
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
  return (
    <aside className="privacy-aside" aria-labelledby="privacy-title">
      <div className="aside-eyebrow">
        <ShieldCheck size={16} />
        Privacidad, sin letra chica
      </div>
      <h2 id="privacy-title">
        El archivo sale cerrado. La llave viaja en el enlace.
      </h2>
      <div className="privacy-steps" aria-label="Cómo funciona">
        <div>
          <span>1</span>
          <p>
            <strong>Se cifra acá</strong>
            Antes de subir, dentro de tu dispositivo.
          </p>
        </div>
        <div>
          <span>2</span>
          <p>
            <strong>El relay guarda ruido</strong>
            Recibe datos cifrados, no el archivo abierto.
          </p>
        </div>
        <div>
          <span>3</span>
          <p>
            <strong>El enlace abre</strong>
            Cualquiera que lo tenga puede descargar y descifrar.
          </p>
        </div>
      </div>
      <details>
        <summary>Lo que todavía puede verse</summary>
        <p>
          El relay puede observar tu IP, el momento y el tamaño de la
          transferencia. El modo anónimo borra metadatos del archivo, oculta el
          nombre y rellena el tamaño hasta una categoría, pero no oculta tu IP:
          para eso hace falta un proxy o Tor, disponible hoy en la CLI con{" "}
          <code>--tor</code>. El cifrado no protege un dispositivo infectado ni
          evita que quien recibe guarde una copia.
        </p>
      </details>
      <NetworkPanel relays={relays} relayUrl={relayUrl} />
    </aside>
  );
}

function MetadataCard({
  metadata,
  received = false,
}: {
  metadata: DisplayMetadata;
  received?: boolean;
}) {
  return (
    <div className="metadata-card">
      <div className="metadata-file-icon" aria-hidden="true">
        {received ? <PackageOpen size={23} /> : <FileCheck2 size={23} />}
      </div>
      <div className="metadata-main">
        <strong title={metadata.filename}>{metadata.filename}</strong>
        <span>
          {formatBytes(metadata.byteLength)} ·{" "}
          {formatMimeType(metadata.mimeType)}
        </span>
      </div>
      {metadata.persistent ? (
        <div className="metadata-expiry">
          <InfinityIcon size={14} />
          <span>
            Sin vencimiento
            <strong>Se borra sólo con tu clave de retiro</strong>
          </span>
        </div>
      ) : metadata.expiresAt ? (
        <div className="metadata-expiry">
          <Clock3 size={14} />
          <span>
            Vence
            <strong>{formatDate(metadata.expiresAt)}</strong>
          </span>
        </div>
      ) : null}
      {metadata.note ? (
        <blockquote>
          <span>Nota</span>
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
  const [mirrorCount, setMirrorCount] = useState(0);
  const [splitAcrossRelays, setSplitAcrossRelays] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [recovery, setRecovery] = useState("");
  const [protecting, setProtecting] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [relayConfig, setRelayConfig] = useState<RelayPublicConfig | null>(
    null,
  );
  const [network, setNetwork] = useState<RelayInfo[]>([]);
  const [sendStage, setSendStage] = useState<SendStage>("form");
  const [sendProgress, setSendProgress] = useState(0);
  const [sendError, setSendError] = useState("");
  const [shared, setShared] = useState<SharedCapsule | null>(null);
  const [copied, setCopied] = useState<"share" | "owner" | "recovery" | null>(
    null,
  );

  const [receiveInput, setReceiveInput] = useState("");
  const [capability, setCapability] = useState<string | null>(null);
  const [receiveStage, setReceiveStage] = useState<ReceiveStage>("empty");
  const [receiveProgress, setReceiveProgress] = useState(0);
  const [receiveError, setReceiveError] = useState("");
  const [received, setReceived] = useState<ReceivedCapsule | null>(null);
  const activeDownload = useRef<string | null>(null);

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
        if (!cancelled) setRelayConfig(config);
      })
      .catch(() => {
        if (!cancelled) setRelayConfig(null);
      });
    discoverRelays({
      seeds: [relayUrl],
      maxRelays: 12,
      // A relay can put anything in its peer list. Following it into the
      // visitor's own network is only acceptable when this app is already
      // pointed at a local relay, which means a local setup.
      ...(isPublicRelayOrigin(relayUrl) ? {} : { allowPrivateRelays: true }),
    })
      .then((relays) => {
        if (!cancelled) setNetwork(relays);
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
    setMirrorCount(0);
    setSplitAcrossRelays(false);
    setPassphrase("");
    setRecovery("");
    setRecoveryError("");
    setSendStage("form");
    setSendProgress(0);
    setSendError("");
    setShared(null);
    setCopied(null);
  };

  const selectMode = (nextMode: Mode) => {
    setMode(nextMode);
    if (nextMode === "receive" && capability) return;
    if (nextMode === "receive") setReceiveStage("empty");
  };

  const beginDownload = useCallback(async (nextCapability: string) => {
    activeDownload.current = nextCapability;
    setCapability(nextCapability);
    setReceiveStage("downloading");
    setReceiveProgress(0.02);
    setReceiveError("");
    setReceived(null);

    try {
      const result = await downloadCapsule({
        capability: decodeShareCapability(nextCapability),
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
      setReceiveError(friendlyError(error, "download"));
      setReceiveStage("error");
    }
  }, []);

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
    setSendError("");
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
      setSendError(friendlyError(error, "upload"));
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
    setRecoveryError("");
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
    } catch (error) {
      setRecoveryError(
        error instanceof Error
          ? error.message
          : "No pudimos proteger la clave.",
      );
    } finally {
      setProtecting(false);
    }
  };

  const handleReceiveSubmit = () => {
    const nextCapability = extractCapability(receiveInput);
    if (!nextCapability) {
      setReceiveError(
        "Pegá un enlace CAPSULE completo. La parte que empieza con #capsule= contiene la llave.",
      );
      setReceiveStage("error");
      return;
    }
    setMode("receive");
    void beginDownload(nextCapability);
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
    setReceiveError("");
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
        <p>
          <LockKeyhole size={14} />
          Sin cuenta. Cifrado en tu dispositivo.
        </p>
      </header>

      <main className="workspace">
        <section className="main-panel" aria-labelledby="main-title">
          <div className="panel-intro">
            <span className="eyebrow">
              <Sparkles size={15} />
              Compartí sin dejarlo para siempre
            </span>
            <h1 id="main-title">Un archivo. Un enlace. El tiempo justo.</h1>
            <p>
              CAPSULE cifra antes de subir y retira el archivo cuando vence.
            </p>
          </div>

          <div
            className="mode-tabs"
            role="tablist"
            aria-label="Elegir una acción"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "send"}
              className={mode === "send" ? "active" : ""}
              onClick={() => selectMode("send")}
            >
              <Send size={17} />
              Enviar
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "receive"}
              className={mode === "receive" ? "active" : ""}
              onClick={() => selectMode("receive")}
            >
              <ArrowDownToLine size={17} />
              Recibir
              {capability ? (
                <span className="tab-dot" aria-label="Cápsula detectada" />
              ) : null}
            </button>
          </div>

          {mode === "send" ? (
            <div className="flow" role="tabpanel">
              {sendStage === "success" && shared ? (
                <div className="success-view">
                  <div className="success-heading">
                    <span className="success-icon" aria-hidden="true">
                      <CheckCircle2 size={29} />
                    </span>
                    <div>
                      <span>La cápsula está lista</span>
                      <h2>Compartí este enlace</h2>
                    </div>
                  </div>

                  <MetadataCard metadata={shared.metadata} />

                  <ul className="delivery-summary">
                    <li>
                      <Server size={14} aria-hidden="true" />
                      Guardada en {shared.relayUrls.length}{" "}
                      {shared.relayUrls.length === 1 ? "relay" : "relays"}:{" "}
                      {shared.relayUrls
                        .map((url) => new URL(url).host)
                        .join(", ")}
                    </li>
                    {shared.anonymity.padded ? (
                      <li>
                        <EyeOff size={14} aria-hidden="true" />
                        Tamaño rellenado con{" "}
                        {formatBytes(shared.anonymity.paddingBytes)} para que el
                        relay vea una categoría y no el tamaño real
                      </li>
                    ) : null}
                    {shared.anonymity.removedMetadata.length > 0 ? (
                      <li>
                        <EyeOff size={14} aria-hidden="true" />
                        Metadatos borrados del archivo:{" "}
                        {shared.anonymity.removedMetadata.join(", ")}
                      </li>
                    ) : null}
                    {anonymous && !shared.anonymity.metadataScrubbed ? (
                      <li>
                        <TriangleAlert size={14} aria-hidden="true" />
                        Todavía no sabemos limpiar metadatos de este formato: el
                        archivo se envió tal cual
                      </li>
                    ) : null}
                    {shared.sharding ? (
                      <li>
                        <Shuffle size={14} aria-hidden="true" />
                        Repartida {shared.sharding.k} de {shared.sharding.n}:
                        ningún relay guarda lo suficiente para reconstruirla
                      </li>
                    ) : null}
                    {shared.anonymity.remainingMetadata.map((entry) => (
                      <li key={entry}>
                        <TriangleAlert size={14} aria-hidden="true" />
                        Quedó sin borrar: {entry}
                      </li>
                    ))}
                    {shared.mirrorFailures.map((failure) => (
                      <li key={failure.relayUrl}>
                        <TriangleAlert size={14} aria-hidden="true" />
                        No pudimos copiar a {new URL(failure.relayUrl).host}
                      </li>
                    ))}
                  </ul>

                  <div className="share-layout">
                    <div className="share-link-block">
                      <label htmlFor="share-url">Enlace privado</label>
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
                          {copied === "share" ? "Copiado" : "Copiar"}
                        </button>
                      </div>
                      <p>
                        <KeyRound size={14} />
                        Este enlace contiene la llave. Enviálo sólo a quien deba
                        abrirlo.
                      </p>
                    </div>
                    {shared.qrDataUrl ? (
                      <div className="qr-card">
                        <img
                          src={shared.qrDataUrl}
                          alt="Código QR del enlace privado"
                        />
                        <span>Escanear para abrir</span>
                      </div>
                    ) : null}
                  </div>

                  <div className="owner-key-block">
                    <div>
                      <KeyRound size={17} aria-hidden="true" />
                      <p>
                        <strong>Guardá tu clave de retiro</strong>
                        Es distinta del enlace compartido y permite eliminar la
                        cápsula antes de que venza.
                      </p>
                    </div>
                    <div className="share-field">
                      <KeyRound size={18} aria-hidden="true" />
                      <input
                        aria-label="Clave privada de retiro"
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
                        {copied === "owner" ? "Copiada" : "Copiar"}
                      </button>
                    </div>
                    <small>
                      No la compartas. CAPSULE no puede recuperarla por vos: si
                      la vas a necesitar más adelante, protegela con una
                      contraseña acá abajo.
                    </small>

                    <div className="recovery-block">
                      <strong>
                        <ShieldCheck size={14} aria-hidden="true" />
                        Guardarla con una contraseña
                      </strong>
                      <small>
                        Cifra la clave de retiro con una contraseña tuya, acá
                        mismo. El resultado se puede anotar o guardar en
                        cualquier lado: sin la contraseña no sirve de nada. El
                        relay no participa ni se entera.
                      </small>
                      {recovery ? (
                        <div className="share-field">
                          <KeyRound size={18} aria-hidden="true" />
                          <input
                            aria-label="Clave de retiro protegida"
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
                            {copied === "recovery" ? "Copiada" : "Copiar"}
                          </button>
                        </div>
                      ) : (
                        <div className="recovery-form">
                          <input
                            type="password"
                            autoComplete="new-password"
                            placeholder="Una contraseña que recuerdes"
                            value={passphrase}
                            disabled={protecting}
                            onChange={(event) => {
                              setPassphrase(event.target.value);
                              setRecoveryError("");
                            }}
                          />
                          <button
                            type="button"
                            disabled={protecting || passphrase.length < 8}
                            onClick={() => void handleProtect()}
                          >
                            {protecting ? "Protegiendo…" : "Proteger"}
                          </button>
                        </div>
                      )}
                      {recoveryError ? (
                        <span className="recovery-error" role="alert">
                          {recoveryError}
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
                    Crear otra cápsula
                  </button>
                </div>
              ) : (
                <>
                  <div className="field-group">
                    <div className="field-label">
                      <span>1</span>
                      <div>
                        <label htmlFor="capsule-file">Elegí qué enviar</label>
                        <small>Un archivo por cápsula</small>
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
                          <label>Elegí cuándo vence</label>
                          <small>Después deja de estar disponible</small>
                        </div>
                      </div>
                      <div
                        className="expiry-options"
                        role="radiogroup"
                        aria-label="Vencimiento de la cápsula"
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
                                  ? "Este relay no guarda cápsulas sin vencimiento"
                                  : option.label
                              }
                              onClick={() => setTtlSeconds(option.seconds)}
                            >
                              <span>{option.shortLabel}</span>
                              <small>
                                {unavailable
                                  ? "No disponible en este relay"
                                  : option.detail}
                              </small>
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
                          Sin vencimiento el relay guarda la cápsula hasta que
                          la borres con tu clave de retiro. Si perdés esa clave,
                          queda ahí.
                        </p>
                      ) : null}
                    </div>

                    <div className="field-group note-group">
                      <div className="field-label">
                        <span>3</span>
                        <div>
                          <label htmlFor="capsule-note">Sumá una nota</label>
                          <small>Opcional · también va cifrada</small>
                        </div>
                      </div>
                      <div className="note-field">
                        <textarea
                          id="capsule-note"
                          maxLength={280}
                          rows={3}
                          value={note}
                          disabled={isSending}
                          placeholder="Ej.: Las fotos del fin de semana"
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
                        <label>Elegí cuánto ocultar</label>
                        <small>Opcional · cada opción tiene un costo</small>
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
                            Modo anónimo
                          </strong>
                          <small>
                            Borra metadatos del archivo (EXIF/XMP), reemplaza el
                            nombre por uno neutro, rellena el tamaño hasta una
                            categoría y espacia las subidas. Sube algo más de
                            datos y tarda un poco más.
                          </small>
                        </span>
                      </label>

                      {mirrorCandidates.length > 0 ? (
                        <div className="switch-row as-static">
                          <Layers size={15} aria-hidden="true" />
                          <span className="switch-copy">
                            <strong>Copias en otros relays</strong>
                            <small>
                              Si un relay se cae o te bloquea, la cápsula sigue
                              disponible en otro. Más copias significa más
                              servidores que ven el tamaño y el horario.
                            </small>
                            <span
                              className="mirror-options"
                              role="radiogroup"
                              aria-label="Cantidad de copias"
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
                                  {count === 0 ? "Sólo uno" : `+${count}`}
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
                                  Repartir en vez de copiar: ningún relay guarda
                                  la cápsula entera y alcanza con dos para
                                  abrirla.
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
                          ? "Cifrando en este dispositivo"
                          : "Subiendo datos cifrados"
                      }
                      detail="No cierres esta ventana todavía"
                    />
                  ) : null}

                  {sendStage === "error" ? (
                    <div className="error-banner" role="alert">
                      <TriangleAlert size={19} />
                      <div>
                        <strong>La cápsula no salió</strong>
                        <span>{sendError}</span>
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
                      <>Preparando…</>
                    ) : (
                      <>
                        <LockKeyhole size={18} />
                        Cifrar y crear enlace
                        <Send size={17} />
                      </>
                    )}
                  </button>
                  <p className="action-note">
                    El archivo original no se modifica y permanece en tu
                    dispositivo.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="flow receive-flow" role="tabpanel">
              {receiveStage === "downloading" ? (
                <div className="receive-state centered-state">
                  <span className="large-state-icon" aria-hidden="true">
                    <PackageOpen size={31} />
                  </span>
                  <h2>Abriendo la cápsula</h2>
                  <p>
                    Descargamos los datos cifrados y los abrimos en este
                    dispositivo.
                  </p>
                  <ProgressState
                    progress={receiveProgress}
                    title={
                      receiveProgress < 0.82
                        ? "Descargando"
                        : "Verificando y descifrando"
                    }
                    detail="La llave no se envía al relay"
                  />
                </div>
              ) : receiveStage === "ready" && received ? (
                <div className="receive-state ready-state">
                  <div className="success-heading">
                    <span className="success-icon" aria-hidden="true">
                      <CheckCircle2 size={29} />
                    </span>
                    <div>
                      <span>Cápsula abierta y verificada</span>
                      <h2>Está lista para guardar</h2>
                    </div>
                  </div>
                  <MetadataCard metadata={received.metadata} received />
                  <button
                    className="primary-action"
                    type="button"
                    onClick={saveReceivedFile}
                  >
                    <Download size={19} />
                    Guardar {received.metadata.filename}
                  </button>
                  <button
                    className="text-action"
                    type="button"
                    onClick={clearReceived}
                  >
                    <ArrowLeft size={16} />
                    Cerrar esta cápsula
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
                      ? "Revisemos el enlace"
                      : "Pegá un enlace CAPSULE"}
                  </h2>
                  <p>
                    Si abriste el enlace completo, la descarga empieza sola.
                    También podés pegarlo acá.
                  </p>
                  <div className="receive-input">
                    <label htmlFor="receive-link">Enlace privado</label>
                    <div>
                      <Link2 size={18} aria-hidden="true" />
                      <input
                        id="receive-link"
                        type="text"
                        value={receiveInput}
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="https://…/#capsule=…"
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
                      <span>{receiveError}</span>
                    </div>
                  ) : null}
                  <button
                    className="primary-action"
                    type="button"
                    disabled={!receiveInput.trim()}
                    onClick={handleReceiveSubmit}
                  >
                    <PackageOpen size={19} />
                    Abrir cápsula
                  </button>
                  <div className="hash-explainer">
                    <KeyRound size={16} />
                    <p>
                      La parte que empieza con <code>#capsule=</code> contiene
                      la llave. El navegador no la manda al relay cuando
                      solicita la página.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        <PrivacyAside relays={network} relayUrl={relayUrl} />
      </main>

      <footer>
        <Brand />
        <p>Privado por diseño · Temporal por elección</p>
        <span>Sin analíticas ni rastreadores de terceros.</span>
      </footer>
    </div>
  );
}
