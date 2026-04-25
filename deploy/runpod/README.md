# RunPod Image Helper

This directory is optional infrastructure for the disposable-host workflow.
User-facing setup and connection instructions live in the repo-root
[README.md](/Users/EthanJ/Documents/github/branching_workbook/README.md).

This subdirectory exists only for the custom RunPod image helper:

- [Dockerfile](/Users/EthanJ/Documents/github/branching_workbook/deploy/runpod/Dockerfile)
- [runpod-entrypoint.sh](/Users/EthanJ/Documents/github/branching_workbook/deploy/runpod/runpod-entrypoint.sh)

## What The Image Does

The image extends the stock TabbyAPI container and bakes in the RunPod-specific
startup behavior we need:

- starts `sshd`
- writes a minimal `config.yml` into `/workspace/tabby-config/config.yml`
- binds TabbyAPI to `127.0.0.1:5000`
- disables TabbyAPI auth for the recommended SSH-tunnel workflow
- stores models under `/workspace/models`
- enables `HF_HUB_ENABLE_HF_TRANSFER=1`

That keeps the Pod template simple. Once this image is built and pushed, the
template does not need a custom startup command.

## Build And Push

Build from the repo root:

```bash
docker build \
  -t <registry>/branching-workbook-tabby-runpod:latest \
  -f deploy/runpod/Dockerfile \
  deploy/runpod
```

Push:

```bash
docker push <registry>/branching-workbook-tabby-runpod:latest
```

## Template Shape

Use a custom RunPod `Pod` template with:

- Type: `Pod`
- Compute: `Nvidia GPU`
- Container image: `<registry>/branching-workbook-tabby-runpod:latest`
- Exposed TCP port: `22`
- Volume mount path: `/workspace`
- Environment variable: `PUBLIC_KEY=<your ssh public key>`

The image entrypoint already starts SSH and TabbyAPI. Leave the template start
command blank.
