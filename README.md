# Branching Workbook

Local creative-writing app with tree-structured branching generation, backed by
TabbyAPI over an SSH tunnel.

The product boundary is:

- Branching Workbook runs locally on your laptop
- TabbyAPI runs on a GPU host
- the laptop reaches Tabby through an SSH tunnel
- project data stays local in `.bwbk` files

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

If local port `5000` is free:

```bash
ssh -N -L 5000:127.0.0.1:5000 root@<pod-ip> -p <ssh-port> -i ~/.ssh/id_ed25519
```

If local port `5000` is already occupied, use `5001` instead:

```bash
ssh -N -L 5001:127.0.0.1:5000 root@<pod-ip> -p <ssh-port> -i ~/.ssh/id_ed25519
```

Keep that tunnel terminal open while using the app.

### 5. Verify The Tunnel Locally

If you used local port `5000`:

```bash
curl http://127.0.0.1:5000/health
curl http://127.0.0.1:5000/v1/model
```

If you used local port `5001`:

```bash
curl http://127.0.0.1:5001/health
curl http://127.0.0.1:5001/v1/model
```

### 6. Start Branching Workbook Locally

If you used local port `5000`:

```bash
PATH=/opt/homebrew/bin:$PATH \
BWBK_BACKEND=tabby \
BWBK_TABBY_COMPLETIONS_URL=http://127.0.0.1:5000/v1/completions \
just dev
```

If you used local port `5001`:

```bash
PATH=/opt/homebrew/bin:$PATH \
BWBK_BACKEND=tabby \
BWBK_TABBY_COMPLETIONS_URL=http://127.0.0.1:5001/v1/completions \
just dev
```

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

## Repo Notes

- Main spec: [branching-workbook.md](/Users/EthanJ/Documents/github/branching_workbook/branching-workbook.md)
- Implementation order: [implementation-plan.md](/Users/EthanJ/Documents/github/branching_workbook/implementation-plan.md)
- RunPod image helper: [deploy/runpod/README.md](/Users/EthanJ/Documents/github/branching_workbook/deploy/runpod/README.md)

`deploy/runpod/` is only for the optional image/template helper. The normal
user-facing connection instructions now live here at the repo root.
