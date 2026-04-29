import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const APP_READY_TYPE = "AppReady "; // trailing space is intentional — matches DataCentral parent
const ACCESS_TOKEN_TYPE = "AccessToken";
const KNOWN_QUERY_KEYS = ["dcdata", "dcsig"];

// webhookAuth.ts strips dcdata/dcsig from window.location.search after reading
// them (via history.replaceState), so by the time this component renders the
// query string is empty. Fall back to sessionStorage where webhookAuth stashed
// them — keys must match the ones webhookAuth writes.
const STORAGE_KEYS: Record<string, string> = {
  dcdata: "datacentral-app-dcdata",
  dcsig: "datacentral-app-dcsig"
};

function readPersisted(key: string): string | null {
  const storageKey = STORAGE_KEYS[key];
  if (!storageKey) return null;
  try {
    return sessionStorage.getItem(storageKey) ?? localStorage.getItem(storageKey);
  } catch {
    return null;
  }
}

type LogTag = "info" | "send" | "recv" | "warn" | "error";

interface LogEntry {
  id: number;
  tag: LogTag;
  ts: string;
  msg: string;
}

interface JwtPayload {
  exp?: number;
  [key: string]: unknown;
}

function decodeJwtPayload(token: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64)) as JwtPayload;
  } catch {
    return null;
  }
}

interface EmbedInfo {
  token: string;
  url?: string | null;
  workspaceId?: string | null;
  reportId?: string | null;
}

export default function EmbedDiagnostics() {
  const [token, setToken] = useState<string | null>(null);
  const [aadToken, setAadToken] = useState<string | null>(null);
  const [embedInfo, setEmbedInfo] = useState<EmbedInfo | null>(null);
  const [tokenStatus, setTokenStatus] = useState<"waiting" | "ok" | "err">("waiting");
  const [tokenLabel, setTokenLabel] = useState("Awaiting token");
  const [log, setLog] = useState<LogEntry[]>([]);
  const logIdRef = useRef(0);
  const tokenRef = useRef<string | null>(null);
  const initRef = useRef(false);

  const appendLog = useCallback((tag: LogTag, msg: string) => {
    setLog((prev) => [
      ...prev,
      {
        id: ++logIdRef.current,
        tag,
        ts: new Date().toISOString().substring(11, 23),
        msg
      }
    ]);
  }, []);

  const sendHandshake = useCallback(() => {
    if (!window.parent || window.parent === window) {
      appendLog("warn", "No parent window — cannot send handshake. Open this page inside a DataCentral Tool.");
      return;
    }
    appendLog("send", `Posting { type: "${APP_READY_TYPE}" } to parent (target: "*")`);
    window.parent.postMessage({ type: APP_READY_TYPE }, "*");
  }, [appendLog]);

  const queryRows = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const keys = new Set<string>([...KNOWN_QUERY_KEYS, ...params.keys()]);
    return Array.from(keys).map((k) => {
      const fromUrl = params.get(k);
      if (fromUrl != null) return { key: k, value: fromUrl, source: "url" as const };
      const fromStorage = readPersisted(k);
      if (fromStorage != null) return { key: k, value: fromStorage, source: "storage" as const };
      return { key: k, value: null, source: "missing" as const };
    });
  }, []);

  const embedContext = useMemo(() => {
    const inIframe = window.self !== window.top;
    let parentOrigin = "(unknown)";
    if (document.referrer) {
      try {
        parentOrigin = new URL(document.referrer).origin;
      } catch {
        // referrer not a valid URL — leave as unknown
      }
    }
    return {
      inIframe,
      parentOrigin,
      myOrigin: window.location.origin,
      referrer: document.referrer || "(none)"
    };
  }, []);

  const fullUrl = window.location.href;
  const decodedPayload = useMemo(() => (token ? decodeJwtPayload(token) : null), [token]);
  const decodedAadPayload = useMemo(() => (aadToken ? decodeJwtPayload(aadToken) : null), [aadToken]);

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const params = new URLSearchParams(window.location.search);
    if (params.toString()) {
      appendLog("info", `Query parameters from URL: ${params.toString()}`);
    } else {
      const stored = KNOWN_QUERY_KEYS
        .map((k) => [k, readPersisted(k)] as const)
        .filter(([, v]) => v != null);
      if (stored.length > 0) {
        appendLog(
          "info",
          `URL has no query string (webhookAuth already cleaned it). Recovered from storage: ${stored.map(([k]) => k).join(", ")}`
        );
      } else {
        appendLog("info", "Query parameters: (none in URL or storage)");
      }
    }

    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      const summary =
        `origin=${event.origin}  data=` +
        (typeof data === "object" ? JSON.stringify(data) : String(data));
      appendLog("recv", `message  ${summary}`);

      if (data && typeof data === "object" && (data as { type?: string }).type === ACCESS_TOKEN_TYPE) {
        const incoming = (data as { token?: unknown }).token;
        const incomingAad = (data as { aadToken?: unknown }).aadToken;

        if (typeof incoming === "string" && incoming.length > 0) {
          appendLog("info", `Received access token (${incoming.length} chars) from ${event.origin}`);
          tokenRef.current = incoming;
          setToken(incoming);
          setTokenStatus("ok");
          setTokenLabel("Token received");
          const payload = decodeJwtPayload(incoming);
          if (payload?.exp) {
            const expDate = new Date(payload.exp * 1000);
            appendLog("info", `JWT expires at ${expDate.toISOString()}`);
          }
        } else {
          appendLog("warn", "AccessToken message had no token field");
        }

        if (typeof incomingAad === "string" && incomingAad.length > 0) {
          appendLog("info", `Received AAD access token (${incomingAad.length} chars) from ${event.origin}`);
          setAadToken(incomingAad);
          const aadPayload = decodeJwtPayload(incomingAad);
          if (aadPayload?.exp) {
            appendLog("info", `AAD token expires at ${new Date(aadPayload.exp * 1000).toISOString()}`);
          }
        } else if (incomingAad === null) {
          appendLog("info", "AAD token: null (user did not sign in via Azure AD, or scopes not configured)");
        }

        const incomingEmbedToken = (data as { embedToken?: unknown }).embedToken;
        if (typeof incomingEmbedToken === "string" && incomingEmbedToken.length > 0) {
          const embedUrl = typeof (data as any).embedUrl === "string" ? (data as any).embedUrl as string : null;
          const workspaceId = typeof (data as any).embedWorkspaceId === "string" ? (data as any).embedWorkspaceId as string : null;
          const reportId = typeof (data as any).embedReportId === "string" ? (data as any).embedReportId as string : null;
          appendLog("info",
            `Received Power BI embed token (${incomingEmbedToken.length} chars) ` +
            `for workspace ${workspaceId ?? "?"} / report ${reportId ?? "?"}`);
          setEmbedInfo({ token: incomingEmbedToken, url: embedUrl, workspaceId, reportId });
        }
      }
    };

    window.addEventListener("message", onMessage);

    // The DataCentral parent (Angular embed-tool.component.ts) attaches its
    // message listener and binds its iframe ViewChild on different lifecycle
    // ticks, and its reply path crashes if iframeRef.nativeElement is null
    // when our handshake arrives. Retry on a backoff so we eventually land
    // a handshake after the parent's view has stabilised.
    const retryDelays = [0, 250, 500, 1000, 2000, 4000, 8000];
    const retryHandles = retryDelays.map((delay) =>
      window.setTimeout(() => {
        if (tokenRef.current) return;
        sendHandshake();
      }, delay)
    );

    const timeout = window.setTimeout(() => {
      if (!tokenRef.current) {
        setTokenStatus("waiting");
        setTokenLabel("Awaiting token...");
        appendLog(
          "warn",
          'No token received within 2s. The Tool may have "Include access token" disabled, ' +
            "or the parent listener attached after our initial handshake. Retrying in background; " +
            'click "Re-send handshake" to nudge.'
        );
      }
    }, 2000);

    return () => {
      window.removeEventListener("message", onMessage);
      retryHandles.forEach(window.clearTimeout);
      window.clearTimeout(timeout);
    };
  }, [appendLog, sendHandshake]);

  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      appendLog("info", "Token copied to clipboard");
    } catch (e) {
      appendLog("error", `Clipboard write failed: ${(e as Error).message}`);
    }
  };

  const clearLog = () => setLog([]);

  return (
    <section className="diag">
      <div className="diag-header">
        <h2>Embed diagnostics</h2>
        <span className={`diag-pill ${tokenStatus}`}>{tokenLabel}</span>
      </div>

      <div className="diag-grid">
        <div className="diag-panel">
          <h3>Query parameters</h3>
          {queryRows.length === 0 ? (
            <div className="diag-empty">No query parameters present.</div>
          ) : (
            <dl className="diag-kv">
              {queryRows.map(({ key, value, source }) => (
                <div className="diag-row" key={key}>
                  <dt>
                    {key}
                    {source === "storage" && (
                      <span className="diag-source" title="Captured from URL on load, then cleaned from address bar by webhookAuth"> (from storage)</span>
                    )}
                  </dt>
                  <dd>{value == null ? <span className="diag-empty">(not provided)</span> : value}</dd>
                </div>
              ))}
            </dl>
          )}
          <details>
            <summary>Full URL</summary>
            <pre>{fullUrl}</pre>
          </details>
        </div>

        <div className="diag-panel">
          <h3>Embed context</h3>
          <dl className="diag-kv">
            <div className="diag-row">
              <dt>In iframe?</dt>
              <dd>{embedContext.inIframe ? "yes" : "no (open in DataCentral)"}</dd>
            </div>
            <div className="diag-row">
              <dt>Parent origin</dt>
              <dd>{embedContext.parentOrigin}</dd>
            </div>
            <div className="diag-row">
              <dt>My origin</dt>
              <dd>{embedContext.myOrigin}</dd>
            </div>
            <div className="diag-row">
              <dt>Referrer</dt>
              <dd>{embedContext.referrer}</dd>
            </div>
          </dl>
        </div>

        <div className="diag-panel diag-full">
          <h3>Access token (via postMessage)</h3>
          <dl className="diag-kv">
            <div className="diag-row">
              <dt>Status</dt>
              <dd>
                {token ? (
                  <code className="diag-token">{token}</code>
                ) : (
                  <span className="diag-empty">
                    No token received yet. Sent {`{ type: "${APP_READY_TYPE}" }`} to parent on load.
                  </span>
                )}
              </dd>
            </div>
          </dl>
          {decodedPayload && (
            <details open>
              <summary>Decoded JWT payload</summary>
              <pre>{JSON.stringify(decodedPayload, null, 2)}</pre>
            </details>
          )}
          <div className="diag-actions">
            <button type="button" onClick={sendHandshake}>Re-send handshake</button>
            <button type="button" onClick={copyToken} disabled={!token}>Copy token</button>
          </div>
        </div>

        <div className="diag-panel diag-full">
          <h3>Entra ID access token (via postMessage)</h3>
          <dl className="diag-kv">
            <div className="diag-row">
              <dt>Status</dt>
              <dd>
                {aadToken ? (
                  <code className="diag-token">{aadToken}</code>
                ) : (
                  <span className="diag-empty">
                    No AAD token. Either the user did not sign in via Azure AD, the Tool's
                    "AAD scopes" field is empty, or MSAL silent acquisition failed.
                    Forwarded only when the parent's handshake reply includes an aadToken field.
                  </span>
                )}
              </dd>
            </div>
          </dl>
          {decodedAadPayload && (
            <details open>
              <summary>Decoded AAD JWT payload</summary>
              <pre>{JSON.stringify(decodedAadPayload, null, 2)}</pre>
            </details>
          )}
        </div>

        <div className="diag-panel diag-full">
          <h3>Power BI embed token (via postMessage)</h3>
          <dl className="diag-kv">
            <div className="diag-row">
              <dt>Status</dt>
              <dd>
                {embedInfo ? (
                  <code className="diag-token">{embedInfo.token}</code>
                ) : (
                  <span className="diag-empty">
                    No embed token. Either the Tool's "Include Power BI embed token" toggle is off,
                    or the workspace/report/tenant inputs are missing, or the backend service principal
                    failed to generate a token (check backend logs).
                  </span>
                )}
              </dd>
            </div>
            {embedInfo && (
              <>
                <div className="diag-row">
                  <dt>Embed URL</dt>
                  <dd>
                    {embedInfo.url ? (
                      <code className="diag-token">{embedInfo.url}</code>
                    ) : (
                      <span className="diag-empty">(not provided)</span>
                    )}
                  </dd>
                </div>
                <div className="diag-row">
                  <dt>Workspace ID</dt>
                  <dd>{embedInfo.workspaceId ?? <span className="diag-empty">(not provided)</span>}</dd>
                </div>
                <div className="diag-row">
                  <dt>Report ID</dt>
                  <dd>{embedInfo.reportId ?? <span className="diag-empty">(not provided)</span>}</dd>
                </div>
              </>
            )}
          </dl>
        </div>

        <div className="diag-panel diag-full">
          <h3>Event log</h3>
          <div className="diag-log">
            {log.length === 0 ? (
              <div className="diag-empty">No events yet.</div>
            ) : (
              log.map((entry) => (
                <div className={`diag-log-entry tag-${entry.tag}`} key={entry.id}>
                  <span className="ts">{entry.ts}</span>
                  <span className="tag">[{entry.tag.toUpperCase()}]</span> {entry.msg}
                </div>
              ))
            )}
          </div>
          <div className="diag-actions">
            <button type="button" onClick={clearLog}>Clear log</button>
          </div>
        </div>
      </div>
    </section>
  );
}
