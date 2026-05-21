import { Outlet } from "react-router";
import { Header } from "../components/Header";

export function Layout() {
  return (
    <div className="app-shell">
      <Header />
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
