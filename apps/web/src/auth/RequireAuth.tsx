import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useSession } from "./client";
import { Spinner } from "../components/Spinner";

type Props = { children: ReactNode };

export function RequireAuth({ children }: Props) {
  const { data, isPending } = useSession();
  const location = useLocation();

  if (isPending) {
    return (
      <div className="page-loading">
        <Spinner label="Loading session…" />
      </div>
    );
  }

  if (!data?.user) {
    const from = `${location.pathname}${location.search}`;
    const next = from === "/" || from === "" ? "/dashboard" : from;
    return (
      <Navigate
        to={`/login?next=${encodeURIComponent(next)}`}
        replace
      />
    );
  }

  return <>{children}</>;
}
