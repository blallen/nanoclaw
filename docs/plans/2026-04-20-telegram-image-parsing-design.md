# Telegram Image Parsing Design

**Date:** 2026-04-20
**Goal:** Enable agents to see photos, screenshots, and video preview frames sent via Telegram

## Background

Currently, photos and videos are stored as text placeholders (`[Photo]`, `[Video]`). The agent knows a media message was sent but can't see it.

Taskie wrote an initial implementation spec (`groups/main/plans/IMPLEMENTATION-SPEC-image-parsing.md`) which proposed modifying the agent-runner to base64-encode images into Claude API content blocks. However, the agent-runner uses the Claude Agent SDK (`query()` with string prompts), not raw API calls, so that approach won't work.

## Approach: Mount-and-Read

The agent inside the container already has a `Read` tool that natively handles images (multimodal LLM). Instead of modifying the agent-runner, we:

1. Download media on the host (telegram.ts)
2. Save to the IPC images directory (already mounted into the container)
3. Include the container-side file path in the message content
4. The agent uses `Read` on the path to view the image

### Why this works

- Zero agent-runner changes
- Uses existing Read tool capability
- IPC directory is already mounted read-write
- Same code path for photos, screenshots, and video thumbnails

## Files Changed

### `src/channels/telegram.ts`

- Add `@grammyjs/files` plugin for file downloads
- Replace `message:photo` handler: download highest-res photo, save to IPC images dir, store path in message content
- Replace `message:video` handler: download video thumbnail (preview frame), store with annotation that it's a preview only
- Size guard: skip download for files >20MB, fall back to placeholder
- Error handling: on download failure, fall back to text placeholder

### `src/container-runner.ts`

- Create `images/` subdirectory in IPC dir setup (alongside `messages/`, `tasks/`, `input/`)
- Clean up images dir when container session closes

### `package.json`

- Add `@grammyjs/files` dependency

## Message Format

- **Photo:** `[Photo: /workspace/ipc/images/123.jpg] optional caption`
- **Video:** `[Video (preview frame only, not the full video): /workspace/ipc/images/123.jpg] optional caption`
- **Photo too large:** `[Photo - too large]`
- **Download failed:** `[Photo - download failed] optional caption`

## Data Flow

```
User sends photo/video in Telegram
  → grammY receives message
  → telegram.ts downloads file (photo) or thumbnail (video)
  → Saves to DATA_DIR/ipc/<group>/images/<msgId>.jpg
  → Stores message with container-side path: /workspace/ipc/images/<msgId>.jpg
  → Agent receives message, uses Read tool on the path
  → Agent sees the image and responds
```

## Cleanup

Images are stored at `DATA_DIR/ipc/<group>/images/`. Cleaned up when the container session ends — container-runner deletes all files in the images dir. Images are ephemeral and don't need to persist across sessions.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Download failure | Fall back to `[Photo]` / `[Video]` placeholder |
| File >20MB | Skip download, store `[Photo - too large]` |
| File missing at read time | Agent sees path doesn't exist, responds accordingly |
| Video with no thumbnail | Fall back to `[Video]` placeholder |

## Scope

**In scope:** Photos, screenshots, video preview frames

**Out of scope (future):** Full video processing, documents/PDFs, image resizing, persistent image storage, multiple images per message
