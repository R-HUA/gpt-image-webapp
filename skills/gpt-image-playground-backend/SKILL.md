---
name: gpt-image-playground-backend
description: Use this project as an image generation backend through an administrator-created backend API Key. Trigger when Codex should generate or edit images by calling a deployed GPT Image Playground backend, submit queued jobs to /api/jobs, poll results, save returned images locally, or integrate with the backend gallery rather than using built-in image generation.
---

# GPT Image Playground Backend Skill

Use this skill to interact with a deployed GPT Image Playground backend using a Bearer token created by the administrator in the web UI.

## Required environment

Require these environment variables:

```bash
GIP_BACKEND_URL=http://127.0.0.1:4173
GIP_BACKEND_API_KEY=<backend api key from admin panel>
```

Never ask the user to paste the key in chat. Ask them to set `GIP_BACKEND_API_KEY` in their shell or automation environment.

## Workflow

1. Confirm `GIP_BACKEND_URL` and `GIP_BACKEND_API_KEY` are set.
2. Decide whether the task is text-to-image or image edit.
3. Use `scripts/gip_backend_client.mjs` instead of writing one-off HTTP code.
4. Save outputs under a project-local output directory unless the user specifies another path.
5. Report saved image paths and backend gallery result IDs.

## Script usage

Text-to-image:

```bash
node skills/gpt-image-playground-backend/scripts/gip_backend_client.mjs generate \
  --prompt "a clean product photo of a white ceramic mug" \
  --out-dir output/gip-backend
```

Image edit with one or more input images:

```bash
node skills/gpt-image-playground-backend/scripts/gip_backend_client.mjs generate \
  --prompt "turn this into a rainy night scene" \
  --image path/to/input.png \
  --out-dir output/gip-backend
```

Batch text-to-image:

```bash
node skills/gpt-image-playground-backend/scripts/gip_backend_client.mjs generate \
  --prompt "minimal app icon, blue glass style" \
  --batch-count 6 \
  --out-dir output/gip-backend
```

Useful options:

- `--size auto`
- `--quality auto|low|medium|high`
- `--format png|jpeg|webp`
- `--n 1`
- `--batch-count <number>`
- `--image <path>` repeatable
- `--timeout-ms 600000`
- `--out-dir <directory>`

## Prompting

For image tasks, structure prompts using the same concise pattern as the system image generation skill:

```text
Use case: <photorealistic-natural|product-mockup|ui-mockup|illustration-story|...>
Asset type: <where it will be used>
Primary request: <main request>
Input images: <Image 1 role; Image 2 role>
Style/medium: <photo/illustration/3D/etc>
Composition/framing: <layout>
Lighting/mood: <lighting>
Constraints: <must keep/must avoid>
```

For edits, explicitly state what must remain unchanged.

## Notes

- The backend handles queueing, concurrency, server-side output persistence, thumbnails, gallery metadata, and audit logs.
- Browser-local history is not updated by this skill. Outputs are saved locally by the script and also persisted in the backend gallery.
- If the backend returns `401`, the API Key is missing, disabled, or wrong.
- If the backend returns `后端尚未配置 API Key`, the administrator still needs to configure the upstream image provider in the web UI.
