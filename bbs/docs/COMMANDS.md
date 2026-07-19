# Meshtastic BBS — Command Reference

Full command reference for the [Meshtastic BBS plugin](https://github.com/maxg10/meshplugin-bbs).

## Quick Start

Send any command prefixed with `!bbs` (or `BBS`) as a mesh text message.
Messages are split automatically into ≤ 200-character chunks for mesh delivery.

**Note:** Your node must be **ROUTER_CLIENT** (not ROUTER) to receive DM replies.
Alternatively, send commands on the primary channel — BBS listens to all traffic.

---

## Commands

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

---

## Board Areas

| Area | Purpose |
|------|---------|
| `GENERAL` | General discussion |
| `TECH` | Technical topics |
| `LOCAL` | Local/regional news |
| `MESH` | Meshtastic network topics |

---

## Examples

### Reading the bulletin board

```
!bbs list
!bbs list TECH
!bbs read 42
```

### Posting a message

```
!bbs post Hello | First post from grid square JO91!
```

### Private mail

```
# Send mail
!bbs send !abcd1234 | Meeting | Meet me on channel 2 tonight

# Check inbox
!bbs inbox

# Read a specific mail
!bbs read mail 3

# Delete mail
!bbs delete mail 3
```

### Node directory

```
!bbs nodes
!bbs whois !abc123
!bbs whois ShortName
```

### System info

```
!bbs info
```

---

## FidoNet Comparison

| FidoNet Concept | Meshtastic BBS Equivalent |
|-----------------|--------------------------|
| Echomail areas | Board areas (GENERAL, TECH, LOCAL, MESH) |
| Netmail | Private mail (`!bbs send`) |
| BBS door | — (future: plugin extensions) |
| Sysop | Configured in plugin settings |
| FREQ (file request) | — (not applicable) |
| Store & Forward | Automatic via sf_queue |

---

## Configuration

See [plugin.json](../plugin.json) and the main [README](../README.md) for configuration options (`bbs_name`, `welcome_message`, `auto_welcome`, `max_messages_per_read`).
