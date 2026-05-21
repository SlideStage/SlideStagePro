type Props = {
  label?: string;
  size?: number;
};

export function Spinner({ label, size = 18 }: Props) {
  return (
    <span className="spinner" role="status" aria-live="polite">
      <span
        className="spinner__circle"
        style={{ width: size, height: size }}
        aria-hidden
      />
      {label ? <span className="spinner__label">{label}</span> : null}
    </span>
  );
}
