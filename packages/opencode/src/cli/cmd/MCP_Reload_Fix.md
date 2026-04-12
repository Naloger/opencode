# MCP Configuration Reload Fix

## Problem

The MCP (Model Context Protocol) service in OpenCode loads configuration once at startup and caches it. When users manually edit the `opencode.json` config file to add, change, or remove MCP servers, the running instance doesn't reload the configuration, causing changes to not take effect until restart.

## How It Works

1. **Config Loading**: When OpenCode starts, it reads MCP configuration from:
   - Global config: `~/.config/opencode/opencode.json`
   - Project config: `.opencode/opencode.jsonc` (in project directory)
   - Account/org config: From your OpenCode account

2. **Reload Mechanism**: `Config.invalidate()` clears the cached configuration and forces a fresh load from disk
   - Disposes all running instances
   - Reloads configuration from files
   - MCPs are re-initialized with the new config

3. **Config Persistence**: Changes are only picked up after manual file edits are saved AND reload is triggered

## Solution

### 1. Automatic Reload on Add (CLI)

Modified `McpAddCommand` in `src/cli/cmd/mcp.ts` to call `Config.invalidate()` after successfully adding an MCP server to the config file. This disposes all running instances and forces a reload of the configuration.

**Changes:**
- Added `await Config.invalidate()` after `addMcpToConfig()` calls
- Applied to both local and remote MCP server additions

### 2. Manual Reload Command

Added `McpReloadCommand` to provide a manual way to reload MCP configuration without restarting the application.

**New Command:**
```bash
opencode mcp reload
```

**Implementation:**
- Calls `Config.invalidate()` to dispose instances and reload config
- Provides user feedback via prompts

## Usage

### Adding MCP Servers (Automatic Reload)
```bash
opencode mcp add
```
The CLI now automatically reloads the configuration after adding servers.

### Manual Config Edits
1. Edit `opencode.json` (typically at `~/.config/opencode/opencode.json` on Windows/Mac/Linux)
2. Edit the `mcp` section to add/remove/modify MCP servers
3. Save the file
4. Run reload command:
```bash
opencode mcp reload
```

### Listing MCP Servers
```bash
opencode mcp list
```
Shows all configured MCP servers and their current connection status. Includes debug info showing the loaded MCP configuration.

### Finding Where MCPs Are Configured
```bash
opencode mcp sources
```
Shows:
- All MCP servers defined across all config files
- Their type (Local or Remote)
- Their command/URL
- Which config file to check

**Config file locations (in order of precedence):**
1. **Global**: `~/.config/opencode/opencode.json` - applies to all projects
2. **Project**: `.opencode/opencode.jsonc` - only applies in this project
3. **Account/Org**: From your OpenCode account settings

If the same MCP name appears in multiple files, **the last one loaded wins** (account > project > global).

**To avoid duplicates:**
- Give each MCP a **unique name** (like `LocalToolbox` vs `MasterRegistry`)
- Even if they point to the same command, different names = separate MCP instances
- Check all three locations to ensure no accidental duplicates

### Example: Removing a Duplicate MCP Server

If you have duplicate MCPs pointing to the same path, edit your config file to remove the unwanted entry.

**Before (in `~/.config/opencode/opencode.json`):**
```json
{
  "mcp": {
    "LocalToolbox": {
      "type": "local",
      "command": ["python.exe", "-X", "utf8", "main.py"],
      "enabled": true
    },
    "MasterRegistry": {
      "type": "local",
      "command": ["python.exe", "-X", "utf8", "main.py"],
      "enabled": true
    }
  }
}
```

**After (remove MasterRegistry):**
```json
{
  "mcp": {
    "LocalToolbox": {
      "type": "local",
      "command": ["python.exe", "-X", "utf8", "main.py"],
      "enabled": true
    }
  }
}
```

Then run:
```bash
opencode mcp reload
opencode mcp list
```

The duplicate entry will be gone after reload.

## Files Modified

- `src/cli/cmd/mcp.ts`:
  - Added `Config.invalidate()` calls in `McpAddCommand`
  - Added new `McpReloadCommand` export
  - Updated `McpCommand` builder to include reload command

## Safety

The changes are safe and follow existing patterns:
- `Config.invalidate()` is the standard way to reload configuration
- No breaking changes to existing functionality
- Only affects MCP-related configuration loading

## Testing

- Build passes without errors
- Type checking passes
- CLI commands work as expected
- Manual reload command functions correctly

## Future Improvements

Consider implementing file watching for automatic config reload on file changes, but this would require more complex infrastructure and is not necessary for the current fix.
