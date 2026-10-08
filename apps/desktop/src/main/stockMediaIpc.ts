// Electron wiring for stock media search (see stockMedia.ts for the logic):
// net.fetch for the catalog APIs and downloads, safeStorage keys, and the
// `stock:*` IPC handlers the preload bridge exposes as `window.api.stock`.
//
// A finished download is handed to the media pool through the SAME
// `media:external-drop` event a Finder/Explorer drop uses, so a stock clip goes
// through exactly the import pipeline (probe, proxy, readiness) a local file does.

import { ipcMain, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web'

import { loadAllKeys, setKey } from './keys.js'
import { createStockMedia, StockError } from './stockMedia.js'
import {
  STOCK_PROVIDERS,
  isStockProvider,
  stockKeyTag,
  type StockKeyStatus,
} from '../shared/stock-media.js'

/// Same timeout family as the model downloads: generous for a 100 MB clip on
/// a slow line, bounded so a dead connection does not hang a spinner forever.
const SEARCH_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000

async function downloadTo(url: string, dest: string): Promise<number> {
  const res = await net.fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  if (!res.ok || !res.body) {
    void res.body?.cancel().catch(() => {})
    return res.status
  }
  const tmp = `${dest}.part`
  try {
    await pipeline(
      Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>),
      fs.createWriteStream(tmp),
    )
    fs.renameSync(tmp, dest)
  } catch (e) {
    fs.rmSync(tmp, { force: true })
    throw e
  }
  return res.status
}

export function installStockMediaIpc(opts: {
  /// `<dataRoot>/stock`.
  stockDir: string
  /// Hand downloaded paths to the renderer's import pipeline.
  importPaths: (paths: string[]) => void
}): void {
  const stock = createStockMedia({
    getJson: async (url, headers) => {
      const res = await net.fetch(url, {
        headers: { Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      })
      let json: unknown = null
      try { json = await res.json() } catch { /* Non-JSON error bodies: the status decides. */ }
      return { status: res.status, json }
    },
    download: downloadTo,
    getKey: (provider) => loadAllKeys()[stockKeyTag(provider)] ?? null,
    fs: {
      mkdirp: (d) => { fs.mkdirSync(d, { recursive: true }) },
      statBytes: (p) => {
        try { const s = fs.statSync(p); return s.isFile() ? s.size : null } catch { return null }
      },
      appendText: (p, t) => { fs.appendFileSync(p, t, 'utf8') },
    },
    join: path.join,
    stockDir: opts.stockDir,
    now: () => Date.now(),
  })

  // Errors cross IPC as their message only; StockError's message carries the
  // `stock:<code>` the renderer localizes. Anything else is reported as network.
  const wrap = <A, R>(fn: (a: A) => Promise<R> | R) => async (_e: Electron.IpcMainInvokeEvent, a: A): Promise<R> => {
    try {
      return await fn(a)
    } catch (e) {
      if (e instanceof StockError) throw e
      throw new StockError('network', e instanceof Error ? e.message : String(e))
    }
  }

  ipcMain.handle('stock:keyStatus', wrap((): StockKeyStatus[] => {
    const keys = loadAllKeys()
    return STOCK_PROVIDERS.map((p) => ({ provider: p.id, hasKey: !!keys[stockKeyTag(p.id)] }))
  }))

  ipcMain.handle('stock:setKey', wrap((a: { provider: unknown; key: unknown }) => {
    if (!isStockProvider(a?.provider)) throw new StockError('bad_request', 'provider')
    const key = typeof a.key === 'string' ? a.key.slice(0, 512) : ''
    setKey(stockKeyTag(a.provider), key)
  }))

  ipcMain.handle('stock:search', wrap((a: unknown) => stock.search(a as never)))

  ipcMain.handle('stock:download', wrap(async (a: unknown) => {
    const result = await stock.download(a as never)
    opts.importPaths([result.path])
    return result
  }))
}
