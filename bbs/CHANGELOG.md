# Changelog

## v1.0.6 (2026-05-01)
- fix: _c_about returns default when about_message is empty string, support \n in config

## v1.0.5 (2026-05-01)
- feat: !bbs about command with configurable about_message config field

## v1.0.4 (2026-04-29)
- fix: add 2s delay before reply chunks to avoid serial collision
- fix: add 0.5s inter-chunk delay in `_handle` reply loop

## v1.0.3 (2026-04-28)
- fix: always deliver store&forward queue regardless of is_new flag

## v1.0.1 (2026-04-28)
- Fix: on_node_update guard against None node parameter
- Fix: on_node_update use correct database connection (self._db)
- Fix: on_node_update use correct column names (short_name, long_name)
- Docs: Added full command reference in README.md and docs/COMMANDS.md
- Docs: FidoNet comparison table

## v1.0.0 (2026-04-27)
- Initial release
- Bulletin board with areas (GENERAL, TECH, LOCAL, MESH)
- Private mail (netmail) with store & forward
- Node directory with first/last seen tracking
- Welcome message for new nodes
- FidoNet-inspired command interface
- Retro terminal UI with green phosphor theme
- WebSocket real-time updates
