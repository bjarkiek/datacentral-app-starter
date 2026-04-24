# DataCentral App Starter

A starter repository for building external apps that plug into DataCentral as embedded Apps/Tools.

DataCentral handles authentication, tenant context, and role-based access. Your app receives a signed launch payload using:

```text
?dcdata=<BASE64_JSON>&dcsig=<BASE64_HMAC_SHA256>
```

This starter includes:

- React + Vite frontend
- .NET 8 API backend
- DataCentral launch payload parsing
- Signature verification
- Role display
- Backend `/api/me` endpoint
- One-file Hello World app for quick testing

## Repository structure

```text
src/
  DataCentral.AppStarter.Admin/   React/Vite frontend
  DataCentral.AppStarter.Api/     .NET 8 API backend
hello-world-one-click/            Single-file Hello World app
```

## 5-minute local run

### 1. Start the API

```bash
cd src/DataCentral.AppStarter.Api
dotnet run
```

The API listens on:

```text
https://localhost:7055
http://localhost:5055
```

### 2. Start the frontend

```bash
cd src/DataCentral.AppStarter.Admin
npm install
npm run dev
```

Open:

```text
http://localhost:5173
```

Localhost runs in developer mode and allows anonymous/demo context when no signed DataCentral launch payload exists.

## Configure as a DataCentral App

In DataCentral:

1. Go to Administration -> Tools/Apps
2. Create a new App
3. Set the App URL to your deployed frontend
4. Set a per-app shared secret
5. Assign roles
6. Open the App from DataCentral

DataCentral will launch the app as:

```text
https://your-app.example.com/?dcdata=<BASE64_JSON>&dcsig=<BASE64_HMAC_SHA256>
```

## Production security note

The recommended production path is backend-side verification:

1. Frontend receives `dcdata` and `dcsig`.
2. Frontend forwards them to the backend as headers.
3. Backend verifies HMAC using the App secret.
4. Backend returns trusted user context.

This avoids baking the shared secret into frontend JavaScript.

The one-click HTML sample includes frontend verification only because it has no backend. Treat that as a low-security demo pattern.
