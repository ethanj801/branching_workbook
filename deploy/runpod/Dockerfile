FROM ghcr.io/theroyallab/tabbyapi:latest

ENV PYTHONUNBUFFERED=1 \
    HF_HUB_ENABLE_HF_TRANSFER=1 \
    TABBY_HOST=127.0.0.1 \
    TABBY_PORT=5000 \
    TABBY_DISABLE_AUTH=true \
    TABBY_MODEL_DIR=/workspace/models \
    TABBY_CONFIG_PATH=/workspace/tabby-config/config.yml

RUN apt-get update --yes && \
    DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
        curl \
        openssh-server && \
    rm -rf /var/lib/apt/lists/* && \
    cd /app && \
    python3 -m pip install --no-cache-dir -U '.[cu12]' hf_transfer && \
    python3 -m pip uninstall -y infinity-emb sentence-transformers || true && \
    mkdir -p /var/run/sshd /workspace/models /workspace/tabby-config

COPY runpod-entrypoint.sh /usr/local/bin/runpod-entrypoint.sh
RUN chmod +x /usr/local/bin/runpod-entrypoint.sh

EXPOSE 22

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${TABBY_PORT}/health || exit 1

ENTRYPOINT ["/usr/local/bin/runpod-entrypoint.sh"]
