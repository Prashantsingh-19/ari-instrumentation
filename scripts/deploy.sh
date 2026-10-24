#!/bin/sh
# Deploy the dashboard + API to Cloudflare Pages, and the legacy workers.dev API.
set -e
cd "$(dirname "$0")/.."
rm -rf dist && mkdir dist
cp index.html dist/index.html
cp src/worker.js dist/_worker.js
wrangler pages deploy dist --project-name ari-instrumentation --branch main --commit-dirty=true
wrangler deploy -c wrangler.worker.toml
