import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = "primary",
    size = "md",
    leadingIcon,
    trailingIcon,
    loading,
    disabled,
    children,
    className,
    type,
    ...rest
  },
  ref,
) {
  const classes = [
    "btn",
    `btn--${variant}`,
    `btn--${size}`,
    loading ? "btn--loading" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      className={classes}
      {...rest}
    >
      {leadingIcon ? <span className="btn__icon" aria-hidden>{leadingIcon}</span> : null}
      <span className="btn__label">{children}</span>
      {trailingIcon ? <span className="btn__icon" aria-hidden>{trailingIcon}</span> : null}
    </button>
  );
});
