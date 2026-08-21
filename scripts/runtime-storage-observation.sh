#!/usr/bin/env bash

set -euo pipefail

runtime_deploy_root="${RUNTIME_DEPLOY_ROOT:-/opt/wa-runtime}"
observation_file="${RUNTIME_STORAGE_OBSERVATION_FILE:-${runtime_deploy_root}/shared/runtime-storage-observations.tsv}"
retention_log_file="${RUNTIME_RETENTION_OBSERVATION_FILE:-${runtime_deploy_root}/shared/runtime-retention-observations.jsonl}"
compose_file="${runtime_deploy_root}/current/docker-compose.yml"

if [[ ! -f "${compose_file}" ]]; then
  echo "Runtime Compose file not found: ${compose_file}" >&2
  exit 1
fi

observation_dir="$(dirname "${observation_file}")"
mkdir -p "${observation_dir}"
mkdir -p "$(dirname "${retention_log_file}")"

exec 9>"${observation_file}.lock"
if ! flock -n 9; then
  exit 0
fi

postgres_container="$(docker compose -f "${compose_file}" ps -q postgres)"
if [[ -z "${postgres_container}" ]]; then
  echo "Runtime PostgreSQL container is not running" >&2
  exit 1
fi

database_user="$(
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${postgres_container}" |
    sed -n 's/^POSTGRES_USER=//p' | tail -1
)"
database_name="$(
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "${postgres_container}" |
    sed -n 's/^POSTGRES_DB=//p' | tail -1
)"
if [[ -z "${database_user}" || -z "${database_name}" ]]; then
  echo "Runtime PostgreSQL database identity is unavailable" >&2
  exit 1
fi

read -r root_size_bytes root_used_bytes root_available_bytes root_used_percent < <(
  df -B1 --output=size,used,avail,pcent / | tail -1
)
root_used_percent="${root_used_percent%%%}"

database_metrics="$(
  docker exec -i "${postgres_container}" psql \
    -X -v ON_ERROR_STOP=1 -U "${database_user}" -d "${database_name}" -At -F '|' <<'SQL'
WITH table_stats AS MATERIALIZED (
  SELECT relname, n_live_tup, n_dead_tup, n_tup_ins, n_tup_del, autovacuum_count
  FROM pg_stat_user_tables
  WHERE relname IN ('webhook_events', 'runtime_events', 'inbound_messages', 'contact_observations')
), intent_stats AS MATERIALIZED (
  SELECT
    count(*) FILTER (WHERE processing_state = 'PENDING') AS pending,
    count(*) FILTER (WHERE processing_state = 'PROCESSING') AS processing,
    count(*) FILTER (WHERE processing_state = 'RETRY') AS retry,
    count(*) FILTER (WHERE processing_state = 'DEAD') AS dead,
    COALESCE(
      round(extract(epoch FROM now() - (
        min(created_at) FILTER (WHERE processing_state IN ('PENDING', 'PROCESSING', 'RETRY'))
      ))),
      0
    )::bigint AS oldest_active_seconds
  FROM contact_message_observation_intents
)
SELECT
  pg_database_size(current_database()),
  pg_total_relation_size('webhook_events'::regclass),
  COALESCE((SELECT n_live_tup FROM table_stats WHERE relname = 'webhook_events'), 0),
  COALESCE((SELECT n_dead_tup FROM table_stats WHERE relname = 'webhook_events'), 0),
  COALESCE((SELECT n_tup_ins FROM table_stats WHERE relname = 'webhook_events'), 0),
  COALESCE((SELECT n_tup_del FROM table_stats WHERE relname = 'webhook_events'), 0),
  COALESCE((SELECT autovacuum_count FROM table_stats WHERE relname = 'webhook_events'), 0),
  pg_total_relation_size('runtime_events'::regclass),
  COALESCE((SELECT n_live_tup FROM table_stats WHERE relname = 'runtime_events'), 0),
  COALESCE((SELECT n_dead_tup FROM table_stats WHERE relname = 'runtime_events'), 0),
  COALESCE((SELECT n_tup_ins FROM table_stats WHERE relname = 'runtime_events'), 0),
  COALESCE((SELECT n_tup_del FROM table_stats WHERE relname = 'runtime_events'), 0),
  COALESCE((SELECT autovacuum_count FROM table_stats WHERE relname = 'runtime_events'), 0),
  pg_total_relation_size('inbound_messages'::regclass),
  COALESCE((SELECT n_live_tup FROM table_stats WHERE relname = 'inbound_messages'), 0),
  COALESCE((SELECT n_dead_tup FROM table_stats WHERE relname = 'inbound_messages'), 0),
  COALESCE((SELECT n_tup_ins FROM table_stats WHERE relname = 'inbound_messages'), 0),
  COALESCE((SELECT n_tup_del FROM table_stats WHERE relname = 'inbound_messages'), 0),
  COALESCE((SELECT autovacuum_count FROM table_stats WHERE relname = 'inbound_messages'), 0),
  pg_total_relation_size('contact_observations'::regclass),
  COALESCE((SELECT n_live_tup FROM table_stats WHERE relname = 'contact_observations'), 0),
  COALESCE((SELECT n_dead_tup FROM table_stats WHERE relname = 'contact_observations'), 0),
  COALESCE((SELECT n_tup_ins FROM table_stats WHERE relname = 'contact_observations'), 0),
  COALESCE((SELECT n_tup_del FROM table_stats WHERE relname = 'contact_observations'), 0),
  COALESCE((SELECT autovacuum_count FROM table_stats WHERE relname = 'contact_observations'), 0),
  pending, processing, retry, dead, oldest_active_seconds
FROM intent_stats;
SQL
)"

expected_database_fields=30
actual_database_fields="$(awk -F '|' '{print NF}' <<<"${database_metrics}")"
if [[ "${actual_database_fields}" != "${expected_database_fields}" ]]; then
  echo "Unexpected Runtime storage observation field count: ${actual_database_fields}" >&2
  exit 1
fi

header='observed_at_utc|root_size_bytes|root_used_bytes|root_available_bytes|root_used_percent|database_bytes|webhook_events_bytes|webhook_events_live_rows|webhook_events_dead_rows|webhook_events_inserted_total|webhook_events_deleted_total|webhook_events_autovacuum_total|runtime_events_bytes|runtime_events_live_rows|runtime_events_dead_rows|runtime_events_inserted_total|runtime_events_deleted_total|runtime_events_autovacuum_total|inbound_messages_bytes|inbound_messages_live_rows|inbound_messages_dead_rows|inbound_messages_inserted_total|inbound_messages_deleted_total|inbound_messages_autovacuum_total|contact_observations_bytes|contact_observations_live_rows|contact_observations_dead_rows|contact_observations_inserted_total|contact_observations_deleted_total|contact_observations_autovacuum_total|contact_intent_pending_rows|contact_intent_processing_rows|contact_intent_retry_rows|contact_intent_dead_rows|contact_intent_oldest_active_seconds'

if [[ ! -s "${observation_file}" ]]; then
  printf '%s\n' "${header}" >"${observation_file}"
fi
printf '%s|%s|%s|%s|%s|%s\n' \
  "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  "${root_size_bytes}" "${root_used_bytes}" "${root_available_bytes}" "${root_used_percent}" \
  "${database_metrics}" >>"${observation_file}"

scheduler_container="$(docker compose -f "${compose_file}" ps -q scheduler || true)"
if [[ -n "${scheduler_container}" ]]; then
  latest_retention_log="$(
    docker logs --since=70m "${scheduler_container}" 2>&1 |
      grep -F '"message":"data.retention.completed"' | tail -1 || true
  )"
  if [[ -n "${latest_retention_log}" ]]; then
    touch "${retention_log_file}"
    if ! tail -1 "${retention_log_file}" | grep -Fqx "${latest_retention_log}"; then
      printf '%s\n' "${latest_retention_log}" >>"${retention_log_file}"
    fi
  fi
fi

if (( root_used_percent >= 90 )); then
  logger -p user.crit -t wa-runtime-storage \
    "Runtime root filesystem is at ${root_used_percent}% (critical threshold: 90%)"
elif (( root_used_percent >= 80 )); then
  logger -p user.warning -t wa-runtime-storage \
    "Runtime root filesystem is at ${root_used_percent}% (escalation threshold: 80%)"
elif (( root_used_percent >= 70 )); then
  logger -p user.notice -t wa-runtime-storage \
    "Runtime root filesystem is at ${root_used_percent}% (warning threshold: 70%)"
fi
