import type { ReactNode } from "react";

type Props = {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
};

export function Empty({ title, description, action, icon }: Props) {
  return (
    <div className="empty">
      {icon ? <div className="empty__icon" aria-hidden>{icon}</div> : null}
      <h3 className="empty__title">{title}</h3>
      {description ? <p className="empty__description">{description}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}
