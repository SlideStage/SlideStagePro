import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

// Mock the auth client: tests don't need a real Better Auth runtime.
vi.mock("../src/auth/client", () => {
  return {
    authClient: {
      signIn: { email: vi.fn() },
      signUp: { email: vi.fn() },
      signOut: vi.fn(),
    },
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
    useSession: () => ({ data: null, isPending: false, error: null }),
    userIsAdmin: () => false,
  };
});

// Mock the API client so smoke tests don't hit fetch.
vi.mock("../src/api/client", () => ({
  ApiError: class ApiError extends Error {
    code = "ERR";
    status = 0;
    details: unknown;
  },
  api: {
    health: vi.fn(),
    decks: {
      list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      get: vi.fn(),
      blob: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    notes: { list: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    annotations: { list: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
    invites: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
    users: { list: vi.fn(), update: vi.fn(), delete: vi.fn() },
  },
}));

// Pull the Login route lazily so the mocks are active by the time the module
// graph evaluates.
async function loadLogin() {
  const mod = await import("../src/routes/Login");
  return mod.Login;
}

describe("App routing smoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the login page at /login", async () => {
    const Login = await loadLogin();
    const router = createMemoryRouter(
      [
        { path: "/login", element: <Login /> },
        { path: "*", element: <div>fallback</div> },
      ],
      { initialEntries: ["/login"] },
    );
    render(<RouterProvider router={router} />);
    expect(await screen.findByRole("heading", { name: /Sign in/i })).toBeTruthy();
    expect(screen.getByLabelText(/email/i)).toBeTruthy();
    expect(screen.getByLabelText(/password/i)).toBeTruthy();
  });

  it("redirects unauthenticated visitors away from protected routes", async () => {
    const { RequireAuth } = await import("../src/auth/RequireAuth");
    const router = createMemoryRouter(
      [
        {
          path: "/dashboard",
          element: (
            <RequireAuth>
              <div>dashboard</div>
            </RequireAuth>
          ),
        },
        { path: "/login", element: <div data-testid="login-marker">login</div> },
      ],
      { initialEntries: ["/dashboard"] },
    );
    render(<RouterProvider router={router} />);
    expect(await screen.findByTestId("login-marker")).toBeTruthy();
  });
});
