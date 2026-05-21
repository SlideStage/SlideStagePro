import { createBrowserRouter, Navigate } from "react-router";
import { RequireAuth } from "./auth/RequireAuth";
import { RequireAdmin } from "./auth/RequireAdmin";
import { Layout } from "./routes/Layout";
import { Login } from "./routes/Login";
import { SignUp } from "./routes/SignUp";
import { Dashboard } from "./routes/Dashboard";
import { DeckList } from "./routes/DeckList";
import { DeckUpload } from "./routes/DeckUpload";
import { DeckDetail } from "./routes/DeckDetail";
import { Settings } from "./routes/Settings";
import { NotFound } from "./routes/NotFound";

// Single source of truth for routing. React Router v7 ships
// `createBrowserRouter` from `react-router` directly.
export const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  { path: "/sign-up", element: <SignUp /> },
  {
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: "dashboard", element: <Dashboard /> },
      { path: "decks", element: <DeckList /> },
      { path: "decks/upload", element: <DeckUpload /> },
      { path: "decks/:id", element: <DeckDetail /> },
      { path: "settings", element: <Settings /> },
      {
        path: "admin",
        element: (
          <RequireAdmin>
            <Settings />
          </RequireAdmin>
        ),
      },
    ],
  },
  { path: "*", element: <NotFound /> },
]);

export default router;
