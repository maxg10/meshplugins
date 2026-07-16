#!/bin/bash
# Build .meshplugin packages for distribution.
#
#   ./build.sh            build every plugin in the repo
#   ./build.sh meshcore   build a single plugin
#
# A plugin is any immediate subdirectory containing a plugin.json.
# The output filename version always comes from the manifest.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p dist

# Files/dirs that go into a package (whichever exist).
INCLUDE=(plugin.json requirements.txt backend frontend)

# Never ship these: caches, VCS files, and runtime files the mapper
# writes into the installed plugin dir (config.json, data.db) —
# shipping those would clobber a user's settings on upgrade.
EXCLUDE=(
    -x '*__pycache__/*'
    -x '*.pyc'
    -x '*.git/*'
    -x '*data.db'
    -x '*config.json'
    -x '*/dist/*'
    -x '*README.md'
    -x '*.gitignore'
    -x '*.DS_Store'
)

manifest_field() {
    # manifest_field <plugin.json> <key>
    python3 -c '
import json, sys
with open(sys.argv[1]) as f:
    m = json.load(f)
v = m[sys.argv[2]]
if not isinstance(v, str) or not v:
    raise ValueError(f"{sys.argv[2]} must be a non-empty string")
print(v)
' "$1" "$2"
}

# ── Which plugins to build ──────────────────────────────────────
plugins=()
if [ $# -gt 0 ]; then
    for name in "$@"; do
        if [ ! -f "$name/plugin.json" ]; then
            echo "ERROR: '$name' is not a plugin directory (no $name/plugin.json)" >&2
            exit 1
        fi
        plugins+=("$name")
    done
else
    for dir in */; do
        dir="${dir%/}"
        case "$dir" in dist|.*) continue ;; esac
        [ -f "$dir/plugin.json" ] || continue
        plugins+=("$dir")
    done
    if [ ${#plugins[@]} -eq 0 ]; then
        echo "ERROR: no plugin directories found (no */plugin.json)" >&2
        exit 1
    fi
fi

# ── Build ───────────────────────────────────────────────────────
summary=()
for dir in "${plugins[@]}"; do
    manifest="$dir/plugin.json"

    if ! id=$(manifest_field "$manifest" id) ||
       ! version=$(manifest_field "$manifest" version); then
        echo "ERROR: malformed manifest: $manifest" >&2
        exit 1
    fi

    out="dist/$dir-$version.meshplugin"
    echo "📦 Building $id v$version -> $out"

    includes=()
    for item in "${INCLUDE[@]}"; do
        [ -e "$dir/$item" ] && includes+=("$item")
    done

    rm -f "$out"
    (cd "$dir" && zip -r -q "../$out" "${includes[@]}" "${EXCLUDE[@]}")

    # The mapper requires plugin.json at the ZIP root — verify.
    if ! unzip -l "$out" | grep -q ' plugin\.json$'; then
        echo "ERROR: $out does not contain plugin.json at the ZIP root" >&2
        exit 1
    fi

    size=$(du -h "$out" | cut -f1)
    summary+=("$id"$'\t'"$version"$'\t'"$out"$'\t'"$size")
done

# ── Summary ─────────────────────────────────────────────────────
echo ""
{
    printf 'PLUGIN\tVERSION\tFILE\tSIZE\n'
    printf '%s\n' "${summary[@]}"
} | column -t -s $'\t'
