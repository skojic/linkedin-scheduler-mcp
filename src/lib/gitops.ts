import { execFileSync } from "node:child_process";

export function run(cmd: string, args: string[], cwd: string, input?: string): string {
  return execFileSync(cmd, args, { cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

export function tryRun(cmd: string, args: string[], cwd: string, input?: string): { ok: boolean; out: string } {
  try {
    return { ok: true, out: run(cmd, args, cwd, input) };
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    return { ok: false, out: (err.stderr || err.message).toString().trim() };
  }
}

// Commits the given paths and pushes. Returns false (never throws) if the push
// fails, so callers can decide whether that is safe to continue from.
export function commitAndPush(cwd: string, paths: string[], message: string, retries = 0): boolean {
  run("git", ["add", "--", ...paths], cwd);
  const staged = tryRun("git", ["diff", "--cached", "--quiet"], cwd);
  if (!staged.ok) run("git", ["commit", "-m", message], cwd);
  for (let i = 0; i <= retries; i++) {
    if (tryRun("git", ["push"], cwd).ok) return true;
    if (i < retries) tryRun("git", ["pull", "--rebase"], cwd);
  }
  return false;
}

// Opens an issue unless an open one with the same title already exists.
export function openIssue(cwd: string, title: string, body: string): void {
  const existing = tryRun("gh", ["issue", "list", "--state", "open", "--search", `"${title}" in:title`, "--json", "title"], cwd);
  if (existing.ok) {
    try {
      const list = JSON.parse(existing.out) as { title: string }[];
      if (list.some((i) => i.title === title)) return;
    } catch { /* fall through and create */ }
  }
  const withLabel = tryRun("gh", ["issue", "create", "--title", title, "--body", body, "--label", "publisher"], cwd);
  if (!withLabel.ok) {
    const plain = tryRun("gh", ["issue", "create", "--title", title, "--body", body], cwd);
    if (!plain.ok) console.error(`::error::could not open issue "${title}": ${plain.out}`);
  }
}

export function runUrl(): string {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  return GITHUB_RUN_ID ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}` : "(local run)";
}
