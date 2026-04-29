import { useEffect, useState } from "react";
import api from "./api/client";
import { authReady, WebhookAuth } from "./auth/webhookAuth";
import EmbedDiagnostics from "./embed/EmbedDiagnostics";
import type { DataCentralUserContext } from "./types";

function isLocalhost(): boolean {
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<DataCentralUserContext | null>(null);
  const [backendContext, setBackendContext] = useState<any>(null);

  useEffect(() => {
    authReady.then(async () => {
      const currentUser = WebhookAuth.getUserInfo();
      setUser(currentUser);
      setReady(true);

      try {
        const response = await api.get("/api/me");
        setBackendContext(response.data);
      } catch {
        setBackendContext(null);
      }
    });
  }, []);

  if (!ready || !user) return <main>Loading...</main>;

  const canRun = WebhookAuth.isVerified() || isLocalhost();

  if (!canRun) {
    return (
      <main className="card">
        <h1>Access restricted</h1>
        <p>This app must be launched from DataCentral with a valid signature.</p>
      </main>
    );
  }

  return (
    <main className="card">
      <h1>Hello, {user.user.displayName}</h1>
      <p>This app received its user and tenant context from DataCentral.</p>

      <section>
        <h2>User context</h2>
        <dl>
          <dt>User ID</dt><dd>{user.user.id}</dd>
          <dt>Username</dt><dd>{user.user.userName}</dd>
          <dt>Tenant</dt><dd>{user.tenant.name} ({user.tenant.id})</dd>
          <dt>Roles</dt><dd>{user.roles.join(", ") || "None"}</dd>
          <dt>Frontend verified</dt><dd>{String(user.isVerified)}</dd>
        </dl>
      </section>

      <section>
        <h2>Backend verification</h2>
        <pre>{JSON.stringify(backendContext, null, 2)}</pre>
      </section>

      <EmbedDiagnostics />
    </main>
  );
}
