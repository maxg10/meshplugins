# Elevation Map Plugin for MeshPulse

## What it does

Swaps the map's base tiles for a topographic/terrain provider so you can see the
terrain your mesh actually lives in — plus an optional semi-transparent **hillshade
overlay** that adds relief shading on top of *any* base map. Frontend-only, no backend.

Base tile providers (pick one in the plugin config):

- **OpenTopoMap** — detailed topographic map (default)
- **Esri World Topo** — Esri's topographic map with labels
- **Esri Shaded Relief** — pure relief/hillshade base map

As of **v1.0.2** the defunct legacy terrain provider (whose tile host shut down at
the end of 2023) has been replaced by Esri World Topo. This release also adds the
Hillshade overlay toggle and a `hillshade_default` config option.

As of **v1.0.3** the toggle control registers with the core panel system
(MeshPulse >= 2.6.1), so it integrates with the mobile layers drawer; on older
cores it falls back to the previous placement.

## Requirements

- MeshPulse >= 2.2.0
- Internet access in the browser (tiles are fetched from the provider's servers)

## Usage

Enable the plugin and a panel appears in the top-left of the map:

- **⛰️ Elevation Map checkbox** — swaps the current base map for the configured
  elevation provider; unchecking restores the original base map.
- **🏔️ Hillshade checkbox** — toggles the Esri World Hillshade overlay. Unlike the
  provider choice, this is an *overlay*, not a base map: it stacks semi-transparently
  (35% opacity) on top of whatever base is active — the default OSM map, OpenTopoMap,
  Esri Topo, or Shaded Relief — so roads and labels stay visible under the terrain
  shading. It renders above the base tiles but below node markers and lines.

Both checkbox states persist across page refreshes.

## Configuration

- **Tile Provider** — `opentopomap`, `esri_topo`, or `shaded_relief`
- **Default Enabled** — show the elevation base layer on page load
- **Hillshade Default** — show the hillshade overlay on page load
- **Opacity** — elevation layer transparency (10–100%)

## Links

- [MeshPulse](https://github.com/maxg10/meshpulse) — the mapper this plugin extends
- [Plugin developer guide](https://github.com/maxg10/meshpulse/blob/main/docs/plugin-developer-guide.md)

## License

GPL-3.0
