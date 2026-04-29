# `tool-embed-test.html` — Technical Reference

A single-file HTML diagnostic page that runs inside a Datacentral "Tool" iframe. It exists to:

1. Verify the iframe→parent **postMessage handshake** that delivers user-context tokens.
2. Decode and explain every JWT in the postMessage with claim-level detail.
3. Embed a Power BI report using either an `embedToken` (service-issued) or an `aadToken` (user/SP AAD), with auto-classification of which `TokenType` to send to the SDK.
4. Execute DAX queries directly against the dataset behind the report via the Power BI REST `executeQueries` API.

It's a self-contained reference implementation. Use it as the architectural baseline if you split this into a real application — every contract documented here is something a production app must still respect.

> **Path note:** `c:\VS Code\datacentral-app-starter\tool-embed-test.html`. There is also a React port at `src/DataCentral.AppStarter.Admin/src/embed/EmbedDiagnostics.tsx` that mirrors the early parts of the postMessage flow but has not been kept in sync with the embed/DAX features.

---

## 1. File anatomy

| Section              | Lines     | Purpose                                                                                                |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `<head>`           | 1–7      | Loads `powerbi-client@2.23.1` from jsDelivr CDN. **No build step.**                            |
| CSS                  | 8–478    | Dark theme + component styles. CSS custom properties (`--bg`, `--accent`, etc.) drive the palette. |
| HTML body            | 480–643  | Five panels in a `.grid` container, plus an embed modal.                                             |
| Script (single IIFE) | 645–1874 | Everything: handshake, classifier, decode, embed, DAX. No modules.                                     |

The whole file is a single anonymous IIFE so nothing leaks to `window`. If you split this for a real app, every named function in the IIFE should become an exportable module.

### CSS structure

```
:root             palette tokens
.grid / .panel    main layout (auto-fit columns ≥ 360px)
.row .key/.val    key/value rows used in headers & claim grids
.pill             status badges (waiting/ok/err)
.log              event log container + per-tag colors
.token-card       big cards in the decoded panel
.claim-grid       150px-label two-column grid used inside cards
.validity-bar     thin bar fill (good/warn/bad)
.modal            full-screen overlay + dialog
.token-toggle     segmented two-option control inside the modal
.dax-grid         responsive 3-up form for the DAX panel
```

The visual states `good` / `warn` / `bad` map to `--good`/`--warn`/`--bad` and are used by both pills and validity bars. Reuse these names if you add new components.

---

## 2. The postMessage protocol — the central contract

This is the most important thing on the page. Everything downstream depends on it.

### Constants (script lines 718–719)

```javascript
const APP_READY_TYPE   = 'AppReady ';      // <-- TRAILING SPACE IS INTENTIONAL
const ACCESS_TOKEN_TYPE = 'AccessToken';
```

The trailing space in `'AppReady '` is **load-bearing**. The Datacentral parent (Angular: `angular/src/app/main/embed-tool/embed-tool.component.ts`) does an exact-string equality check, so removing the space breaks the handshake silently. If you're rebuilding, treat this as an immutable wire-protocol token until both sides change.

### Outgoing — `AppReady` (script lines 724–734)

```javascript
window.parent.postMessage({ type: 'AppReady ' }, '*');
```

- Target origin is `'*'`. Justification: `document.referrer` is unreliable (it's stripped by Permissions-Policy on some hosts), so we can't compute the parent's exact origin. The parent uses the iframe's known `tool.url` as its target origin when replying, so it's not a confused-deputy risk on the response path. Outgoing is fine because the message contains no secrets.
- Sent on three triggers: synchronous if `document.readyState === 'complete'` at script-eval time, on the `load` event otherwise, and again at `T+250ms`. If no token has arrived by `T+2000ms` the page warns the user (lines 1856–1872). The retry is necessary because some parents attach their `message` listener inside their own `ngOnInit`/`useEffect`, which can race the iframe's first send.

### Incoming — `AccessToken` (script lines 766–786)

The parent responds with an object of this shape (every field except `type` and `token` is optional in principle but commonly all are present):

```typescript
interface AccessTokenMessage {
  type: 'AccessToken';
  token: string;              // DataCentral backend JWT (HS256, internal)
  aadToken?: string;          // AAD/Entra access token — audience varies (Graph or PBI)
  embedToken?: string;        // Either a real PBI service-issued embed token,
                              //   or an AAD service-principal token for PBI
  embedUrl?: string;          // app.powerbi.com URL with config= blob baked in
  embedWorkspaceId?: string;  // Workspace the embedToken is bound to
  embedReportId?: string;     // Report the embedToken is bound to
  // Forward-compatible: any additional string field that looks like a JWT
  // will be decoded and shown in the Decoded panel.
}
```

The listener (lines 766–786):

1. Logs the full envelope (origin + JSON) at `[RECV]` level.
2. If `data.type === 'AccessToken'` and `data.token` is a non-empty string:
   - Stashes the entire object in `lastMessageData` (script line 722).
   - Enables the **Decode postMessage** button.
   - Calls `showToken(data.token)` to render the DC token in the legacy "Access token" panel.
3. There is **no origin allow-list**. Production code should validate `event.origin` against the configured parent origin. The diagnostic skips this because it loops back to the user as a debug surface.

### `lastMessageData` is the single source of truth

Once received, every downstream feature reads `lastMessageData`:

- The decoded panel iterates its keys.
- The embed modal reads `embedWorkspaceId`/`embedReportId` to pre-fill, and `embedToken`/`aadToken`/`embedUrl` to embed.
- The DAX panel reads workspace/report IDs and picks a token via `pickRestToken()`.
- The token toggle's `findBestPbiAadToken()` scans every string field, not just `aadToken`.

If you refactor to a state container, this object is your top-level state slice. Treat the message listener as a reducer that replaces it on every `AccessToken` message (the parent re-sends on token refresh).

---

## 3. Token model

Three logically distinct token types coexist in the postMessage. The page treats them differently because they have different signatures, audiences, and intended consumers.

| Token                     | Field          | Issuer (`iss`)                                                                                                                            | Algorithm                          | Audience (`aud`)                                                                                           | Used by                                                                                                                                |
| ------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **DataCentral JWT** | `token`      | `uiData` (or similar)                                                                                                                     | HS256                              | `uiData`                                                                                                   | DataCentral REST API (Bearer auth). Carries `Role`, `tenantId`. **Never** verifiable outside the DC backend (symmetric key). |
| **AAD user token**  | `aadToken`   | `https://sts.windows.net/<tenant>/`                                                                                                       | RS256                              | Variable —`Microsoft Graph`, or `analysis.windows.net/powerbi/api`, or anything else MSAL was asked for | Whatever audience it was minted for. The host decides at MSAL `acquireToken*` time.                                                  |
| **PBI embed token** | `embedToken` | `https://api.powerbi.com/...` (real embed token) **OR** `https://sts.windows.net/...` (SP-acquired AAD token mislabeled as embed) | RS256 (PBI service) or RS256 (AAD) | `https://analysis.windows.net/powerbi/api`                                                                 | Power BI iframe embed handshake.                                                                                                       |

The naming is misleading on purpose — the `embedToken` field has historically held both real `GenerateToken` output AND service-principal AAD tokens. The classifier handles both.

### Classifier — `classifyPbiToken(token)` (script lines 1190–1203)

Branches on `iss` regex, returns one of:

```javascript
{ kind: 'aad'     | 'embed' | 'unknown' | 'opaque' | 'none',
  iss: string?, aud: string?, decoded: { header, payload, signature }? }
```

- `aad` → `iss` matches `sts.windows.net | login.microsoftonline | login.windows.net` → SDK should use `TokenType.Aad`.
- `embed` → `iss` matches `api.powerbi.com | analysis.windows.net` (real PBI service issuer) → SDK should use `TokenType.Embed`.
- `unknown` → JWT decoded but `iss` matched nothing.
- `opaque` → not three dot-separated base64-url parts (probably encrypted).
- `none` → falsy input.

**This is the single point of authority for "what `TokenType` should I send to the SDK?"** Don't duplicate that logic; call this function. If you hit a new issuer pattern, add it here.

### Power BI Service audience constant

```javascript
const PBI_AUDIENCE = 'https://analysis.windows.net/powerbi/api';
```

A token is considered "PBI-compatible" if `aud === PBI_AUDIENCE` OR `aud` contains `'powerbi'` OR `aud` contains `'analysis.windows.net'`. The fuzzy match is intentional — Microsoft has historically issued tokens with slightly different forms of the same audience.

### Token discovery for embed — `findBestPbiAadToken(data)` (script lines 1237–1255)

Scans **every** string field in the postMessage (not just `aadToken`), classifies each, and ranks by:

```
score = (PBI audience ? 100 : 0) + (not expired ? 10 : 0)
```

Returns the highest-scoring AAD-issued token. This is what makes "the toggle is set to aadToken (PBI)" still work when the host put the PBI token in a non-obvious field name — common when one host migrates from sending Graph tokens in `aadToken` to sending PBI tokens in a new field while keeping backwards compatibility.

### Token selection for embed — `resolveTokenForChoice(choice)` (script lines 1259–1280)

Returns `{ token, source, field }`:

- `choice === 'aadToken'`:
  1. If the modal's override textarea has content → use that. `source = 'override (pasted)'`.
  2. Else `findBestPbiAadToken(data)` → if found AND `audPbi`, use it. `source = 'postMessage.<fieldname> (auto-found PBI audience)'`.
  3. Else fall back to the literal `data.aadToken` field. `source = 'postMessage.aadToken (no PBI-audience token in any field)'`.
- `choice === 'embedToken'`:
  - Returns `data.embedToken` directly. No fallback because by-name selection is what the user asked for.

### Token selection for REST — `pickRestToken()` (script lines 1613–1647)

Used by the DAX panel and `executeQueries`. **Different ranking** from `resolveTokenForChoice` because REST API calls are much more sensitive to audience mismatch than the iframe embed (which can sometimes get away with handshake-based fallback).

Three passes over `[aadToken, embedToken, token]` in order:

1. AAD-issued AND PBI audience → return.
2. Any token with PBI audience (covers real embed tokens) → return.
3. Any embed-issuer token → return.
4. Last resort: the first candidate available. Will probably 401, but the user gets a clear `executeQueries failed: 401 — …` message.

### Why the two functions diverge

Embed uses a postMessage-based handshake between the iframe and `app.powerbi.com`. The SDK accepts `TokenType.Aad` for either user or service-principal AAD tokens, and `TokenType.Embed` for real `GenerateToken` output. Both can satisfy the same iframe *if* the audience is right. So the embed picker can be optimistic.

REST `executeQueries` is a plain `fetch` with `Authorization: Bearer`. The PBI service rejects with 401 instantly if `aud != https://analysis.windows.net/powerbi/api`. So the REST picker is strict about audience.

---

## 4. UI panels

The page renders five `.panel` blocks inside the top-level `.grid`, plus a hidden modal. Layout is a CSS Grid with `auto-fit, minmax(360px, 1fr)`. Panels with `class="panel full"` span all columns.

### 4.1 Query parameters (lines 493–501)

Renders the URL's query string as a key-value list. `KNOWN_QUERY_KEYS = ['dcdata', 'dcsig']` (script line 673) — these are always shown even if missing, since they're contract fields the host uses to authenticate the iframe URL itself. The full URL is in a `<details>` block.

### 4.2 Embed context (lines 503–510)

Static sniffing on script load:

- `In iframe?` — `window.self !== window.top`.
- `Parent origin` — best-effort from `document.referrer`. Often `(unknown)` because referrer is policy-stripped.
- `My origin` — `window.location.origin`.
- `Referrer` — `document.referrer || '(none)'`.

These four are diagnostic-only; nothing else reads them.

### 4.3 Access token (lines 512–528)

Shows the DC `token` field from the postMessage — the legacy single-token view. Has its own minimal JWT-payload decoder. Three buttons:

| Button             | Handler                      | Effect                                                                                        |
| ------------------ | ---------------------------- | --------------------------------------------------------------------------------------------- |
| Re-send handshake  | `sendHandshake` (line 724) | Re-posts `AppReady ` to parent. Useful when token has rotated.                              |
| Copy token         | line 1846                    | Copies `receivedToken` (the `token` field, NOT `aadToken`/`embedToken`) to clipboard. |
| Decode postMessage | line 1842                    | Opens the next panel.                                                                         |

### 4.4 Decoded postMessage (lines 530–534, hidden until first decode)

`decodeMessage()` (script lines 1138–1176) iterates `Object.keys(lastMessageData)`, skipping `type`. For each value:

- If it parses as a JWT (`decodeJwt` → 3 base64-url parts), branches on issuer:
  - AAD-style issuer → `buildAadCard(jwt, fieldName)` (script lines 1034–1123)
  - Anything else → `buildDcCard(jwt, fieldName)` (script lines 967–1032)
- Otherwise → `buildUnknownField(name, value)` (script lines 1125–1136), shows raw value.

Each card has the same structure:

```
[icon] [Title — postMessage.<fieldName>] [pill: validity badge]
  IDENTITY        — claim grid
  TOKEN METADATA  — claim grid + validity bar
  APPLICATION     — only on AAD cards: app name/id, scopes as chips
  WHAT YOU CAN DO — bulleted list, dynamically built per token
  <details> Raw decoded JSON
```

The "What you can do with this" copy is computed per token — for the DC card it lists the role/tenant/algorithm; for the AAD card it switches on `aud` and `scp` to suggest concrete API calls (e.g., `GET /me` if `User.Read` is in scopes). When extending, keep this section honest — it's the most consulted part of the page.

### 4.5 fs 536–549)

The launcher panel. Two buttons (Embed → opens modal, Clear embed → resets the iframe), and a `<div id="pbiContainer">` that becomes a 600px-tall iframe host once embedding starts.

### 4.6 Embed modal (lines 587–632)

Full-screen overlay. The form has these inputs in order:

| ID                              | Default         | Notes                                                                                                                                                         |
| ------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `embedWorkspaceId`            | `adbdd3f4-…` | Pre-filled from `lastMessageData.embedWorkspaceId` if present.                                                                                              |
| `embedReportId`               | `b917bdc8-…` | Same.                                                                                                                                                         |
| `embedTenantId`               | `60ae6057-…` | Used for the `&ctid=` query param when on the AAD path. Embed tokens don't need it but the AAD path does (cross-tenant scenarios).                          |
| `embedTokenChoice` (radio)    | auto            | `embedToken` or `aadToken`. The `setTokenChoice` helper toggles the visual `.checked` class.                                                          |
| `aadTokenOverride` (textarea) | empty           | Hidden unless the toggle is on `aadToken`. Lets you paste a token from `az account get-access-token --resource https://analysis.windows.net/powerbi/api`. |
| `embedHint`                   | dynamic         | Live status: green if the picked token will work, amber otherwise, with the exact `iss`/`aud` shown.                                                      |

Closing: backdrop click (`data-close` attribute), × button, Cancel button, or `Esc` (line 1825).

Submission: form `submit` listener (line 1830) validates non-empty fields, closes the modal, calls `embedReport()`.

The hint is recomputed on:

- Token toggle click (line 1814).
- Workspace/report ID input (line 1822).
- Override textarea input (same listener).

The hint logic (`updateEmbedHint`, script lines 1282–1331) is the user's pre-flight conscience — it runs the same audience/ID checks `embedReport` does, so the user sees red flags before committing.

### 4.7 DAX query (lines 551–585)

Three IDs (workspace / report / dataset) and a textarea pre-filled with `DEFAULT_DAX` (script lines 1582–1606).

- `Run DAX query` → `runDaxQuery` (line 1685): full pipeline.
- `Resolve dataset ID` → just calls `ensureDatasetId`, populates the field, does nothing else.
- `Copy result` → clipboard.
- `Clear result` → resets pre/status.

### 4.8 Event log (lines 634–641)

A simple scrollable `<div>` that `log(tag, msg)` (lines 651–660) appends to. Tags map to colors:

```
info  →  --text   (default)
send  →  --accent (blue)
recv  →  --good   (green)
warn  →  --warn   (amber)
error →  --bad    (red)
```

Each entry: `<span class="ts">HH:MM:SS.fff</span><span class="tag">[TAG]</span> message`. The log is the most important debugging surface — the embed and DAX flows write extensively to it.

---

## 5. Power BI embed flow (`embedReport`)

Script lines 1403–1577. This is where most of the complexity lives.

### Inputs

- `workspaceId`, `reportId`, `tenantId` — from the modal form.
- Implicit: `lastMessageData`, the toggle state, the override textarea.

### Step-by-step

**1. SDK availability check** (line 1404).
`getPbiClient()` (lines 1365–1371) returns `{ service: window.powerbi, models: window['powerbi-client'].models }` or `null` if the CDN didn't load.

**2. Diagnostic logging** (lines 1419–1426).

- Form inputs.
- Host-provided IDs and `idsMatchHost` boolean.
- Toggle choice.
- One-line `tokenSummary()` for every token in the postMessage. `tokenSummary()` (lines 1382–1401) prints `kind/iss/aud/scp/roles/sub/exp` so you can grep the log.

**3. Token + URL selection** (lines 1432–1497).
Two branches keyed on the toggle:

#### `tokenChoice === 'embedToken'`

- Reads `data.embedToken` directly.
- Classifies it: if `iss` is `sts.windows.net`, uses `TokenType.Aad`; otherwise `TokenType.Embed`.
- **Embed URL**: prefers `data.embedUrl` (the host-provided URL with `&w=2&config=…clusterUrl…` blob) and only falls back to a constructed URL if missing.
- Warns if `idsMatchHost` is false (embed tokens are bound to specific IDs).

#### `tokenChoice === 'aadToken'`

- Calls `resolveTokenForChoice('aadToken')` to get the right token (override → auto-found PBI → literal field).
- Classifies: if it's actually an embed token (`kind === 'embed'`), still uses `TokenType.Embed`; otherwise `TokenType.Aad`.
- **Embed URL**: always constructed locally with `?reportId=&groupId=&ctid=`. The `ctid` matters for cross-tenant access; the embed token URL doesn't need it but the AAD path does.
- Pre-flight checks (lines 1471–1493):
  - Audience must contain `powerbi` or `analysis.windows.net` → otherwise logs `[ERROR] AAD token audience is "X" — NOT Power BI…` with the exact MSAL scope to acquire.
  - Scope must include `Report.Read` or `.default` → otherwise warns.
  - `exp * 1000 > Date.now()` → otherwise logs `EXPIRED`.

**4. Embed config object** (lines 1504–1518):

```javascript
{
  type: 'report',
  tokenType: <Aad | Embed>,         // resolved above
  accessToken: <string>,
  embedUrl: <string>,
  id: reportId,
  permissions: pbi.models.Permissions.Read,
  settings: {
    panes: {
      filters:        { expanded: false, visible: true },
      pageNavigation: { visible: true }
    },
    background: pbi.models.BackgroundType.Transparent
  }
}
```

If you need to support **embed-and-edit**, switch `permissions` to `Permissions.All` and the iframe will gain Save/Save-As capability — but the token must have write scopes.

**5. Container reset and embed** (lines 1499–1526):

```javascript
pbi.service.reset(container);   // idempotent, swallows errors on first embed
const report = pbi.service.embed(container, config);
```

**6. Event listeners** (lines 1528–1576). Crucial for debugging:

| Event        | Effect                                                                                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loaded`   | Logs success.                                                                                                                                                                                                                                |
| `rendered` | Logs success.                                                                                                                                                                                                                                |
| `warning`  | Logs the detail.                                                                                                                                                                                                                             |
| `error`    | Extracts every field PBI exposes:`errorCode`, `message`, `detailedMessage`, `level`, `technicalDetails.requestId`, `errorInfo`. Each on its own log line. Then matches against four common error codes and logs a friendly hint. |

The `requestId` is what Microsoft Support asks for when you escalate — make sure your production logger captures it.

### Common embed error → hint mapping (lines 1561–1575)

| Code or msg                                   | Hint                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `TokenExpired` / `'token has expired'`    | Re-handshake.                                                                                             |
| `PowerBINotAuthorizedException` / `'401'` | Audience or signature wrong. Need `aud=https://analysis.windows.net/powerbi/api` + `Report.Read.All`. |
| `'403'` / `PowerBIForbiddenException`     | Token valid but principal lacks workspace access. Add to workspace, check capacity.                       |
| `LoadReportFailed` + `'not found'`        | Wrong IDs.                                                                                                |

If you hit a code that isn't in the list, the underlying error fields are still logged — extend the map.

### Why the SDK calls `/metadata/cluster` (and what 403 means)

The PBI iframe at `app.powerbi.com/reportEmbed` issues a `GET https://api.powerbi.com/metadata/cluster` early in its boot to resolve the actual cluster (the `clusterUrl` in the `config=` blob is a redirect placeholder). With `TokenType.Embed`, that call uses the embed token; with `TokenType.Aad`, it uses the user/SP token. A 403 there means the token isn't valid for the metadata API specifically — usually wrong audience or the principal lacks workspace access.

### `Permissions-Policy: unload is not allowed` console violation

Benign noise emitted from inside Power BI's bundle. It's a Chrome deprecation warning about `unload` listeners in Permissions-Policy contexts. Not breaking; can't be fixed from inside this page (would need `<iframe allow="unload">` on the parent that hosts *us*). Document it in your runbook so support doesn't chase it.

---

## 6. DAX query flow (`runDaxQuery`)

Script lines 1685–1761.

### Pipeline

```
[user clicks Run]
    ↓
runDaxQuery
    ├─ pickRestToken            → choose best PBI-API token
    ├─ ensureDatasetId
    │   └─ resolveDatasetId    → GET /reports/{reportId} (PBI REST)
    │                            → returns r.datasetId
    └─ POST /datasets/{datasetId}/executeQueries
        body: { queries: [{ query }], serializerSettings: { includeNulls: true } }
        ↓
        results[0].tables[0].rows  (success path)
```

### Endpoint

```
POST https://api.powerbi.com/v1.0/myorg/groups/{workspaceId}/datasets/{datasetId}/executeQueries
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json
```

Body (lines 1714–1717):

```json
{
  "queries":            [{ "query": "EVALUATE ..." }],
  "serializerSettings": { "includeNulls": true }
}
```

`serializerSettings.includeNulls` keeps null cells in the response. Set to `false` to omit them — useful if your DAX returns sparse tables.

### Error handling

- `res.ok === false` → reads PBI's standard `{ error: { code, message } }` shape; surfaces `code — message` in the status line and the full body in the `<pre>`.
- Network throw → caught at line 1754; surfaces `e.message` plus any `responseText` we attached upstream (only on `resolveDatasetId` failure).
- Status line color reflects state via `setDaxStatus(state, msg)` where `state ∈ { '', 'ok', 'err' }`.

### Required scopes

| Operation                                                  | Minimum scope (delegated) | App role (service principal)        |
| ---------------------------------------------------------- | ------------------------- | ----------------------------------- |
| `GET /reports/{id}`                                      | `Report.Read.All`       | `Tenant.Read.All` (any read role) |
| `POST .../executeQueries` (read)                         | `Dataset.Read.All`      | `Dataset.Read.All`                |
| `POST .../executeQueries` (write — XMLA writes via DAX) | `Dataset.ReadWrite.All` | `Dataset.ReadWrite.All`           |

If you use service principal flow, the workspace must have the SP added as Member at minimum, and the tenant setting "Allow service principals to use Power BI APIs" must be on for the security group containing your SP. None of that is checked client-side; you'll get a 401/403 with `PowerBINotAuthorizedException`.

### Pre-fill timing quirk (lines 1795–1804)

The DAX panel pre-fills `daxWorkspaceId`/`daxReportId` from `lastMessageData.embed*` via a 500ms `setInterval` poll (clears itself once data arrives). This is a stop-gap from when the message listener and DAX panel were added in different sessions. **For a real app, fold this into the message listener** — no polling needed.

---

## 7. Decoded postMessage panel — extension points

`decodeMessage` (lines 1138–1176) is the piece you'll most likely extend if your host adds new fields. It's intentionally generic:

- Iterates **all** keys, not a hardcoded list.
- Routes by JWT issuer regex, not field name.
- Falls back to `buildUnknownField` for non-JWT values.

To add support for a new token type (e.g., a Snowflake JWT issued by your own auth service), you'd:

1. Add an `iss` regex match in `decodeMessage` (line 1169).
2. Write a `buildSnowflakeCard(jwt, fieldName)` mirroring `buildAadCard`.
3. Add an icon class in CSS (`.token-icon.snowflake { background: ... }`).
4. Optionally extend `KNOWN_AUDIENCES` (lines 791–800).
5. Optionally extend `CLAIM_LABELS` (lines 803–853) for friendly names.

The `el(tag, attrs, children)` helper (lines 920–937) and `claimGrid([[k, v, annot], …])` helper (lines 939–949) keep card markup terse. Use them rather than hand-rolling DOM.

### Validity bar logic (`validityState`, lines 907–918)

```
state = bad   if remaining < 5min  (or already past exp)
state = warn  if remaining < 30min
state = good  otherwise
pct   = remaining / total  (clamped to [2, 100])
```

If your tokens have different lifetimes (e.g., 5-minute embed tokens), the thresholds may produce misleading colors. Make `validityState` accept token-type-aware thresholds if you go that route.

---

## 8. Defaults, constants, and configuration

All defaults are inline. If you extract to a config file, keep these names:

| Value                                                         | Where                                                             | Purpose                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `APP_READY_TYPE = 'AppReady '` (trailing space)             | line 718                                                          | Wire protocol — DO NOT change without coordinating with parent.                    |
| `ACCESS_TOKEN_TYPE = 'AccessToken'`                         | line 719                                                          | Same.                                                                               |
| `PBI_AUDIENCE = 'https://analysis.windows.net/powerbi/api'` | line 1181                                                         | The string Power BI service tokens have as `aud`.                                 |
| `KNOWN_AUDIENCES`                                           | lines 791–800                                                    | Friendly-name map for AAD audience GUIDs/URLs. Extend as you onboard new resources. |
| `CLAIM_LABELS`                                              | lines 803–853                                                    | URN/opaque-claim → human label. Extend for any new claim you want to surface.      |
| Default workspace `adbdd3f4-…`                             | three places:`embedWorkspaceId` value, `daxWorkspaceId` value | Test workspace. Move to config.                                                     |
| Default report `b917bdc8-…`                                | three places:`embedReportId`, `daxReportId`                   | Test report.                                                                        |
| Default tenant `60ae6057-…`                                | `embedTenantId`                                                 | The Datacentral tenant.                                                             |
| `DEFAULT_DAX`                                               | lines 1582–1606                                                  | The continents/CO2 EVALUATE query.                                                  |
| Handshake retries: load + 250ms + 2000ms warning              | lines 1856–1872                                                  | Tune if your parent is slower.                                                      |
| `powerbi-client` version `2.23.1`                         | line 7                                                            | Pin or unpin per your supply-chain policy.                                          |

---

## 9. Logging — the contract for `log(tag, msg)`

Tags: `info | send | recv | warn | error`. The function only adds DOM nodes; if you want to mirror to `console`, the cleanest patch is to wrap the function — don't sprinkle `console.log` calls throughout.

For a real app, replace this with a structured logger (each entry as `{ ts, level, source, message, context }`). The current `escapeHtml` wrapper means you can't log objects; only strings. The diagnostic gets away with `JSON.stringify` at call sites — production code should structure data and let the logger format.

The log is unbounded — it'll grow forever in long sessions. Add a ring buffer (e.g., keep last 500 entries) if you're embedding for hours.

---

## 10. Failure modes and runbook

The page covers the major ones via inline hints; this is the master list for a runbook.

### Handshake failures

| Symptom                             | Likely cause                                                                         | Fix                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Pill stays "Awaiting token" past 2s | Parent listener attached too late, or this page not actually inside the right iframe | Click "Re-send handshake". If still nothing, parent's `Tool.url` doesn't match window origin or "Include access token" is off in tool config. |
| `[WARN] No parent window`         | Page opened directly, not in an iframe                                               | Open it inside the Datacentral host.                                                                                                            |

### Embed failures (`tokenChoice === 'embedToken'`)

| Symptom                                                                                         | Likely cause                                                                                      | Fix                                                                            |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Generic "Something went wrong / Try opening the report again"                                   | Click "Show details" twisty in the iframe; check log for `[ERROR] Power BI error:` lines.       | Use the friendly hints.                                                        |
| Hint warns "IDs differ from host-provided"                                                      | User changed the ID in the modal                                                                  | Embed tokens are bound to specific IDs — switch toggle to `aadToken (PBI)`. |
| `errorCode: TokenExpired`                                                                     | Stale data                                                                                        | Re-handshake.                                                                  |
| `403` on `metadata/cluster` (devtools network tab) with embedToken auto-detected as `Aad` | The `embedToken` field actually holds an SP AAD token, and the SP doesn't have workspace access | Add SP as workspace member.                                                    |

### Embed failures (`tokenChoice === 'aadToken'`)

| Hint says                                                                             | Cause                                                            | Fix                                                                                  |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `aud: https://graph.microsoft.com (NOT Power BI — will 401)`                       | Host is sending a Graph-audience token in the `aadToken` field | Use the override textarea with a CLI-acquired PBI token, or fix the host (see §11). |
| `aud: https://analysis.windows.net/powerbi/api (Power BI ✓)` but embed still fails | Token is right; permission is wrong                              | Add user to workspace; check tenant settings allow embedding.                        |
| `AAD token is EXPIRED`                                                              | Token > 1h old                                                   | Re-handshake.                                                                        |
| `scopes do not include Report.Read.All`                                             | Host acquired a token with restricted scopes                     | Host must request `Report.Read.All` (or `.default`) at MSAL acquireToken time.   |

### DAX failures

| Symptom                                                  | Cause                                                | Fix                                                 |
| -------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `Resolve dataset failed: HTTP 401`                     | No PBI-audience token available                      | Same as AAD embed — fix host or paste an override. |
| `executeQueries failed: PowerBINotAuthorizedException` | Token doesn't include `Dataset.Read.All`           | Add scope.                                          |
| `executeQueries failed: 400 — DAX query syntax error` | Self-explanatory; the response body has line/column. | Fix the DAX.                                        |
| `executeQueries failed: 429 — TooManyRequests`        | PBI throttled the call                               | Back off. The page doesn't currently retry.         |

### CORS

The PBI REST API (`api.powerbi.com`) supports CORS for browser clients with the right `Origin`. If you host this page on a non-allowlisted origin you may see opaque CORS errors; the diagnostic doesn't surface them well. Check the browser's network tab.

---

## 11. The upstream change for "AAD token works"

The diagnostic correctly identifies when the host is sending a Graph token under `aadToken`. The fix is in the **parent** Datacentral app, not here.

### Azure portal

1. App registration → **API permissions** → Add a permission → **Power BI Service** → **Delegated**.
2. Check at minimum: `Report.Read.All`, `Dataset.Read.All`. Add `Dataset.ReadWrite.All` if you want write paths to executeQueries to work.
3. Click **Grant admin consent** (or have a tenant admin do it).

### Code

In the parent (Angular: `embed-tool.component.ts`, or wherever the postMessage producer is), call MSAL **twice** — once for Graph (if anything still needs it) and once for Power BI:

```typescript
const account = msal.instance.getActiveAccount();

const pbiResult = await msal.instance.acquireTokenSilent({
  scopes: ['https://analysis.windows.net/powerbi/api/.default'],
  account
});

iframe.contentWindow.postMessage({
  type: 'AccessToken',
  token:    dcToken,
  aadToken: pbiResult.accessToken,   // PBI-audience instead of Graph
  embedToken, embedUrl,
  embedWorkspaceId, embedReportId
}, '*');
```

You **can't** combine `https://graph.microsoft.com/.default` and `https://analysis.windows.net/powerbi/api/.default` in one `acquireToken` call — they're different resources. Keep them as separate fields if both are needed.

### If you can't change the host

Use the override textarea in the modal with a CLI-acquired PBI token:

```bash
az login
az account get-access-token --resource https://analysis.windows.net/powerbi/api --query accessToken -o tsv
```

---

## 12. Security notes

This page is a **diagnostic**, not a production reference for security. If you extend, remember:

- **No origin allow-list** on the message listener (line 766). Production must validate `event.origin` against a known parent.
- **Target origin `'*'`** on the outgoing handshake (line 733). Acceptable here because the message has no secrets, but if you ever post anything sensitive outbound, compute the parent origin properly.
- **Tokens are rendered as DOM text** (`textContent`/`pre`), never `innerHTML`, so XSS-via-token is not a vector.
- **Tokens are copied to `navigator.clipboard`** on user action. Tokens aren't logged to console.
- **CSP**: there is none. The page loads `cdn.jsdelivr.net` unconditionally. Production should:
  - Add `Content-Security-Policy` with explicit `script-src` allowing only the CDN you trust.
  - Subresource-integrity-pin the `powerbi-client` script.
- **No automated token refresh**. The diagnostic relies on the user clicking "Re-send handshake". For long-lived UIs, listen for token-expiry warnings from the embed SDK and trigger a fresh handshake automatically.
- **No audit log**. Log entries live in the DOM only; reload destroys them.

---

## 13. Browser compatibility

The page uses:

- ES2017+ features: `async/await`, spread operators, template literals.
- `URLSearchParams`, `URL`, `Set`, `WeakMap` are not used but `URL`/`URLSearchParams` are.
- CSS Grid, CSS custom properties, `inset` shorthand (line 284), `:has()` is **not** used (an earlier draft did; replaced with explicit `.checked` class toggling because Firefox lagged).

Tested implicitly on current Edge/Chrome (Chromium). Should work on Firefox 121+ and Safari 16+.

The `unload` Permissions-Policy violation is Chromium-only console output.

---

## 14. Migration path to a real application

If you grow this into a production app, here's the suggested split. Each section maps cleanly to a module.

```
src/
  protocol/
    appReady.ts             constants APP_READY_TYPE, ACCESS_TOKEN_TYPE
    handshake.ts            sendHandshake, message listener (returns Observable<AccessTokenMessage>)
    types.ts                AccessTokenMessage interface
  jwt/
    decode.ts               b64UrlDecode, decodeJwt
    classify.ts             classifyPbiToken, PBI_AUDIENCE, KNOWN_AUDIENCES
    validity.ts             validityState, fmtAbsolute, fmtRelative
  tokens/
    selectForEmbed.ts       resolveTokenForChoice, findBestPbiAadToken
    selectForRest.ts        pickRestToken
  pbi/
    embed.ts                embedReport, the SDK config builder, error→hint map
    executeQueries.ts       runDaxQuery, resolveDatasetId
  ui/
    panels/
      QueryParams.tsx
      EmbedContext.tsx
      AccessToken.tsx
      DecodedPostMessage.tsx
      PbiEmbed.tsx
      DaxQuery.tsx
      EventLog.tsx
    EmbedModal.tsx
    cards/
      DcCard.tsx
      AadCard.tsx
      UnknownFieldCard.tsx
  log/
    logger.ts               structured logger; ringbuffer; console mirror
  config.ts                 defaults (workspace/report/tenant), powerbi-client version
```

A few specific traps when porting:

- **Don't lose the trailing space** in `'AppReady '` during refactors.
- **Keep `lastMessageData` as a single observable** rather than many separate fields — many derived values depend on the whole envelope.
- **The token toggle's "checked" visual state** is set via class toggling in JS, not via the radio input's state. If you switch to a framework-native radio, make sure the styling still applies — the original draft used `:has(input:checked)` but it was removed for browser-compat.
- **The DAX panel's pre-fill timer** is a smell that disappears when you have a proper observable.
- **`pickRestToken` and `resolveTokenForChoice` are intentionally different.** Don't merge them.

### Tests worth writing

- `decodeJwt` — handles Unicode (e.g., the Icelandic surname in the sample tokens) and missing/extra padding.
- `classifyPbiToken` — every issuer pattern, opaque tokens, malformed JWTs.
- `findBestPbiAadToken` — score order is stable when multiple PBI tokens are present.
- `pickRestToken` — three-pass fallback ordering.
- The embed error → hint mapping — every code in the table.

---

## 15. Quick reference

| I want to…                               | Where to look                                                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Change the postMessage shape              | §2; producer is in the upstream Angular app                                                                      |
| Add a new token type to the decoded panel | §7                                                                                                               |
| Add a new error code → hint mapping      | script lines 1561–1575                                                                                           |
| Change embed permissions to ReadWrite     | script line 1510 (`Permissions.Read` → `Permissions.All`)                                                    |
| Add a new MSAL audience                   | extend `KNOWN_AUDIENCES`, `classifyPbiToken`, and `findBestPbiAadToken` if it should be PBI-compatible      |
| Change the default DAX                    | script lines 1582–1606                                                                                           |
| Investigate "Something went wrong"        | event log; click "Show details" in the PBI iframe; §10                                                           |
| Verify a token is PBI-compatible          | open Decode panel; look for `aud: https://analysis.windows.net/powerbi/api` and `Power BI Service` annotation |
