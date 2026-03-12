---
name: article-processing
description: Process !archive URLs into the knowledge base. Fetches articles via Jina AI Reader, generates summaries, detects concepts, and maintains cross-referenced markdown files.
---

# Article Processing Skill

## When to Use

Run this skill when:
- A scheduled task triggers daily article processing
- A user asks to process articles manually

## Knowledge Base Location

`/workspace/extra/knowledge-base/`
- `articles/` — Individual article files (YYYY-MM-DD-slug.md)
- `concepts/` — Concept aggregation pages (concept-name.md)

## Workflow

### 1. Find URLs to Process

Use the `mcp__nanoclaw-messages__query_messages` tool to find messages containing `!archive`:

- Set `chat_jid` to the current chat JID (from your context)
- Set `search` to `!archive`
- Set `since` to 24 hours ago (for daily runs) or as instructed
- Extract all URLs from matching messages using regex: `https?://[^\s)>\]]+`

### 2. Deduplicate

For each URL found:
- Search existing files in `/workspace/extra/knowledge-base/articles/` for the URL
- Run: `grep -rl "Source:.*URL_DOMAIN" /workspace/extra/knowledge-base/articles/` (use a unique portion of the URL)
- Skip any URL already present

### 3. Fetch Article Content

For each new URL, fetch via Jina AI Reader:

```bash
curl -s "https://r.jina.ai/ENCODED_URL" \
  -H "Accept: text/markdown" \
  -H "X-No-Cache: true"
```

If Jina AI fails (empty response, error, or timeout), log the failure and continue with the next URL.

### 4. Create Article File

For each successfully fetched article, create a file at:
`/workspace/extra/knowledge-base/articles/YYYY-MM-DD-slug.md`

Slug rules: lowercase, hyphens, max 50 chars, derived from article title.

Template:

```markdown
# [Article Title]

**Source:** [Original URL]
**Date Saved:** YYYY-MM-DD
**Concepts:** #concept-1, #concept-2, #concept-3

## Summary

[Generate a 2-3 paragraph summary of the article's key points]

## Key Quotes

> "Notable quote 1"

> "Notable quote 2"

> "Notable quote 3"

## Images

[Include any significant images from the article using markdown syntax]

## Full Content

[The extracted markdown content from Jina AI Reader]
```

### 5. Detect Concepts

For each article, identify 2-5 main topics/concepts. Use lowercase-with-hyphens format (e.g., `artificial-intelligence`, `climate-change`).

Consider:
- Main subject matter
- Key themes and arguments
- Related fields or domains
- Avoid overly generic concepts (e.g., "article", "writing")

### 6. Update Concept Pages

For each detected concept, create or update the concept page at:
`/workspace/extra/knowledge-base/concepts/concept-name.md`

If the file exists, add the new article reference to the "Related Articles" section.
If new, create with this template:

```markdown
# [Concept Name]

## Related Articles

- [[YYYY-MM-DD-article-slug]] - Brief one-line description

## Key Themes

[Summary of common themes across articles tagged with this concept]

## Notable Quotes

> "Relevant quote" — [[article-slug]]
```

### 7. Send Summary Report

After processing all articles, send a summary using `mcp__nanoclaw__send_message`:

Format:
```
*Daily Article Processing Report - [Date]*

Processed X articles, updated Y concepts.

*New Articles:*
• [Title 1] — #concept-a, #concept-b
• [Title 2] — #concept-c, #concept-d

*Updated Concepts:* concept-a, concept-b, concept-c, concept-d

*Errors:* [List any URLs that failed to fetch, or "None"]
```

## Error Handling

- If Jina AI returns an error for a URL, skip it and report in the summary
- If a URL is malformed, skip it
- If the knowledge base directory doesn't exist, create it
- Always send a summary report, even if no articles were processed
