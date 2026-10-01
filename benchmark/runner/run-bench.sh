#!/usr/bin/env bash
# Benchmark A/B: tool `batch` (plugin) vs OpenCode pelado (sin el plugin).
# Corre la misma tarea, con el mismo modelo y el mismo workspace, N veces por
# condicion (alternando), y mide tokens por sesion con `opencode session export`.
#
# Uso:
#   ./runner/run-bench.sh              # 3 corridas por condicion (default)
#   RUNS=5 ./runner/run-bench.sh       # 5 corridas por condicion
#   MODEL=otro/modelo RUNS=1 ./runner/run-bench.sh
#
# Requisitos: opencode V2, git, jq, timeout (coreutils).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE="$ROOT/workspace"
PLUGIN="$HOME/.config/opencode/plugins/batch.js"
MOVED="$HOME/.config/opencode/.batch.js.bench-moved"
MODEL="${MODEL:-opencode-go/longcat-2.5-preview-free}"
RUNS="${RUNS:-3}"
RUN_TIMEOUT="${RUN_TIMEOUT:-600}"
RESULTS="${RESULTS:-$ROOT/results/$(printf '%s' "$MODEL" | tr '/#: ' '----')}"

PROMPT="En este proyecto corré los cuatro checks: npm test, npm run lint, npm run typecheck y npm run build. Decime cuáles pasan y cuáles fallan, con una línea por check. No modifiques archivos ni investigues más allá de eso."

mkdir -p "$RESULTS"
SUMMARY="$RESULTS/summary.tsv"
printf 'condicion\trun\tsession\tinput\toutput\treasoning\tcache_read\tcache_write\tcosto\tseg\tsteps\ttool_parts\tshell_calls\tbatch_calls\tbatch_failed\tresult_chars\tbatch_loaded\n' > "$SUMMARY"

restore_plugin() {
  if [ -f "$MOVED" ]; then
    mv "$MOVED" "$PLUGIN"
    echo "[bench] plugin batch restaurado en $PLUGIN"
  fi
}
trap restore_plugin EXIT INT TERM

run_one() {
  local cond="$1" i="$2"
  local tag="${cond}-${i}"
  local out="$RESULTS/run-${tag}.json" logs="$RESULTS/logs-${tag}.txt" exp="$RESULTS/export-${tag}.json"

  # Workspace limpio antes de cada corrida (por si el agente tocó algo).
  git -C "$WORKSPACE" checkout -q -- . 2>/dev/null
  git -C "$WORKSPACE" clean -qfd 2>/dev/null

  local start end rc sid
  start=$(date +%s)
  ( cd "$WORKSPACE" && timeout "$RUN_TIMEOUT" opencode run --standalone --auto --print-logs --format json --title "bench-${tag}" -m "$MODEL" "$PROMPT" ) >"$out" 2>"$logs"
  rc=$?
  end=$(date +%s)

  local batch_loaded="no"
  if grep -q 'loading plugin.*batch\.js' "$logs" 2>/dev/null; then batch_loaded="si"; fi

  sid=$(jq -r 'select(.sessionID != null) | .sessionID' "$out" 2>/dev/null | head -1)

  local input=0 output=0 reasoning=0 cread=0 cwrite=0 costo=0 steps=0 tool_calls=0 batch_calls=0 batch_failed=0 shell_calls=0 result_chars=0
  if [ -n "$sid" ]; then
    opencode session export "$sid" > "$exp" 2>/dev/null
    input=$(jq -r '.info.tokens.input // 0' "$exp" 2>/dev/null || echo 0)
    output=$(jq -r '.info.tokens.output // 0' "$exp" 2>/dev/null || echo 0)
    reasoning=$(jq -r '.info.tokens.reasoning // 0' "$exp" 2>/dev/null || echo 0)
    cread=$(jq -r '.info.tokens.cache.read // 0' "$exp" 2>/dev/null || echo 0)
    cwrite=$(jq -r '.info.tokens.cache.write // 0' "$exp" 2>/dev/null || echo 0)
    costo=$(jq -r '.info.cost // 0' "$exp" 2>/dev/null || echo 0)
    steps=$(jq '[.messages[] | select(.type=="assistant")] | length' "$exp" 2>/dev/null || echo 0)
    tool_calls=$(jq '[.messages[] | .content[]? | select(.type=="tool")] | length' "$exp" 2>/dev/null || echo 0)
    local direct_shell nested_shell
    direct_shell=$(jq '[.messages[] | .content[]? | select(.type=="tool" and .name=="shell")] | length' "$exp" 2>/dev/null || echo 0)
    nested_shell=$(jq '[.messages[] | .content[]? | select(.type=="tool") | .state.metadata.toolCalls[]? | select(.tool=="shell" and .status=="completed")] | length' "$exp" 2>/dev/null || echo 0)
    shell_calls=$(( ${direct_shell:-0} + ${nested_shell:-0} ))
    batch_calls=$(jq '[.messages[] | .content[]? | select(.type=="tool") | .state.metadata.toolCalls[]? | select(.tool=="batch" and .status=="completed")] | length' "$exp" 2>/dev/null || echo 0)
    batch_failed=$(jq '[.messages[] | .content[]? | select(.type=="tool") | .state.metadata.toolCalls[]? | select(.tool=="batch" and .status!="completed")] | length' "$exp" 2>/dev/null || echo 0)
    result_chars=$(jq '[.messages[] | .content[]? | select(.type=="tool") | ([.state.content[]?.text | length] | add // 0)] | add // 0' "$exp" 2>/dev/null || echo 0)
  fi

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$cond" "$i" "${sid:-FALLO}" "$input" "$output" "$reasoning" "$cread" "$cwrite" "$costo" \
    "$((end - start))" "$steps" "$tool_calls" "$shell_calls" "$batch_calls" "$batch_failed" "$result_chars" "$batch_loaded" >> "$SUMMARY"

  echo "[bench] ${tag}: rc=${rc} sid=${sid:-ninguna} in=${input} out=${output} cache_read=${cread} steps=${steps} tool_parts=${tool_calls} shell=${shell_calls} batch=${batch_calls}(fallidas:${batch_failed}) chars=${result_chars} plugin=${batch_loaded}"
}

echo "[bench] modelo: $MODEL"
echo "[bench] corridas por condicion: $RUNS"
echo "[bench] workspace: $WORKSPACE"
echo

for i in $(seq 1 "$RUNS"); do
  echo "[bench] --- corrida $i/$RUNS: con plugin ---"
  run_one con "$i"

  echo "[bench] --- corrida $i/$RUNS: sin plugin (se mueve batch.js temporalmente) ---"
  mv "$PLUGIN" "$MOVED"
  run_one sin "$i"
  mv "$MOVED" "$PLUGIN"
  echo "[bench] plugin batch restaurado"
  echo
done

echo "=== Resumen por condicion (promedios) ==="
awk -F'\t' 'NR==1 {next} {
  n[$1]++; i[$1]+=$4; o[$1]+=$5; r[$1]+=$6; cr[$1]+=$7; cw[$1]+=$8; t[$1]+=$12; sh[$1]+=$13; b[$1]+=$14; bf[$1]+=$15; ch[$1]+=$16; sec[$1]+=$10
} END {
  printf "%-4s %6s %12s %12s %12s %12s %14s %12s %8s %8s\n", "cond", "runs", "input", "output", "reasoning", "cache.read", "contexto.total", "chars.tools", "shell", "batch"
  split("con sin", order, " ")
  for (idx in order) { k = order[idx]; if (k in n) printf "%-4s %6d %12.1f %12.1f %12.1f %12.1f %14.1f %12.1f %8.1f %8.1f\n", k, n[k], i[k]/n[k], o[k]/n[k], r[k]/n[k], cr[k]/n[k], (i[k]+cr[k]+cw[k])/n[k], ch[k]/n[k], sh[k]/n[k], b[k]/n[k] }
}' "$SUMMARY"

echo
echo "Resultados crudos en: $RESULTS"
