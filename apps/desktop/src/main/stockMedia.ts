// Stock media search and download (Pexels / Pixabay video, Jamendo music).
// Owned by the main process: it holds the API keys (safeStorage, keys.ts), makes
// every HTTP call, and writes the downloaded files under the data root. The
// renderer only ever sends a query or a (provider, id) it got back from a search
// — never a URL — so a compromised renderer cannot turn this into a general
// fetch-and-write primitive.
//
// Everything that touches Electron, the network or the disk is injected
// (`StockMediaDeps`), so the normalization, caching, host checks and file naming
// are unit-tested in plain Node (stockMedia.test.ts). The Electron wiring lives
// in stockMediaIpc.ts.

import {
  isStockProvider,
  type StockDownloadRequest,
  type StockItem,
  type StockProvider,
  type StockSearchRequest,
  type StockSearchResult,
} from "../shared/stock-media.js";

/// Results per page, for every catalog. Inside every provider's limits
/// (Pixabay 3-200, Pexels ≤80, Jamendo ≤200) and a full grid at the dialog's
/// widths.
export const STOCK_PAGE_SIZE = 24;

/// Pixabay's terms require caching API responses for 24 hours; one rule for all
/// three keeps a re-typed query from spending anyone's rate limit.
export const STOCK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const MAX_QUERY_CHARS = 100;
const MAX_PAGE = 100;

/// Hosts a provider's downloads and previews may come from. Matched as a
/// suffix on a dot boundary: `cdn.pixabay.com` passes `pixabay.com`,
/// `evilpixabay.com` does not.
export const STOCK_DOWNLOAD_HOSTS: Record<StockProvider, readonly string[]> = {
  // Pexels serves files from videos.pexels.com; older entries still point at
  // its Vimeo-backed CDN.
  pexels: ["pexels.com", "vimeo.com", "vimeocdn.com"],
  pixabay: ["pixabay.com"],
  jamendo: ["jamendo.com"],
};

/// Error codes the renderer turns into a localized message. Thrown as
/// `Error("stock:<code>")` so the code survives Electron's IPC error wrapping.
export type StockErrorCode =
  | "no_key"
  | "invalid_key"
  | "rate_limited"
  | "bad_request"
  | "not_found"
  | "network"
  | "download_failed";

export class StockError extends Error {
  constructor(public readonly code: StockErrorCode, detail?: string) {
    super(`stock:${code}${detail ? ` ${detail}` : ""}`);
    this.name = "StockError";
  }
}

export interface StockHttpResponse {
  status: number;
  json: unknown;
}

export interface StockMediaDeps {
  getJson(url: string, headers: Record<string, string>): Promise<StockHttpResponse>;
  /// Stream `url` into `dest` (via a temp file + rename). Resolves with the HTTP
  /// status; anything but 2xx must leave no file at `dest`.
  download(url: string, dest: string): Promise<number>;
  getKey(provider: StockProvider): string | null;
  fs: {
    mkdirp(dir: string): void;
    /// Size in bytes of a regular file, or null when there is none.
    statBytes(path: string): number | null;
    appendText(path: string, text: string): void;
  };
  join(...parts: string[]): string;
  /// `<dataRoot>/stock`.
  stockDir: string;
  now(): number;
}

/// What a search remembers about each result so a later download can be
/// served without trusting anything the renderer sends back.
interface Downloadable {
  item: StockItem;
  url: string;
  ext: string;
}

export interface StockMedia {
  search(req: StockSearchRequest): Promise<StockSearchResult>;
  download(req: StockDownloadRequest): Promise<{ path: string }>;
}

// ---------------------------------------------------------------------------
// Validation

export function validateSearch(raw: unknown): StockSearchRequest {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!isStockProvider(o.provider)) throw new StockError("bad_request", "provider");
  const query = typeof o.query === "string" ? o.query.trim().slice(0, MAX_QUERY_CHARS) : "";
  if (query === "") throw new StockError("bad_request", "query");
  const page = typeof o.page === "number" && Number.isSafeInteger(o.page) ? o.page : 1;
  return { provider: o.provider, query, page: Math.min(MAX_PAGE, Math.max(1, page)) };
}

export function validateDownload(raw: unknown): StockDownloadRequest {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (!isStockProvider(o.provider)) throw new StockError("bad_request", "provider");
  const id = typeof o.id === "string" ? o.id : typeof o.id === "number" ? String(o.id) : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new StockError("bad_request", "id");
  return { provider: o.provider, id };
}

/// True when `url` is https and its host is (a subdomain of) one of the
/// provider's download hosts.
export function isAllowedStockUrl(provider: StockProvider, url: string): boolean {
  let host: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  return STOCK_DOWNLOAD_HOSTS[provider].some((h) => host === h || host.endsWith(`.${h}`));
}

// ---------------------------------------------------------------------------
// Small readers for untrusted JSON

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const https = (v: unknown): string | null => {
  const s = str(v);
  return /^https:\/\//i.test(s) ? s : null;
};

/// Pexels has no titles; its page URL carries a slug
/// (`/video/waves-crashing-on-rocks-1234/`). Turn that back into words.
export function titleFromPexelsUrl(url: string, id: string): string {
  const m = /\/video\/([^/?#]+?)\/?(?:[?#].*)?$/.exec(url);
  if (!m) return `Pexels ${id}`;
  const words = m[1]!.replace(new RegExp(`-?${id}$`), "").replace(/-+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : `Pexels ${id}`;
}

/// `http://creativecommons.org/licenses/by-nc-sa/3.0/` → `CC BY-NC-SA 3.0`.
export function ccLicenseLabel(url: string): string {
  const m = /creativecommons\.org\/licenses\/([a-z-]+)\/([\d.]+)/i.exec(url);
  if (m) return `CC ${m[1]!.toUpperCase()} ${m[2]}`;
  if (/creativecommons\.org\/publicdomain/i.test(url)) return "CC0";
  return "Creative Commons";
}

/// A filesystem-safe ASCII slug for the downloaded file's name.
export function slugify(text: string, max = 40): string {
  const s = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return s;
}

/// Pick the rendition to download: the widest one no wider than 1920 (a full-HD
/// timeline gains nothing from a 4K stock clip and the download is 4× the
/// size); failing that, the narrowest one available.
export function pickRendition<T extends { width: number | null }>(files: T[], maxWidth = 1920): T | null {
  const sized = files.filter((f) => f.width !== null);
  const fit = sized.filter((f) => f.width! <= maxWidth).sort((a, b) => b.width! - a.width!);
  if (fit[0]) return fit[0];
  const over = sized.sort((a, b) => a.width! - b.width!);
  return over[0] ?? files[0] ?? null;
}

// ---------------------------------------------------------------------------
// Per-provider request + normalization

interface ProviderPage {
  entries: Downloadable[];
  hasMore: boolean;
}

interface ProviderAdapter {
  request(key: string, query: string, page: number): { url: string; headers: Record<string, string> };
  parse(json: unknown, page: number): ProviderPage;
}

export const pexels: ProviderAdapter = {
  request(key, query, page) {
    const q = new URLSearchParams({ query, page: String(page), per_page: String(STOCK_PAGE_SIZE) });
    return { url: `https://api.pexels.com/videos/search?${q}`, headers: { Authorization: key } };
  },
  parse(json, page) {
    const root = obj(json);
    const entries: Downloadable[] = [];
    for (const raw of arr(root.videos)) {
      const v = obj(raw);
      const id = str(v.id);
      const files = arr(v.video_files)
        .map(obj)
        .filter((f) => str(f.file_type) === "video/mp4" && https(f.link) !== null)
        .map((f) => ({ url: https(f.link)!, width: num(f.width), height: num(f.height) }));
      const pick = pickRendition(files);
      if (!id || !pick || !isAllowedStockUrl("pexels", pick.url)) continue;
      const preview = pickRendition(files, 960);
      const user = obj(v.user);
      const pageUrl = https(v.url) ?? `https://www.pexels.com/video/${id}/`;
      entries.push({
        url: pick.url,
        ext: "mp4",
        item: {
          provider: "pexels",
          id,
          kind: "video",
          title: titleFromPexelsUrl(pageUrl, id),
          author: str(user.name) || "Pexels",
          authorUrl: https(user.url),
          pageUrl,
          thumbnailUrl: https(v.image),
          previewUrl: preview?.url ?? null,
          durationSec: num(v.duration),
          width: pick.width ?? num(v.width),
          height: pick.height ?? num(v.height),
          license: "Pexels License",
          licenseUrl: "https://www.pexels.com/license/",
        },
      });
    }
    const total = num(root.total_results);
    const hasMore = typeof root.next_page === "string" || (total !== null && page * STOCK_PAGE_SIZE < total);
    return { entries, hasMore };
  },
};

export const pixabay: ProviderAdapter = {
  request(key, query, page) {
    const q = new URLSearchParams({
      key,
      q: query,
      page: String(page),
      per_page: String(STOCK_PAGE_SIZE),
      safesearch: "true",
    });
    return { url: `https://pixabay.com/api/videos/?${q}`, headers: {} };
  },
  parse(json, page) {
    const root = obj(json);
    const entries: Downloadable[] = [];
    for (const raw of arr(root.hits)) {
      const h = obj(raw);
      const id = str(h.id);
      const videos = obj(h.videos);
      const renditions = (["large", "medium", "small", "tiny"] as const)
        .map((size) => obj(videos[size]))
        .filter((r) => https(r.url) !== null)
        .map((r) => ({ url: https(r.url)!, width: num(r.width), height: num(r.height), thumb: https(r.thumbnail) }));
      const pick = pickRendition(renditions);
      if (!id || !pick || !isAllowedStockUrl("pixabay", pick.url)) continue;
      const preview = pickRendition(renditions, 960);
      const user = str(h.user);
      const userId = str(h.user_id);
      const tags = str(h.tags);
      entries.push({
        url: pick.url,
        ext: "mp4",
        item: {
          provider: "pixabay",
          id,
          kind: "video",
          title: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 3).join(", ") : `Pixabay ${id}`,
          author: user || "Pixabay",
          authorUrl: user && userId ? `https://pixabay.com/users/${encodeURIComponent(user)}-${userId}/` : null,
          pageUrl: https(h.pageURL) ?? `https://pixabay.com/videos/id-${id}/`,
          thumbnailUrl: renditions.find((r) => r.thumb)?.thumb ?? null,
          previewUrl: preview?.url ?? null,
          durationSec: num(h.duration),
          width: pick.width,
          height: pick.height,
          license: "Pixabay Content License",
          licenseUrl: "https://pixabay.com/service/license-summary/",
        },
      });
    }
    const total = num(root.totalHits);
    return { entries, hasMore: total !== null && page * STOCK_PAGE_SIZE < total };
  },
};

export const jamendo: ProviderAdapter = {
  request(key, query, page) {
    const q = new URLSearchParams({
      client_id: key,
      format: "json",
      limit: String(STOCK_PAGE_SIZE),
      offset: String((page - 1) * STOCK_PAGE_SIZE),
      search: query,
      audioformat: "mp32",
      audiodlformat: "mp32",
      include: "licenses",
      fullcount: "true",
    });
    return { url: `https://api.jamendo.com/v3.0/tracks/?${q}`, headers: {} };
  },
  parse(json, page) {
    const root = obj(json);
    const head = obj(root.headers);
    // Jamendo answers 200 with `headers.status: "failed"` for a bad client_id.
    if (str(head.status) === "failed") {
      const code = num(head.code);
      throw new StockError(code === 5 || code === 7 ? "invalid_key" : "bad_request", str(head.error_message));
    }
    const entries: Downloadable[] = [];
    const results = arr(root.results);
    for (const raw of results) {
      const t = obj(raw);
      const id = str(t.id);
      // Only tracks the artist allows apps to offer for download.
      const dl = t.audiodownload_allowed === false ? null : https(t.audiodownload);
      if (!id || !dl || !isAllowedStockUrl("jamendo", dl)) continue;
      const ccUrl = str(t.license_ccurl);
      const artistId = str(t.artist_id);
      entries.push({
        url: dl,
        ext: "mp3",
        item: {
          provider: "jamendo",
          id,
          kind: "audio",
          title: str(t.name) || `Jamendo ${id}`,
          author: str(t.artist_name) || "Jamendo",
          authorUrl: artistId ? `https://www.jamendo.com/artist/${artistId}` : null,
          pageUrl: https(t.shareurl) ?? `https://www.jamendo.com/track/${id}`,
          thumbnailUrl: https(t.image) ?? https(t.album_image),
          previewUrl: https(t.audio),
          durationSec: num(t.duration),
          width: null,
          height: null,
          license: ccUrl ? ccLicenseLabel(ccUrl) : "Jamendo",
          licenseUrl: ccUrl ? ccUrl.replace(/^http:/i, "https:") : null,
        },
      });
    }
    const full = num(head.results_fullcount);
    const hasMore = full !== null ? page * STOCK_PAGE_SIZE < full : results.length === STOCK_PAGE_SIZE;
    return { entries, hasMore };
  },
};

const ADAPTERS: Record<StockProvider, ProviderAdapter> = { pexels, pixabay, jamendo };

function statusError(status: number): StockError {
  if (status === 401 || status === 403) return new StockError("invalid_key");
  if (status === 429) return new StockError("rate_limited");
  if (status === 400) return new StockError("bad_request");
  return new StockError("network", `HTTP ${status}`);
}

/// The credit line appended to `<stockDir>/CREDITS.txt` for every download, so
/// the attribution the licenses ask for (CC BY on most Jamendo tracks) stays
/// next to the files.
export function creditLine(fileName: string, item: StockItem): string {
  const license = item.licenseUrl ? `${item.license} (${item.licenseUrl})` : item.license;
  return `${fileName}\t"${item.title}" by ${item.author} — ${item.pageUrl} — ${license}\n`;
}

// ---------------------------------------------------------------------------

export function createStockMedia(deps: StockMediaDeps): StockMedia {
  const cache = new Map<string, { at: number; result: StockSearchResult }>();
  const known = new Map<string, Downloadable>();
  const inFlight = new Map<string, Promise<{ path: string }>>();
  const knownKey = (p: StockProvider, id: string) => `${p}:${id}`;

  function keyFor(provider: StockProvider): string {
    const key = deps.getKey(provider)?.trim();
    if (!key) throw new StockError("no_key");
    return key;
  }

  async function search(raw: StockSearchRequest): Promise<StockSearchResult> {
    const req = validateSearch(raw);
    const key = keyFor(req.provider);
    // The key is part of the cache key: a corrected key must not be answered
    // from the error-free cache of a different account, and vice versa.
    const cacheKey = `${req.provider}\u0000${key}\u0000${req.query.toLowerCase()}\u0000${req.page}`;
    const hit = cache.get(cacheKey);
    if (hit && deps.now() - hit.at < STOCK_CACHE_TTL_MS) return hit.result;

    const adapter = ADAPTERS[req.provider];
    const { url, headers } = adapter.request(key, req.query, req.page);
    let res: StockHttpResponse;
    try {
      res = await deps.getJson(url, headers);
    } catch (e) {
      throw new StockError("network", e instanceof Error ? e.message : String(e));
    }
    if (res.status < 200 || res.status >= 300) throw statusError(res.status);
    const parsed = adapter.parse(res.json, req.page);
    for (const d of parsed.entries) known.set(knownKey(d.item.provider, d.item.id), d);
    const result: StockSearchResult = {
      items: parsed.entries.map((d) => d.item),
      page: req.page,
      hasMore: parsed.hasMore,
    };
    cache.set(cacheKey, { at: deps.now(), result });
    return result;
  }

  async function doDownload(entry: Downloadable): Promise<{ path: string }> {
    const { item } = entry;
    if (!isAllowedStockUrl(item.provider, entry.url)) throw new StockError("download_failed", "host");
    const dir = deps.join(deps.stockDir, item.provider);
    deps.fs.mkdirp(dir);
    const slug = slugify(item.title);
    const fileName = `${item.provider}-${item.id}${slug ? `-${slug}` : ""}.${entry.ext}`;
    const dest = deps.join(dir, fileName);
    // Already downloaded (same item asked for twice, or a previous session):
    // hand back the file instead of fetching it again.
    if ((deps.fs.statBytes(dest) ?? 0) > 0) return { path: dest };
    let status: number;
    try {
      status = await deps.download(entry.url, dest);
    } catch (e) {
      throw new StockError("download_failed", e instanceof Error ? e.message : String(e));
    }
    if (status < 200 || status >= 300) throw new StockError("download_failed", `HTTP ${status}`);
    try {
      deps.fs.appendText(deps.join(deps.stockDir, "CREDITS.txt"), creditLine(fileName, item));
    } catch {
      /* Credits are a courtesy file; a failed append never fails the download. */
    }
    return { path: dest };
  }

  async function download(raw: StockDownloadRequest): Promise<{ path: string }> {
    const req = validateDownload(raw);
    const k = knownKey(req.provider, req.id);
    const entry = known.get(k);
    // Only results this session has seen can be downloaded — the URL comes
    // from the catalog's answer, never from the renderer.
    if (!entry) throw new StockError("not_found");
    const pending = inFlight.get(k);
    if (pending) return pending;
    const p = doDownload(entry).finally(() => inFlight.delete(k));
    inFlight.set(k, p);
    return p;
  }

  return { search, download };
}
