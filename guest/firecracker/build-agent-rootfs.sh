#!/usr/bin/env bash
# Builds the agent-capable Firecracker guest rootfs.
#
# This is deliberately a SEPARATE builder and a SEPARATE artifact from
# guest/firecracker/build-test-artifacts.sh. That script produces the tiny
# 128 MiB static BusyBox rootfs used for low-level boot/protocol smokes and its
# size and composition guarantees must not change. This script produces the
# larger rootfs needed to actually execute generated gh-aw agents: a real Bash,
# coreutils, git, curl, iproute2, CA certificates and a Node runtime, plus the
# same AWF guest supervisor as init.
#
# Every external input is pinned: the base image by manifest digest, Debian
# packages by snapshot.debian.org timestamp, and Node.js by release SHA-256.
set -euo pipefail

umask 077

# Base image pinned by manifest digest (debian:bookworm-slim).
DEBIAN_IMAGE_DIGEST=sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241
DEBIAN_IMAGE=debian@${DEBIAN_IMAGE_DIGEST}
# Frozen Debian package snapshot; no "latest" indexes are consulted.
DEBIAN_SNAPSHOT=20251101T000000Z
DEBIAN_SUITE=bookworm
NODE_VERSION=22.22.0
NODE_SHA256=9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37
CA_BUNDLE_DATE=2025-02-25
CA_BUNDLE_SHA256=50a6277ec69113f00c5fd45f09e8b97a4b3e32daa35d3a95ab30137a55386cef
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1767225600}
ROOTFS_BLOCKS=${ROOTFS_BLOCKS:-524288}
ROOTFS_UUID=1b6b0d2f-72e3-4f1b-9e6a-9d0f7c3a5f11

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
OUTPUT=${OUTPUT:-"$ROOT/release/firecracker-agent-x86_64"}
BUILD=${BUILD:-"$ROOT/.build/firecracker-agent-x86_64"}

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo "Firecracker agent rootfs must be built on Linux x86_64" >&2
  exit 1
fi

# Root is required so the exported Debian tree keeps its real ownership and
# permissions; a user-owned tree would produce an unusable guest filesystem.
if [ "$(id -u)" != 0 ]; then
  echo "Firecracker agent rootfs build must run as root (ownership fidelity)" >&2
  exit 1
fi

for tool in curl sha256sum tar docker mke2fs e2fsck go; do
  command -v "$tool" >/dev/null || {
    echo "required build tool not found: $tool" >&2
    exit 1
  }
done

rm -rf "$BUILD" "$OUTPUT"
mkdir -p "$BUILD/downloads" "$OUTPUT"

download_verified() {
  local url=$1
  local expected=$2
  local destination=$3
  curl --fail --location --proto '=https' --tlsv1.2 "$url" --output "$destination"
  printf '%s  %s\n' "$expected" "$destination" | sha256sum --check --status
}

# --- Base filesystem from the digest-pinned Debian image ---------------------
docker pull "$DEBIAN_IMAGE" >/dev/null
resolved_digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$DEBIAN_IMAGE")
case "$resolved_digest" in
  *"$DEBIAN_IMAGE_DIGEST") ;;
  *)
    echo "base image digest mismatch: $resolved_digest" >&2
    exit 1
    ;;
esac

rootfs_tree="$BUILD/rootfs"
mkdir -p "$rootfs_tree"

# Package installation runs inside the pinned base image against a frozen
# snapshot index, then the whole tree is exported. Nothing is fetched from a
# mutable "latest" Debian mirror.
cat >"$BUILD/install-packages.sh" <<EOF
#!/bin/sh
set -eu
cat >/etc/apt/sources.list <<SOURCES
deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/ ${DEBIAN_SUITE} main
deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/ ${DEBIAN_SUITE}-security main
SOURCES
rm -f /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources 2>/dev/null || true
echo 'Acquire::Check-Valid-Until "false";' >/etc/apt/apt.conf.d/99-awf-snapshot
export DEBIAN_FRONTEND=noninteractive
apt-get -o Acquire::Retries=3 update
apt-get -o Acquire::Retries=3 install --yes --no-install-recommends \\
  bash \\
  ca-certificates \\
  coreutils \\
  curl \\
  findutils \\
  gawk \\
  git \\
  grep \\
  iproute2 \\
  iputils-ping \\
  jq \\
  less \\
  openssl \\
  procps \\
  sed \\
  tar \\
  unzip \\
  xz-utils
dpkg-query --show --showformat='\${Package}\t\${Version}\t\${Architecture}\n' | sort >/awf-packages.tsv
apt-get clean
rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb
EOF
chmod 0755 "$BUILD/install-packages.sh"

container=$(docker create "$DEBIAN_IMAGE" /bin/sh -c 'sleep 3600')
cleanup_container() {
  docker rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup_container EXIT
docker start "$container" >/dev/null
docker cp "$BUILD/install-packages.sh" "$container:/install-packages.sh"
docker exec "$container" /install-packages.sh
docker cp "$container:/awf-packages.tsv" "$BUILD/packages.tsv"
docker export "$container" >"$BUILD/rootfs.tar"
cleanup_container
trap - EXIT

tar --extract --file "$BUILD/rootfs.tar" --directory "$rootfs_tree" \
  --numeric-owner \
  --same-owner \
  --preserve-permissions \
  --exclude='.dockerenv' \
  --exclude='awf-packages.tsv' \
  --exclude='install-packages.sh' \
  --exclude='dev/*' \
  --exclude='proc/*' \
  --exclude='sys/*'

# --- Node.js runtime, pinned by release checksum ----------------------------
node_tar="$BUILD/downloads/node-v${NODE_VERSION}-linux-x64.tar.xz"
download_verified \
  "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  "$NODE_SHA256" \
  "$node_tar"
mkdir -p "$rootfs_tree/opt/node"
tar --extract --xz --file "$node_tar" --directory "$rootfs_tree/opt/node" --strip-components=1
ln -sf ../../opt/node/bin/node "$rootfs_tree/usr/local/bin/node"
ln -sf ../../opt/node/bin/npm "$rootfs_tree/usr/local/bin/npm"
ln -sf ../../opt/node/bin/npx "$rootfs_tree/usr/local/bin/npx"

# --- CA bundle, pinned by checksum ------------------------------------------
ca_bundle="$BUILD/downloads/cacert-${CA_BUNDLE_DATE}.pem"
download_verified \
  "https://curl.se/ca/cacert-${CA_BUNDLE_DATE}.pem" \
  "$CA_BUNDLE_SHA256" \
  "$ca_bundle"
install -D -m 0644 "$ca_bundle" "$rootfs_tree/etc/ssl/certs/ca-certificates.crt"

# --- AWF guest supervisor (same init contract as the test rootfs) ------------
supervisor="$OUTPUT/awf-firecracker-supervisor"
VERSION="${VERSION:-agent-${DEBIAN_SUITE}-${DEBIAN_SNAPSHOT}}" \
  OUTPUT="$supervisor" \
  "$ROOT/guest/firecracker-supervisor/build.sh"
install -m 0755 "$supervisor" "$rootfs_tree/sbin/awf-supervisor"

# --- Guest identity and mount points ----------------------------------------
mkdir -p \
  "$rootfs_tree/awf/exchange" \
  "$rootfs_tree/awf/runner-temp" \
  "$rootfs_tree/awf/runtime" \
  "$rootfs_tree/dev" \
  "$rootfs_tree/proc" \
  "$rootfs_tree/sys" \
  "$rootfs_tree/tmp" \
  "$rootfs_tree/workspace"
cat >"$rootfs_tree/etc/passwd" <<'PASSWD'
root:x:0:0:root:/root:/bin/bash
awf:x:1000:1000:AWF guest:/workspace:/bin/bash
nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin
PASSWD
cat >"$rootfs_tree/etc/group" <<'GROUP'
root:x:0:
awf:x:1000:
nogroup:x:65534:
GROUP
cat >"$rootfs_tree/etc/resolv.conf" <<'RESOLV'
# Direct DNS is intentionally unavailable in the Firecracker preview.
RESOLV
cat >"$rootfs_tree/etc/hostname" <<'HOSTNAME'
awf-firecracker
HOSTNAME
# No host credential material, package caches, or machine identity ships here.
rm -f \
  "$rootfs_tree/etc/machine-id" \
  "$rootfs_tree/etc/shadow" \
  "$rootfs_tree/etc/shadow-" \
  "$rootfs_tree/etc/gshadow" \
  "$rootfs_tree/etc/gshadow-" \
  "$rootfs_tree/root/.bash_history"
chmod 0755 "$rootfs_tree/awf/runner-temp" "$rootfs_tree/awf/runtime" "$rootfs_tree/awf/exchange"
chmod 01777 "$rootfs_tree/tmp"

# setuid/setgid binaries are unnecessary for the guest workload and are a
# privilege-escalation surface once repository-controlled code runs inside.
find "$rootfs_tree" -xdev -type f -perm /6000 -exec chmod a-s {} +
if find "$rootfs_tree" -xdev -type f -perm /6000 | grep -q .; then
  echo "setuid/setgid binaries remain in the agent rootfs" >&2
  exit 1
fi

find "$rootfs_tree" -print0 | xargs -0 touch --no-dereference --date="@${SOURCE_DATE_EPOCH}"

# --- Image ------------------------------------------------------------------
rootfs="$OUTPUT/rootfs.ext4"
E2FSPROGS_FAKE_TIME="$SOURCE_DATE_EPOCH" mke2fs \
  -t ext4 \
  -F \
  -q \
  -b 4096 \
  -d "$rootfs_tree" \
  -U "$ROOTFS_UUID" \
  -E lazy_itable_init=0,lazy_journal_init=0 \
  "$rootfs" \
  "$ROOTFS_BLOCKS"
E2FSPROGS_FAKE_TIME="$SOURCE_DATE_EPOCH" e2fsck -f -y "$rootfs" >/dev/null

"$ROOT/guest/firecracker/verify-agent-rootfs.sh" "$rootfs_tree"
# Re-verify the published image itself so the artifact, not just the staging
# tree, is what carries the contract.
"$ROOT/guest/firecracker/verify-agent-rootfs.sh" "$rootfs"

(
  cd "$OUTPUT"
  sha256sum rootfs.ext4 awf-firecracker-supervisor >SHA256SUMS
)

package_json=$(
  awk -F'\t' 'BEGIN { printf "[" } {
    if (NR > 1) printf ",";
    printf "\n      {\"name\": \"%s\", \"version\": \"%s\", \"architecture\": \"%s\"}", $1, $2, $3
  } END { printf "\n    ]" }' "$BUILD/packages.tsv"
)

cat >"$OUTPUT/manifest.json" <<MANIFEST
{
  "schemaVersion": 1,
  "purpose": "AWF Firecracker agent-capable guest rootfs for gh-aw workloads",
  "artifact": "firecracker-agent-x86_64",
  "architecture": "x86_64",
  "sourceDateEpoch": ${SOURCE_DATE_EPOCH},
  "base": {
    "image": "debian:bookworm-slim",
    "digest": "${DEBIAN_IMAGE_DIGEST}",
    "snapshot": "${DEBIAN_SNAPSHOT}",
    "suite": "${DEBIAN_SUITE}"
  },
  "node": {
    "version": "${NODE_VERSION}",
    "tarballSha256": "${NODE_SHA256}"
  },
  "caBundle": {
    "date": "${CA_BUNDLE_DATE}",
    "sha256": "${CA_BUNDLE_SHA256}"
  },
  "rootfs": {
    "uuid": "${ROOTFS_UUID}",
    "blockSizeBytes": 4096,
    "blocks": ${ROOTFS_BLOCKS}
  },
  "packages": ${package_json}
}
MANIFEST

cat >"$OUTPUT/sbom.spdx.json" <<SBOM
{
  "spdxVersion": "SPDX-2.3",
  "dataLicense": "CC0-1.0",
  "SPDXID": "SPDXRef-DOCUMENT",
  "name": "awf-firecracker-agent-x86_64",
  "documentNamespace": "https://github.com/github/gh-aw-firewall/firecracker-agent/${SOURCE_DATE_EPOCH}",
  "creationInfo": {
    "created": "2026-01-01T00:00:00Z",
    "creators": ["Tool: guest/firecracker/build-agent-rootfs.sh"]
  },
  "packages": [
    {
      "name": "debian",
      "SPDXID": "SPDXRef-Debian",
      "versionInfo": "${DEBIAN_SUITE}@${DEBIAN_SNAPSHOT}",
      "downloadLocation": "https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/",
      "filesAnalyzed": false,
      "checksums": [
        { "algorithm": "SHA256", "checksumValue": "${DEBIAN_IMAGE_DIGEST#sha256:}" }
      ],
      "licenseConcluded": "NOASSERTION",
      "licenseDeclared": "NOASSERTION",
      "copyrightText": "NOASSERTION"
    },
    {
      "name": "nodejs",
      "SPDXID": "SPDXRef-NodeJS",
      "versionInfo": "${NODE_VERSION}",
      "downloadLocation": "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz",
      "filesAnalyzed": false,
      "checksums": [
        { "algorithm": "SHA256", "checksumValue": "${NODE_SHA256}" }
      ],
      "licenseConcluded": "MIT",
      "licenseDeclared": "MIT",
      "copyrightText": "NOASSERTION"
    }
  ],
  "relationships": [
    { "spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-Debian" },
    { "spdxElementId": "SPDXRef-DOCUMENT", "relationshipType": "DESCRIBES", "relatedSpdxElement": "SPDXRef-NodeJS" }
  ]
}
SBOM

cp "$BUILD/packages.tsv" "$OUTPUT/packages.tsv"

tar \
  --sort=name \
  --mtime="@${SOURCE_DATE_EPOCH}" \
  --owner=0 \
  --group=0 \
  --numeric-owner \
  --create \
  --gzip \
  --file "$OUTPUT/awf-firecracker-agent-x86_64.tar.gz" \
  --directory "$OUTPUT" \
  rootfs.ext4 \
  awf-firecracker-supervisor \
  SHA256SUMS \
  manifest.json \
  packages.tsv \
  sbom.spdx.json

echo "agent rootfs written to $OUTPUT"
