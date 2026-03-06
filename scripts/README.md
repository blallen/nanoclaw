# Test Scripts

## test-che-ical-mcp.sh

Tests che-ical-mcp's error handling before full migration.

### Purpose

Verifies that che-ical-mcp properly handles (or fails gracefully on) calendar events with mismatched day-of-week, addressing the silent failure bug discovered in mcp-server-apple-events.

### Prerequisites

1. Binary downloaded: `vendor/CheICalMCP` (v1.1.0)
2. If not present, the script will tell you how to download it
3. Run from project root on the **host Mac Mini** (not in container)

### Usage

```bash
cd /path/to/nanoclaw-project
./scripts/test-che-ical-mcp.sh
```

### What It Tests

1. **Basic connectivity** - Ensures che-ical-mcp can list calendars
2. **Invalid day-of-week** - Creates event for "Saturday 2026-03-08" (actually Sunday)
3. **Event verification** - Searches to confirm if event was created or not
4. **Valid event** - Creates proper event on Tuesday 2026-03-10
5. **Valid verification** - Confirms valid event was created correctly

### Expected Outcomes

**Good behaviors:**
- Returns error for mismatched day-of-week
- OR: Creates event successfully on specified date (2026-03-08)
- OR: Corrects to actual Saturday (2026-03-07)

**Bad behavior (same bug as current):**
- Returns success message but event doesn't exist

### TCC Permissions

On first run, macOS will prompt for Calendar access. Click **OK** to grant CheICalMCP permission.

If the dialog doesn't appear:
1. Go to System Settings → Privacy & Security → Calendars
2. Find CheICalMCP
3. Enable it
4. Re-run the script

### Cleanup

The script automatically stops the test server on exit. Test events remain in your calendar - you can delete them manually:
- "TEST: Wrong Day-of-Week" (if created)
- "TEST: Valid Event"

### Next Steps

After running, document findings in:
- `groups/main/plans/2026-03-06-test-results.md`

Based on results:
- **If che-ical-mcp handles errors correctly**: Proceed with full migration
- **If same bug exists**: Add verification layer to Taskie
- **If worse behavior**: Stay with current server
