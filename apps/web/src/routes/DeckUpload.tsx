import { useCallback, useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router";
import { FileUp, Upload } from "lucide-react";
import { api, ApiError } from "../api/client";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { Input } from "../components/Input";
import { formatBytes } from "../lib/format";

const STAGE_MIME = "application/zip";

type UploadState =
  | { kind: "idle" }
  | { kind: "selected"; file: File }
  | { kind: "uploading"; file: File; loaded: number; total: number }
  | { kind: "error"; file: File | null; message: string };

function describeUploadError(code: string | undefined, message: string | undefined): string {
  switch (code) {
    case "UPLOAD_TOO_LARGE":
      return "That file exceeds the server's upload limit.";
    case "INVALID_STAGE_ZIP":
      return "This file isn't a valid `.stage` package (zip missing or corrupted).";
    case "INVALID_MANIFEST":
      return "Manifest validation failed. Re-export the deck and try again.";
    case "UNSAFE_PATH":
      return "The package contains unsafe paths and was rejected.";
    default:
      return message || "Upload failed.";
  }
}

export function DeckUpload() {
  const navigate = useNavigate();
  const [state, setState] = useState<UploadState>({ kind: "idle" });
  const [title, setTitle] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedFile =
    state.kind === "selected" || state.kind === "uploading"
      ? state.file
      : state.kind === "error" && state.file
        ? state.file
        : null;

  const onPick = useCallback((file: File | null | undefined) => {
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".stage") && !lower.endsWith(".zip")) {
      setState({
        kind: "error",
        file,
        message: "Pick a `.stage` (or `.zip`) file produced by the SlideStage packer.",
      });
      return;
    }
    setState({ kind: "selected", file });
  }, []);

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    onPick(e.dataTransfer.files?.[0]);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (!isDragging) setIsDragging(true);
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }

  async function startUpload() {
    if (!selectedFile) return;
    setState({ kind: "uploading", file: selectedFile, loaded: 0, total: selectedFile.size });
    try {
      const summary = await api.decks.create(selectedFile, {
        title: title.trim() || undefined,
        onProgress: (loaded, total) => {
          setState({ kind: "uploading", file: selectedFile, loaded, total });
        },
      });
      navigate(`/decks/${summary.id}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setState({
          kind: "error",
          file: selectedFile,
          message: describeUploadError(err.code, err.message),
        });
      } else {
        setState({
          kind: "error",
          file: selectedFile,
          message: "Upload failed unexpectedly. Check your connection and try again.",
        });
      }
    }
  }

  const isUploading = state.kind === "uploading";
  const percent =
    state.kind === "uploading" && state.total > 0
      ? Math.min(100, Math.round((state.loaded / state.total) * 100))
      : 0;

  return (
    <div className="stack" style={{ gap: 20 }}>
      <header className="page-header">
        <div className="page-header__heading">
          <h1>Upload deck</h1>
          <p>Drop a `.stage` package or pick one from disk. Manifests are validated server-side.</p>
        </div>
      </header>

      <Card title="Choose a file">
        <div
          className={`dropzone ${isDragging ? "dropzone--dragging" : ""}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-disabled={isUploading}
        >
          <span className="dropzone__icon">
            <FileUp size={22} aria-hidden />
          </span>
          <div>
            <div className="dropzone__title">
              {selectedFile ? selectedFile.name : "Drop a `.stage` package here"}
            </div>
            <div className="dropzone__hint">
              {selectedFile
                ? `${formatBytes(selectedFile.size)} · click to choose a different file`
                : "or click to browse — typical decks are a few MB"}
            </div>
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".stage,application/zip"
            style={{ display: "none" }}
            onChange={(e) => onPick(e.target.files?.[0])}
          />
        </div>

        <div className="stack" style={{ marginTop: 16 }}>
          <Input
            label="Title override (optional)"
            placeholder="Leave blank to use the manifest title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isUploading}
          />

          {state.kind === "uploading" ? (
            <div className="progress-row">
              <div className="progress">
                <div className="progress__bar" style={{ width: `${percent}%` }} />
              </div>
              <div className="progress-row__meta">
                <span>
                  Uploading… {formatBytes(state.loaded)} / {formatBytes(state.total)}
                </span>
                <span>{percent}%</span>
              </div>
            </div>
          ) : null}

          {state.kind === "error" ? (
            <div className="alert alert--error" role="alert" aria-live="polite">
              {state.message}
            </div>
          ) : null}

          <div className="row row--end">
            <Button
              variant="primary"
              size="lg"
              leadingIcon={<Upload size={14} aria-hidden />}
              disabled={!selectedFile || isUploading}
              loading={isUploading}
              onClick={startUpload}
            >
              {isUploading ? "Uploading…" : "Upload"}
            </Button>
          </div>
        </div>
      </Card>

      <div className="muted" style={{ fontSize: 12.5 }}>
        Tip: build a `.stage` archive with the SlideStage Lite converter (<code>pnpm convert pack</code>) or any tool
        that emits a <code>slidestage@1.0</code> manifest.
      </div>
    </div>
  );
}
