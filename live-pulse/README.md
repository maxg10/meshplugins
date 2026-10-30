# Live Pulse Plugin for MeshPulse

## What it does

Shows **radio traffic as it happens**. Every packet your radio hears makes the
node that sent it pulse on the map, and a glowing arc runs along the part of its
path your mapper can actually see.

- **Pulses**: rings on the sender, coloured by what was sent (text, position,
  telemetry, node info, routing, encrypted, other). Louder packets (higher SNR)
  make bigger rings.
- **Arcs**: a light that travels to your own node and lands with a small ring.
- **Afterglow**: a node that just transmitted keeps a soft halo in the colour of
  its last packet, and links that carried traffic keep a faint glow. Both fade
  out, so a glance at the map tells you who was talking lately and which paths
  are busy, even if you looked away when it happened.
- **Persistence**: Short, Normal or Long, right in the panel, to match how busy
  your mesh is:

  | | Pulse | Arc fades | Node afterglow | Link afterglow (half-life) |
  |---|---|---|---|---|
  | Short | about 2 s | 0.9 s | none | 20 s |
  | Normal | about 4 s | 1.5 s | 1 min | 45 s |
  | Long | about 6 s | 2.5 s | 3 min | 90 s |
- **Dark map**: darkens the base map while Live Pulse is on. It is a filter on
  the tiles you already have, nothing extra is downloaded.
- A small panel counts the packets and nodes of the last minute and lists the
  latest four, with how they arrived. Click one to move the map to that node.

## Honest arcs

MeshPulse only knows what its own radio heard: how many hops a packet took and,
usually, the **last byte** of the node that handed it over. So Live Pulse draws:

| What was heard | What you see |
|---|---|
| Directly from the sender | Arc from the sender to your node |
| Through a relay that is known for certain | Dashed line from the sender to the relay (the hops in between are unknown), then a glowing arc from the relay to you |
| Through a relay that is not known | A pulse on the sender and a small blip on your node, no arc |

A relay counts as known when its full id is reported, or when exactly **one**
node your radio heard directly ends in that last byte. With two candidates there
is no arc, because that would be a guess. A relay without a position on the map
is still named in the panel ("via ..."), it just cannot have an arc.

A sender without a position (no GPS fix yet, or position sharing off) cannot
pulse where it is. You see a small blip on your own node instead, and its name
in the panel.

Packets that arrived over MQTT are not shown: they never went through the air
here. Arcs need a position for your own node; without one you get pulses only,
and the panel says so.

## Light on purpose

Everything is drawn in the browser on one canvas, and only while something
moves. Afterglows are redrawn ten times a second until they fade out; after
that nothing runs at all. A hidden tab draws nothing and does not catch up
later. The Raspberry Pi does no extra work: MeshPulse already sends every
packet it hears to the open pages. With "reduce motion" set in your system,
pulses and arcs are shorter and do not travel.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `default_enabled` | on | Show live traffic on startup |
| `dark_map` | on | Darken the base map while Live Pulse is on |
| `show_arcs` | on | Draw arcs where the path is known |
| `persistence` | normal | How long things stay on screen: short, normal or long |
| `max_animations` | 80 | Most pulses and arcs on screen at once (10 to 300) |

The panel switches remember your choice in this browser.

## Requirements

MeshPulse **2.9.3** or newer (it needs `api.packets`).

## License

GPL-3.0 · © 2026 Mariusz "Max" Gieparda
