# Meshcore Plugin for MeshPulse

Shows Meshcore network nodes on the MeshPulse map alongside Meshtastic — **read-only**.

The plugin connects to a Meshcore companion node over serial or TCP, reads its
contact list and injects every known node into the map as a `net='MC'` node.
MC nodes render with diamond markers, and the map gains MT/MC layer toggles so
either network can be shown or hidden independently.

## Requirements

- MeshPulse >= 2.5.5
- A Meshcore companion node reachable over USB serial or TCP
- Python package `meshcore>=2.3.7` (installed automatically when the plugin is enabled)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `connection_type` | `serial` | How to reach the Meshcore companion node (`serial` or `tcp`) |
| `device_path` | — | Serial device path, e.g. `/dev/serial/by-id/usb-Seeed_Studio_..._-if00` |
| `tcp_host` | — | TCP target as `host` or `host:port` (default port 5000) |
| `contact_sync_interval` | `300` | Seconds between contact-list re-reads (60–3600) |

> **Tip:** for serial connections use a `/dev/serial/by-id/...` path —
> `/dev/ttyACM*` numbering can shift on reboot.

## How it works

- On enable the plugin connects and injects the companion node itself plus every contact.
- The contact list is re-read every `contact_sync_interval` seconds — this is the
  primary data path, since Meshcore advertisements are rare.
- ADVERTISEMENT and NEW_CONTACT events are also handled and injected as they arrive.
- The connection auto-reconnects with backoff (5s / 15s / 60s).

## Not included in v1

- Messages
- Telemetry
- Node configuration
- Stats

## License

GPL-3.0
