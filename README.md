# Tool Call Viewer

Web UI for browsing OpenClaw session tool call history.

## Features

- **Dynamic parsing** of JSONL session files from `~/.openclaw/agents/main/sessions/`
- **Filter by:** date range, tool type (multi-select), session, text search
- **Sort by:** date, tool name, session, model
- **Copy rows** as JSON (double-click or 📋 button)
- **Network accessible** on `0.0.0.0:3847`

## Usage

```bash
npm start
# or
node server.js
```

Then open http://localhost:3847 (or your machine's IP on port 3847).

## Screenshot

Dark theme table interface with:
- Stats cards (total calls, tool types, sessions)
- Multi-select tool dropdown with checkboxes
- Date range pickers
- Paginated results (50-500 per page)

## API

- `GET /` - Web UI
- `GET /api/tools` - All tool calls as JSON
- `GET /api/stats` - Aggregated stats by tool type
