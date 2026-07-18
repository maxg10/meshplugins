# Weather Overlay Plugin for MeshPulse

## What it does

Shows environment sensor data (temperature, humidity, pressure) from nodes reporting
`environmentMetrics` — as text labels above each node on the map, plus an optional
heatmap overlay. Frontend-only, no backend.

As of **v1.0.1** the labels render in a dedicated map pane above the
direct/neighbor/traceroute lines, so crossing lines no longer make them unreadable.

## Requirements

- MeshPulse >= 2.5.3
- Nodes reporting environment telemetry (temperature works with either top-level
  `temperature` or `env.temperature`; humidity and pressure come from `env.*`)
- Internet access in the browser on first enable (Leaflet.heat is loaded from unpkg
  if not already present)

## Usage

Enable the plugin and a **🌡️ Weather Overlay** panel appears in the top-left of the map:

- **Metric selector** — switch between Temperature (°C), Humidity (%), and Pressure
  (hPa). The choice persists across page refreshes.
- **Heatmap checkbox** — toggles the heatmap layer. Temperature uses an absolute
  0–40 °C colour scale; humidity and pressure are scaled relative to the current
  min/max across nodes.
- Labels appear at zoom level 10 and above; the node counter shows how many nodes
  currently report data for the selected metric.

## Links

- [MeshPulse](https://github.com/maxg10/meshpulse) — the mapper this plugin extends
- [Plugin developer guide](https://github.com/maxg10/meshpulse/blob/main/docs/plugin-developer-guide.md)

## License

GPL-3.0
