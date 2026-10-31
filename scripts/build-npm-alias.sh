#!/usr/bin/env bash
# Build one alias package into <outdir>: a static shim that starts @bitfloo/mailoo under another
# npm name, so that `npx <name>` finds the server. Everything comes from the root package.json,
# including the version: the alias is republished at every release and depends on exactly that
# version. A range would freeze: npx keeps the dependency tree it resolved the first time as long as
# the alias's own version is unchanged.
set -euo pipefail
name=${1:?alias name}
out=${2:?output dir}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

[[ $name =~ ^[a-z0-9][a-z0-9._-]*$ ]] || {
  echo "not an unscoped lowercase npm name: $name" >&2
  exit 1
}

mkdir -p "$out"
jq --arg name "$name" '{
  name: $name,
  version: .version,
  description: .description,
  keywords: .keywords,
  type: "module",
  license: .license,
  author: .author,
  repository: .repository,
  homepage: .homepage,
  bugs: .bugs,
  bin: {($name): "bin.js"},
  files: ["bin.js", "README.md", "LICENSE", "COPYING", "NOTICE"],
  dependencies: {(.name): .version},
  engines: .engines
}' "$root/package.json" > "$out/package.json"

# Importing the entry point starts the server: main.ts calls main() at load.
printf '#!/usr/bin/env node\nimport '"'"'%s'"'"';\n' \
  "$(jq -r '.name + "/" + .bin.mailoo' "$root/package.json")" > "$out/bin.js"
chmod +x "$out/bin.js"

cp "$root/LICENSE" "$root/COPYING" "$root/NOTICE" "$out/"

main=$(jq -r .name "$root/package.json")
{
  echo "# $name"
  echo
  echo "\`$name\` is an alias for [\`$main\`](https://www.npmjs.com/package/$main), an email MCP server"
  echo "for AI agents. It starts the same server and contains nothing else."
  echo
  echo '```bash'
  echo "npx -y $name@latest"
  echo '```'
  echo
  echo "Setup for Claude Code, Claude Desktop, Cursor and other clients: $(jq -r .homepage "$root/package.json")"
} > "$out/README.md"
