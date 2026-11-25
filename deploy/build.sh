#!/bin/sh
# Bundles the server into single files that the cluster mounts from a ConfigMap.
set -eu
cd "$(dirname "$0")/../server"
bun install --frozen-lockfile
bun build src/server.ts --target=bun --minify --outfile ../deploy/dist/server.js
bun build src/admin.ts --target=bun --minify --outfile ../deploy/dist/admin.js
