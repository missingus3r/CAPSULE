import { siteManifestFile, type SiteFile } from "@capsule/protocol";
import { publishSite, type RelayTransportFactory } from "@capsule/sdk";
import {
  CheckCircle2,
  FolderUp,
  Globe,
  KeyRound,
  RotateCcw,
  Search,
  Sparkles,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { EXAMPLE_TTL_SECONDS, exampleSite } from "../lib/example-site";
import {
  gatherFromFolder,
  gatherFromZip,
  type GatheredSite,
} from "../lib/sitefiles";
import {
  downloadSiteKeyFile,
  importSiteKeyFile,
  listSiteKeys,
  rememberSiteKey,
  type StoredSiteKey,
} from "../lib/sitekeys";
import { copyText, formatBytes } from "../lib/ui";
import { ProgressState } from "./ProgressState";

/**
 * Publishing a `.capsule` site from the browser.
 *
 * Everything past the file picker is the code the CLI already runs: the same
 * bundle format, the same encryption, the same signed record. What is new here
 * is only where the bytes come from and where the key lives, and the second of
 * those is the part worth being careful about — a site key *is* the name, and
 * there is nobody to appeal to when it is gone.
 */

type Stage = "form" | "working" | "done" | "error";

interface Published {
  name: string;
  sequence: number;
  bundleBytes: number;
  announcedTo: string[];
}

export function PublishSite({
  relayUrl,
  transport,
  ttlSeconds,
}: {
  relayUrl: string;
  transport?: RelayTransportFactory;
  ttlSeconds: number | null;
}) {
  const { locale, t } = useI18n();
  const [keys, setKeys] = useState<StoredSiteKey[]>([]);
  const [selected, setSelected] = useState<string>("new");
  const [gathered, setGathered] = useState<GatheredSite | undefined>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [listed, setListed] = useState(false);
  /** The example publishes for an hour whatever the panel above is set to. */
  const [isExample, setIsExample] = useState(false);
  const [stage, setStage] = useState<Stage>("form");
  const [progress, setProgress] = useState(0);
  const [problem, setProblem] = useState<string | undefined>();
  const [published, setPublished] = useState<Published | undefined>();
  const [copied, setCopied] = useState(false);

  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);

  const refreshKeys = useCallback(() => {
    void listSiteKeys().then(setKeys);
  }, []);
  useEffect(refreshKeys, [refreshKeys]);

  const take = async (run: () => Promise<GatheredSite>) => {
    setProblem(undefined);
    setIsExample(false);
    try {
      setGathered(await run());
    } catch (error) {
      setGathered(undefined);
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };

  const publish = async () => {
    if (!gathered) return;
    setStage("working");
    setProgress(0.02);
    setProblem(undefined);
    try {
      // A new name hands over its backup before it is used for anything. By
      // the time somebody finds out they needed the file, the name is gone.
      let identity;
      let sequence = 1;
      let createdAt = new Date().toISOString();
      if (selected === "new") {
        const { createSiteIdentity } = await import("@capsule/sdk");
        const created = await createSiteIdentity();
        downloadSiteKeyFile(created.file);
        identity = created.identity;
        createdAt = created.file.createdAt;
      } else {
        const stored = keys.find((key) => key.name === selected);
        if (!stored) throw new Error(t("publish.error.missingKey"));
        identity = {
          name: stored.name,
          publicKey: stored.publicKey,
          privateKey: stored.privateKey,
        };
        sequence = stored.sequence + 1;
        createdAt = stored.createdAt;
      }

      const files: SiteFile[] = [
        ...gathered.files.filter((file) => file.path !== "capsule.json"),
        siteManifestFile({
          index: listed,
          ...(description.trim() ? { description: description.trim() } : {}),
          lang: locale,
        }),
      ];

      const result = await publishSite({
        identity,
        files,
        relayUrl,
        ttlSeconds: isExample ? EXAMPLE_TTL_SECONDS : ttlSeconds,
        sequence,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(transport ? { transport } : {}),
        onProgress: (value) =>
          setProgress(
            Math.max(
              0.02,
              value.totalBytes > 0
                ? value.completedBytes / value.totalBytes
                : 0,
            ),
          ),
      });

      await rememberSiteKey(identity, createdAt, sequence);
      refreshKeys();
      setProgress(1);
      setPublished({
        name: result.name,
        sequence,
        bundleBytes: result.bundleBytes,
        announcedTo: result.announcedTo,
      });
      setStage("done");
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setStage("error");
    }
  };

  const startOver = () => {
    setStage("form");
    setGathered(undefined);
    setPublished(undefined);
    setProblem(undefined);
    setProgress(0);
    setTitle("");
    setDescription("");
    setListed(false);
    setIsExample(false);
  };

  if (stage === "working") {
    return (
      <div className="flow" role="tabpanel">
        <ProgressState
          title={t("publish.working")}
          detail={t("publish.workingDetail")}
          progress={progress}
        />
      </div>
    );
  }

  if (stage === "done" && published) {
    const address = `http://${published.name}/`;
    return (
      <div className="flow" role="tabpanel">
        <div className="success-view">
          <div className="success-heading">
            <span className="success-icon" aria-hidden="true">
              <CheckCircle2 size={29} />
            </span>
            <div>
              <h2>{t("publish.done")}</h2>
              <p>
                {t("publish.doneDetail", {
                  version: published.sequence,
                  relays: published.announcedTo.length,
                })}
              </p>
            </div>
          </div>

          <label className="field">
            <span>{t("publish.address")}</span>
            <div className="copy-row">
              <input readOnly value={address} />
              <button
                type="button"
                onClick={() => {
                  void copyText(address).then((ok) => setCopied(ok));
                }}
              >
                {copied ? t("publish.copied") : t("publish.copy")}
              </button>
            </div>
          </label>

          <p className="inline-warning">
            <KeyRound size={14} aria-hidden="true" />
            {t("publish.keptKey")}
          </p>

          <button type="button" className="ghost" onClick={startOver}>
            <RotateCcw size={15} aria-hidden="true" />
            {t("publish.again")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flow" role="tabpanel">
      <div className="field-group">
        <div className="field-label">
          <span>1</span>
          <div>
            <label>{t("publish.step1.label")}</label>
            <small>{t("publish.step1.hint")}</small>
          </div>
        </div>

        <div className="publish-pickers">
          <button
            type="button"
            onClick={() => folderInput.current?.click()}
            className="picker"
          >
            <FolderUp size={17} aria-hidden="true" />
            {t("publish.pickFolder")}
          </button>
          <button
            type="button"
            onClick={() => zipInput.current?.click()}
            className="picker"
          >
            <Upload size={17} aria-hidden="true" />
            {t("publish.pickZip")}
          </button>
        </div>

        <input
          ref={folderInput}
          type="file"
          hidden
          multiple
          // Not in the JSX types; it is what makes a folder selectable.
          {...({ webkitdirectory: "" } as Record<string, string>)}
          onChange={(event) => {
            const selection = [...(event.target.files ?? [])];
            if (selection.length > 0) {
              void take(() => gatherFromFolder(selection));
            }
          }}
        />
        <input
          ref={zipInput}
          type="file"
          hidden
          accept=".zip,application/zip"
          onChange={(event) => {
            const archive = event.target.files?.[0];
            if (archive) void take(() => gatherFromZip(archive));
          }}
        />

        <button
          type="button"
          className="ghost example-button"
          onClick={() => {
            setProblem(undefined);
            setGathered(exampleSite());
            setIsExample(true);
            setListed(false);
            setTitle("Hello from CAPSULE");
          }}
        >
          <Sparkles size={15} aria-hidden="true" />
          {t("publish.example")}
        </button>

        {gathered ? (
          <p className="publish-summary">
            <Globe size={14} aria-hidden="true" />
            {t("publish.gathered", {
              files: gathered.files.length,
              size: formatBytes(gathered.totalBytes, locale),
            })}
            {gathered.skipped.length > 0 ? (
              <small>
                {t("publish.skipped", { count: gathered.skipped.length })}
              </small>
            ) : null}
          </p>
        ) : null}
      </div>

      <div className="field-group">
        <div className="field-label">
          <span>2</span>
          <div>
            <label>{t("publish.step2.label")}</label>
            <small>{t("publish.step2.hint")}</small>
          </div>
        </div>

        <select
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          aria-label={t("publish.step2.label")}
        >
          <option value="new">{t("publish.newName")}</option>
          {keys.map((key) => (
            <option key={key.name} value={key.name}>
              {key.name.slice(0, 12)}… · v{key.sequence + 1}
            </option>
          ))}
        </select>

        <button
          type="button"
          className="ghost"
          onClick={() => keyInput.current?.click()}
        >
          <KeyRound size={15} aria-hidden="true" />
          {t("publish.importKey")}
        </button>
        <input
          ref={keyInput}
          type="file"
          hidden
          accept=".capsulekey,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void importSiteKeyFile(file)
              .then(async ({ identity, createdAt }) => {
                await rememberSiteKey(identity, createdAt, 0);
                refreshKeys();
                setSelected(identity.name);
                setProblem(undefined);
              })
              .catch((error: unknown) =>
                setProblem(
                  error instanceof Error ? error.message : String(error),
                ),
              );
          }}
        />
      </div>

      <div className="field-group">
        <div className="field-label">
          <span>3</span>
          <div>
            <label>{t("publish.step3.label")}</label>
            <small>{t("publish.step3.hint")}</small>
          </div>
        </div>

        <input
          type="text"
          maxLength={120}
          placeholder={t("publish.titlePlaceholder")}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />

        <label className="switch-row">
          <input
            type="checkbox"
            checked={listed}
            onChange={(event) => setListed(event.target.checked)}
          />
          <span className="switch-copy">
            <strong>
              <Search size={15} aria-hidden="true" />
              {t("publish.listed")}
            </strong>
            <small>{t("publish.listedDetail")}</small>
          </span>
        </label>

        {listed ? (
          <input
            type="text"
            maxLength={300}
            placeholder={t("publish.descriptionPlaceholder")}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        ) : null}
      </div>

      {problem ? (
        <p className="inline-warning" role="alert">
          <TriangleAlert size={14} aria-hidden="true" />
          {problem}
        </p>
      ) : null}

      {isExample ? (
        <p className="inline-warning">
          <Sparkles size={14} aria-hidden="true" />
          {t("publish.exampleNote")}
        </p>
      ) : null}

      <p className="inline-warning">
        <KeyRound size={14} aria-hidden="true" />
        {selected === "new" ? t("publish.keyWarning") : t("publish.keyReused")}
      </p>

      <button
        type="button"
        className="primary"
        disabled={!gathered}
        onClick={() => void publish()}
      >
        <Globe size={16} aria-hidden="true" />
        {t("publish.go")}
      </button>
    </div>
  );
}
