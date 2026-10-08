// Unit tests for stock media search/download (stockMedia.ts): per-catalog
// normalization, the host allowlist, caching, error mapping and file naming.
// Network and disk are in-memory fakes; nothing here imports `electron`.

import { describe, it, expect } from 'vitest'
import {
  createStockMedia,
  isAllowedStockUrl,
  titleFromPexelsUrl,
  ccLicenseLabel,
  slugify,
  pickRendition,
  validateDownload,
  validateSearch,
  pexels,
  pixabay,
  jamendo,
  STOCK_CACHE_TTL_MS,
  STOCK_PAGE_SIZE,
  type StockMediaDeps,
} from './stockMedia'

const PEXELS_PAGE = {
  page: 1,
  per_page: 24,
  total_results: 100,
  next_page: 'https://api.pexels.com/videos/search/?page=2&per_page=24&query=ocean',
  videos: [
    {
      id: 1234,
      width: 3840,
      height: 2160,
      url: 'https://www.pexels.com/video/waves-crashing-on-rocks-1234/',
      image: 'https://images.pexels.com/videos/1234/pictures/preview-0.jpg',
      duration: 17,
      user: { id: 9, name: 'Ann Lee', url: 'https://www.pexels.com/@ann' },
      video_files: [
        { id: 1, quality: 'uhd', file_type: 'video/mp4', width: 3840, height: 2160, link: 'https://videos.pexels.com/video-files/1234/uhd.mp4' },
        { id: 2, quality: 'hd', file_type: 'video/mp4', width: 1920, height: 1080, link: 'https://videos.pexels.com/video-files/1234/hd.mp4' },
        { id: 3, quality: 'sd', file_type: 'video/mp4', width: 640, height: 360, link: 'https://videos.pexels.com/video-files/1234/sd.mp4' },
        { id: 4, quality: 'hls', file_type: 'video/hls', width: null, height: null, link: 'https://videos.pexels.com/video-files/1234/x.m3u8' },
      ],
    },
    // Dropped: its only file is on a host Pexels does not serve from.
    {
      id: 5678,
      url: 'https://www.pexels.com/video/x-5678/',
      video_files: [{ file_type: 'video/mp4', width: 1280, link: 'https://evil.example/x.mp4' }],
    },
  ],
}

const PIXABAY_PAGE = {
  total: 500,
  totalHits: 30,
  hits: [
    {
      id: 42,
      pageURL: 'https://pixabay.com/videos/id-42/',
      tags: 'sea, waves, beach, sand',
      duration: 25,
      user_id: 77,
      user: 'Coverr',
      videos: {
        large: { url: 'https://cdn.pixabay.com/video/42_large.mp4', width: 3840, height: 2160, size: 9, thumbnail: 'https://cdn.pixabay.com/video/42_large.jpg' },
        medium: { url: 'https://cdn.pixabay.com/video/42_medium.mp4', width: 1920, height: 1080, size: 5, thumbnail: 'https://cdn.pixabay.com/video/42_medium.jpg' },
        small: { url: 'https://cdn.pixabay.com/video/42_small.mp4', width: 1280, height: 720, size: 3, thumbnail: '' },
        tiny: { url: 'https://cdn.pixabay.com/video/42_tiny.mp4', width: 960, height: 540, size: 1, thumbnail: '' },
      },
    },
  ],
}

const JAMENDO_PAGE = {
  headers: { status: 'success', code: 0, error_message: '', results_count: 2, results_fullcount: 2 },
  results: [
    {
      id: '1886257',
      name: 'Night Drive',
      duration: 147,
      artist_id: '501',
      artist_name: 'Lofi Lopez',
      album_image: 'https://usercontent.jamendo.com?type=album&id=1&width=300',
      image: 'https://usercontent.jamendo.com?type=album&id=1&width=300',
      audio: 'https://prod-1.storage.jamendo.com/?trackid=1886257&format=mp31',
      audiodownload: 'https://prod-1.storage.jamendo.com/download/track/1886257/mp32/',
      audiodownload_allowed: true,
      shareurl: 'https://www.jamendo.com/track/1886257',
      license_ccurl: 'http://creativecommons.org/licenses/by-nc-sa/3.0/',
    },
    {
      id: '99',
      name: 'No downloads',
      audiodownload: '',
      audiodownload_allowed: false,
    },
  ],
}

function makeDeps(responses: Record<string, { status: number; json: unknown }>, keys: Record<string, string> = {
  pexels: 'pk', pixabay: 'xk', jamendo: 'jk',
}) {
  const calls: string[] = []
  const downloads: Array<{ url: string; dest: string }> = []
  const files = new Map<string, number>()
  const appended: Record<string, string> = {}
  let clock = 1_000
  const deps: StockMediaDeps = {
    getJson: async (url, headers) => {
      calls.push(url)
      const host = new URL(url).hostname
      const hit = responses[host]
      if (!hit) throw new Error(`no fake for ${host}`)
      void headers
      return hit
    },
    download: async (url, dest) => {
      downloads.push({ url, dest })
      files.set(dest, 100)
      return 200
    },
    getKey: (p) => keys[p] ?? null,
    fs: {
      mkdirp: () => {},
      statBytes: (p) => files.get(p) ?? null,
      appendText: (p, t) => { appended[p] = (appended[p] ?? '') + t },
    },
    join: (...parts) => parts.join('/'),
    stockDir: '/data/stock',
    now: () => clock,
  }
  return { deps, calls, downloads, files, appended, advance: (ms: number) => { clock += ms } }
}

describe('helpers', () => {
  it('accepts only https URLs on a provider host, on a dot boundary', () => {
    expect(isAllowedStockUrl('pixabay', 'https://cdn.pixabay.com/a.mp4')).toBe(true)
    expect(isAllowedStockUrl('pixabay', 'https://pixabay.com/a.mp4')).toBe(true)
    expect(isAllowedStockUrl('pixabay', 'https://evilpixabay.com/a.mp4')).toBe(false)
    expect(isAllowedStockUrl('pixabay', 'http://cdn.pixabay.com/a.mp4')).toBe(false)
    expect(isAllowedStockUrl('pexels', 'https://cdn.pixabay.com/a.mp4')).toBe(false)
    expect(isAllowedStockUrl('jamendo', 'not a url')).toBe(false)
  })

  it('derives a Pexels title from the page slug', () => {
    expect(titleFromPexelsUrl('https://www.pexels.com/video/waves-crashing-on-rocks-1234/', '1234')).toBe('Waves crashing on rocks')
    expect(titleFromPexelsUrl('https://www.pexels.com/video/1234/', '1234')).toBe('Pexels 1234')
    expect(titleFromPexelsUrl('https://www.pexels.com/', '7')).toBe('Pexels 7')
  })

  it('labels Creative Commons licenses', () => {
    expect(ccLicenseLabel('http://creativecommons.org/licenses/by-nc-sa/3.0/')).toBe('CC BY-NC-SA 3.0')
    expect(ccLicenseLabel('https://creativecommons.org/licenses/by/4.0/')).toBe('CC BY 4.0')
    expect(ccLicenseLabel('https://creativecommons.org/publicdomain/zero/1.0/')).toBe('CC0')
  })

  it('slugifies to filesystem-safe ASCII', () => {
    expect(slugify('Waves, Crashing — on Rocks!')).toBe('waves-crashing-on-rocks')
    expect(slugify('Café déjà vu')).toBe('cafe-deja-vu')
    expect(slugify('Ночной город')).toBe('')
    expect(slugify('a'.repeat(80)).length).toBe(40)
  })

  it('picks the widest rendition within the cap, else the narrowest above it', () => {
    const f = (width: number | null) => ({ width })
    expect(pickRendition([f(3840), f(1920), f(640)])?.width).toBe(1920)
    expect(pickRendition([f(3840), f(2560)])?.width).toBe(2560)
    expect(pickRendition([f(3840), f(1280), f(640)], 960)?.width).toBe(640)
    expect(pickRendition([])).toBeNull()
  })

  it('validates and clamps search requests', () => {
    expect(validateSearch({ provider: 'pexels', query: '  sea  ', page: 0 })).toEqual({ provider: 'pexels', query: 'sea', page: 1 })
    expect(validateSearch({ provider: 'pexels', query: 'x'.repeat(300), page: 1e6 }).query.length).toBe(100)
    expect(() => validateSearch({ provider: 'youtube', query: 'sea' })).toThrow('stock:bad_request')
    expect(() => validateSearch({ provider: 'pexels', query: '   ' })).toThrow('stock:bad_request')
  })

  it('validates download ids', () => {
    expect(validateDownload({ provider: 'jamendo', id: 1886257 })).toEqual({ provider: 'jamendo', id: '1886257' })
    expect(() => validateDownload({ provider: 'jamendo', id: '../../etc' })).toThrow('stock:bad_request')
  })
})

describe('adapters', () => {
  it('builds Pexels requests with the raw key in Authorization', () => {
    const r = pexels.request('KEY', 'ocean waves', 2)
    expect(r.url).toBe(`https://api.pexels.com/videos/search?query=ocean+waves&page=2&per_page=${STOCK_PAGE_SIZE}`)
    expect(r.headers).toEqual({ Authorization: 'KEY' })
  })

  it('normalizes Pexels videos, preferring HD mp4 and dropping foreign hosts', () => {
    const { entries, hasMore } = pexels.parse(PEXELS_PAGE, 1)
    expect(hasMore).toBe(true)
    expect(entries).toHaveLength(1)
    const [e] = entries
    expect(e!.url).toBe('https://videos.pexels.com/video-files/1234/hd.mp4')
    expect(e!.item).toMatchObject({
      provider: 'pexels', id: '1234', kind: 'video', title: 'Waves crashing on rocks',
      author: 'Ann Lee', width: 1920, height: 1080, durationSec: 17,
      previewUrl: 'https://videos.pexels.com/video-files/1234/sd.mp4',
    })
  })

  it('normalizes Pixabay videos', () => {
    expect(pixabay.request('K', 'sea', 1).url).toContain('https://pixabay.com/api/videos/?key=K&q=sea')
    const { entries, hasMore } = pixabay.parse(PIXABAY_PAGE, 1)
    expect(hasMore).toBe(true)
    expect(pixabay.parse(PIXABAY_PAGE, 2).hasMore).toBe(false)
    expect(entries[0]!.url).toBe('https://cdn.pixabay.com/video/42_medium.mp4')
    expect(entries[0]!.item).toMatchObject({
      title: 'sea, waves, beach', author: 'Coverr',
      authorUrl: 'https://pixabay.com/users/Coverr-77/',
      thumbnailUrl: 'https://cdn.pixabay.com/video/42_large.jpg',
      previewUrl: 'https://cdn.pixabay.com/video/42_tiny.mp4',
    })
  })

  it('normalizes Jamendo tracks and skips ones without download rights', () => {
    const r = jamendo.request('CID', 'lofi', 3)
    expect(r.url).toContain('client_id=CID')
    expect(r.url).toContain(`offset=${2 * STOCK_PAGE_SIZE}`)
    const { entries, hasMore } = jamendo.parse(JAMENDO_PAGE, 1)
    expect(hasMore).toBe(false)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.ext).toBe('mp3')
    expect(entries[0]!.item).toMatchObject({
      kind: 'audio', title: 'Night Drive', author: 'Lofi Lopez',
      license: 'CC BY-NC-SA 3.0', licenseUrl: 'https://creativecommons.org/licenses/by-nc-sa/3.0/',
      authorUrl: 'https://www.jamendo.com/artist/501',
    })
  })

  it('maps a Jamendo 200-with-failure answer to an error', () => {
    expect(() => jamendo.parse({ headers: { status: 'failed', code: 5, error_message: 'bad client' } }, 1)).toThrow('stock:invalid_key')
  })
})

describe('createStockMedia', () => {
  it('refuses to search without a key', async () => {
    const { deps } = makeDeps({}, {})
    await expect(createStockMedia(deps).search({ provider: 'pexels', query: 'sea', page: 1 })).rejects.toThrow('stock:no_key')
  })

  it('maps HTTP statuses to error codes', async () => {
    for (const [status, code] of [[401, 'invalid_key'], [403, 'invalid_key'], [429, 'rate_limited'], [500, 'network']] as const) {
      const { deps } = makeDeps({ 'api.pexels.com': { status, json: null } })
      await expect(createStockMedia(deps).search({ provider: 'pexels', query: 'sea', page: 1 })).rejects.toThrow(`stock:${code}`)
    }
  })

  it('caches identical searches for 24 hours', async () => {
    const { deps, calls, advance } = makeDeps({ 'pixabay.com': { status: 200, json: PIXABAY_PAGE } })
    const stock = createStockMedia(deps)
    await stock.search({ provider: 'pixabay', query: 'Sea', page: 1 })
    await stock.search({ provider: 'pixabay', query: 'sea ', page: 1 })
    expect(calls).toHaveLength(1)
    advance(STOCK_CACHE_TTL_MS)
    await stock.search({ provider: 'pixabay', query: 'sea', page: 1 })
    expect(calls).toHaveLength(2)
  })

  it('downloads only items a search returned, names the file, and writes credits', async () => {
    const { deps, downloads, appended } = makeDeps({ 'api.jamendo.com': { status: 200, json: JAMENDO_PAGE } })
    const stock = createStockMedia(deps)
    await expect(stock.download({ provider: 'jamendo', id: '1886257' })).rejects.toThrow('stock:not_found')
    await stock.search({ provider: 'jamendo', query: 'lofi', page: 1 })
    const { path } = await stock.download({ provider: 'jamendo', id: '1886257' })
    expect(path).toBe('/data/stock/jamendo/jamendo-1886257-night-drive.mp3')
    expect(downloads).toEqual([{ url: JAMENDO_PAGE.results[0]!.audiodownload, dest: path }])
    expect(appended['/data/stock/CREDITS.txt']).toContain('"Night Drive" by Lofi Lopez')
    expect(appended['/data/stock/CREDITS.txt']).toContain('CC BY-NC-SA 3.0')
  })

  it('reuses a file that is already on disk and collapses concurrent requests', async () => {
    const { deps, downloads } = makeDeps({ 'api.pexels.com': { status: 200, json: PEXELS_PAGE } })
    const stock = createStockMedia(deps)
    await stock.search({ provider: 'pexels', query: 'sea', page: 1 })
    const [a, b] = await Promise.all([
      stock.download({ provider: 'pexels', id: '1234' }),
      stock.download({ provider: 'pexels', id: '1234' }),
    ])
    expect(a).toEqual(b)
    await stock.download({ provider: 'pexels', id: '1234' })
    expect(downloads).toHaveLength(1)
  })

  it('reports a failed download without writing credits', async () => {
    const { deps, appended } = makeDeps({ 'pixabay.com': { status: 200, json: PIXABAY_PAGE } })
    deps.download = async () => 404
    const stock = createStockMedia(deps)
    await stock.search({ provider: 'pixabay', query: 'sea', page: 1 })
    await expect(stock.download({ provider: 'pixabay', id: '42' })).rejects.toThrow('stock:download_failed')
    expect(appended).toEqual({})
  })
})
