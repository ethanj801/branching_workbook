#!/usr/bin/env bash
set -euo pipefail

TABBY_HOST="${TABBY_HOST:-127.0.0.1}"
TABBY_PORT="${TABBY_PORT:-5000}"
TABBY_DISABLE_AUTH="${TABBY_DISABLE_AUTH:-true}"
TABBY_MODEL_DIR="${TABBY_MODEL_DIR:-/workspace/models}"
TABBY_CONFIG_PATH="${TABBY_CONFIG_PATH:-/workspace/tabby-config/config.yml}"
TABBY_CONFIG_DIR="$(dirname "$TABBY_CONFIG_PATH")"
SSH_KEY_VALUE="${PUBLIC_KEY:-${SSH_PUBLIC_KEY:-}}"

mkdir -p "$TABBY_MODEL_DIR" "$TABBY_CONFIG_DIR" /var/run/sshd /root/.ssh
chmod 700 /root/.ssh

if [[ -n "$SSH_KEY_VALUE" ]]; then
    touch /root/.ssh/authorized_keys
    if ! grep -qxF "$SSH_KEY_VALUE" /root/.ssh/authorized_keys; then
        printf '%s\n' "$SSH_KEY_VALUE" >> /root/.ssh/authorized_keys
    fi
    chmod 600 /root/.ssh/authorized_keys
else
    echo "warning: neither PUBLIC_KEY nor SSH_PUBLIC_KEY is set; SSH login may fail" >&2
fi

ssh-keygen -A >/dev/null 2>&1
service ssh start

cat >"$TABBY_CONFIG_PATH" <<EOF
network:
  host: "$TABBY_HOST"
  port: $TABBY_PORT
  disable_auth: $TABBY_DISABLE_AUTH

model:
  model_dir: "$TABBY_MODEL_DIR"
EOF

cd /app
exec python3 main.py --config "$TABBY_CONFIG_PATH"
