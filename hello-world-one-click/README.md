# One-click Hello World App

This is a single-file HTML app.

## Use it

1. Deploy `index.html` to any static host.
2. Register that URL as a DataCentral App.
3. Assign roles.
4. Open from DataCentral.

The app reads:

```text
dcdata
dcsig
```

and displays the decoded DataCentral payload.

For signature verification in this single-file demo, paste the App secret into:

```js
const SHARED_SECRET = "";
```

For real apps, verify signatures on the backend instead.
