# RunPod recipe

Optional Dockerfile and pod template for running TabbyAPI on RunPod. This is one example disposable-host setup — any Linux GPU machine works. For the app-side connection mechanics (SSH tunnel, env vars, model loading) see the parent [deploy README](../README.md).

This directory contains:

- [`Dockerfile`](./Dockerfile) — extends the stock TabbyAPI image with RunPod-specific startup behavior.
- [`runpod-entrypoint.sh`](./runpod-entrypoint.sh) — entrypoint that starts `sshd` and TabbyAPI with sane defaults.

## What the image does

- Starts `sshd` so RunPod's SSH-over-TCP exposure works.
- Writes a minimal `config.yml` at `/workspace/tabby-config/config.yml`.
- Binds TabbyAPI to `127.0.0.1:5000`.
- Disables TabbyAPI auth (SSH is the security boundary).
- Stores downloaded models under `/workspace/models`.
- Enables `HF_HUB_ENABLE_HF_TRANSFER=1` for faster Hugging Face downloads.

Once built and pushed to your container registry, the RunPod template doesn't need a custom start command.

## Build and push your own image

```bash
docker build \
  -t <your-registry>/branching-workbook-tabby-runpod:latest \
  -f deploy/runpod/Dockerfile \
  deploy/runpod

docker push <your-registry>/branching-workbook-tabby-runpod:latest
```

## RunPod template

Create a `Pod` template with:

- **Type**: `Pod`
- **Compute**: NVIDIA GPU of your choice
- **Container image**: `<your-registry>/branching-workbook-tabby-runpod:latest`
- **Exposed TCP port**: `22`
- **Volume mount path**: `/workspace` (use a non-zero volume disk to persist downloaded models across pod restarts)
- **Environment variable**: `PUBLIC_KEY=<your SSH public key>`

Leave the template start command blank — the image's entrypoint handles it.

## SSH into the pod

Use the **SSH over exposed TCP** command from the RunPod *Connect* tab. Example shape:

```bash
ssh root@<pod-ip> -p <ssh-port> -i ~/.ssh/<your-private-key>
```

Confirm TabbyAPI is up inside the pod:

```bash
curl http://127.0.0.1:5000/health
curl http://127.0.0.1:5000/v1/model
```

## Connect Branching Workbook

From here, follow the SSH-tunnel and env-var setup in the parent [`deploy/README.md`](../README.md#2-open-an-ssh-tunnel).
