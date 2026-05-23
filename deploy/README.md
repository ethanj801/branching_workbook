# Connecting Branching Workbook to a real model

Branching Workbook talks to a stock [TabbyAPI](https://github.com/theroyallab/tabbyAPI) over HTTP. Once you have TabbyAPI running somewhere, set `BWBK_BACKEND=tabby` and point Branching Workbook at the right URL:

```bash
BWBK_BACKEND=tabby \
BWBK_TABBY_COMPLETIONS_URL=http://<host>:<port>/v1/completions \
just dev
```

If TabbyAPI is on the same machine and bound to its default `127.0.0.1:5000`, you can skip the URL — that's already the default:

```bash
BWBK_BACKEND=tabby just dev
```

Open <http://localhost:5173>, then download or load a model through the in-app model panel. A small one useful for testing: `lucyknada/google_gemma-3-270m-exl3` at revision `6.0bpw`.

If you've kept TabbyAPI's auth enabled, also set `BWBK_TABBY_API_KEY`. See [Environment variables](#environment-variables) below for the full list.

---

## Cloud GPU host via SSH tunnel

If TabbyAPI is on a disposable cloud GPU or a remote workstation, the recommended setup is an SSH tunnel. TabbyAPI stays bound to localhost on the GPU host (no public network exposure), and SSH is the security boundary. RunPod is one disposable-host example — see [`runpod/`](./runpod) for a Dockerfile and pod-template recipe.

### 1. Open the tunnel

```bash
ssh -N -L 5000:127.0.0.1:5000 <user>@<gpu-host> -p <ssh-port>
```

Keep the tunnel terminal open while using the app.

#### macOS port note

On modern macOS, local port `5000` is occupied by **AirPlay Receiver**. It silently shadows the tunnel — `GET /v1/model` returns 403 and streaming POSTs hang. Two options:

- **Disable AirPlay Receiver**: System Settings → General → AirDrop & Handoff → AirPlay Receiver = Off. Then `5000:127.0.0.1:5000` works.
- **Use a different local port**, e.g. `5001`:
  ```bash
  ssh -N -L 5001:127.0.0.1:5000 <user>@<gpu-host> -p <ssh-port>
  ```
  Then set `BWBK_TABBY_COMPLETIONS_URL=http://127.0.0.1:5001/v1/completions` when launching the app (step 3).

### 2. Verify the tunnel

From another terminal:

```bash
curl http://127.0.0.1:5000/health        # or 5001 if you remapped
curl http://127.0.0.1:5000/v1/model
```

If `/v1/model` returns a JSON model object, you're connected. If you see `Server: AirTunes/...` in the response headers, you're hitting AirPlay — pick a different local port.

### 3. Run Branching Workbook

```bash
BWBK_BACKEND=tabby just dev
```

If you remapped to a non-default local port:

```bash
BWBK_BACKEND=tabby \
BWBK_TABBY_COMPLETIONS_URL=http://127.0.0.1:5001/v1/completions \
just dev
```

Open <http://localhost:5173> and load a model through the in-app model panel.

---

## Environment variables

| Variable                                  | Default                                       | What it does                                                                                  |
| ----------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `BWBK_BACKEND`                            | `mock`                                        | Set to `tabby` to talk to a real TabbyAPI host. Anything else uses the mock.                  |
| `BWBK_TABBY_COMPLETIONS_URL`              | `http://127.0.0.1:5000/v1/completions`        | Where to send completion requests. Must match TabbyAPI's address (or your tunnel's local port). |
| `BWBK_TABBY_BASE_URL`                     | derived from `_COMPLETIONS_URL`               | Base URL for model-control endpoints. Usually inferred; override if needed.                   |
| `BWBK_TABBY_API_KEY`                      | unset                                         | If TabbyAPI auth is enabled, this is sent as `x-api-key`.                                     |
| `BWBK_TABBY_STREAM_READ_TIMEOUT_SECONDS`  | `60`                                          | How long the proxy waits for a streamed chunk before timing out.                              |

## Tips

### Branches stream one-at-a-time

Branching Workbook sends a single TabbyAPI completion request with `n > 1` and routes streamed chunks to per-branch panels by `choices[*].index`. If the branches appear to fill one after another rather than in parallel, the usual cause is not the client or tunnel — it's the loaded ExLlamaV3 cache budget.

ExLlamaV3 can keep multiple branch jobs active only when the cache fits the shared prompt plus each active branch's reserved output chunk. Approximate rule:

```text
required active cache ≈ prompt_tokens + branch_count × chunk_size
```

TabbyAPI's EXL3 backend defaults `chunk_size` to `2048`. On a small `4096` context/cache load, that forces branches to run sequentially. Practical guidance:

- For short prompts, sequential output finishes quickly and barely matters.
- For longer prompts or larger `n`, load the model with enough context/cache headroom for `prompt_tokens + branch_count × chunk_size`.
- If you need interleaving on a small load, lower TabbyAPI's `chunk_size` at load time. It favors branch concurrency at the cost of long-prompt throughput.
- Increasing the loaded context/cache mainly costs VRAM. A 1 k prompt doesn't become a 128 k prefill just because the model was loaded with 128 k context.
