#!/usr/bin/env bash

set -euo pipefail

minimum_disk_gib=150
apply=false
snapshot_verified=false

usage() {
  echo 'Usage: runtime-root-filesystem-expand.sh [--minimum-disk-gib 150] [--apply --snapshot-verified]' >&2
  exit 1
}

while (( $# > 0 )); do
  case "$1" in
    --minimum-disk-gib)
      (( $# >= 2 )) || usage
      minimum_disk_gib="$2"
      shift 2
      ;;
    --apply)
      apply=true
      shift
      ;;
    --snapshot-verified)
      snapshot_verified=true
      shift
      ;;
    *) usage ;;
  esac
done

[[ "${minimum_disk_gib}" =~ ^[1-9][0-9]*$ ]] || usage

for command in findmnt lsblk readlink df awk; do
  command -v "${command}" >/dev/null || {
    echo "Required command not found: ${command}" >&2
    exit 1
  }
done

root_source="$(findmnt -n -o SOURCE /)"
root_filesystem="$(findmnt -n -o FSTYPE /)"
root_options="$(findmnt -n -o OPTIONS /)"
root_partition="$(readlink -f "${root_source}")"

if [[ "${root_filesystem}" != 'ext4' ]]; then
  echo "Unsupported root filesystem: ${root_filesystem}; expected ext4" >&2
  exit 1
fi
if [[ ",${root_options}," != *,rw,* ]]; then
  echo 'Root filesystem is not mounted read-write' >&2
  exit 1
fi
if [[ "$(lsblk -dnro TYPE "${root_partition}")" != 'part' ]]; then
  echo "Root source is not a direct disk partition: ${root_partition}" >&2
  exit 1
fi

parent_name="$(lsblk -dnro PKNAME "${root_partition}" | awk 'NF { print; exit }')"
if [[ -z "${parent_name}" ]]; then
  echo "Unable to resolve parent disk for ${root_partition}" >&2
  exit 1
fi
disk="/dev/${parent_name}"
partition_number_file="/sys/class/block/$(basename "${root_partition}")/partition"
if [[ ! -r "${partition_number_file}" ]]; then
  echo "Unable to resolve partition number for ${root_partition}" >&2
  exit 1
fi
partition_number="$(<"${partition_number_file}")"

last_partition="$(lsblk -lnpo NAME,TYPE "${disk}" | awk '$2 == "part" { value = $1 } END { print value }')"
if [[ "$(readlink -f "${last_partition}")" != "${root_partition}" ]]; then
  echo "Root partition is not the last partition on ${disk}" >&2
  exit 1
fi

disk_bytes="$(lsblk -bdnro SIZE "${disk}")"
partition_bytes="$(lsblk -bdnro SIZE "${root_partition}")"
filesystem_bytes="$(df -B1 --output=size / | awk 'NR == 2 { print $1 }')"
target_bytes=$(( minimum_disk_gib * 1024 * 1024 * 1024 ))
tolerated_filesystem_bytes=$(( target_bytes * 95 / 100 ))
growth_margin_bytes=$(( 16 * 1024 * 1024 ))

printf 'disk=%s disk_bytes=%s partition=%s partition_bytes=%s filesystem_bytes=%s target_gib=%s\n' \
  "${disk}" "${disk_bytes}" "${root_partition}" "${partition_bytes}" "${filesystem_bytes}" \
  "${minimum_disk_gib}"

if (( disk_bytes < target_bytes )); then
  echo 'PENDING: expand the Tencent Cloud system disk before changing the guest partition' >&2
  exit 2
fi

partition_needs_growth=false
filesystem_needs_growth=false
if (( partition_bytes + growth_margin_bytes < disk_bytes )); then
  partition_needs_growth=true
fi
if (( filesystem_bytes < tolerated_filesystem_bytes )); then
  filesystem_needs_growth=true
fi

if [[ "${partition_needs_growth}" == false && "${filesystem_needs_growth}" == false ]]; then
  echo 'PASS: root partition and ext4 filesystem already use the expanded disk'
  exit 0
fi

if [[ "${apply}" == false ]]; then
  echo "READY: partition_growth=${partition_needs_growth} filesystem_growth=${filesystem_needs_growth}; rerun with --apply --snapshot-verified"
  exit 3
fi
if [[ "${snapshot_verified}" == false ]]; then
  echo 'Refusing to apply without --snapshot-verified' >&2
  exit 1
fi
if (( EUID != 0 )); then
  echo 'The apply operation must run as root' >&2
  exit 1
fi

for command in growpart resize2fs udevadm; do
  command -v "${command}" >/dev/null || {
    echo "Required apply command not found: ${command}" >&2
    exit 1
  }
done

sync
if [[ "${partition_needs_growth}" == true ]]; then
  growpart "${disk}" "${partition_number}"
  udevadm settle
  partition_bytes="$(lsblk -bdnro SIZE "${root_partition}")"
  if (( partition_bytes + growth_margin_bytes < disk_bytes )); then
    echo "Partition did not grow to the end of ${disk}" >&2
    exit 1
  fi
fi

if [[ "${filesystem_needs_growth}" == true ]]; then
  resize2fs "${root_partition}"
fi

filesystem_bytes="$(df -B1 --output=size / | awk 'NR == 2 { print $1 }')"
if (( filesystem_bytes < tolerated_filesystem_bytes )); then
  echo "Expanded filesystem is smaller than the tolerated ${minimum_disk_gib} GiB target" >&2
  exit 1
fi

printf 'PASS: disk_bytes=%s partition_bytes=%s filesystem_bytes=%s\n' \
  "${disk_bytes}" "${partition_bytes}" "${filesystem_bytes}"
