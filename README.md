# OpenClaw Tool Call Viewer

A lightweight web UI for browsing [OpenClaw](https://github.com/openclaw/openclaw) session tool call history. Zero dependencies — just Node.js.

![Screenshot](screenshot.png)

## ⚠️ Security Warning

**Do not expose this to the public internet.** Session logs contain your full command history, file paths, API responses, and potentially sensitive data. This tool is designed for **local network use only**.

## Features

- **Dynamic parsing** of JSONL session files
- **Filter by:** tool type, model, session (multi-select with search), date range, text search
- **Sort by:** clicking column headers — date, tool name, model, session
- **Cross-filtered counts** — dropdown counts update based on other active filters
- **Copy** — double-click arguments to copy, or 📋 button for full row JSON
- **Auto-refresh** — polls for new calls every 10 seconds (enabled by default)
- **Export** — download filtered results as JSON
- **Relative timestamps** — "2m ago" with full date on hover
- **Customizable** — set your agent name/emoji via CLI or env var
- **Mobile responsive** — works on phones and tablets
- **LAN accessible** — binds to `0.0.0.0`

## Requirements

- [Node.js](https://nodejs.org/) v18 or later

### Installing Node.js

**macOS (Homebrew):**
```bash
brew install node
```

**macOS/Linux (nvm):**
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install --lts
```

**Ubuntu/Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Windows:**

Download installer from [nodejs.org](https://nodejs.org/)

## Installation

```bash
git clone https://github.com/VACInc/openclaw-tool-call-viewer.git
cd openclaw-tool-call-viewer
node server.js
```

No `npm install` needed — zero dependencies.

## Usage

```bash
# Default (port 3847, OpenClaw sessions)
node server.js

# Custom port
node server.js --port 8080

# Custom sessions directory
node server.js --sessions /path/to/sessions

# Custom agent name (shows in title + favicon)
node server.js --name "🤖 Jarvis"

# Or via environment variable
OPENCLAW_AGENT_NAME="🤖 Jarvis" node server.js

# Demo mode (fake data, safe for screenshots)
node server.js --demo

# Show help
node server.js --help
```

Then open http://localhost:3847 (or your machine's LAN IP).

## CLI Options

| Option | Short | Description | Default |
|--------|-------|-------------|---------|
| `--port` | `-p` | Port to listen on | `3847` |
| `--sessions` | `-s` | Path to sessions directory | `~/.openclaw/agents/main/sessions` |
| `--name` | `-n` | Agent name for title + favicon | `OpenClaw` (or `OPENCLAW_AGENT_NAME` env) |
| `--demo` | | Run with fake demo data | |
| `--help` | `-h` | Show help message | |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Web UI |
| `GET /api/tools?all=true` | All tool calls as JSON |
| `GET /api/tools?days=7` | Tool calls from last N days |
| `GET /api/stats` | Aggregated stats by tool type |

## Running as a Service

### macOS (launchd)

Create `~/Library/LaunchAgents/com.toolcallviewer.plist`:
```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.toolcallviewer</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/path/to/toolcallviewer/server.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.toolcallviewer.plist
```

### Linux (systemd)

Create `~/.config/systemd/user/toolcallviewer.service`:
```ini
[Unit]
Description=Tool Call Viewer

[Service]
ExecStart=/usr/bin/node /path/to/toolcallviewer/server.js
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now toolcallviewer
```

## License

MIT
