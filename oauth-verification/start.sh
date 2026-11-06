#!/bin/bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"
for tool in node ffmpeg ffprobe swiftc; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
node record.mjs "$@"
