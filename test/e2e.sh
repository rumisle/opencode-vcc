#!/usr/bin/env bash
# End-to-end: a real `opencode serve` with this plugin, against test/fake-anthropic.ts.
# Runs /compact, an automatic compaction, a vcc_recall tool call, and the /recall command,
# then checks the database and the requests the model received.
#   test/e2e.sh [opencode binary]   (default: opencode2)
set -euo pipefail
OC=${1:-opencode2}
# The plugin to load; e.g. PLUGIN=github:rumisle/opencode-vcc#<commit> to test an install.
PLUGIN=${PLUGIN:-}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
E=/tmp/vcc-e2e
PORT=4822
FAKE=4821
S=agent-vcce2e-$(openssl rand -hex 3)
cleanup() { tmux kill-session -t "$S" 2>/dev/null || true; }
trap cleanup EXIT

rm -rf $E && mkdir -p $E/{config/opencode,data,state,cache,work}
cat > $E/config/opencode/opencode.jsonc <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugins": ["${PLUGIN:-$ROOT}"],
  "providers": { "anthropic": { "settings": { "baseURL": "http://127.0.0.1:$FAKE/v1" } } }
}
EOF
cat > $E/env.sh <<EOF
export XDG_CONFIG_HOME=$E/config XDG_DATA_HOME=$E/data XDG_STATE_HOME=$E/state XDG_CACHE_HOME=$E/cache
export OPENCODE_SERVER_PASSWORD=test ANTHROPIC_API_KEY=sk-ant-fake OPENCODE_VCC_DEBUG=1 OUT=$E FAKE_PORT=$FAKE
EOF
. $E/env.sh

tmux new-session -d -s "$S" -n fake ". $E/env.sh && bun $ROOT/test/fake-anthropic.ts > $E/fake.log 2>&1"
tmux new-window -t "$S" -n oc ". $E/env.sh && cd $E/work && $OC serve --port $PORT --print-logs --log-level info > $E/oc.log 2>&1"
URL=http://127.0.0.1:$PORT
A() { $OC api --server $URL "$@"; }
timeout 60 sh -c "until $OC api --server $URL get /api/session >/dev/null 2>&1; do sleep 0.5; done"

cd $E/work
run() { timeout 120 $OC run --server $URL -m anthropic/claude-opus-5-5 --auto "$@" 2>&1 | tail -3; }
wait_idle() { A post "/api/experimental/session/$SID/wait" >/dev/null 2>&1 || true; }
run --title vcc-e2e "WORK 1: set up the project. Always use tabs, never spaces."
SID=$(A get /api/session | jq -r '[.data[] | select(.title == "vcc-e2e")][0].id')
echo "session $SID"
run -s "$SID" "WORK 2: add the second file"
run -s "$SID" "WORK 3: third file"

echo "== /compact"
A post "/api/session/$SID/compact" -d '{}' >/dev/null
wait_idle
run -s "$SID" "WORK 4 after the first compaction"
run -s "$SID" "WORK 5 BIG turn"
echo "== automatic compaction on the next turn"
run -s "$SID" "WORK 6 after auto compaction"
echo "== vcc_recall tool"
run -s "$SID" "RECALL tabs spaces"
echo "== /recall command"
A post "/api/session/$SID/command" -d '{"name":"recall","text":"file-1"}' >/dev/null
wait_idle

echo "== checks"
bun "$ROOT/test/e2e-check.ts" "$E" "$SID"
