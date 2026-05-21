import type { ReactNode } from "react";
import { Navigate } from "react-router";
import { useSession, userIsAdmin, type SessionUser } from "./client";
import { Spinner } from "../components/Spinner";

type Props = { children: ReactNode };

export function RequireAdmin({ children }: Props) {
  const { data, isPending } = useSession();

  if (isPending) {
    return (
      <div className="page-loading">
        <Spinner label="Loading session…" />
      </div>
    );
  }

  if (!data?.user) {
    return <Navigate to="/login" replace />;
  }

  if (!userIsAdmin(data.user as SessionUser)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
