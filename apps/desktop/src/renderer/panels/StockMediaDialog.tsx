import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckIcon,
  LinkIcon,
  LoaderCircleIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
} from "lucide-react";

import { AppDialog } from "../components/AppDialog";
import { AppInput } from "../components/AppInput";
import { AppSelect } from "../components/AppSelect";
import { Button } from "../components/ui/button";
import { openExternal } from "../app/links";
import {
  STOCK_PROVIDERS,
  type StockItem,
  type StockProvider,
  type StockProviderInfo,
} from "../../shared/stock-media";

/// Main throws `Error("stock:<code> …")`; Electron prefixes it with its own
/// "Error invoking remote method" text. Pull the code back out.
function stockErrorCode(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return /stock:([a-z_]+)/.exec(msg)?.[1] ?? "network";
}

type AddState = "adding" | "added" | "failed";

const itemKey = (i: StockItem) => `${i.provider}:${i.id}`;

function formatDuration(sec: number | null): string {
  if (sec === null) return "";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/// Search Pexels / Pixabay (video) and Jamendo (music) and pull results into the
/// media pool. Main owns the keys, the HTTP and the download; a finished
/// download arrives in the pool through the same import as a file drop, so this
/// dialog only tracks per-item progress.
export function StockMediaDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [provider, setProvider] = useState<StockProvider>("pexels");
  const info = STOCK_PROVIDERS.find((p) => p.id === provider)!;
  const [keys, setKeys] = useState<Record<string, boolean> | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [items, setItems] = useState<StockItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adds, setAdds] = useState<Record<string, AddState>>({});
  // Guards against a slow answer for an old query landing after a newer one.
  const searchSeq = useRef(0);

  const refreshKeys = useCallback(async () => {
    const status = await window.api.stock.keyStatus();
    setKeys(Object.fromEntries(status.map((s) => [s.provider, s.hasKey])));
  }, []);
  useEffect(() => {
    void refreshKeys();
  }, [refreshKeys]);

  const hasKey = keys?.[provider] ?? false;
  const showKeyForm = keys !== null && (!hasKey || editingKey);

  const runSearch = async (q: string, nextPage: number) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    const seq = ++searchSeq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await window.api.stock.search({ provider, query: trimmed, page: nextPage });
      if (seq !== searchSeq.current) return;
      setItems((prev) => (nextPage === 1 ? res.items : [...prev, ...res.items]));
      setPage(res.page);
      setHasMore(res.hasMore);
      setSubmitted(trimmed);
    } catch (e) {
      if (seq !== searchSeq.current) return;
      const code = stockErrorCode(e);
      setError(code);
      if (code === "no_key" || code === "invalid_key") setEditingKey(true);
    } finally {
      if (seq === searchSeq.current) setLoading(false);
    }
  };

  const switchProvider = (next: string) => {
    searchSeq.current++;
    setProvider(next as StockProvider);
    setItems([]);
    setSubmitted("");
    setHasMore(false);
    setError(null);
    setEditingKey(false);
    setLoading(false);
  };

  const add = async (item: StockItem) => {
    const k = itemKey(item);
    setAdds((s) => ({ ...s, [k]: "adding" }));
    try {
      await window.api.stock.download({ provider: item.provider, id: item.id });
      setAdds((s) => ({ ...s, [k]: "added" }));
    } catch (e) {
      setAdds((s) => ({ ...s, [k]: "failed" }));
      setError(stockErrorCode(e));
    }
  };

  const providerOptions = STOCK_PROVIDERS.map((p) => ({
    value: p.id,
    label: `${p.label} · ${t(p.kind === "video" ? "stock_media.kind_video" : "stock_media.kind_audio")}`,
  }));

  return (
    <AppDialog
      title={t("stock_media.title")}
      onClose={onClose}
      panelClassName="settings-panel stock-panel"
    >
      <div className="settings-body stock-body">
        <div className="stock-toolbar">
          <AppSelect
            value={provider}
            onValueChange={switchProvider}
            options={providerOptions}
            ariaLabel={t("stock_media.source")}
          />
          <AppInput
            type="search"
            value={query}
            onValueChange={setQuery}
            placeholder={t("stock_media.search_placeholder", { provider: info.label })}
            ariaLabel={t("stock_media.search_placeholder", { provider: info.label })}
            disabled={!hasKey}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void runSearch(query, 1);
              }
            }}
          />
          <Button
            variant="default"
            disabled={!hasKey || loading || query.trim() === ""}
            onClick={() => void runSearch(query, 1)}
          >
            <SearchIcon size={14} aria-hidden />
            {t("stock_media.search")}
          </Button>
          {hasKey && !editingKey && (
            <Button
              variant="ghost"
              title={t("stock_media.key_title", { provider: info.label })}
              onClick={() => setEditingKey(true)}
            >
              {t("stock_media.change_key")}
            </Button>
          )}
        </div>

        {showKeyForm && (
          <KeyForm
            info={info}
            hasKey={hasKey}
            onCancel={hasKey ? () => setEditingKey(false) : undefined}
            onSaved={async () => {
              await refreshKeys();
              setEditingKey(false);
              setError(null);
            }}
          />
        )}

        {error && <p className="stock-error" role="alert">{t(`stock_media.error.${error}`, { defaultValue: t("stock_media.error.network") })}</p>}

        {!showKeyForm && items.length === 0 && !loading && (
          <p className="placeholder stock-placeholder">
            {submitted ? t("stock_media.no_results", { query: submitted }) : t("stock_media.hint")}
          </p>
        )}

        {items.length > 0 && (
          <div className={info.kind === "video" ? "stock-grid" : "stock-list"}>
            {items.map((item) =>
              item.kind === "video" ? (
                <VideoCard key={itemKey(item)} item={item} state={adds[itemKey(item)]} onAdd={() => void add(item)} />
              ) : (
                <AudioRow key={itemKey(item)} item={item} state={adds[itemKey(item)]} onAdd={() => void add(item)} />
              ),
            )}
          </div>
        )}

        <div className="stock-footer">
          {loading ? (
            <LoaderCircleIcon size={16} className="animate-spin" aria-hidden />
          ) : (
            hasMore && (
              <Button onClick={() => void runSearch(submitted, page + 1)}>{t("stock_media.load_more")}</Button>
            )
          )}
        </div>

        <p className="stock-attribution">
          <button type="button" className="stock-link" onClick={() => openExternal(info.homeUrl)}>
            {t("stock_media.provided_by", { provider: info.label })}
          </button>
          {" · "}
          {t("stock_media.license_note")}
        </p>
      </div>
    </AppDialog>
  );
}

function KeyForm({
  info,
  hasKey,
  onCancel,
  onSaved,
}: {
  info: StockProviderInfo;
  hasKey: boolean;
  onCancel: (() => void) | undefined;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const save = async (key: string) => {
    setSaving(true);
    try {
      await window.api.stock.setKey(info.id, key);
      await onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="settings-card stock-key">
      <strong>{t("stock_media.key_title", { provider: info.label })}</strong>
      <p className="settings-toggle-hint">{t("stock_media.key_hint", { provider: info.label })}</p>
      <div className="stock-key-row">
        <AppInput
          type="password"
          value={value}
          onValueChange={setValue}
          placeholder={t("stock_media.key_placeholder")}
          ariaLabel={t("stock_media.key_title", { provider: info.label })}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              e.preventDefault();
              void save(value);
            }
          }}
        />
        <Button variant="default" disabled={saving || !value.trim()} onClick={() => void save(value)}>
          {t("stock_media.key_save")}
        </Button>
      </div>
      <div className="stock-key-actions">
        <button type="button" className="stock-link" onClick={() => openExternal(info.keyUrl)}>
          <LinkIcon size={12} aria-hidden /> {t("stock_media.key_get")}
        </button>
        {hasKey && (
          <button type="button" className="stock-link" disabled={saving} onClick={() => void save("")}>
            {t("stock_media.key_remove")}
          </button>
        )}
        {onCancel && (
          <button type="button" className="stock-link" onClick={onCancel}>
            {t("stock_media.key_cancel")}
          </button>
        )}
      </div>
    </div>
  );
}

function AddButton({ state, onAdd }: { state: AddState | undefined; onAdd: () => void }) {
  const { t } = useTranslation();
  if (state === "added") {
    return (
      <Button size="sm" disabled>
        <CheckIcon size={12} aria-hidden />
        {t("stock_media.added")}
      </Button>
    );
  }
  if (state === "adding") {
    return (
      <Button size="sm" disabled>
        <LoaderCircleIcon size={12} className="animate-spin" aria-hidden />
        {t("stock_media.adding")}
      </Button>
    );
  }
  return (
    <Button size="sm" variant={state === "failed" ? "destructive" : "default"} onClick={onAdd}>
      {state === "failed" ? <RotateCcwIcon size={12} aria-hidden /> : <PlusIcon size={12} aria-hidden />}
      {t(state === "failed" ? "stock_media.retry" : "stock_media.add")}
    </Button>
  );
}

function Credit({ item }: { item: StockItem }) {
  const { t } = useTranslation();
  return (
    <span className="stock-credit">
      <button
        type="button"
        className="stock-link"
        onClick={() => openExternal(item.authorUrl ?? item.pageUrl)}
      >
        {t("stock_media.by", { author: item.author })}
      </button>
      {" · "}
      {item.licenseUrl ? (
        <button type="button" className="stock-link" onClick={() => openExternal(item.licenseUrl!)}>
          {item.license}
        </button>
      ) : (
        item.license
      )}
    </span>
  );
}

function VideoCard({ item, state, onAdd }: { item: StockItem; state: AddState | undefined; onAdd: () => void }) {
  // The preview rendition only loads while hovered: a page of 24 results must
  // not start 24 video downloads.
  const [hover, setHover] = useState(false);
  return (
    <div className="stock-card">
      <div
        className="stock-thumb"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {hover && item.previewUrl ? (
          <video src={item.previewUrl} poster={item.thumbnailUrl ?? undefined} muted autoPlay loop playsInline />
        ) : item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" loading="lazy" draggable={false} />
        ) : null}
        {item.durationSec !== null && <span className="stock-duration">{formatDuration(item.durationSec)}</span>}
      </div>
      <div className="stock-meta">
        <button type="button" className="stock-title stock-link" title={item.title} onClick={() => openExternal(item.pageUrl)}>
          {item.title}
        </button>
        <Credit item={item} />
        <div className="stock-actions">
          {item.width && item.height ? <span className="stock-dim">{item.width}×{item.height}</span> : <span />}
          <AddButton state={state} onAdd={onAdd} />
        </div>
      </div>
    </div>
  );
}

function AudioRow({ item, state, onAdd }: { item: StockItem; state: AddState | undefined; onAdd: () => void }) {
  return (
    <div className="stock-row">
      {item.thumbnailUrl ? (
        <img className="stock-cover" src={item.thumbnailUrl} alt="" loading="lazy" draggable={false} />
      ) : (
        <span className="stock-cover" />
      )}
      <div className="stock-meta">
        <button type="button" className="stock-title stock-link" title={item.title} onClick={() => openExternal(item.pageUrl)}>
          {item.title}
        </button>
        <Credit item={item} />
      </div>
      {item.previewUrl && <audio className="stock-audio" src={item.previewUrl} controls preload="none" />}
      <span className="stock-dim">{formatDuration(item.durationSec)}</span>
      <AddButton state={state} onAdd={onAdd} />
    </div>
  );
}
