// Stock media search (free-to-use video and music from public catalogs), shared
// by the Electron main process (owner of the API keys, the HTTP calls and the
// downloads — src/main/stockMedia.ts) and the renderer (the search dialog).
//
// The renderer never sees a key and never hands main a URL to fetch: it sends a
// query, gets normalized results back, and asks main to download one of THOSE
// results by provider + id. Main re-checks the download host against the
// provider's allowlist before it opens a connection.

/// One catalog. Each needs its own free key, typed once in the Stock dialog and
/// kept in safeStorage (main/keys.ts) under `stock_<provider>`.
export type StockProvider = "pexels" | "pixabay" | "jamendo";

export type StockKind = "video" | "audio";

export interface StockProviderInfo {
  id: StockProvider;
  /// What the catalog serves. Pexels and Pixabay are video here; Jamendo is
  /// music (Pixabay's own music library has no public API).
  kind: StockKind;
  label: string;
  /// Where the user gets a key.
  keyUrl: string;
  /// The catalog's home page, linked from the attribution line.
  homeUrl: string;
}

export const STOCK_PROVIDERS: readonly StockProviderInfo[] = [
  {
    id: "pexels",
    kind: "video",
    label: "Pexels",
    keyUrl: "https://www.pexels.com/api/new/",
    homeUrl: "https://www.pexels.com",
  },
  {
    id: "pixabay",
    kind: "video",
    label: "Pixabay",
    keyUrl: "https://pixabay.com/api/docs/",
    homeUrl: "https://pixabay.com",
  },
  {
    id: "jamendo",
    kind: "audio",
    label: "Jamendo",
    keyUrl: "https://devportal.jamendo.com/",
    homeUrl: "https://www.jamendo.com",
  },
];

export function isStockProvider(v: unknown): v is StockProvider {
  return typeof v === "string" && STOCK_PROVIDERS.some((p) => p.id === v);
}

/// The `cloud_keys.json` tag a provider's key is stored under. Prefixed so it
/// can never collide with a speech provider tag, and so the startup loop that
/// pushes speech keys into the Rust backend can skip it.
export const STOCK_KEY_PREFIX = "stock_";
export const stockKeyTag = (p: StockProvider): string => `${STOCK_KEY_PREFIX}${p}`;

/// One search result, normalized across catalogs.
export interface StockItem {
  provider: StockProvider;
  /// The catalog's own id, as a string.
  id: string;
  kind: StockKind;
  title: string;
  author: string;
  authorUrl: string | null;
  /// The item's page on the catalog — the attribution link.
  pageUrl: string;
  /// A still for the result grid (video) or the cover (music).
  thumbnailUrl: string | null;
  /// A small, streamable rendition for hover / click preview.
  previewUrl: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  /// Human-readable license, e.g. "Pexels License" or "CC BY-SA 3.0".
  license: string;
  licenseUrl: string | null;
}

export interface StockSearchRequest {
  provider: StockProvider;
  query: string;
  /// 1-based.
  page: number;
}

export interface StockSearchResult {
  items: StockItem[];
  page: number;
  hasMore: boolean;
}

export interface StockDownloadRequest {
  provider: StockProvider;
  id: string;
}

export interface StockDownloadResult {
  /// Absolute path of the downloaded file. Main has already handed it to the
  /// media pool's import pipeline.
  path: string;
}

export interface StockKeyStatus {
  provider: StockProvider;
  hasKey: boolean;
}

/// The contextBridge surface (WeftcutApi.stock).
export interface StockMediaApi {
  keyStatus(): Promise<StockKeyStatus[]>;
  /// Empty string clears the key.
  setKey(provider: StockProvider, key: string): Promise<void>;
  search(request: StockSearchRequest): Promise<StockSearchResult>;
  download(request: StockDownloadRequest): Promise<StockDownloadResult>;
}
