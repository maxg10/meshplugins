# Circles Plugin for MeshPulse

## What it does

Keeps **your own circles of nodes**: family, your own gear, nodes you keep an
eye on. It starts with two, 👨‍👩‍👧 Family and 🛠 My nodes; make as many as you
like (up to 12), each with a name, an emoji and a colour.

- **Rings on the map**: every node in a circle gets a ring in its circle's
  colour, so your people stand out in a busy mesh. A node in two circles gets
  two rings.
- **A line per node in the panel**: when it was last heard, battery, hops and
  SNR, or "not heard yet". Click a name to go to that node.
- **Only my circles**: one switch hides every other node. Everything that is
  about your nodes keeps working: their lines, Live Pulse's pulses and arcs,
  Weather Overlay's readings, Trails. Your own node always stays.
- **Show relays** (with the switch on): a node that handed one of your circles'
  packets to your radio appears on the map, with a dashed ring, and goes again
  after a few minutes (5 by default, `relay_minutes`). The same honest rule as
  Live Pulse: the firmware usually reports only the last byte of the relay, so
  it counts only when exactly one node your radio heard directly ends in it.
  The hops before that relay are not known, so they are not shown.
- **Show their neighbours** (with the switch on): nodes your circles report as
  neighbours in NEIGHBORINFO. That report is off by default in the firmware, so
  on many meshes this adds nothing.
- Each circle has its own checkbox to leave it out of the rings and the switch,
  in this browser.

## Adding nodes

Type part of a name or an id in the box at the bottom of the panel, pick the
node from the suggestions, choose the circle, **Add**. An id can be typed with
or without the `!` (`!a1b2c3d4` or `a1b2c3d4`), also for a node your radio has
not heard yet. **✎** next to a circle renames it, changes its emoji and colour,
or deletes it (click twice).

## Where circles are kept

On the MeshPulse host, in the plugin's settings, so every browser and phone
sees the same circles. With an admin password set, changing them asks for it;
looking at them does not. What is switched on (the switch, the options, which
circles are shown) is remembered per browser.

Circles are not the "Favorites" on the Config page: those are stored in your
radio and change how it routes. Circles change nothing on the radio.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `relay_minutes` | 5 | How long a relay stays on the map with "Only my circles" on (1 to 120) |

## Requirements

MeshPulse **2.9.4** or newer (it needs `api.nodes.addFilter` and `api.config.save`).

## License

GPL-3.0 · © 2026 Mariusz "Max" Gieparda
