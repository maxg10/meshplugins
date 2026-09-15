# Lifelines Plugin for MeshPulse

## What it does

Finds the **single points of failure** in your mesh: the nodes that, if they went
off the air, would cut other nodes off from the network.

A mesh looks resilient on a map — lines everywhere, hundreds of nodes. But a
graph can be dense and still hang off one repeater on a hill. Lifelines names
that repeater, and tells you how many nodes go with it.

Frontend only. No backend, no extra packets, nothing asked of the radio: it
works on the neighbour reports the map already receives.

## How it works

The mesh is treated as an undirected graph. Edges come from two places the core
already knows about:

- **Neighbour reports** (`NEIGHBORINFO`) between any two nodes.
- **Your own radio's direct contacts** — nodes heard with zero hops. Optional,
  because your own node is a hub and will otherwise top every list.

On that graph the plugin runs an iterative Tarjan search for articulation
points, then — for each one — asks the question that actually matters: with this
node removed, how many nodes can no longer reach **your** node? That number is
what the panel shows. Articulation points say *that* a node splits the graph;
the count says what it costs.

Click an entry and the map answers visually: an amber ring around the node in
question, red rings around everything that depends on it.

## Requirements

- MeshPulse >= 2.8.0 — it uses `api.links`, added in that release.
- At least one node sending **NEIGHBORINFO**. It is **off by default** in the
  Meshtastic firmware; with none of it, and no direct contacts yet, the panel
  says so instead of pretending the mesh is healthy.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `default_enabled` | off | Analyse as soon as the map loads |
| `min_orphans` | 1 | Hide cut points that would strand fewer than this many nodes |
| `include_own_radio` | on | Count your own zero-hop contacts as links |
| `recompute_ms` | 15000 | Shortest gap between recomputations while reports arrive |

## Notes and honest limits

- **Reports are a sample, not the truth.** A node only appears on the graph once
  something reports it. A quiet neighbour link exists in the air but not here.
- **"Cut off" is relative to your node.** Nodes already unreachable from yours
  are not counted again, and cut points inside a part of the mesh your node
  cannot reach at all are not listed.
- The graph is undirected. RF is not always symmetric — A may hear B while B
  never hears A — so treat a lifeline as a strong hint, not a proof.

## Licence

GPL-3.0, like MeshPulse itself.
