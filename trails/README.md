# Trails Plugin for MeshPulse

## What it does

Shows **where moving nodes are heading, where they have been, and replays it**.

The core keeps one position per node, the latest. That is enough to draw a map,
and not enough to see that a tracker drove across town. Trails keeps a short
history of fixes and gives the map four modes, switched from its panel:

- **Off**: nothing drawn.
- **Vectors**: an arrow on every node that is moving right now, as long as the
  road it covers in five minutes, labelled with speed and direction
  (`51 km/h SW`). A `≈` marks a speed estimated from two fixes rather than
  measured by the node's GPS.
- **Trails**: the route each mover left in the last **1 h, 6 h or 24 h**. Older
  segments fade, so the direction of travel reads at a glance. Hover a dot for
  the time and speed of that fix.
- **⏱ Replay**: the last **1, 3 or 7 days** on a timeline. Press play (60× to
  3600×) or drag the slider, and every mover travels the map again with a
  30-minute tail. Pick a mover from the list to jump to its first trip.

Clicking a mover in the list highlights it, dims the others and zooms to its
track.

## Telling movement from noise

Stationary nodes do not stand still on paper. GPS noise moves a fixed router by
tens of metres, and a node that rounds its position for privacy (*position
precision*) jumps a whole grid cell whenever the noise crosses a cell edge.
Trails counts a fix as movement only when it lands farther from where the node
has been sitting than that can explain:

- "where it has been sitting" is a running average of its recent fixes, not one
  noisy fix;
- the threshold is `min_move_m` (100 m by default), or 1.5 grid cells for a
  rounded position, whichever is larger. On a real mesh most nodes round:
  precision 13 (a 5.8 km grid) is common on public channels.

Nodes that never move stay out of the panel and off the overlay. They are
already on the map.

## Being honest about gaps

Trackers report every few minutes, and stop reporting when they stop moving.
So:

- a silence longer than 15 minutes is drawn as a **dashed** line, never as a
  road the node did not report;
- an arrow disappears once a mover has been quiet for three times its usual
  reporting interval (at least 5 minutes). It has most likely arrived;
- in Replay a mover is interpolated between fixes only across short gaps, and
  drawn **hollow** while it is silent: we know where it was, not where it is.

On public channels positions are usually rounded, so a walk round the block will
not show, while a drive between districts will.

## What it stores

Its own `data/trails.db` in the plugin directory, which survives plugin
updates. Nothing in the core's `stats.db` is touched. A fix is stored when the
node moved, or as a heartbeat every 30 minutes, so a router reporting every
15 minutes costs two rows an hour instead of four. History older than `retention_days` (7 by default, up to 30) is
pruned hourly in small chunks.

New movements are pushed to open maps as they arrive, so Vectors and Trails
update live.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `retention_days` | 7 | Days of fixes kept for trails and replay (1 to 30) |
| `min_move_m` | 100 | Closer than this is noise, not movement (metres) |
| `include_mqtt` | on | Also record positions that arrive over MQTT |
| `default_mode` | off | What the panel shows on load: off, vectors or trails |

## Requirements

MeshPulse **2.6.1** or newer. On **2.9.1+** the core passes the GPS speed,
heading and position precision the node sent. On older cores Trails estimates
speed and direction from consecutive fixes, and reads the position precision
off the coordinates themselves: the firmware rounds a position to the middle
of its grid cell, which leaves a recognisable pattern in the low bits.

## License

GPL-3.0 · © 2026 Mariusz "Max" Gieparda
