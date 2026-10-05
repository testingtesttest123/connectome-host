#!/usr/bin/env bash
# shadow-provision.sh — one-shot key-free rehearsal layout on agent-host.
#
# Creates the unprivileged rehearsal user and the directory contract, fetches
# ONLY ciphertext artifacts from the host's own backup dir, and verifies each
# against a pinned SHA256 before anything is decrypted. Decryption itself is a
# separate deliberate step (shadow-boot), never part of provisioning.
#
# Dry-run: SHADOW_DRYRUN=1 prints the plan and touches nothing.
# Idempotent: re-running verifies existing state instead of erroring.
# No provider keys, no channel tokens, no systemd units, no identity claim.
set -euo pipefail

HOST=ansible@204.168.244.110
KEY=${SHADOW_SSH_KEY:-$HOME/.ssh/hetzner_secondary}
SHADOW_USER=shadow-katie
BASE=/home/${SHADOW_USER}
ARTDIR=${BASE}/artifacts          # ciphertext lands here, 0700
SCRATCH=${BASE}/boot-scratch      # decryption scratch, 0700, wiped after boot
# Pinned artifact baselines (filename:sha256). Refuse everything else.
PINS=$(cat <<'EOF'
owned-core-20261003T0142.tar.gz.age:0afe8fbd8504ef9146508d8a401939a42a37d3244c354815e49cd8266dd49e6d
runtime-slice-20261003T0253.tar.gz.age:a2e804d193750f41dd2ec355e60c13f029e49b00a2c974c8e03456bf326061f7
mail-state-20261003T0404.tar.gz.age:29c78ec1563019a253840f610dea342961505cfbf088e37160da2ce8beb55a50
witness-source-20261003T0408.tar.gz.age:3383e39260e40e44efde6e04ca9c552bfe09e5e7cfa5244a9dc1d18d1ee549be
EOF
)

fail() { echo "REFUSED: $*" >&2; exit 1; }

run_remote() {
  if [ "${SHADOW_DRYRUN:-0}" = 1 ]; then echo "[dryrun] ssh $HOST: $*"; else
    ssh -i "$KEY" -o BatchMode=yes "$HOST" "$@"
  fi
}

# --- 1. user + directory contract -------------------------------------------
run_remote "set -e
  id -u ${SHADOW_USER} >/dev/null 2>&1 || sudo useradd -m -s /usr/sbin/nologin ${SHADOW_USER}
  sudo test \"\$(id -u ${SHADOW_USER})\" -ne 0
  sudo install -d -o ${SHADOW_USER} -g ${SHADOW_USER} -m 700 ${ARTDIR} ${SCRATCH}
  # contract: shell stays nologin; nothing in home is world-readable
  sudo test \"\$(getent passwd ${SHADOW_USER} | cut -d: -f7)\" = /usr/sbin/nologin
  echo USER_AND_DIRS_OK"

# --- 2. fetch ciphertext only ------------------------------------------------
while IFS=: read -r name sha; do
  [ -n "$name" ] || continue
  if [ "${SHADOW_DRYRUN:-0}" = 1 ]; then echo "[dryrun] would fetch+verify $name"; continue; fi
  scp -q -i "$KEY" "$HOST:/home/ansible/migration-source-backups/$name" "/tmp/$name.$$"
  echo "$sha  /tmp/$name.$$" | sha256sum -c - >/dev/null || { rm -f "/tmp/$name.$$"; fail "hash mismatch $name"; }
  # Move into place via sudo (shadow-katie home is not ansible-writable).
  ssh -i "$KEY" "$HOST" "sudo install -o ${SHADOW_USER} -g ${SHADOW_USER} -m 600 /tmp/$name.$$ ${ARTDIR}/$name && rm -f /tmp/$name.$$"
  echo "staged: $name"
done <<< "$PINS"

# --- 3. confirm no plaintext anywhere in the shadow home ---------------------
run_remote "sudo find ${BASE} -type f ! -name '*.age' ! -name '.*' -print -quit | grep -q . && echo WARN_PLAINTEXT_PRESENT || echo CIPHERTEXT_ONLY_OK"
echo "PROVISION_OK"
