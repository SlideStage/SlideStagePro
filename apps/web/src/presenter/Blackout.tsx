/**
 * Solid color full-cover overlay used by blackout (B) and whiteout (W).
 * Captures pointer events so accidental clicks during a "let me grab focus"
 * moment don't leak through to the iframe.
 */

interface Props {
  color: '#000' | '#fff' | null;
}

export function Blackout({ color }: Props): JSX.Element | null {
  if (!color) return null;
  return (
    <div
      className="presenter-blackout"
      data-testid={color === '#000' ? 'blackout' : 'whiteout'}
      style={{
        position: 'absolute',
        inset: 0,
        background: color,
        pointerEvents: 'auto',
        zIndex: 5,
      }}
    />
  );
}
