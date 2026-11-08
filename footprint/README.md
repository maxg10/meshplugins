# Footprint Plugin for MeshPulse

## What it does

Shows **where your radio really hears**, measured instead of predicted.

A coverage prediction says where a signal ought to reach. The nodes on your mesh
measure it for free: every position packet says where its sender was, and your
radio knows how strong it arrived. Footprint keeps those measurements and draws
them as a grid over the map:

- **Coloured cell**: a position from here reached you **straight from the
  sender** (hops = 0). The colour is the median SNR of everything heard from
  that cell: green above 5 dB, then lime, yellow, orange, and red below -10 dB.
- **Purple cell ("mesh only")**: positions from here reached you **only through
  a relay**. Meshtastic drops duplicate packets, so when the relayed copy is the
  one that arrived, the direct one was not decoded. Your antenna does not hear
  that spot; the mesh carries you there.

Click a cell to see who was heard from it: how often, how well (mean and best
SNR, RSSI), how often only via a relay, and when.

Live: every position heard directly flashes on the map, and the grid refreshes
a few seconds later.

## One direction only

Footprint measures **them to you**: where you can hear others. How far you are
heard is a different number. Your transmitter, their antennas and the noise at
their end decide it. The panel says so too.

## Measured vs predicted

The core's **Show coverage** (Mesh Info) draws the predicted coverage from the
coverage server. Turn it on, switch Footprint to **Outline**, and the measured
cells sit on top of the prediction as hollow squares: you see at once where the
model is right, where a forest or a hill takes the signal away, and where
reflections carry it further than predicted.

## The grid, and blurred positions

Pick a grid of 100 m, 250 m, 500 m, 1 km, 2 km or 5 km, or **Auto**, which
follows the zoom so cells stay readable: 5 km for a whole region, 500 m for a
town, 100 m for a street.

Many nodes round their position for privacy (*position precision*): precision
13 puts a node anywhere in a 5.8 km square, precision 16 in 730 m. A blurred
sample cannot say which 250 m cell it came from, so it is kept but only drawn
on a grid coarse enough for it (its blur at most 1.5 cells): a 730 m blur
appears on the 500 m grid and up, not on 250 m. The panel says how many samples
are waiting for a coarser grid. Positions blurred by more than
`max_position_error_m` (1.5 km by default) are not kept at all.

## Mesh-only radius

Far from you, "only through a relay" is obvious and says nothing, so purple
cells are drawn only within a radius of your node: by default a little past the
farthest spot you have heard directly (at least 3 km). From a hilltop that sees
the Alps this can be 100 km; from a ground-floor window, 4. Set
`mesh_only_radius_km` to fix it.

## History on day one

If the **Trails** plugin is installed, Footprint starts with history instead of
an empty map. The core's `stats.db` knows every position packet's hops and SNR
but not where it came from; Trails knows where nodes were. On first start a
packet takes the position of a Trails fix logged within 5 seconds of it (the
same packet seen by both), or the node's last fix when the node was standing
still. Anything else is skipped rather than guessed. On a Raspberry Pi 2 this
takes a few seconds.

## What it stores

Its own `data/footprint.db`, which survives plugin updates. Samples are folded
into a 50 m grid, one row per cell, node and day: a router reporting every 15
minutes from the same roof adds one row a day, not ninety-six. A week of a busy
mesh is about 200 KB. Coarser grids are merged on request. Only cells are kept,
never routes. Nothing in the core's `stats.db` is written: it is opened
read-only, once, for the history import. Rows older than `retention_days` are
pruned hourly.

Ignored: positions that arrived over MQTT (the internet carried them, not the
air), packets whose hop count is unknown (old firmware), your own node, and
placeholder positions near 0,0.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `retention_days` | 90 | Days of samples kept (7 to 365) |
| `max_position_error_m` | 1500 | Positions blurred more than this are not kept (metres) |
| `mesh_only_radius_km` | 0 | How far to draw mesh-only cells; 0 = automatic |
| `import_history` | on | Build history from `stats.db` and Trails on first start |
| `stats_db_path` | `/var/www/html/meshpulse/stats.db` | Where the core keeps `stats.db` |

The grid, period (7 days, 30 days, all), style and the mesh-only switch are in
the panel and remembered per browser.

## Requirements

MeshPulse **2.9.1** or newer. Trails is optional (only for the history import).

## License

GPL-3.0 · © 2026 Mariusz "Max" Gieparda
