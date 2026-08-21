#!/usr/bin/env bash

set -euo pipefail

runtime_deploy_root="${RUNTIME_DEPLOY_ROOT:-/opt/wa-runtime}"
tool_root="${RUNTIME_STORAGE_ACCEPTANCE_TOOL_ROOT:-${runtime_deploy_root}/tools/storage-acceptance/current}"
observation_file="${RUNTIME_STORAGE_OBSERVATION_FILE:-${runtime_deploy_root}/shared/runtime-storage-observations.tsv}"
retention_log_file="${RUNTIME_RETENTION_OBSERVATION_FILE:-${runtime_deploy_root}/shared/runtime-retention-observations.jsonl}"
evaluator="${tool_root}/dist/scripts/evaluate-runtime-storage.js"

if [[ ! -f "${evaluator}" ]]; then
  echo "Runtime storage acceptance evaluator not found: ${evaluator}" >&2
  exit 1
fi

exec node "${evaluator}" \
  --observations "${observation_file}" \
  --retention-log "${retention_log_file}" \
  "$@"
