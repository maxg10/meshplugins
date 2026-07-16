# MeshPulse Plugins

All MeshPulse plugins except VineKeeper, one directory per plugin. Each plugin
directory contains a `plugin.json` manifest plus its backend/frontend code, and
is packaged into a `.meshplugin` file (a ZIP with `plugin.json` at the root)
for installation.

## Layout

```
meshplugins/
├── build.sh          # builds .meshplugin packages into dist/
├── dist/             # build output (not committed)
└── meshcore/         # one directory per plugin
    ├── plugin.json   # manifest: id, version, config schema, ...
    ├── requirements.txt
    └── backend/
```

## Building

```sh
./build.sh            # build all plugins
./build.sh meshcore   # build one plugin
```

Packages land in `dist/<plugin>-<version>.meshplugin`, with the version taken
from each plugin's manifest.

## Installing

Upload the built `.meshplugin` file via the MeshPulse UI: **Config → Plugins**.

## Plugins

| Name     | Version | Description                                                                        |
|----------|---------|------------------------------------------------------------------------------------|
| Meshcore | 1.0.0   | Show Meshcore network nodes on the MeshPulse map alongside Meshtastic (read-only) |

## License

All plugins in this repo are licensed under GPL-3.0.

## Writing a new plugin

See the [plugin developer guide](https://github.com/maxg10/meshpulse/blob/main/docs/plugin-developer-guide.md).
