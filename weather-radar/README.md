# Weather Radar Plugin for MeshPulse

## What it does

Adds an animated precipitation radar layer to the map, sourced from
[RainViewer](https://www.rainviewer.com/). Roughly two hours of past radar are
available in 10-minute steps, with a time slider, playback controls and a
timestamp for the frame on screen.

Frontend-only, no backend. The browser fetches the radar index and the tiles
directly from RainViewer, so the machine running MeshPulse — very often a small
Raspberry Pi — does no extra work, gains no extra dependency and carries no
extra traffic.

## Requirements

- MeshPulse >= 2.6.1 (uses the core panel system, so it also works in the mobile
  layers drawer)
- Internet access **in the browser** viewing the map. MeshPulse itself does not
  need to reach RainViewer.

## Usage

Enable the plugin and a **🌧️ Weather Radar** panel appears with the other map
layer controls:

- **Checkbox** — turns the radar layer on and off. The state persists across page
  reloads.
- **▶ / ⏸** — play or pause the animation.
- **◀ / ▶▌** — step one frame back or forward (stops playback).
- **Slider** — scrub to any frame; the label shows that frame's local time and
  how long ago it was recorded.

The radar is drawn above the base map (and above the Elevation Map plugin's
hillshade) but below node markers, lines and labels, so nothing on the mesh gets
hidden by rain.

Frames are preloaded one step ahead and swapped by opacity rather than by
rewriting a single layer's URL, which is what keeps the animation from flashing.
The index is re-checked every 5 minutes; when RainViewer publishes a new frame,
the timeline extends itself without interrupting playback.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Show the radar layer on startup | off | |
| Start the animation automatically | on | |
| Opacity | 70% | |
| Colour scheme | Universal Blue | 9 RainViewer schemes |
| Smooth | on | smoothed image instead of raw radar pixels |
| Snow | on | renders snow in its own colours |
| Frame time | 500 ms | how long each frame stays on screen |
| Max native zoom | 7 | the free RainViewer API has real tiles up to zoom 7; beyond that the last level is upscaled |
| Index URL | RainViewer public API | see below |

### Index URL and commercial feeds

RainViewer's public Weather Maps API is free for personal and small community
use and needs no registration or API key, which is what this plugin uses out of
the box. RainViewer arranges commercial terms case by case rather than selling a
self-service key, so instead of a key field this plugin exposes the **index URL**
itself: point it at whatever endpoint your arrangement gives you and everything
else — tile host, frame list, colour schemes — follows from that response.

Raise **max native zoom** at the same time if your feed serves higher zoom levels.

One caveat worth stating plainly: the browser calls that URL directly, so any
key or token embedded in it is visible in the browser's developer tools. If that
matters for your deployment, proxy the endpoint yourself and point the plugin at
your proxy.

## Links

- [RainViewer Weather Maps API](https://www.rainviewer.com/api/weather-maps-api.html)
- [MeshPulse](https://github.com/maxg10/meshpulse) — the mapper this plugin extends
- [Plugin developer guide](https://github.com/maxg10/meshpulse/blob/main/docs/plugin-developer-guide.md)

## License

GPL-3.0
