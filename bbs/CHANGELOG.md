# Changelog

## v1.1.0 (2026-09-07)
- feat: the web board viewer works — the BBS tab in the MeshPulse navbar opens a
  browsable view of the boards, netmail, node directory and stats
- feat: transport moved to the mapper's plugin WebSocket channel. The frontend
  used to call a REST API under the plugin's web-root path and a
  `/ws/plugin/...` socket, neither of which exists — MeshPulse has no HTTP API
  server, and `register_api_route()` has nothing behind it in the core
- feat: `on_ws_request()` dispatches to the existing board/mail/node/stats
  handlers and answers only the client that asked (core 2.7.0+)
- fix: `register_ws_channel('bbs_updates')` was never called, so the core could
  not route the viewer's frames back to this plugin
- fix: `broadcast_ws()` was called with its arguments swapped — the channel name
  went in as the payload — so live "command received" events never arrived
- Requires core 2.7.0 for the web viewer; the mesh side still runs on 2.2.0+

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
