import type { Visibility } from "./queue.ts";

const API = "https://api.linkedin.com";

export interface Client {
  token: string;
  version: string; // YYYYMM, sent as Linkedin-Version
}

function headers(c: Client, json = true): Record<string, string> {
  return {
    Authorization: `Bearer ${c.token}`,
    "Linkedin-Version": c.version,
    "X-Restli-Protocol-Version": "2.0.0",
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

// Outcome classes drive retry safety:
// - "rejected": LinkedIn answered 4xx, so nothing was created. Safe to retry.
// - "unknown":  5xx, timeout or network error. A post MAY exist. Never retry.
export class LinkedInError extends Error {
  kind: "rejected" | "unknown";
  status?: number;
  body?: string;
  constructor(kind: "rejected" | "unknown", message: string, status?: number, body?: string) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.body = body;
  }
}

async function call(url: string, init: RequestInit, what: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    throw new LinkedInError("unknown", `${what}: network error or timeout (${(e as Error).message})`);
  }
  if (res.ok) return res;
  const body = (await res.text()).slice(0, 2000);
  const kind = res.status >= 400 && res.status < 500 ? "rejected" : "unknown";
  throw new LinkedInError(kind, `${what}: HTTP ${res.status}`, res.status, body);
}

export async function uploadImage(c: Client, ownerUrn: string, bytes: Uint8Array): Promise<string> {
  const init = await call(
    `${API}/rest/images?action=initializeUpload`,
    { method: "POST", headers: headers(c), body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }) },
    "initializeUpload",
  );
  const data = (await init.json()) as { value?: { uploadUrl?: string; image?: string } };
  const uploadUrl = data.value?.uploadUrl;
  const image = data.value?.image;
  if (!uploadUrl || !image) throw new LinkedInError("rejected", "initializeUpload: response missing uploadUrl or image");
  await call(
    uploadUrl,
    { method: "PUT", headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/octet-stream" }, body: bytes },
    "image upload",
  );
  return image;
}

export interface PostRequest {
  author: string;
  commentary: string; // already little-text escaped
  visibility: Visibility;
  imageUrn: string;
  altText?: string;
}

export function postBody(p: PostRequest): Record<string, unknown> {
  const media: Record<string, string> = { id: p.imageUrn };
  if (p.altText) media.altText = p.altText;
  return {
    author: p.author,
    commentary: p.commentary,
    visibility: p.visibility,
    distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
    content: { media },
    lifecycleState: "PUBLISHED",
    isReshareDisabledByAuthor: false,
  };
}

export async function createPost(c: Client, p: PostRequest): Promise<string> {
  const res = await call(`${API}/rest/posts`, { method: "POST", headers: headers(c), body: JSON.stringify(postBody(p)) }, "create post");
  const urn = res.headers.get("x-restli-id");
  // The post exists (2xx) even if the header is missing, so this is "unknown", not "rejected".
  if (!urn) throw new LinkedInError("unknown", "create post: 2xx but no x-restli-id header");
  return urn;
}

export function postUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}

export function isMediaNotReady(e: unknown): boolean {
  return e instanceof LinkedInError && e.kind === "rejected" && /media|image|asset|process/i.test(e.body ?? "");
}
