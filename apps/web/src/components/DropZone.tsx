import { FileUp, FolderOpen, RefreshCw, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { useI18n } from "../i18n";
import { formatBytes, mimeTypeKey } from "../lib/ui";

interface DropZoneProps {
  file: File | null;
  disabled?: boolean;
  onFile: (file: File | null) => void;
}

export function DropZone({ file, disabled = false, onFile }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const { locale, t } = useI18n();

  const pickFirstFile = (files: FileList | null) => {
    const nextFile = files?.item(0) ?? null;
    if (nextFile) onFile(nextFile);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!disabled) pickFirstFile(event.dataTransfer.files);
  };

  if (file) {
    const typeKey = mimeTypeKey(file.type);
    return (
      <div className="selected-file" data-testid="selected-file">
        <div className="file-icon" aria-hidden="true">
          <FileUp size={22} strokeWidth={2} />
        </div>
        <div className="file-copy">
          <strong title={file.name}>{file.name}</strong>
          <span>
            {formatBytes(file.size, locale) || t("size.unknown")} ·{" "}
            {typeKey ? t(typeKey) : file.type}
          </span>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={t("drop.remove")}
          disabled={disabled}
          onClick={() => onFile(null)}
        >
          <X size={18} />
        </button>
        <button
          className="replace-button"
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
        >
          <RefreshCw size={15} />
          {t("drop.replace")}
        </button>
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          disabled={disabled}
          onChange={(event) => pickFirstFile(event.currentTarget.files)}
        />
      </div>
    );
  }

  return (
    <div
      className={`drop-zone${dragging ? " is-dragging" : ""}${disabled ? " is-disabled" : ""}`}
      onDragEnter={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <input
        id="capsule-file"
        ref={inputRef}
        className="sr-only"
        type="file"
        disabled={disabled}
        onChange={(event) => pickFirstFile(event.currentTarget.files)}
      />
      <label htmlFor="capsule-file">
        <span className="drop-icon" aria-hidden="true">
          <FolderOpen size={26} strokeWidth={1.8} />
        </span>
        <strong>{dragging ? t("drop.dragging") : t("drop.choose")}</strong>
        <span>{t("drop.hint")}</span>
      </label>
    </div>
  );
}
