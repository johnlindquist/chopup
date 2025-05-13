#!/bin/bash
set -euo pipefail

# Helper to print and exit on failure
die() { echo "[FAIL] $1"; exit 1; }

# Clean up temp dirs on exit
cleanup() {
  [[ -n "${LOGDIR:-}" && -d "$LOGDIR" ]] && rm -rf "$LOGDIR"
  [[ -n "${SOCKETPATH:-}" && -e "$SOCKETPATH" ]] && rm -f "$SOCKETPATH"
}
trap cleanup EXIT

# 1. Basic interactive example
echo "[TEST] Basic interactive example"
LOGDIR=$(mktemp -d)
SOCKETPATH="$LOGDIR/chopup-test.sock"
CHOPUP_OUT=$(mktemp)

# Start chopup in background, capture output
pnpm exec chopup --log-dir "$LOGDIR" --socket-path "$SOCKETPATH" -- node examples/interactive-script.js > "$CHOPUP_OUT" 2>&1 &
CHOPUP_PID=$!
sleep 2

grep -q "CHOPUP_SOCKET_PATH=$SOCKETPATH" "$CHOPUP_OUT" || die "Socket path not printed"

# Send input
echo "[TEST] send-input"
SEND_RESULT=$(pnpm exec chopup send-input --socket "$SOCKETPATH" --input "hello world\\n" 2>&1)
echo "$SEND_RESULT" | grep -q "CHOPUP_INPUT_SENT" || die "send-input did not succeed"

# Request logs
echo "[TEST] request-logs"
REQ_RESULT=$(pnpm exec chopup request-logs --socket "$SOCKETPATH" 2>&1)
echo "$REQ_RESULT" | grep -q "LOGS_CHOPPED" || die "request-logs did not succeed"

# Check log file exists
ls "$LOGDIR" | grep -q log || die "No log file created"

# Kill chopup process
tree-kill $CHOPUP_PID || kill $CHOPUP_PID || true
sleep 1

echo "[PASS] Basic interactive example"

# 2. Long running script with file watching
echo "[TEST] File watching and log chopping"
LOGDIR2=$(mktemp -d)
SOCKETPATH2="$LOGDIR2/chopup-test2.sock"
TOUCHFILE="$LOGDIR2/trigger.txt"
touch "$TOUCHFILE"
CHOPUP_OUT2=$(mktemp)

pnpm exec chopup --log-dir "$LOGDIR2" --socket-path "$SOCKETPATH2" --watch-file "$TOUCHFILE" -- node examples/long-running-script.js > "$CHOPUP_OUT2" 2>&1 &
CHOPUP_PID2=$!
sleep 2

grep -q "CHOPUP_SOCKET_PATH=$SOCKETPATH2" "$CHOPUP_OUT2" || die "Socket path not printed (file watch)"

touch "$TOUCHFILE"
sleep 2
ls "$LOGDIR2" | grep -q log || die "No log file created after file watch"

tree-kill $CHOPUP_PID2 || kill $CHOPUP_PID2 || true
sleep 1

echo "[PASS] File watching and log chopping"

# 3. Initial input (EXPERIMENTAL)
echo "[TEST] Initial input"
LOGDIR3=$(mktemp -d)
SOCKETPATH3="$LOGDIR3/chopup-test3.sock"
CHOPUP_OUT3=$(mktemp)

pnpm exec chopup --log-dir "$LOGDIR3" --socket-path "$SOCKETPATH3" --send "initinput\\n" -- node examples/interactive-script.js > "$CHOPUP_OUT3" 2>&1 &
CHOPUP_PID3=$!
sleep 2

grep -q "CHOPUP_SOCKET_PATH=$SOCKETPATH3" "$CHOPUP_OUT3" || die "Socket path not printed (initial input)"

tree-kill $CHOPUP_PID3 || kill $CHOPUP_PID3 || true
sleep 1

echo "[PASS] Initial input"

echo "[ALL PASS] All example scenarios verified." 