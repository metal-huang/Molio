#!/usr/bin/env bash
#
# Upload every release asset to OSS, in PARALLEL.
#
# Why parallel: sequentially this took ~60 minutes for ~340MB (GitHub's US
# runners → Guangzhou OSS ≈ 95KB/s per stream), which ran into the 1-hour STS
# session lifetime — run 36685374706 died at minute 60 with
# SecurityTokenExpired after uploading 5 of 8 assets. The transfers are
# independent, so fan out rather than waiting on each stream in turn.
#
# Raising --duration-seconds in sts_oidc.py is the other half of the fix, but
# the role's MaxSessionDuration caps it, so the wall-clock reduction must not
# depend on it.
#
# Required env:
#   TAG                      release tag, e.g. v0.3.59
#   OSS_BUCKET, OSS_ENDPOINT
#   OSS_ACCESS_KEY_ID, OSS_ACCESS_KEY_SECRET, OSS_SECURITY_TOKEN
# Optional env:
#   OSS_UPLOAD_PARALLEL      concurrent transfers (default 4)
#
# Usage: upload-release-assets.sh <asset-dir>
#
# Exits non-zero when ANY transfer fails, so the caller aborts before it
# rewrites the channel pointers — a partially uploaded version must never be
# advertised by latest.json / latest*.yml.

set -euo pipefail

: "${TAG:?TAG is required}"
: "${OSS_BUCKET:?OSS_BUCKET is required}"
: "${OSS_ENDPOINT:?OSS_ENDPOINT is required}"
: "${OSS_ACCESS_KEY_ID:?OSS_ACCESS_KEY_ID is required}"
: "${OSS_ACCESS_KEY_SECRET:?OSS_ACCESS_KEY_SECRET is required}"
: "${OSS_SECURITY_TOKEN:?OSS_SECURITY_TOKEN is required}"

ASSET_DIR="${1:?usage: upload-release-assets.sh <asset-dir>}"
PARALLEL="${OSS_UPLOAD_PARALLEL:-4}"

shopt -s nullglob
assets=("${ASSET_DIR}"/*)
if [ "${#assets[@]}" -eq 0 ]; then
  echo "::error::no assets found in ${ASSET_DIR}" >&2
  exit 1
fi

upload_one() {
  local file="$1"
  local filename
  filename=$(basename "$file")
  ossutil cp "$file" "oss://${OSS_BUCKET}/releases/${TAG}/${filename}" \
    --endpoint="${OSS_ENDPOINT}" \
    -i "${OSS_ACCESS_KEY_ID}" \
    -k "${OSS_ACCESS_KEY_SECRET}" \
    -t "${OSS_SECURITY_TOKEN}" \
    --update
}

pids=()
failed=0
uploaded=0
for file in "${assets[@]}"; do
  upload_one "$file" &
  pids+=($!)
  uploaded=$((uploaded + 1))

  # Keep at most PARALLEL transfers in flight.
  if [ "${#pids[@]}" -ge "${PARALLEL}" ]; then
    wait "${pids[0]}" || failed=1
    # Drop the finished pid. Guarded rather than sliced unconditionally:
    # under `set -u` bash 3.2 (macOS /bin/bash) treats an empty array
    # expansion as an unbound variable, and slicing a 1-element array empties
    # it — which is exactly what OSS_UPLOAD_PARALLEL=1 does.
    if [ "${#pids[@]}" -gt 1 ]; then
      pids=("${pids[@]:1}")
    else
      pids=()
    fi
  fi
done

# Drain whatever is still running. A bare `wait` would swallow the exit status
# of every background transfer, so collect each one explicitly. Guarded because
# the array is legitimately empty when every asset came off in a full window.
if [ "${#pids[@]}" -gt 0 ]; then
  for pid in "${pids[@]}"; do
    wait "$pid" || failed=1
  done
fi

if [ "$failed" -ne 0 ]; then
  echo "::error::At least one asset upload failed — channel pointers left unchanged" >&2
  exit 1
fi

echo "Uploaded ${uploaded} assets to oss://${OSS_BUCKET}/releases/${TAG}/"
