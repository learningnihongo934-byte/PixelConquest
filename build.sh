#!/usr/bin/env bash
# ./build.sh map     - re-bake public/data/world.bin from Natural Earth (python3 + Pillow)
# ./build.sh serve   - play locally at http://localhost:8768
# ./build.sh test    - run the headless sim tests (speed, lockstep determinism, admin powers)
# ./build.sh deploy  - deploy hosting + database rules to Firebase
set -euo pipefail
cd "$(dirname "$0")"
case "${1:-serve}" in
  map)    python3 -I tools/bake_map.py ;;
  serve)  echo "http://localhost:8768"; exec python3 -m http.server 8768 --bind 127.0.0.1 --directory public ;;
  test)   node tools/simtest.mjs && node tools/admintest.mjs ;;
  deploy) node tools/simtest.mjs && node tools/admintest.mjs && firebase deploy --only hosting,database ;;
  *)      echo "usage: ./build.sh [map|serve|test|deploy]"; exit 1 ;;
esac
