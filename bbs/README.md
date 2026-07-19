# 📟 Meshtastic BBS — Meshtastic Mapper Plugin

FidoNet-inspired bulletin board system plugin for the [Meshtastic Network Mapper](https://github.com/maxg10/meshtastic-network-mapper).

Gives your mesh network a classic BBS experience: bulletin areas, private netmail with store & forward, a node directory, and a retro green-phosphor web UI — all controllable via 200-character mesh messages.

## Features

- **Bulletin areas** — four boards (GENERAL, TECH, LOCAL, MESH); nodes post and read via mesh text commands
- **Private netmail** — store-and-forward private mail between any node IDs; inbox accessible over mesh or web
- **Node directory** — first/last-seen tracking and message count for every node that contacts the BBS
- **Auto-welcome** — configurable welcome message sent to new nodes on first contact
- **FidoNet-inspired commands** — short commands that fit in a single 200-char mesh packet
- **Retro terminal UI** — green phosphor web interface with real-time WebSocket updates
- **Zero Python dependencies** — backend uses only the Python standard library (sqlite3, asyncio, json, time, re)

## Installation

### From Plugin Store (recommended)
1. Open your mapper → Config → Plugins
2. Find **Meshtastic BBS** in the Plugin Store
3. Click **Install**

### Manual
1. Download the latest `bbs-X.Y.Z.meshplugin` from [Releases](https://github.com/maxg10/meshplugin-bbs/releases)
2. Mapper → Config → Plugins → Install Plugin → upload the `.meshplugin` file

## Mesh Commands

Any node can control the BBS by sending text messages starting with `BBS`:

| Command | Description |
|---|---|
| `BBS HELP` | Show command reference |
| `BBS LIST` | List all areas with message counts |
| `BBS READ <area>` | Read latest messages from area |
| `BBS READ <area> <offset>` | Read messages starting at offset (pagination) |
| `BBS POST <area> <message>` | Post a message to an area |
| `BBS MAIL <node_id> <message>` | Send private netmail to a node |
| `BBS INBOX` | Read your private inbox (marks as read) |
| `BBS NODES` | Show 5 most recently seen nodes |
| `BBS INFO` | Show BBS statistics |

**Areas:** `GENERAL`, `TECH`, `LOCAL`, `MESH`

Messages are automatically split into ≤ 200-character chunks for mesh delivery.

### Examples

```
BBS POST GENERAL Hello from grid square JO91!
BBS READ TECH
BBS MAIL !abcd1234 Meet me on channel 2 tonight
BBS INBOX
BBS LIST
```

## Web Interface

The BBS ships a retro green-phosphor web UI accessible from the mapper's plugin panel (💾 BBS tab).

- **BOARDS** — browse and post to bulletin areas
- **NETMAIL** — read all mail, filter by node, compose new mail
- **NODES** — node directory with first/last-seen timestamps
- **INFO** — system stats and command reference

Real-time updates arrive via WebSocket whenever a node sends a mesh BBS command.

## Configuration

Plugin settings (Mapper → Config → Plugins → Meshtastic BBS → Settings):

| Setting | Default | Description |
|---|---|---|
| `bbs_name` | `MeshBBS` | System name shown in responses and the web UI |
| `welcome_message` | `Welcome to MeshBBS! Type BBS HELP for commands.` | Sent to new nodes on first contact |
| `auto_welcome` | `true` | Enable/disable the auto-welcome |
| `max_messages_per_read` | `3` | Max messages per BBS READ response (1–5; keep low to save bandwidth) |

## Requirements

- Meshtastic Network Mapper v2.2.0+
- Python 3.9+ (standard library only — no `pip install` needed)
- Mapper permissions: `mesh_receive`, `mesh_send`

## Data Storage

The BBS stores data in `data/bbs.sqlite3` inside the plugin's directory. The file is created automatically on first enable. Back it up with the rest of your mapper data.

## Commands Reference

| Command | Description | Example |
|---------|-------------|---------|
| `!bbs` or `!bbs help` | Show command list | `!bbs help` |
| `!bbs info` | BBS info: name, sysop, stats | `!bbs info` |
| `!bbs nodes` | List nodes in directory | `!bbs nodes` |
| `!bbs list` | List last 5 bulletin posts | `!bbs list` |
| `!bbs list <area>` | List posts in area | `!bbs list TECH` |
| `!bbs read <id>` | Read post by ID | `!bbs read 42` |
| `!bbs post <subject> \| <body>` | Create new post | `!bbs post Hello \| First post!` |
| `!bbs areas` | List available board areas | `!bbs areas` |
| `!bbs inbox` | List unread mail | `!bbs inbox` |
| `!bbs inbox all` | List all mail | `!bbs inbox all` |
| `!bbs read mail <id>` | Read specific mail | `!bbs read mail 3` |
| `!bbs send <node> \| <subject> \| <body>` | Send private mail | `!bbs send !abc123 \| Hi \| Hello there` |
| `!bbs delete mail <id>` | Delete mail | `!bbs delete mail 3` |
| `!bbs whois <node_id>` | Lookup node info | `!bbs whois !abc123` |

**Note:** Your node must be ROUTER_CLIENT (not ROUTER) to receive DM commands.
Alternatively, send commands on the primary channel — BBS listens to all traffic.

See [docs/COMMANDS.md](docs/COMMANDS.md) for the full reference with examples and FidoNet comparison.

## License

GPL-3.0 — see [LICENSE](LICENSE)

## Author

Mariusz "Max" Gieparda — [GitHub](https://github.com/maxg10) · [meshtastic.world](https://meshtastic.world)
