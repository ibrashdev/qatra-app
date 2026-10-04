#!/usr/bin/env bash
# run_local.sh -- LOCAL validation of supabase/migrations/*.sql on a scratch PostgreSQL.
#
# NEVER run this against production or any shared database: it creates and drops a
# scratch database and creates API roles (anon, authenticated, service_role) if absent.
# See README.md in this folder.
#
# Steps: ensure the cluster is running -> create database qatra_local_<pid> ->
# apply 00_supabase_shim.sql and 01_check_helpers.sql -> for every migration in sorted
# order apply it (psql -v ON_ERROR_STOP=1, one transaction) and then run the checks file
# with the same four-digit prefix (checks_0001.sql after 0001_*.sql) -> print PASS/FAIL
# per check -> drop the scratch database unless KEEP_DB=1.
#
# Environment:
#   KEEP_DB=1   keep the scratch database and print its name
#   UPTO=0001   stop after the migration with this prefix (and its checks)
#   PGVER / PGCLUSTER   cluster started with pg_ctlcluster when it is down (16 / main)
#   As root the script uses `runuser -u postgres`; otherwise it calls psql directly and
#   expects PG* variables that reach a superuser.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
MIG_DIR="$REPO_ROOT/supabase/migrations"
PGVER="${PGVER:-16}"
PGCLUSTER="${PGCLUSTER:-main}"
KEEP_DB="${KEEP_DB:-0}"
UPTO="${UPTO:-}"
DB="qatra_local_$$"
WORK="$(mktemp -d)"
PASS=0
FAIL=0
DB_CREATED=0

export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

pg() { # superuser psql; extra arguments are passed to psql, SQL arrives on stdin or -f -
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u postgres -- psql -X -q -v ON_ERROR_STOP=1 "$@"
  else
    psql -X -q -v ON_ERROR_STOP=1 "$@"
  fi
}

cleanup() {
  rm -rf "$WORK"
  if [ "$DB_CREATED" = 1 ]; then
    if [ "$KEEP_DB" = 1 ]; then
      echo "KEEP_DB=1: scratch database kept: $DB (drop it with: runuser -u postgres -- psql -c 'drop database \"$DB\"')"
    else
      pg -d postgres -c "drop database if exists \"$DB\" with (force)" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

ensure_cluster() {
  if pg_isready -q 2>/dev/null; then
    return
  fi
  if command -v pg_ctlcluster >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
    echo "Starting PostgreSQL cluster $PGVER/$PGCLUSTER ..."
    pg_ctlcluster "$PGVER" "$PGCLUSTER" start || true
  fi
  for _ in $(seq 1 30); do
    if pg_isready -q 2>/dev/null; then
      return
    fi
    sleep 1
  done
  echo "FAIL  PostgreSQL is not reachable (start the cluster, then run again)" >&2
  exit 1
}

apply_file() { # $1 file, $2 label ; one transaction; stops at the first error
  local out
  if out="$(pg -1 -v VERBOSITY=terse -d "$DB" -f - <"$1" 2>&1)"; then
    echo "APPLIED  $2"
  else
    echo "FAIL     $2 could not be applied"
    printf '%s\n' "$out" | sed 's/^/         /'
    FAIL=$((FAIL + 1))
    return 1
  fi
}

run_checks() { # $1 checks file; every "-- CHECK: name" starts one independent chunk
  local file="$1" label dir chunk name out
  label="$(basename "$file" .sql)"
  dir="$WORK/$label"
  mkdir -p "$dir"
  awk -v dir="$dir" '
    /^-- CHECK:/ {
      if (sqlfile != "") close(sqlfile)
      n++
      name = $0
      sub(/^-- CHECK:[ ]*/, "", name)
      sqlfile = sprintf("%s/%03d.sql", dir, n)
      namefile = sprintf("%s/%03d.name", dir, n)
      print name > namefile
      close(namefile)
      next
    }
    n > 0 { print > sqlfile }
  ' "$file"
  for chunk in "$dir"/*.sql; do
    [ -e "$chunk" ] || continue
    name="$(cat "${chunk%.sql}.name")"
    if out="$(pg -v VERBOSITY=terse -d "$DB" -f - <"$chunk" 2>&1)"; then
      echo "PASS  $label: $name"
      PASS=$((PASS + 1))
    else
      echo "FAIL  $label: $name"
      printf '%s\n' "$out" | sed 's/^/        /'
      FAIL=$((FAIL + 1))
    fi
  done
}

ensure_cluster

server_version_num="$(pg -d postgres -Atc 'show server_version_num')"
server_version="$(pg -d postgres -Atc 'show server_version')"
echo "PostgreSQL $server_version (scratch database $DB)"
if [ "$server_version_num" -lt 150000 ]; then
  echo "FAIL  PostgreSQL 15 or later is required (Database-schema.md OPEN-15)" >&2
  exit 1
fi
if [ "$(pg -d postgres -Atc "select count(*) from pg_available_extensions where name = 'vector'")" = 0 ]; then
  echo "FAIL  pgvector is not installed (apt-get install -y postgresql-$PGVER-pgvector)" >&2
  exit 1
fi

mapfile -t MIGRATIONS < <(find "$MIG_DIR" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' | sort)
if [ "${#MIGRATIONS[@]}" -eq 0 ]; then
  echo "FAIL  no migration found in $MIG_DIR" >&2
  exit 1
fi

pg -d postgres -c "create database \"$DB\" template template0 encoding 'UTF8'"
DB_CREATED=1

for f in "$HERE"/[0-9][0-9]_*.sql; do
  apply_file "$f" "$(basename "$f")" || exit 1
done

declare -A CHECKED=()
for mig in "${MIGRATIONS[@]}"; do
  base="$(basename "$mig")"
  prefix="${base:0:4}"
  if [ -n "$UPTO" ] && [[ "$prefix" > "$UPTO" ]]; then
    echo "UPTO=$UPTO: stopping before $base"
    break
  fi
  apply_file "$mig" "$base" || exit 1
  if [ -f "$HERE/checks_${prefix}.sql" ]; then
    run_checks "$HERE/checks_${prefix}.sql"
    CHECKED[$prefix]=1
  fi
done

# Checks files without a matching migration prefix run last (cross-cutting checks).
for f in "$HERE"/checks_*.sql; do
  [ -e "$f" ] || continue
  prefix="$(basename "$f" .sql)"
  prefix="${prefix#checks_}"
  if [ -z "${CHECKED[$prefix]:-}" ] && ! printf '%s\n' "${MIGRATIONS[@]##*/}" | grep -q "^${prefix}_"; then
    run_checks "$f"
  fi
done

echo "----"
echo "checks passed: $PASS, failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
