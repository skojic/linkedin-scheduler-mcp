// `npm run login`. Repeat when the renewal issue appears (LinkedIn tokens last 60 days).
//
// 1. Gets the LinkedIn app's Client ID and Secret. On macOS they are kept in the
//    Keychain (asked once); elsewhere you are asked each time and nothing is stored.
// 2. Opens LinkedIn's consent page; receives the code on http://localhost:8765/callback.
// 3. Exchanges it for an access token and reads your member ID from /v2/userinfo.
// 4. Stores the token and person URN as GitHub Actions secrets via stdin, and the
//    expiry as a repository variable. The token is never printed or written to disk.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.LP_REPO_DIR ?? join(fileURLToPath(import.meta.url), "..", "..");
const SERVICE = process.env.LP_KEYCHAIN_SERVICE ?? "linkedin-publisher";
const PORT = 8765;
const REDIRECT = `http://localhost:${PORT}/callback`;
const SCOPES = "openid profile w_member_social";
const MAC = process.platform === "darwin";

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim();
  rl.close();
  return answer;
}

function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error("an interactive terminal is required to enter the client secret"));
  process.stdout.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let buf = "";
    const cleanup = () => { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); process.stdout.write("\n"); };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") { cleanup(); resolve(buf.trim()); return; }
        if (c === "\u0003") { cleanup(); reject(new Error("cancelled")); return; }
        if (c === "\u007f" || c === "\b") { buf = buf.slice(0, -1); continue; }
        buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

function keychainGet(account: string): string | null {
  if (!MAC) return null;
  const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function clientId(): Promise<string> {
  const stored = keychainGet("client_id");
  if (stored) return stored;
  const id = await ask("Client ID (Auth tab of your LinkedIn app): ");
  if (!/^[A-Za-z0-9]+$/.test(id)) throw new Error("that does not look like a Client ID");
  if (MAC) execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", "client_id", "-w", id]);
  return id;
}

async function clientSecret(): Promise<string> {
  const stored = keychainGet("client_secret");
  if (stored) return stored;
  if (MAC) {
    console.log('\nPaste the Primary Client Secret when macOS asks for the "password data" (typing is hidden; it asks twice).');
    // -w as the last argument makes `security` prompt itself, so the secret never passes through argv.
    const r = spawnSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", "client_secret", "-w"], { stdio: "inherit" });
    if (r.status !== 0) throw new Error("could not store the client secret in the Keychain");
    const secret = keychainGet("client_secret");
    if (!secret) throw new Error("client secret not found after storing it");
    return secret;
  }
  const secret = await askHidden("Primary Client Secret (hidden): ");
  if (!secret) throw new Error("no client secret entered");
  return secret;
}

function openBrowser(url: string): void {
  const cmd = MAC ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  const r = spawnSync(cmd[0] as string, cmd[1] as string[], { stdio: "ignore" });
  if (r.status !== 0) console.log(`\nOpen this URL in your browser:\n${url}\n`);
}

function waitForCode(state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const servers: Server[] = [];
    const done = (fn: () => void) => { servers.forEach((s) => s.close()); clearTimeout(timer); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error("timed out after 10 minutes waiting for LinkedIn"))), 600_000);
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", REDIRECT);
      if (url.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const page = (msg: string) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><body style="font-family:Georgia,serif;padding:3em"><p>${msg}</p></body>`);
      };
      if (url.searchParams.get("state") !== state) { page("State mismatch. Close this tab and run the login again."); done(() => reject(new Error("OAuth state mismatch"))); return; }
      const e = url.searchParams.get("error");
      if (e) { page(`LinkedIn returned an error: ${e}. You can close this tab.`); done(() => reject(new Error(`${e}: ${url.searchParams.get("error_description") ?? ""}`))); return; }
      const code = url.searchParams.get("code");
      if (!code) { page("No code received."); done(() => reject(new Error("no code in callback"))); return; }
      page("Done. You can close this tab and return to the terminal.");
      done(() => resolve(code));
    };
    // Listen on both loopback addresses: browsers may resolve "localhost" to either.
    for (const host of ["127.0.0.1", "::1"]) {
      const s = createServer(handler);
      s.on("error", (er: NodeJS.ErrnoException) => {
        if (er.code === "EADDRINUSE") done(() => reject(new Error(`port ${PORT} is in use`)));
      });
      s.listen(PORT, host);
      servers.push(s);
    }
  });
}

function ghSecret(name: string, value: string) {
  execFileSync("gh", ["secret", "set", name], { cwd: ROOT, input: value, stdio: ["pipe", "ignore", "inherit"] });
}

async function main() {
  const id = await clientId();
  const secret = await clientSecret();
  const state = randomBytes(16).toString("hex");
  const auth = new URL("https://www.linkedin.com/oauth/v2/authorization");
  auth.search = new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: REDIRECT, state, scope: SCOPES }).toString();

  const codePromise = waitForCode(state);
  console.log("\nOpening LinkedIn in your browser. Click Allow.");
  openBrowser(auth.toString());
  const code = await codePromise;

  const tokenRes = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: id, client_secret: secret }),
  });
  if (!tokenRes.ok) throw new Error(`token exchange failed: HTTP ${tokenRes.status} ${(await tokenRes.text()).slice(0, 300)}`);
  const tok = (await tokenRes.json()) as { access_token?: string; expires_in?: number; scope?: string };
  if (!tok.access_token || !tok.expires_in) throw new Error("token response missing access_token or expires_in");
  if (!(tok.scope ?? "").includes("w_member_social")) throw new Error(`token lacks w_member_social (scope: "${tok.scope}")`);

  const me = await fetch("https://api.linkedin.com/v2/userinfo", { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!me.ok) throw new Error(`userinfo failed: HTTP ${me.status}`);
  const info = (await me.json()) as { sub?: string; name?: string };
  if (!info.sub) throw new Error("userinfo has no sub");

  const expiresAt = new Date(Date.now() + tok.expires_in * 1000).toISOString();
  ghSecret("LINKEDIN_ACCESS_TOKEN", tok.access_token);
  ghSecret("LINKEDIN_PERSON_URN", `urn:li:person:${info.sub}`);
  execFileSync("gh", ["variable", "set", "LINKEDIN_TOKEN_EXPIRES_AT", "--body", expiresAt], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });

  console.log(`\nLogged in as ${info.name ?? "(name not returned)"}.`);
  console.log(`Token stored in GitHub secrets; expires ${expiresAt}. Scopes: ${tok.scope}`);
}

main().catch((e) => {
  console.error(`\nLogin failed: ${(e as Error).message}`);
  process.exitCode = 1;
});
