# Brand

The Essence mark is a band folded into a gem: a bright ribbon making two turns,
tucking under itself at the top-right and bottom-left, leaving a diamond cutout
in the middle.

## Geometry

Everything is drawn on a square 4 × 5 grid with a unit of 10 — a 40 × 50
viewBox — so every fold is exactly 45° and every vertex lands on a multiple of
ten. `figma-export.svg` is the raw export this was rebuilt from; the masters
here are the cleaned equivalents (verbose path data normalised, the two
near-vertical hairline gradients straightened to exact verticals, display-p3
style duplicates dropped in favour of the same sRGB values the site's CSS
tokens use).

## Layers

Painted back to front:

1. **Fold facets** — the two under-fold diamonds.
   `#A3363F → #59020F`, gradient axis along the fold direction. Identical in
   both themes; this is what keeps the mark recognisable when the band changes.
2. **Band** — the ribbon itself, vertical gradient over the full height.
   Top stop is themed: `#C41E34` (light) / `#F5515F` (dark); bottom is always
   `#9F041B`. Same rule as `--logo-top-gradient` in the website tokens.
3. **Crease shadows** — two black slivers at 20 % opacity where the band tucks
   under the facets.
4. **Rim highlights** — white hairlines fading 50 % → 20 % down the mark, on
   the apex's outer edges and the lower band's inner diagonal (the latter at
   75 % opacity).

## Files

| File | What it is | Consumer |
| --- | --- | --- |
| `essence-mark.svg` / `essence-mark-dark.svg` | Master mark, light / dark band | source of truth for everything below |
| `favicon.svg` | Mark centered on a square 50 viewBox; band brightens via `prefers-color-scheme: dark` | website `public/` (pending) |
| `favicon.ico` | 48 / 32 / 16 px rasters of the light favicon | website `public/` (pending) |
| `apple-touch-icon.svg` / `.png` | Dark mark on `rgb(13,13,13)`, 180 px | website `public/` (pending) |
| `marketplace-icon.svg` / `.png` | Light mark, 256 px, ~11 % padding | `packages/vscode-extension/icon.png` |
| `file-icon-light.svg` / `file-icon-dark.svg` | Mark at 12 × 15 in a 16 px frame | `packages/vscode-extension/icons/` |
| `figma-export.svg` | The raw dark-theme export the masters were rebuilt from | reference only |

The website consumers stay "pending" until the `website-redesign` branch picks
them up: `<link rel="icon">` / `apple-touch-icon` tags in `BaseLayout.astro`,
and `Logo.astro` collapsing its three per-size `clip-path` coordinate sets into
this one scalable SVG.

## Regenerating rasters

The PNGs and the ICO were rasterised with headless Chrome at their exact target
sizes (never scaled from a larger render), e.g.:

```
chrome --headless=new --screenshot=out.png --window-size=256,256 \
  --default-background-color=00000000 marketplace-icon.svg
```

`favicon.ico` bundles true 48 / 32 / 16 px renders of `favicon.svg`.
