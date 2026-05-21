import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

const signInMock = vi.fn();

vi.mock("../src/auth/client", () => {
  return {
    authClient: {
      signIn: { email: signInMock },
      signUp: { email: vi.fn() },
      signOut: vi.fn(),
    },
    signIn: { email: signInMock },
    signUp: { email: vi.fn() },
    signOut: vi.fn(),
    useSession: () => ({ data: null, isPending: false, error: null }),
    userIsAdmin: () => false,
  };
});

async function mountLogin(initialUrl = "/login") {
  const { Login } = await import("../src/routes/Login");
  const router = createMemoryRouter(
    [
      { path: "/login", element: <Login /> },
      { path: "/dashboard", element: <div data-testid="dashboard-marker">dashboard</div> },
      { path: "*", element: <div>fallback</div> },
    ],
    { initialEntries: [initialUrl] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("Login page", () => {
  beforeEach(() => {
    signInMock.mockReset();
  });

  it("submits email + password and navigates on success", async () => {
    signInMock.mockResolvedValue({ data: { user: { id: "u1" } } });
    await mountLogin("/login?next=/dashboard");

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "alice@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "hunter22" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    await waitFor(() => {
      expect(signInMock).toHaveBeenCalledWith({ email: "alice@example.com", password: "hunter22" });
    });
    await waitFor(() => {
      expect(screen.getByTestId("dashboard-marker")).toBeTruthy();
    });
  });

  it("surfaces a friendly error when credentials are bad", async () => {
    signInMock.mockResolvedValue({
      error: { code: "INVALID_CREDENTIALS", message: "Wrong" },
    });
    await mountLogin();

    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: "x@example.com" } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent ?? "").toMatch(/email or password is incorrect/i);
  });
});
