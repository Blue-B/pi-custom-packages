#!/usr/bin/env bash
# Run N ChatGPT web chats in parallel for the same prompt (one tab each, one browser).
# usage: batch.sh <outdir> <N> <prompt>
set -euo pipefail

out=${1:?usage: batch.sh <outdir> <N> <prompt>}
jobs=${2:?usage: batch.sh <outdir> <N> <prompt>}
prompt=${3:?usage: batch.sh <outdir> <N> <prompt>}
here=$(cd "$(dirname "$0")" && pwd)

mkdir -p "$out"
pids=()
for _ in $(seq 1 "$jobs"); do
	"$here/gen.sh" "$out" "$prompt" &
	pids+=($!)
	sleep 2 # stagger mounts so the tabs do not race on navigation
done
fail=0
for p in "${pids[@]}"; do wait "$p" || fail=$((fail + 1)); done
echo "done: $jobs job(s), $fail failed" >&2
[ "$fail" -eq 0 ]
