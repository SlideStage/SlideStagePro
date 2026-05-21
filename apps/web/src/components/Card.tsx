import type { HTMLAttributes, ReactNode } from "react";

type Props = HTMLAttributes<HTMLDivElement> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  padded?: boolean;
};

export function Card({
  title,
  description,
  actions,
  padded = true,
  className,
  children,
  ...rest
}: Props) {
  return (
    <section
      className={`card ${padded ? "card--padded" : ""} ${className ?? ""}`}
      {...rest}
    >
      {(title || actions || description) && (
        <header className="card__header">
          <div className="card__heading">
            {title ? <h2 className="card__title">{title}</h2> : null}
            {description ? <p className="card__description">{description}</p> : null}
          </div>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      )}
      <div className="card__body">{children}</div>
    </section>
  );
}
