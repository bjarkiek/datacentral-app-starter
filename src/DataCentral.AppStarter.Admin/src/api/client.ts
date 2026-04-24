import axios, { AxiosHeaders } from "axios";
import { getLaunchHeaders } from "../auth/webhookAuth";

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? ""
});

api.interceptors.request.use((config) => {
  const headers = AxiosHeaders.from(config.headers ?? {});
  const launchHeaders = getLaunchHeaders();

  Object.entries(launchHeaders).forEach(([key, value]) => headers.set(key, value));

  const tenantOverride = (import.meta.env.VITE_TENANT_OVERRIDE ?? "").trim();
  if (tenantOverride) headers.set("X-Tenant-Override", tenantOverride);

  config.headers = headers;
  return config;
});

export default api;
