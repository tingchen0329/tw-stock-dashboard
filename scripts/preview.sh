#!/usr/bin/env bash
# 本機預覽：用合成假資料組出完整網站並啟動伺服器（不需網路、不需 token）
#   ./scripts/preview.sh          → http://localhost:8000
#   ./scripts/preview.sh --build  → 只組網站到 _site/，不啟動伺服器
# 想用真實資料預覽：先 export FINMIND_TOKEN=...，再執行 ./scripts/preview.sh --live
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf _site && mkdir -p _site
cp -r index.html assets _site/

if [[ "${1:-}" == "--live" ]]; then
  python3 scripts/fetch_data.py --out _site/data
else
  FX="$(mktemp -d)"
  python3 tests/fixtures/make_fixtures.py "$FX" --today "${PREVIEW_TODAY:-2026-10-19}" >/dev/null
  python3 scripts/fetch_data.py --fixtures "$FX" --out _site/data --today "${PREVIEW_TODAY:-2026-10-19}" \
    --watchlist tests/fixtures/watchlist.json
  rm -rf "$FX"
fi
node scripts/build_overview.mjs _site/data

[[ "${1:-}" == "--build" ]] && exit 0
echo "→ http://localhost:${PORT:-8000}"
cd _site && python3 -m http.server "${PORT:-8000}"
