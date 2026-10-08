---
status: proposed
---

# Stock media is searched and downloaded by main

The media pool can search free stock catalogs — Pexels and Pixabay for video,
Jamendo for music — and add a result to the pool. Each catalog needs its own
free API key, which the user types once in the Stock dialog.

Main owns every part that touches a key, the network or the disk. Keys live in
safeStorage (`cloud_keys.json`) under `stock_<provider>` tags; the startup loop
that pushes speech keys into the Rust backend skips that prefix. The renderer
sends a query and gets normalized results back; to download it names a result
by provider and id. Main serves only results its own searches returned, and
re-checks the file URL against the provider's host allowlist before it opens a
connection, so the bridge is not a general fetch-and-write primitive.

A finished download is written under `<dataRoot>/stock/<provider>/` and handed
to the renderer through the same `media:external-drop` event a file drop uses,
so a stock clip goes through exactly the import pipeline a local file does.
Every download appends an attribution line to `<dataRoot>/stock/CREDITS.txt`.

Video downloads pick the widest rendition no wider than 1920 px; search
responses are cached in memory for 24 hours, as Pixabay's terms require.
Jamendo tracks whose artist disallows app downloads are not offered.

Tradeoffs: downloads count against each catalog's rate limit and are not
resumable; licenses differ per catalog and per Jamendo track (many are
non-commercial), so the dialog shows each item's license rather than
enforcing one. The MCP tool surface does not expose stock search yet.
