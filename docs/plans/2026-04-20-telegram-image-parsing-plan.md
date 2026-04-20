# Telegram Image Parsing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable agents to see photos, screenshots, and video preview frames sent via Telegram by downloading media to the IPC directory and letting the agent use its Read tool.

**Architecture:** Download media files on the host in `telegram.ts`, save to `DATA_DIR/ipc/<group>/images/`, include the container-side path (`/workspace/ipc/images/<msgId>.<ext>`) in the message content. The agent's existing Read tool handles image viewing. Cleanup happens when container session closes. No agent-runner changes.

**Tech Stack:** grammY, @grammyjs/files plugin, Node.js fs

---

### Task 1: Install @grammyjs/files dependency

**Files:**
- Modify: `package.json`

**Step 1: Install the package**

Run: `npm install @grammyjs/files`

**Step 2: Verify installation**

Run: `grep "@grammyjs/files" package.json`
Expected: `"@grammyjs/files": "^X.X.X"`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @grammyjs/files dependency for Telegram media downloads"
```

---

### Task 2: Create IPC images directory in container-runner

**Files:**
- Modify: `src/container-runner.ts:200-203`

**Step 1: Add images dir creation alongside existing IPC subdirs**

In `src/container-runner.ts`, find the IPC directory setup block (~line 200-203):

```typescript
const groupIpcDir = path.join(DATA_DIR, 'ipc', group.folder);
fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
```

Add after the `input` line:

```typescript
fs.mkdirSync(path.join(groupIpcDir, 'images'), { recursive: true });
```

**Step 2: Build to verify no errors**

Run: `npm run build`
Expected: Clean compilation

**Step 3: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: create images subdirectory in IPC dir for media storage"
```

---

### Task 3: Add image cleanup on container session close

**Files:**
- Modify: `src/container-runner.ts`

The container process emits results and eventually the `close` event fires. We need to clean up images after the container exits.

**Step 1: Find the container `close` handler**

In `src/container-runner.ts`, find `container.on('close', (code) => {` (~line 431).

**Step 2: Add cleanup at the start of the close handler**

Add immediately after `clearTimeout(timeout);` on line 432, before `const duration = ...`:

```typescript
// Clean up downloaded images
const imagesDir = path.join(DATA_DIR, 'ipc', group.folder, 'images');
try {
  const imageFiles = fs.readdirSync(imagesDir);
  for (const file of imageFiles) {
    try { fs.unlinkSync(path.join(imagesDir, file)); } catch { /* ignore */ }
  }
  if (imageFiles.length > 0) {
    logger.debug({ group: group.name, count: imageFiles.length }, 'Cleaned up IPC images');
  }
} catch { /* images dir may not exist */ }
```

**Step 3: Build to verify**

Run: `npm run build`
Expected: Clean compilation

**Step 4: Commit**

```bash
git add src/container-runner.ts
git commit -m "feat: clean up IPC images when container session closes"
```

---

### Task 4: Add imports and configure @grammyjs/files in telegram.ts

**Files:**
- Modify: `src/channels/telegram.ts:1-9`

**Step 1: Add new imports**

At the top of `src/channels/telegram.ts`, after the existing `grammy` import, add:

```typescript
import { hydrateFiles } from "@grammyjs/files";
```

Also add these to the existing imports or as new imports:

```typescript
import fs from "fs";
import path from "path";
import { DATA_DIR } from "../config.js";
```

**Step 2: Update Bot type and enable files plugin**

In the `connect()` method (~line 30), change:

```typescript
this.bot = new Bot(this.botToken);
```

to:

```typescript
this.bot = new Bot(this.botToken);
this.bot.api.config.use(hydrateFiles(this.botToken));
```

Note: We don't need `FileFlavor<Context>` generic — the plugin works without it for our use case (we just call `ctx.getFile()` which is already on the base Context type, and then call `.download()` on the hydrated file object).

**Step 3: Build to verify**

Run: `npm run build`
Expected: Clean compilation

**Step 4: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat: configure @grammyjs/files plugin for Telegram media downloads"
```

---

### Task 5: Implement photo download handler

**Files:**
- Modify: `src/channels/telegram.ts:137`

**Step 1: Replace the photo handler**

Find the current photo handler (~line 137):

```typescript
this.bot.on("message:photo", (ctx) => storeNonText(ctx, "[Photo]"));
```

Replace with:

```typescript
this.bot.on("message:photo", async (ctx) => {
  const chatJid = `tg:${ctx.chat.id}`;
  const group = this.opts.registeredGroups()[chatJid];
  if (!group) return;

  const timestamp = new Date(ctx.message.date * 1000).toISOString();
  const senderName =
    ctx.from?.first_name ||
    ctx.from?.username ||
    ctx.from?.id.toString() ||
    "Unknown";
  const sender = ctx.from?.id.toString() || "";
  const msgId = ctx.message.message_id.toString();
  const caption = ctx.message.caption || "";
  const chatName =
    ctx.chat.type === "private"
      ? senderName
      : (ctx.chat as any).title || chatJid;

  this.opts.onChatMetadata(chatJid, timestamp, chatName);

  try {
    // Check file size (Telegram bot API limit is 20MB)
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1]; // Highest resolution
    if (photo.file_size && photo.file_size > 20_000_000) {
      logger.warn({ chatJid, size: photo.file_size }, "Photo too large to download");
      storeNonText(ctx, "[Photo - too large]");
      return;
    }

    // Download to IPC images directory
    const imagesDir = path.join(DATA_DIR, 'ipc', group.folder, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const file = await ctx.getFile();
    const ext = file.file_path?.split('.').pop() || 'jpg';
    const destPath = path.join(imagesDir, `${msgId}.${ext}`);
    await file.download(destPath);

    logger.info({ chatJid, path: destPath }, "Photo downloaded");

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: `[Photo: /workspace/ipc/images/${msgId}.${ext}]${caption ? " " + caption : ""}`,
      timestamp,
      is_from_me: false,
    });
  } catch (err) {
    logger.error({ err, chatJid }, "Failed to download Telegram photo");
    storeNonText(ctx, "[Photo - download failed]");
  }
});
```

**Step 2: Build to verify**

Run: `npm run build`
Expected: Clean compilation

**Step 3: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat: download Telegram photos to IPC images directory"
```

---

### Task 6: Implement video thumbnail handler

**Files:**
- Modify: `src/channels/telegram.ts:138` (the line after the new photo handler)

**Step 1: Replace the video handler**

Find the current video handler:

```typescript
this.bot.on("message:video", (ctx) => storeNonText(ctx, "[Video]"));
```

Replace with:

```typescript
this.bot.on("message:video", async (ctx) => {
  const chatJid = `tg:${ctx.chat.id}`;
  const group = this.opts.registeredGroups()[chatJid];
  if (!group) return;

  const timestamp = new Date(ctx.message.date * 1000).toISOString();
  const senderName =
    ctx.from?.first_name ||
    ctx.from?.username ||
    ctx.from?.id.toString() ||
    "Unknown";
  const sender = ctx.from?.id.toString() || "";
  const msgId = ctx.message.message_id.toString();
  const caption = ctx.message.caption || "";
  const chatName =
    ctx.chat.type === "private"
      ? senderName
      : (ctx.chat as any).title || chatJid;

  this.opts.onChatMetadata(chatJid, timestamp, chatName);

  const thumbnail = ctx.message.video?.thumbnail;
  if (!thumbnail) {
    storeNonText(ctx, "[Video]");
    return;
  }

  try {
    // Download thumbnail to IPC images directory
    const imagesDir = path.join(DATA_DIR, 'ipc', group.folder, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const file = await this.bot!.api.getFile(thumbnail.file_id);
    const ext = file.file_path?.split('.').pop() || 'jpg';
    const destPath = path.join(imagesDir, `${msgId}.${ext}`);
    await (file as any).download(destPath);

    logger.info({ chatJid, path: destPath }, "Video thumbnail downloaded");

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender,
      sender_name: senderName,
      content: `[Video (preview frame only, not the full video): /workspace/ipc/images/${msgId}.${ext}]${caption ? " " + caption : ""}`,
      timestamp,
      is_from_me: false,
    });
  } catch (err) {
    logger.error({ err, chatJid }, "Failed to download video thumbnail");
    storeNonText(ctx, "[Video]");
  }
});
```

Note: For video thumbnails, we use `this.bot.api.getFile(thumbnail.file_id)` since the thumbnail is a separate file from the video itself. The `hydrateFiles` plugin should hydrate this file object too, giving us `.download()`. If `download()` is not available on the raw API file object, we may need to use `hydrateFiles` differently — verify during implementation by checking the type. Fallback: use `getFile()` to get the URL and download manually with fetch.

**Step 2: Build to verify**

Run: `npm run build`
Expected: Clean compilation. If TypeScript complains about `.download()` on the raw file object, switch to using the file URL approach:

```typescript
const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
const response = await fetch(fileUrl);
const buffer = Buffer.from(await response.arrayBuffer());
fs.writeFileSync(destPath, buffer);
```

**Step 3: Commit**

```bash
git add src/channels/telegram.ts
git commit -m "feat: download video preview frames from Telegram"
```

---

### Task 7: Build, test, and verify

**Files:**
- None (verification only)

**Step 1: Full build**

Run: `npm run build`
Expected: Clean compilation, no errors

**Step 2: Run existing tests**

Run: `npx vitest run`
Expected: All previously-passing tests still pass (6 known failures in `formatting.test.ts` are pre-existing)

**Step 3: Manual verification checklist**

After deploying (rebuild container, restart service):
- [ ] Send a photo → agent describes the image
- [ ] Send a photo with caption → agent sees both image and caption text
- [ ] Send a screenshot → agent reads text in screenshot
- [ ] Send a video → agent sees preview frame and notes it's only a preview
- [ ] Send a video with caption → agent sees preview + caption
- [ ] Check `data/ipc/<group>/images/` → files exist during session
- [ ] After session closes → images directory is cleaned up

**Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address issues found during image parsing testing"
```
