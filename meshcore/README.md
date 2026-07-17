# Meshcore Plugin for MeshPulse

## What it does

Shows Meshcore network nodes on the MeshPulse map alongside Meshtastic — **read-only**.
The plugin connects to a Meshcore companion node over USB serial or TCP, reads its
contact list and injects every known node into the map. Meshcore nodes render as
diamond markers, the Mesh Info panel gains Meshtastic/Meshcore layer toggles so either
network can be shown or hidden independently, and the node popup shows the Meshcore
node type (Companion / Repeater / Room Server / Sensor). The locally connected
companion node gets the same "own node" marker treatment as the Meshtastic tracker.

## Requirements

- MeshPulse >= 2.6.0 (the `inject_node` plugin API landed in 2.6.0 — older versions will not work)
- A Meshcore companion node reachable over USB serial or TCP
- Python package `meshcore>=2.3.7` (installed automatically from `requirements.txt` when the plugin is enabled)

## Setup

1. Install the plugin from the store (**Config → Plugins**) or upload the `.meshplugin` file.
2. Find your device path (see [Finding your device](#finding-your-device-serial) below).
3. Open the plugin config and enter the connection settings.
4. **Save** the config.
5. **Then** enable the plugin.

> ⚠️ **Configure before you enable.** The plugin reads its config once, at enable time.
> If you enable it first and configure afterwards, it logs
> `[MESHCORE] Not configured — set the serial device path in plugin config` and does
> nothing — saving the config later does **not** start it. If that happens, toggle
> **Disable → Enable** to pick up the new config.

## Finding your device (serial)

With the Meshcore node plugged in, list the stable device symlinks:

```bash
ls -l /dev/serial/by-id/
```

Real output from a Pi with both a Meshtastic tracker (for MeshPulse core) and a
Meshcore node attached:

```
usb-Seeed_Studio_TRACKER_L1_DEF772D9AAFDA1D6-if00            -> ../../ttyACM0   (Meshtastic firmware)
usb-Seeed_Studio_Seeed_Wio_Tracker_L1_3E7A455D3E5D5287-if00  -> ../../ttyACM1   (Meshcore firmware)
```

Two things to know when reading this:

- **The firmware sets the USB product string**, so the same hardware model shows up
  under different names depending on which firmware is flashed. The long hex string
  is the device serial number — that is what guarantees uniqueness. If in doubt,
  unplug the Meshcore node, run the command again, and see which entry disappears.
- **Use the `/dev/serial/by-id/...` path, not `/dev/ttyACM0`.** The `ttyACM` numbers
  depend on USB enumeration order at boot and are not stable. With two nodes plugged
  in they can swap after a reboot — and MeshPulse would then talk Meshtastic protocol
  to the Meshcore node. The `by-id` symlinks embed the serial number and always point
  at the right device.

Use the full path as the `device_path` setting, e.g.:

```
/dev/serial/by-id/usb-Seeed_Studio_Seeed_Wio_Tracker_L1_3E7A455D3E5D5287-if00
```

## Configuration

| Setting | Type | Default | Description | Example |
|---------|------|---------|-------------|---------|
| `connection_type` | select (`serial` / `tcp`) | `serial` | How to reach the Meshcore companion node | `serial` |
| `device_path` | string | *(empty)* | Serial device path — use a `/dev/serial/by-id/...` path, not `/dev/ttyACM*` | `/dev/serial/by-id/usb-Seeed_Studio_Seeed_Wio_Tracker_L1_3E7A455D3E5D5287-if00` |
| `tcp_host` | string | *(empty)* | TCP target as `host` or `host:port` (default port 5000) | `192.168.1.50:5000` |
| `contact_sync_interval` | number | `300` | Seconds between contact-list re-reads (60–3600) — this is the primary data path | `300` |

## How it works

- On enable the plugin connects and injects the companion node itself plus every contact.
- The contact list is re-read every `contact_sync_interval` seconds — this is the
  primary data path, since Meshcore advertisements are rare.
- ADVERTISEMENT and NEW_CONTACT events are also handled and injected as they arrive.
- The connection auto-reconnects with backoff (5s / 15s / 60s).

## What to expect

Meshcore is much quieter than Meshtastic. Adverts are rare — repeaters advertise
infrequently, unlike Meshtastic's chatty position broadcasts — so a freshly flashed
node may know only 1–2 contacts after an hour and grow to dozens over days. **This is
normal, not a fault.** The map fills in as the companion node's contact list grows,
via the periodic contact sync, not live adverts.

Also note: the Meshcore phone app shows contacts from the *app's own database*, which
can be far more than what the companion node itself knows. This plugin reads the
node's memory, so seeing fewer nodes on the map than in the phone app is expected.

## Not included in v1

- Messages
- Telemetry
- Node configuration
- Stats
- Traceroute / neighbour links
- Any sending to the Meshcore network — the plugin is strictly read-only

## Known limitations

- Injected Meshcore nodes always show **"Seen: just now"** and never age to
  yellow/red, because each contact sync refreshes their timestamp. The age colour is
  not meaningful for Meshcore nodes in v1.

## Troubleshooting

Watch the logs while testing:

```bash
journalctl -u meshpulse -f
```

- `[MESHCORE] Not configured` — the config was not saved, or the plugin was enabled
  before configuring. Save the config, then toggle **Disable → Enable**.
- `[MESHCORE] Connection failed` — wrong device path/host, or another process holds
  the serial port. The Meshcore phone app connected over BLE is fine; a second serial
  client is not.
- `inject_node: mapper not ready yet` — MeshPulse is older than 2.6.0. Update MeshPulse.
- `[MESHCORE] Synced 0 nodes` — the companion node has no contacts yet. Wait — this
  is normal on a freshly flashed node (see [What to expect](#what-to-expect)).
- Nodes appear in `nodes.json` but not on the map — the Meshcore layer checkbox in
  Mesh Info is switched off. Turn it back on.

## Links

- [MeshPulse](https://github.com/maxg10/meshpulse) — the mapper this plugin extends
- [Plugin developer guide](https://github.com/maxg10/meshpulse/blob/main/docs/plugin-developer-guide.md)
- [Meshcore project](https://meshcore.co.uk/)

## License

GPL-3.0
