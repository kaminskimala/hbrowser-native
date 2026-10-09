#!/bin/sh
# Optional local Linux x64 runtime. Does not change system packages or shell config.
set -eu
HB_PROJECT_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$HB_PROJECT_ROOT"
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  printf '%s\n' 'Install Node 24.21.0 for your platform from https://nodejs.org/ then run npm ci.' >&2
  exit 1
fi
HB_VERSION=v24.21.0
HB_ARCHIVE="node-$HB_VERSION-linux-x64.tar.xz"
mkdir -p .tools
if [ -x ".tools/node-$HB_VERSION-linux-x64/bin/node" ]; then
  exec ".tools/node-$HB_VERSION-linux-x64/bin/node" --version
fi
curl --fail --silent --show-error --location "https://nodejs.org/dist/$HB_VERSION/$HB_ARCHIVE" -o ".tools/$HB_ARCHIVE"
curl --fail --silent --show-error --location "https://nodejs.org/dist/$HB_VERSION/SHASUMS256.txt" -o .tools/SHASUMS256.txt
HB_EXPECTED=$(awk -v name="$HB_ARCHIVE" '$2 == name {print $1}' .tools/SHASUMS256.txt)
test -n "$HB_EXPECTED"
printf '%s  %s\n' "$HB_EXPECTED" ".tools/$HB_ARCHIVE" | sha256sum --check --status
tar -xJf ".tools/$HB_ARCHIVE" -C .tools
rm ".tools/$HB_ARCHIVE"
exec ".tools/node-$HB_VERSION-linux-x64/bin/node" --version
