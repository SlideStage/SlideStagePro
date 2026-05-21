import { Link } from "react-router";
import { Card } from "../components/Card";
import { Button } from "../components/Button";

export function NotFound() {
  return (
    <div className="auth-shell">
      <Card
        className="auth-shell__card"
        title="404 — Not found"
        description="That page doesn't exist (or you don't have access)."
      >
        <Link to="/dashboard">
          <Button variant="primary">Back to dashboard</Button>
        </Link>
      </Card>
    </div>
  );
}
