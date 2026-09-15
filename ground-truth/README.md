# Ground Truth Plugin for MeshPulse

## What it does

Finds the links and nodes that have **quietly lost signal**.

An antenna rarely fails outright. Water works its way into a connector, a mast
shifts a few degrees in a winter storm, a tree keeps growing. Nothing breaks —
every packet still arrives — until one day the link is gone and nobody can say
when it started. The mapper has been writing SNR into `stats.db` for months, so
the evidence is already on disk. This plugin asks the one question nobody was
asking it: **compared with its own past, is this link worse than it used to be?**

## How it decides

Two windows: the last few days (*now*), and the weeks before them (*how it used
to be*). For every link and every directly-heard node it compares the two, and
reports a finding only when all of the following hold:

- the **median** dropped by at least `drop_db` — medians, not averages, because
  one thunderstorm should not move the verdict;
- both windows hold at least `min_samples` measurements;
- the drop is larger than **twice the link's own median absolute deviation** —
  a link that swings ±6 dB on an ordinary day cannot report a 5 dB drop as news.

Links come from `NEIGHBORINFO` reports between two nodes. Nodes come from
packets your own radio heard at **zero hops** — one transmitter, one receiver,
no repeater in between to explain a change away. Packets that arrived over MQTT
are ignored: they carry someone else's radio conditions, not yours.

Click a finding and the map draws the link in red, with the numbers in the
popup: what it was, what it is, how many measurements are behind each.

## What it reads

`stats.db` — the mapper's own history, opened **read-only** (`mode=ro`). The
plugin never writes to it, and keeps no database of its own. Default path is
`/var/www/html/meshpulse/stats.db`; change `stats_db_path` if your web root is
somewhere else.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `stats_db_path` | `/var/www/html/meshpulse/stats.db` | Where the history lives (read-only) |
| `baseline_days` | 30 | How far back "how it used to be" reaches |
| `recent_days` | 3 | How recent "how it is now" is |
| `drop_db` | 4 | Minimum loss before a link is reported |
| `min_samples` | 20 | Measurements needed in each window |
| `include_nodes` | on | Also check nodes heard directly at zero hops |
| `default_enabled` | off | Run the check as soon as the map loads |

## Honest limits

- **A node that moved is not a node that degraded.** A handheld carried
  somewhere new will look exactly like a failing antenna. Fixed nodes are what
  this is for; treat anything portable as noise.
- **Seasons are real.** Leaves come back every spring, and wet foliage costs
  dB. A 30-day baseline compares you with last month, not with last year.
- **It needs history.** A mapper running for a week has nothing to compare
  against, and the plugin will say so rather than invent a verdict.
- This is **measurement against its own past**, not against a propagation
  model. Comparing measured signal with a SPLAT-HD prediction needs a
  point-to-point endpoint on the coverage server, which does not exist yet.

## Licence

GPL-3.0, like MeshPulse itself.
