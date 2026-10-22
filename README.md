# MeshPulse Plugins

All MeshPulse plugins except VineKeeper, one directory per plugin. Each plugin
directory contains a `plugin.json` manifest plus its backend/frontend code, and
is packaged into a `.meshplugin` file (a ZIP with `plugin.json` at the root)
for installation.

## Layout

```
meshplugins/
├── build.sh          # builds .meshplugin packages into dist/
├── dist/             # build output (not committed)
└── meshcore/         # one directory per plugin
    ├── plugin.json   # manifest: id, version, config schema, ...
    ├── requirements.txt
    └── backend/
```

## Building

```sh
./build.sh            # build all plugins
./build.sh meshcore   # build one plugin
```

Packages land in `dist/<plugin>-<version>.meshplugin`, with the version taken
from each plugin's manifest.

## Installing

Upload the built `.meshplugin` file via the MeshPulse UI: **Config → Plugins**.

## Plugins

The live catalog is `https://meshpulse.app/plugins/plugins.json`; install from **Config → Plugins → Plugin Store**.

| Plugin | Version | Type | Description |
|---|---|---|---|
| 💎 [Meshcore](meshcore/) | 1.2.0 | backend | Show Meshcore network nodes on the MeshPulse map alongside Meshtastic. |
| ⛰️ [Elevation Map](elevation-map/) | 1.0.3 | frontend | Terrain overlay for the map, switch base tiles (OpenTopoMap, Esri Topo, Shaded Relief) plus a stackable Hillshade overlay that shows terrain shading over any base map. |
| 📡 [MQTT Proxy](mqtt-proxy/) | 1.1.1 | backend | MQTT client proxy for trackers without WiFi. |
| 📋 [Meshtastic BBS](bbs/) | 1.1.0 | backend | Bulletin Board System for Meshtastic mesh networks, inspired by FidoNet BBS systems of the 1980s/90s. |
| 🌡️ [Weather Overlay](weather-overlay/) | 1.0.3 | frontend | Shows environment sensor data (temperature, humidity, barometric pressure) as map labels and heatmap overlay for nodes reporting environmentMetrics. |
| 🌧️ [Weather Radar](weather-radar/) | 1.0.0 | frontend | Animated precipitation radar over the mesh map, from RainViewer. |
| 🩺 [Lifelines](lifelines/) | 1.2.0 | frontend | Finds the single points of failure in your mesh: the nodes that, if they went off the air, would cut other nodes off from the network. |
| 📉 [Ground Truth](ground-truth/) | 1.0.1 | backend | Compares every link and directly-heard node against its own past few weeks and reports the ones that quietly lost signal, water in a connector, a mast that shifted, a tree that grew. |
| 🧭 [Trails](trails/) | 1.0.0 | backend | Where moving nodes are heading, where they have been, and a replay of it all. |

## License

All plugins in this repo are licensed under GPL-3.0.

## Writing a new plugin

See the [plugin developer guide](https://github.com/maxg10/meshpulse/blob/main/docs/plugin-developer-guide.md).
