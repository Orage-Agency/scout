// One-shot helper that does the Google OAuth dance for the Chrome Web Store
// API and prints a refresh token. Run once after creating a Desktop OAuth
// Client ID in Google Cloud Console with the Chrome Web Store API enabled.
//
// Usage:
//   node scripts/get-cws-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
//
// What it does:
//   1. Spins up a localhost server on a random port.
//   2. Opens your browser to the Google consent screen with that port as the
//      redirect.
//   3. Captures the auth code, exchanges it for tokens, prints the refresh.
//   4. Stash the printed refresh token + your client id/secret as
//      CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN secrets at
//      github.com/Orage-Agency/scout/settings/secrets/actions.

import http from "node:http";
import { exec } from "node:child_process";
import { exit } from "node:process";

const [, , clientId, clientSecret] = process.argv;
if (!clientId || !clientSecret) {
  console.error("Usage: node scripts/get-cws-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>");
  exit(1);
}

const SCOPE = "https://www.googleapis.com/auth/chromewebstore";

const server = http.createServer(async (req, res) => {
  if (!req.url) return;
  const url = new URL(req.url, `http://127.0.0.1:${(server.address()).port}`);
  if (url.pathname !== "/cb") {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("missing ?code");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<h1>OK</h1><p>You can close this tab.</p>");

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `http://127.0.0.1:${(server.address()).port}/cb`,
        grant_type: "authorization_code",
      }),
    });
    const json = await tokenRes.json();
    if (!tokenRes.ok) {
      console.error("token exchange failed:", json);
      exit(1);
    }
    console.log("\n--- copy these values into GitHub Actions secrets ---");
    console.log(`CWS_CLIENT_ID=${clientId}`);
    console.log(`CWS_CLIENT_SECRET=${clientSecret}`);
    console.log(`CWS_REFRESH_TOKEN=${json.refresh_token}`);
    console.log("");
    server.close();
  } catch (err) {
    console.error(err);
    exit(1);
  }
});

server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/cb`;
  const consentUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  consentUrl.searchParams.set("client_id", clientId);
  consentUrl.searchParams.set("redirect_uri", redirectUri);
  consentUrl.searchParams.set("response_type", "code");
  consentUrl.searchParams.set("scope", SCOPE);
  consentUrl.searchParams.set("access_type", "offline");
  consentUrl.searchParams.set("prompt", "consent");

  console.log(`Listening on ${redirectUri}`);
  console.log(`Opening browser to:\n${consentUrl}\n`);
  // Cross-platform "open URL" — Windows uses `start`, Mac `open`, Linux `xdg-open`.
  const opener = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  exec(`${opener} "${consentUrl.toString()}"`);
});
