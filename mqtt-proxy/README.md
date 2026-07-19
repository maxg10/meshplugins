# 📡 MQTT Proxy — Meshtastic Mapper Plugin

MQTT client proxy plugin for the [Meshtastic Network Mapper](https://github.com/maxg10/meshtastic-network-mapper).

Enables trackers without WiFi to communicate via MQTT through the mapper. When your tracker has `Proxy to Client Enabled` in its MQTT settings, this plugin connects to the MQTT broker on its behalf.

## Features

- **Automatic config** — reads MQTT broker address, credentials, root topic from tracker firmware. Zero manual setup.
- **Uplink** (mesh → MQTT) — publishes mesh packets to the broker
- **Downlink** (MQTT → mesh) — receives packets from broker and injects into tracker
- **Implicit ACK** — forwards broker echo back to tracker for delivery confirmation
- **Retained message filtering** — skips old retained messages on reconnect to prevent storms
- **Auto-reconnect** — reconnects automatically on broker disconnect

## Installation

### From Plugin Store (recommended)
1. Open your mapper → Config → Plugins
2. Find "MQTT Proxy" in the Plugin Store
3. Click **Install**

### Manual Download
1. Download the latest `.meshplugin` from [Releases](https://github.com/maxg10/meshplugin-mqtt-proxy/releases)
2. Open your mapper → Config → Plugins → Install Plugin
3. Upload the `.meshplugin` file

## Prerequisites

Before enabling the plugin, configure your tracker's MQTT settings (Config → MQTT):
- ✅ MQTT Enabled
- ✅ Proxy to Client Enabled
- Set MQTT Server Address (e.g., `mqtt.meshtastic.org` or `loranet.pl`)
- Set Root Topic (e.g., `msh/EU_868` or `msh/PL`)
- Configure Username/Password if required
- Enable Uplink/Downlink on desired channels (Config → Channels)

## Configuration

Plugin settings (Config → Plugins → MQTT Proxy → Settings):
- **Auto Connect** — connect to MQTT broker automatically on enable (default: true)
- **Log Traffic** — log uplink/downlink messages to console for debugging (default: false)
- **Reconnect Interval** — seconds to wait before reconnecting after disconnect (default: 30)

## Requirements

- Meshtastic Network Mapper v2.3.0+
- Python dependency: `paho-mqtt` (installed automatically)
- Tracker with `Proxy to Client Enabled` in MQTT config

## Tested On

- Pimesh1 (Luboń/Poland) — Seeed WIO Tracker L1, loranet.pl, msh/PL
- Portacomaro (Italy) — Seeed WIO Tracker L1, mqtt.meshtastic.org, msh/EU_868

## License

GPL-3.0 — see [LICENSE](LICENSE)

## Author

Mariusz "Max" Gieparda — [GitHub](https://github.com/maxg10) · [meshtastic.world](https://meshtastic.world)
