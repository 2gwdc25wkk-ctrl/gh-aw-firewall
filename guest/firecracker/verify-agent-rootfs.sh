#!/usr/bin/env bash
# Proves the agent rootfs satisfies the gh-aw execution contract.
#
# Usage: verify-agent-rootfs.sh <rootfs-tree|rootfs.ext4>
#
# Generated gh-aw agents need a real Bash/Node userspace, not just the binaries
# themselves: every required executable must have its interpreter and shared
# libraries present inside the guest tree. This checks both, and re-asserts the
# security properties the builder relies on.
#
# Passing an ext4 image verifies the published artifact rather than the staging
# tree. The image is only ever read: it is dumped through debugfs in read-only
# mode, so verification can run unprivileged in CI and can never mutate the
# artifact it is attesting.
set -euo pipefail

target=${1:?usage: verify-agent-rootfs.sh <rootfs-tree|rootfs.ext4>}
image=
extracted=

cleanup() {
  [ -n "$extracted" ] && rm -rf -- "$extracted"
}
trap cleanup EXIT

if [ -f "$target" ]; then
  command -v debugfs >/dev/null || {
    echo "verify-agent-rootfs: debugfs is required to verify an ext4 image" >&2
    exit 1
  }
  image=$target
  extracted=$(mktemp -d)
  # debugfs without -w opens the image read-only.
  debugfs -R "rdump / $extracted" "$target" >/dev/null 2>&1
  if [ ! -d "$extracted/etc" ]; then
    # Some debugfs versions nest the dump one level deep.
    for candidate in "$extracted"/*; do
      if [ -d "$candidate/etc" ]; then
        extracted_root=$candidate
        break
      fi
    done
    target=${extracted_root:?verify-agent-rootfs: could not locate rootfs in image dump}
  else
    target=$extracted
  fi
fi

tree=$(CDPATH= cd -- "$target" && pwd)

failures=0
fail() {
  echo "verify-agent-rootfs: $*" >&2
  failures=$((failures + 1))
}

require_file() {
  local relative=$1
  local path="$tree/$relative"
  if [ ! -e "$path" ]; then
    fail "missing required path: /$relative"
    return 1
  fi
  return 0
}

require_executable() {
  local relative=$1
  require_file "$relative" || return 0
  local path="$tree/$relative"
  local resolved
  resolved=$(readlink -f "$path" 2>/dev/null || true)
  if [ -z "$resolved" ] || [ ! -f "$resolved" ]; then
    fail "/$relative does not resolve to a regular file"
    return 0
  fi
  case "$resolved" in
    "$tree"/*) ;;
    *)
      fail "/$relative resolves outside the rootfs tree: $resolved"
      return 0
      ;;
  esac
  if [ ! -x "$resolved" ]; then
    fail "/$relative is not executable"
    return 0
  fi
  verify_dependencies "$relative" "$resolved"
}

# Resolves ELF interpreter and NEEDED libraries and proves each exists in-tree.
verify_dependencies() {
  local relative=$1
  local resolved=$2
  local header
  header=$(head -c 4 "$resolved" | od -An -tx1 | tr -d ' \n')
  if [ "$header" != "7f454c46" ]; then
    # Script: prove the shebang interpreter exists inside the tree.
    local shebang
    shebang=$(head -c 128 "$resolved" | head -n 1)
    case "$shebang" in
      '#!'*)
        local interpreter
        interpreter=$(printf '%s' "${shebang#\#!}" | awk '{print $1}')
        case "$interpreter" in
          /usr/bin/env)
            local program
            program=$(printf '%s' "${shebang#\#!}" | awk '{print $2}')
            [ -e "$tree/usr/bin/env" ] || fail "/$relative needs /usr/bin/env"
            command -v true >/dev/null
            if [ -n "$program" ] &&
              [ ! -e "$tree/usr/bin/$program" ] &&
              [ ! -e "$tree/bin/$program" ] &&
              [ ! -e "$tree/usr/local/bin/$program" ]; then
              fail "/$relative needs interpreter $program"
            fi
            ;;
          /*)
            [ -e "$tree$interpreter" ] || fail "/$relative needs interpreter $interpreter"
            ;;
        esac
        ;;
    esac
    return 0
  fi
  if ! command -v readelf >/dev/null; then
    return 0
  fi
  local interpreter
  interpreter=$(readelf -l "$resolved" 2>/dev/null |
    sed -n 's/.*program interpreter: \(.*\)\]/\1/p' | head -n 1)
  if [ -n "$interpreter" ] && [ ! -e "$tree$interpreter" ]; then
    fail "/$relative needs ELF interpreter $interpreter"
  fi
  local needed
  needed=$(readelf -d "$resolved" 2>/dev/null |
    sed -n 's/.*(NEEDED).*Shared library: \[\(.*\)\]/\1/p')
  local library
  for library in $needed; do
    if ! find "$tree/lib" "$tree/lib64" "$tree/usr/lib" "$tree/usr/lib64" \
      -name "$library" -print -quit 2>/dev/null | grep -q .; then
      fail "/$relative needs shared library $library"
    fi
  done
}

for executable in \
  bin/bash \
  bin/sh \
  sbin/awf-supervisor \
  usr/bin/env \
  usr/bin/git \
  usr/bin/curl \
  usr/bin/cat \
  usr/bin/cp \
  usr/bin/find \
  usr/bin/grep \
  usr/bin/id \
  usr/bin/mkdir \
  usr/bin/sed \
  usr/bin/tar \
  usr/sbin/ip \
  usr/local/bin/node \
  usr/local/bin/npm; do
  require_executable "$executable"
done

for path in \
  etc/group \
  etc/passwd \
  etc/resolv.conf \
  etc/ssl/certs/ca-certificates.crt \
  awf/exchange \
  awf/runner-temp \
  awf/runtime \
  workspace; do
  require_file "$path" || true
done

# The guest must never ship host or provider credential material.
for forbidden in \
  etc/shadow \
  etc/gshadow \
  root/.netrc \
  root/.git-credentials \
  root/.ssh \
  root/.aws \
  root/.docker \
  root/.npmrc; do
  if [ -e "$tree/$forbidden" ]; then
    fail "credential-bearing path present: /$forbidden"
  fi
done

if find "$tree" -xdev -type f -perm /6000 | grep -q .; then
  fail "setuid/setgid binaries present"
fi

# debugfs `rdump` restores only the nine rwx bits and skips device nodes, FIFOs
# and sockets, so the tree walk above can never observe setuid/setgid or special
# files that exist in the image. Read the inode modes out of the image itself.
verify_image_inode_modes() {
  local image=$1 tree=$2
  local commands listing
  commands=$(mktemp)
  listing=$(mktemp)
  {
    echo "ls -l -p /"
    (cd "$tree" && find . -type d -print) |
      sed -e 's|^\.||' -e '/^$/d' |
      while IFS= read -r directory; do
        printf 'ls -l -p %s\n' "$directory"
      done
  } >"$commands"
  debugfs -f "$commands" "$image" 2>/dev/null >"$listing"

  local offenders
  # `ls -l -p` emits ` /inode/mode/uid/gid/name/size/date/`, so real rows have a
  # blank first field; debugfs echoes its own commands, which do not.
  offenders=$(awk -F/ '
    $1 ~ /^[[:space:]]*$/ && NF >= 7 && $3 ~ /^[0-7]{5,7}$/ {
      mode = $3
      name = $6
      if (name == "" || name == "." || name == "..") next
      type = substr(mode, 1, length(mode) - 4)
      special = substr(mode, length(mode) - 3, 1)
      # Only 0 and the sticky bit (1) are permitted; 2/4 are setgid/setuid.
      if (special != "0" && special != "1") {
        print "setuid/setgid inode in image: " name " mode " mode
      }
      # 10 regular, 04 directory, 12 symlink; anything else is a special file.
      else if (type != "10" && type != "04" && type != "12") {
        print "special filesystem inode in image: " name " mode " mode
      }
    }' "$listing")
  rm -f "$commands" "$listing"

  if [ -n "$offenders" ]; then
    while IFS= read -r offender; do
      fail "$offender"
    done <<<"$offenders"
  fi
}

if [ -n "$image" ]; then
  verify_image_inode_modes "$image" "$tree"
fi

if [ "$failures" -ne 0 ]; then
  echo "verify-agent-rootfs: $failures check(s) failed" >&2
  exit 1
fi

echo "verify-agent-rootfs: agent rootfs contract satisfied"
