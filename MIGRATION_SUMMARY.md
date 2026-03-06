# che-ical-mcp Migration Summary

**Date:** 2026-03-06
**Status:** ✅ COMPLETE - Ready for commit and restart

## What Changed

### 1. Vendored Binary ✓
- Downloaded CheICalMCP v1.1.0 to `vendor/CheICalMCP` (6.7MB)
- Created `vendor/VERSIONS.md` to track version
- Binary is executable and tested

### 2. MCP Registry Updated ✓
- File: `mcp-servers/registry.json`
- Changed: `"command": "vendor/CheICalMCP"` (was: `"command": "node"`)
- Changed: `"args": []` (was: `["node_modules/mcp-server-apple-events/dist/index.js"]`)
- Port: 7891 (unchanged)

### 3. Removed Old Package ✓
- Uninstalled `mcp-server-apple-events` via npm
- Removed 404 dependency packages
- No longer requires manual Swift compilation

### 4. Updated Documentation ✓
- File: `groups/main/CLAUDE.md`
- Replaced old tool names with che-ical-mcp tool list
- Added usage notes about ISO8601 datetime format
- Documented batch operations and calendar_source parameter

### 5. Test Results Documented ✓
- File: `groups/main/plans/2026-03-06-test-results.md`
- Confirmed che-ical-mcp does NOT have silent failure bug
- Both test events created successfully
- Search quirk documented (needs full datetime, not just dates)

### 6. Usage Guide Created ✓
- File: `groups/main/apple-calendar-mcp-usage-notes.md`
- Best practices for searching events
- Parameter requirements
- Error handling examples

## Files Modified

```
vendor/CheICalMCP (new, 6.7MB)
vendor/VERSIONS.md (new)
mcp-servers/registry.json (modified)
package.json (modified - removed mcp-server-apple-events)
package-lock.json (modified - dependencies updated)
groups/main/CLAUDE.md (modified - tool names updated)
groups/main/plans/2026-03-06-test-results.md (new)
groups/main/apple-calendar-mcp-usage-notes.md (new)
scripts/test-che-ical-mcp.sh (new)
scripts/discover-che-ical-tools.sh (new)
scripts/README.md (new)
```

## Next Steps (Manual - Run on Host)

### 1. Commit Changes with jj

```bash
cd ~/Projects/nanoclaw

# Add all changes
jj describe -m "feat: migrate to che-ical-mcp v1.1.0

- Replace mcp-server-apple-events with vendored CheICalMCP binary
- Remove 404 npm dependencies, no more Swift compilation required
- Update tool names in CLAUDE.md for new MCP server
- Add test scripts and usage documentation
- Confirmed no silent failures in che-ical-mcp (events are created successfully)

Closes: Issue with calendar silent failures"

jj new
```

### 2. Restart nanoclaw Service

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
sleep 5
tail -20 logs/nanoclaw.log
```

Expected log output:
```
MCP bridge started (apple-events)
Listening on port 7891
```

### 3. Verify MCP Server Running

```bash
lsof -i :7891 | head -3
```

Expected: node process listening on port 7891

### 4. Test in Telegram

Send to Taskie:
```
What are my reminders?
```

Expected: Taskie successfully lists your reminders using the new che-ical-mcp server.

### 5. Clean Up Test Events

Delete the two test events from Calendar.app:
- "TEST: Wrong Day-of-Week" (March 8)
- "TEST: Valid Event" (March 10)

## Rollback Plan (if needed)

If something goes wrong:

1. Restore registry.json:
```json
{
  "servers": {
    "apple-events": {
      "transport": "stdio",
      "command": "node",
      "args": ["node_modules/mcp-server-apple-events/dist/index.js"],
      "port": 7891,
      "enabled": true
    }
  }
}
```

2. Reinstall old package:
```bash
npm install mcp-server-apple-events
```

3. Restart service

## Benefits Achieved

✅ **No silent failures** - Events are actually created (tested and confirmed)
✅ **Better error handling** - Proper error messages with isError flag
✅ **Simpler architecture** - Precompiled binary, no build step
✅ **Pinned version** - v1.1.0 vendored, controlled updates
✅ **More features** - 24 tools vs 4 (batch operations, conflict checking, search, etc.)
✅ **Removed 404 dependencies** - Smaller node_modules, faster installs

## Known Issues

⚠️ **Search quirk**: `list_events` needs full ISO8601 datetime with timezone for reliable results. Date-only parameters may only return all-day events. This is documented and won't affect Taskie since proper datetime format will be used.

## Tool Name Mapping (Old → New)

| Old Tool | New Tool |
|----------|----------|
| `reminders_lists` | `list_calendars` (with `type: "reminder"`) |
| `reminders_tasks` (read) | `list_reminders` |
| `reminders_tasks` (create) | `create_reminder` |
| `reminders_tasks` (update) | `update_reminder` |
| `reminders_tasks` (delete) | `delete_reminder` |
| `calendar_calendars` | `list_calendars` |
| `calendar_events` (read) | `list_events` or `list_events_quick` |
| `calendar_events` (create) | `create_event` |
| `calendar_events` (update) | `update_event` |
| `calendar_events` (delete) | `delete_event` |

**New tools not in old server:**
- `search_reminders`, `search_events`
- `create_reminders_batch`, `create_events_batch`
- `delete_reminders_batch`, `delete_events_batch`
- `check_conflicts`, `find_duplicate_events`
- `copy_event`, `move_events_batch`
- `complete_reminder` (separate from update)
