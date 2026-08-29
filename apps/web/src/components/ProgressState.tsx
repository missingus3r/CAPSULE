import { LoaderCircle } from "lucide-react";

interface ProgressStateProps {
  progress: number;
  title: string;
  detail: string;
}

export function ProgressState({ progress, title, detail }: ProgressStateProps) {
  const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));

  return (
    <div className="progress-state" role="status" aria-live="polite">
      <div className="progress-heading">
        <span className="spinner" aria-hidden="true">
          <LoaderCircle size={21} />
        </span>
        <div>
          <strong>{title}</strong>
          <span>{detail}</span>
        </div>
        <b>{percent}%</b>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${Math.max(3, percent)}%` }} />
      </div>
    </div>
  );
}
