# Weather Overlay Plugin for MeshPulse

## What it does

Shows environment sensor data (temperature, humidity, pressure) from nodes reporting
`environmentMetrics` — as text labels above each node on the map, plus an optional
heatmap overlay. Frontend-only, no backend.

As of **v1.0.1** the labels render in a dedicated map pane above the
direct/neighbor/traceroute lines, so crossing lines no longer make them unreadable.

As of **v1.0.2** the control panel registers with the core panel system
(MeshPulse >= 2.6.1), so it integrates with the mobile layers drawer; on older
cores it falls back to the previous placement.

As of **v1.0.4** readings no weather sensor can produce are hidden by default:
temperature outside -50 to 70 °C, humidity outside 0 to 100 %, and pressure no
weather can bring at the node's altitude. Pressure is measured where the sensor
is, not reduced to sea level (about 840 hPa on a 1600 m summit is right), so the
record sea-level range of 870 to 1085 hPa is moved to the node's reported
altitude, with 3 % to spare for GPS error; a node without an altitude only has
300 to 1118 hPa refused. These readings come from broken or misdetected sensors (a node reporting
187 °C on a cold night is real), and they would also paint the heatmap red. The
panel says how many were hidden, and **Hide impossible readings** turns the
filter off: they are then shown marked with ⚠. Leaflet.heat is also loaded with
Subresource Integrity now, pinned to a known file.

Note that a plausible value is not necessarily weather: a node indoors, in a car
or in a sealed box next to its own electronics reports 20 to 35 °C while it is
8 °C outside. That cannot be told apart from a warm day, so those stay on the map.

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
- **Hide impossible readings** (on by default) leaves out values no weather
  sensor can produce; turn it off to see them, marked with ⚠.
- Labels appear at zoom level 10 and above; the node counter shows how many nodes
  currently report data for the selected metric, and how many impossible
  readings were hidden.

## Links

- [MeshPulse](https://github.com/maxg10/meshpulse) — the mapper this plugin extends
- [Plugin developer guide](https://github.com/maxg10/meshpulse/blob/main/docs/plugin-developer-guide.md)

## License

GPL-3.0
