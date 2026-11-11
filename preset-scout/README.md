# Preset Scout Plugin for MeshPulse

## What it does

Shows **which LoRa presets the mesh around you uses**.

A Meshtastic radio only hears nodes on its own preset: a LongFast node and a
MediumFast node a street apart never know about each other. Preset Scout moves
your radio through the presets you pick, a few minutes on each, listen-only,
and shows per preset:

- **Nodes** heard, split into **direct** (straight from the sender, hops = 0)
  and **mesh** (only through a relay)
- **Packets**, and what they were (positions, node info, messages, encrypted)
- **Channel utilization** as your radio measured it
- **OK**: the share of packets received without CRC errors, from the radio's
  own counters. With 15 minutes per preset the radio reports them once per
  preset; a preset where it received nothing at all, not even damaged packets,
  shows **0 rx**.

Then the radio goes back **exactly** as it was. Click a preset in the results
to put its nodes on the map. The best preset is highlighted, with a sentence
on whether it is the one you already use.

## Listen-only

During a scan your radio **sends and relays nothing** (`tx_enabled` off), and
MQTT on the radio is off, so another mesh is never published under your
gateway. Both come back afterwards. Your own mesh loses this node as a relay
for the length of the scan; the panel tells you how long that is before you
start.

While the radio is away, the map waits: nothing heard on other presets goes
into the map, the statistics or other plugins. A banner on the map says what
the radio is doing.

## Safe by design

All the work is done by the MeshPulse core (2.9.5+), not by the browser:
closing the page does not stop a scan, and a scan never leaves the radio
behind.

- Your original settings are written to disk before anything changes.
- Putting them back is checked setting by setting and retried until it works.
- If MeshPulse restarts in the middle of a scan, it puts the radio back first.
- If the link to the radio looks connected but hands over nothing, the scan
  notices within a few minutes, reconnects and gives the preset its lost time
  back. Such a row gets a **link** tag.

Starting and stopping a scan are admin actions: with an admin password set,
the browser asks for it.

## How long to listen

| Per preset | Good for |
|---|---|
| 2 min | A first look: is anyone there at all? |
| 5 min | Busy meshes |
| 10 to 15 min | A fair count, and the radio's receive counters (it reports them every 15 minutes) |

Nodes in direct range often send only every 15 to 60 minutes, so in a short
scan you mostly hear relayed traffic and **Direct** comes out low. A longer
scan finds more of them.

Each preset change takes a minute or two on top (the radio reboots to apply
it), and putting everything back takes about three. The panel shows the total
before you start.

## Which presets

The ones your region allows. In EU_868 the band is 250 kHz wide, so the
500 kHz presets (ShortTurbo, LongTurbo) are left out. A radio on custom LoRa
settings (its own bandwidth and spreading factor) is not scanned, because a
scan could not put those back exactly.

## History

Every scan is kept by the core (the last 50), with every node heard on each
preset. Open an earlier scan from the list at the bottom of the panel. A node
heard without a position (a text message, say) is drawn at its last position
on the map, and its popup says so.

## Requirements

MeshPulse **2.9.5** or newer, with the radio on USB (serial) or TCP and a
LoRa preset set.

## License

GPL-3.0 · © 2026 Mariusz "Max" Gieparda
