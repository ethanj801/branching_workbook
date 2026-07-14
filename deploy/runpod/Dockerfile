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
        openssh-server \
        patch && \
    rm -rf /var/lib/apt/lists/* && \
    cd /app && \
    python3 -m pip install --no-cache-dir -U '.[cu12]' hf_transfer && \
    python3 -m pip uninstall -y infinity-emb sentence-transformers || true && \
    mkdir -p /var/run/sshd /workspace/models /workspace/tabby-config

# Temporary chat completions logprobs fix until the upstream base image carries it.
# Idempotent. It is a no-op once the base already has the fix.
RUN python3 -c "p='/app/endpoints/OAI/utils/chat_completion.py'; s=open(p).read(); open(p,'w').write(s.replace('tag not in [t_think_end, t_tool_end]', 'tag not in [t for t in (t_think_end, t_tool_end) if t]'))"

# Adds continue_final_message to chat completions until the upstream base image
# carries it (fork branch ethanj801/tabbyAPI continue-final-message).
# Idempotent. It is a no-op once the base already has the feature.
COPY tabbyapi-continue-final-message.patch /tmp/
RUN cd /app && \
    { grep -q continue_final_message endpoints/OAI/types/chat_completion.py || \
      patch -p1 --fuzz=0 < /tmp/tabbyapi-continue-final-message.patch; } && \
    rm /tmp/tabbyapi-continue-final-message.patch

# Makes ban_eos_token mask EOS and banned_tokens mask listed token IDs during
# sampling on the exl3 backend until the upstream base image carries it
# (fork branch ethanj801/tabbyAPI fix-exl3-ban-eos-token).
# Idempotent. It is a no-op once the base already has the feature.
COPY tabbyapi-exl3-ban-eos-token.patch /tmp/
RUN cd /app && \
    { grep -q SS_BanTokens backends/exllamav3/sampler.py || \
      patch -p1 --fuzz=0 < /tmp/tabbyapi-exl3-ban-eos-token.patch; } && \
    rm /tmp/tabbyapi-exl3-ban-eos-token.patch

# Adds the post_sampling_probs request field and passes it to the exl3 job
# until the upstream base image carries it.
# Idempotent. It is a no-op once the base already has the field.
COPY tabbyapi-exl3-post-sampling-probs.patch /tmp/
RUN cd /app && \
    { grep -q post_sampling_probs common/sampling.py || \
      patch -p1 --fuzz=0 < /tmp/tabbyapi-exl3-post-sampling-probs.patch; } && \
    rm /tmp/tabbyapi-exl3-post-sampling-probs.patch

# Computes the return_top_tokens and return_probs logprobs from the processed
# distribution when post_sampling_probs is set, in the installed exllamav3
# library, until it carries the change.
# Idempotent. It is a no-op once the installed library already has the feature.
COPY exllamav3-post-sampling-probs.patch /tmp/
RUN SITE="$(python3 -c 'import os, importlib.util; print(os.path.dirname(os.path.dirname(importlib.util.find_spec("exllamav3").origin)))')" && \
    { grep -q vocab_probs "$SITE/exllamav3/generator/sampler/custom.py" || \
      patch -p1 -d "$SITE" --fuzz=0 < /tmp/exllamav3-post-sampling-probs.patch; } && \
    rm /tmp/exllamav3-post-sampling-probs.patch

COPY runpod-entrypoint.sh /usr/local/bin/runpod-entrypoint.sh
RUN chmod +x /usr/local/bin/runpod-entrypoint.sh

EXPOSE 22

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${TABBY_PORT}/health || exit 1

ENTRYPOINT ["/usr/local/bin/runpod-entrypoint.sh"]
