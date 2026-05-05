# Branching Workbook

Local creative-writing app with tree-structured branching generation, backed by
TabbyAPI over an SSH tunnel.

The product boundary is:

- Branching Workbook runs locally on your laptop
- TabbyAPI runs on a GPU host
- the laptop reaches Tabby through an SSH tunnel
- project data stays local in `.bwbk` files

## Local Fake Backend

Use this when you want to work on the UI without a GPU pod or SSH tunnel. The
server defaults to the mock backend, but setting it explicitly makes the intent
clear:

```bash
PATH=/opt/homebrew/bin:$PATH \
BWBK_BACKEND=mock \
just dev
```

Open:

```text
http://localhost:5173
```

The mock backend exposes a loaded fake model, streams branch completions, and
supports the model-panel routes. It is for local development only; use the
RunPod/Tabby workflow below for real model behavior.

## Current RunPod Workflow

This is the current disposable-host path we validated.

### 1. Launch the Pod

Use a RunPod `Pod` template with:

- Container image: `ethan8012/branching-workbook-tabby-runpod:latest`
- Exposed TCP port: `22`
- Volume mount path: `/workspace`
- Environment variable: `PUBLIC_KEY=<contents of ~/.ssh/id_ed25519.pub>`

Notes:

- Leave the template start command blank.
- If you want downloaded models to persist across pod restarts, give the pod a
  non-zero volume disk.

### 2. SSH Into The Pod

Prefer the `SSH over exposed TCP` command from the RunPod Connect tab.

Example shape:

```bash
ssh root@<pod-ip> -p <ssh-port> -i ~/.ssh/id_ed25519
```

### 3. Verify Tabby In The Pod

Inside the pod:

```bash
curl http://127.0.0.1:5000/health
curl http://127.0.0.1:5000/v1/model
```

### 4. Open The SSH Tunnel From The Laptop

**Use local port `5001`.** On modern macOS, port `5000` is occupied by AirPlay
Receiver (`Server: AirTunes/...`), which silently shadows the tunnel — GETs
return 403 and streaming POSTs hang. We default to `5001` to sidestep this.

```bash
ssh -N -L 5001:127.0.0.1:5000 root@<pod-ip> -p <ssh-port> -i ~/.ssh/id_ed25519
```

Keep that tunnel terminal open while using the app.

> If you've explicitly disabled AirPlay Receiver (System Settings → General →
> AirDrop & Handoff → AirPlay Receiver = Off) and confirmed port `5000` is
> free, you can substitute `-L 5000:127.0.0.1:5000` and use `5000` everywhere
> below instead. The rest of this README assumes the recommended `5001` path.

### 5. Verify The Tunnel Locally

```bash
curl http://127.0.0.1:5001/health
curl http://127.0.0.1:5001/v1/model
```

If `/v1/model` returns a JSON model object, the tunnel is good. If you see
`Server: AirTunes/...` in the response headers, you're hitting AirPlay — pick
a different local port and retry.

### 6. Start Branching Workbook Locally

```bash
PATH=/opt/homebrew/bin:$PATH \
BWBK_BACKEND=tabby \
BWBK_TABBY_COMPLETIONS_URL=http://127.0.0.1:5001/v1/completions \
just dev
```

`BWBK_TABBY_COMPLETIONS_URL` **must** match whichever local port you picked in
step 4. The proxy defaults to `5000` if unset, so omitting this variable on a
`5001` tunnel will silently fail.

Open:

```text
http://localhost:5173
```

### 7. In The UI

Use the model panel to:

- download `lucyknada/google_gemma-3-270m-exl3`
- set revision `6.0bpw`
- load the model
- generate

For models that need multiple GPUs, enable `Tensor parallel` in the model
panel before loading. Leave `GPU split` blank to let TabbyAPI choose its split,
or enter comma-separated GB values such as `20, 25` for a manual split.

## Gotchas

### Branches stream one-at-a-time

Branching Workbook sends one TabbyAPI completion request with `n > 1` and
routes streamed chunks by `choices[*].index`. If the branch cards appear to
fill one after another, the usual cause is not the client or SSH tunnel — it is
the loaded Tabby/ExLlamaV3 cache budget.

ExLlamaV3 can keep multiple branch jobs active only when the cache can fit the
shared prompt plus each active branch's reserved output chunk. Approximate rule:

```text
required active cache ~= prompt_tokens + branch_count * chunk_size
```

TabbyAPI's EXL3 backend defaults `chunk_size` to `2048` unless overridden at
model load time. On a small `4096` context/cache load, that can force branches
to run sequentially. Loading the same model with a larger context/cache made
the stream interleave normally in testing.

Practical guidance:

- For short prompts, sequential-looking output is less important because the
  jobs complete quickly.
- For longer prompts or larger `n`, load the model with enough context/cache
  headroom for `prompt_tokens + branch_count * chunk_size`.
- If you need interleaving on a very small context/cache load, lower TabbyAPI's
  `chunk_size` when loading the model; this favors branch concurrency but can
  reduce long-prompt or long-single-completion throughput.
- Increasing loaded context/cache mainly costs VRAM. A 1k prompt does not
  become a 128k prefill just because the model was loaded with a 128k context.

## Repo Notes

- Main spec: [branching-workbook.md](/Users/EthanJ/Documents/github/branching_workbook/branching-workbook.md)
- Implementation order: [implementation-plan.md](/Users/EthanJ/Documents/github/branching_workbook/implementation-plan.md)
- RunPod image helper: [deploy/runpod/README.md](/Users/EthanJ/Documents/github/branching_workbook/deploy/runpod/README.md)

`deploy/runpod/` is only for the optional image/template helper. The normal
user-facing connection instructions now live here at the repo root.

## Example common run 
Port 5000 is occupied by airdrop

Modify with real ssh login
`ssh -N -L 5001:127.0.0.1:5000 root@157.254.50.85 -p 12012 -i ~/.ssh/id_ed25519`

`PATH=/opt/homebrew/bin:$PATH \
  BWBK_BACKEND=tabby \
  BWBK_TABBY_COMPLETIONS_URL=http://127.0.0.1:5001/v1/completions \
  just dev`