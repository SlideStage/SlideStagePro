import { useState, type ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { UploadCloud } from 'lucide-react';
import { api } from '../api/client.js';

export function UploadPage(): JSX.Element {
  const nav = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  function handleFile(e: ChangeEvent<HTMLInputElement>): void {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setError(null);
    setProgress(0);
  }

  async function handleSubmit(): Promise<void> {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const result = await api.uploadDeck(file, (loaded, total) => {
        setProgress(Math.round((loaded / total) * 100));
      });
      nav(`/decks/${encodeURIComponent(result.id)}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="page upload-page">
      <h1>Upload .stage package</h1>
      <p className="muted">
        Drop a `.stage` file (ZIP containing manifest.json + slides/*.html).
        Server enforces zip-slip / zip-bomb / size limits per spec §5.
      </p>

      <div className="upload-card">
        <input
          type="file"
          accept=".stage,application/zip,application/x-zip-compressed,application/vnd.stage+zip"
          onChange={handleFile}
          data-testid="upload-input"
        />
        {file && (
          <div className="file-meta">
            <strong>{file.name}</strong> · {(file.size / 1024).toFixed(1)} KB
          </div>
        )}
        {uploading && (
          <div className="progress">
            <div
              className="progress-bar"
              style={{ width: `${progress}%` }}
              data-testid="upload-progress"
            />
            <span>{progress}%</span>
          </div>
        )}
        {error && (
          <div className="alert error" data-testid="upload-error">
            {error}
          </div>
        )}
        <div className="upload-actions">
          <button
            className="btn primary"
            disabled={!file || uploading}
            onClick={() => void handleSubmit()}
            data-testid="upload-submit"
          >
          <UploadCloud className="btn-icon" aria-hidden size={16} />
          {uploading ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}
