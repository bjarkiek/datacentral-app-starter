import type { DataCentralUserContext, LegacyDcData } from "../types";

const storageKey = "datacentral-app-user";
const verifiedKey = "datacentral-app-verified";
const dcdataKey = "datacentral-app-dcdata";
const dcsigKey = "datacentral-app-dcsig";

let authReadyResolve: () => void;
export const authReady = new Promise<void>((resolve) => {
  authReadyResolve = resolve;
});

function isLocalhost(): boolean {
  return window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
}

function trySetStorage(key: string, value: string): void {
  try { sessionStorage.setItem(key, value); } catch {}
  try { localStorage.setItem(key, value); } catch {}
}

function tryGetStorage(key: string): string | null {
  try {
    return sessionStorage.getItem(key) ?? localStorage.getItem(key);
  } catch {
    return null;
  }
}

function normalizePayload(data: LegacyDcData): DataCentralUserContext {
  return {
    isVerified: false,
    user: {
      id: String(data.userId ?? ""),
      userName: data.userName ?? "",
      displayName: data.userDisplayName ?? data.userName ?? "",
      email: data.userEmail
    },
    tenant: {
      id: String(data.tenantId ?? ""),
      name: data.tenancyName ?? "",
      clientUrl: data.clientUrl ?? ""
    },
    roles: data.roleDisplayNames ?? [],
    roleIds: (data.roleIds ?? []).map(String),
    ui: {
      language: data.language,
      theme: data.theme
    },
    context: {
      allowedGroupIds: data.allowedGroupIds
    },
    issuedAt: data.timeStamp
  };
}

function decodeDcData(dcdata: string): LegacyDcData {
  const decoded = atob(dcdata);
  const parsed = JSON.parse(decoded);
  return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
}

async function verifyInFrontend(dcdata: string, dcsig: string): Promise<boolean> {
  const secret = (import.meta.env.VITE_WEBHOOK_HMAC_SECRET ?? "").trim();
  if (!secret) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(dcdata));
  const computed = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return computed === dcsig;
}

async function initAuth(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const dcdata = params.get("dcdata");
  const dcsig = params.get("dcsig");

  if (dcdata && dcsig) {
    trySetStorage(dcdataKey, dcdata);
    trySetStorage(dcsigKey, dcsig);

    const payload = decodeDcData(dcdata);
    const user = normalizePayload(payload);

    // Frontend verification is optional. Backend verification remains authoritative.
    user.isVerified = await verifyInFrontend(dcdata, dcsig);

    trySetStorage(storageKey, JSON.stringify(user));
    trySetStorage(verifiedKey, String(user.isVerified));

    params.delete("dcdata");
    params.delete("dcsig");
    const cleanUrl = window.location.pathname + (params.toString() ? `?${params.toString()}` : "") + window.location.hash;
    window.history.replaceState({}, document.title, cleanUrl);
  } else if (!tryGetStorage(storageKey) && isLocalhost()) {
    const devUser: DataCentralUserContext = {
      isVerified: false,
      user: { id: "dev-user", userName: "developer", displayName: "Developer" },
      tenant: { id: "dev-tenant", name: "Development", clientUrl: window.location.origin },
      roles: ["Admin"],
      roleIds: ["dev-role"],
      ui: { language: "en", theme: "light" },
      context: { allowedGroupIds: ["*"] },
      issuedAt: new Date().toISOString()
    };
    trySetStorage(storageKey, JSON.stringify(devUser));
    trySetStorage(verifiedKey, "false");
  }

  authReadyResolve();
}

initAuth();

export const WebhookAuth = {
  isAuthenticated(): boolean {
    return this.getUserInfo().user.id.length > 0;
  },

  isVerified(): boolean {
    return tryGetStorage(verifiedKey) === "true";
  },

  getUserInfo(): DataCentralUserContext {
    const raw = tryGetStorage(storageKey);
    if (!raw) {
      return {
        isVerified: false,
        user: { id: "", userName: "", displayName: "" },
        tenant: { id: "", name: "", clientUrl: "" },
        roles: [],
        roleIds: [],
        ui: {},
        context: {}
      };
    }

    return JSON.parse(raw);
  },

  hasRole(role: string): boolean {
    return this.getUserInfo().roles.some(r => r.toLowerCase() === role.toLowerCase());
  }
};

export function getLaunchHeaders(): Record<string, string> {
  const dcdata = tryGetStorage(dcdataKey);
  const dcsig = tryGetStorage(dcsigKey);
  const headers: Record<string, string> = {};
  if (dcdata) headers["X-DC-Data"] = dcdata;
  if (dcsig) headers["X-DC-Sig"] = dcsig;
  return headers;
}
