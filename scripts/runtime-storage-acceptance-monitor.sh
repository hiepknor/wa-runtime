#!/usr/bin/env bash

set -euo pipefail

runtime_deploy_root="${RUNTIME_DEPLOY_ROOT:-/opt/wa-runtime}"
evaluator="${runtime_deploy_root}/scripts/runtime-storage-acceptance.sh"
report_file="${RUNTIME_STORAGE_ACCEPTANCE_REPORT_FILE:-${runtime_deploy_root}/shared/runtime-storage-acceptance.json}"

if [[ ! -x "${evaluator}" ]]; then
  echo "Runtime storage acceptance wrapper is unavailable: ${evaluator}" >&2
  exit 1
fi

mkdir -p "$(dirname "${report_file}")"
exec 9>"${report_file}.lock"
if ! flock -n 9; then
  exit 0
fi

temporary_report="$(mktemp "${report_file}.tmp.XXXXXX")"
cleanup() {
  rm -f -- "${temporary_report}"
}
trap cleanup EXIT

set +e
"${evaluator}" >"${temporary_report}"
result=$?
set -e

status="$(awk -F '"' '/^[[:space:]]*"status"[[:space:]]*:/ { print $4; exit }' "${temporary_report}")"
case "${result}:${status}" in
  0:PASS|1:FAIL|2:PENDING) ;;
  *)
    echo "Invalid Runtime storage acceptance result: exit=${result} status=${status:-missing}" >&2
    exit 1
    ;;
esac

chmod 0600 "${temporary_report}"
mv -f -- "${temporary_report}" "${report_file}"
trap - EXIT
printf 'Runtime storage acceptance status=%s report=%s\n' "${status}" "${report_file}"
exit "${result}"
