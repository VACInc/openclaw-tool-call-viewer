#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

// Parse CLI arguments
const args = process.argv.slice(2);
let PORT = 3847;
let SESSIONS_DIR = path.join(process.env.HOME, '.openclaw/agents/main/sessions');
let DEMO_MODE = false;
let AGENT_NAME = process.env.OPENCLAW_AGENT_NAME || 'OpenClaw';

for (let i = 0; i < args.length; i++) {
  if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
    PORT = parseInt(args[i + 1], 10);
    i++;
  } else if ((args[i] === '--sessions' || args[i] === '-s') && args[i + 1]) {
    SESSIONS_DIR = args[i + 1];
    i++;
  } else if (args[i] === '--demo') {
    DEMO_MODE = true;
  } else if ((args[i] === '--name' || args[i] === '-n') && args[i + 1]) {
    AGENT_NAME = args[i + 1];
    i++;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`
Tool Call Viewer - OpenClaw session tool call history

Usage: node server.js [options]

Options:
  -p, --port <port>       Port to listen on (default: 3847)
  -s, --sessions <path>   Path to sessions directory 
                          (default: ~/.openclaw/agents/main/sessions)
  -n, --name <name>       Agent name for title (default: OpenClaw, or env OPENCLAW_AGENT_NAME)
      --demo              Run with fake demo data (for screenshots)
  -h, --help              Show this help message

Examples:
  node server.js
  node server.js --port 8080
  node server.js --sessions /path/to/sessions
`);
    process.exit(0);
  }
}

function generateDemoData() {
  const tools = ['exec', 'read', 'write', 'edit', 'web_search', 'web_fetch', 'browser', 'message', 'cron', 'memory_search'];
  const models = ['claude-sonnet-4', 'claude-opus-4', 'gpt-4o', 'gemini-pro'];
  const sessions = ['a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'b2c3d4e5-f6a7-8901-bcde-f12345678901', 'c3d4e5f6-a7b8-9012-cdef-123456789012'];
  
  const demoCommands = [
    { name: 'exec', args: { command: 'ls -la /home/user/projects' } },
    { name: 'exec', args: { command: 'git status' } },
    { name: 'exec', args: { command: 'npm run build' } },
    { name: 'read', args: { path: '/home/user/config.json' } },
    { name: 'write', args: { path: '/home/user/output.txt', content: 'Hello world' } },
    { name: 'edit', args: { path: '/home/user/app.js', old_string: 'foo', new_string: 'bar' } },
    { name: 'web_search', args: { query: 'nodejs best practices 2026' } },
    { name: 'web_fetch', args: { url: 'https://example.com/api/data' } },
    { name: 'browser', args: { action: 'snapshot', url: 'https://docs.example.com' } },
    { name: 'message', args: { action: 'send', channel: 'discord', message: 'Task completed!' } },
    { name: 'cron', args: { action: 'add', schedule: '0 9 * * *' } },
    { name: 'memory_search', args: { query: 'project requirements' } },
  ];
  
  const calls = [];
  const now = Date.now();
  
  for (let i = 0; i < 500; i++) {
    const cmd = demoCommands[Math.floor(Math.random() * demoCommands.length)];
    calls.push({
      id: `toolu_demo_${i.toString().padStart(5, '0')}`,
      name: cmd.name,
      arguments: cmd.args,
      timestamp: new Date(now - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString(),
      sessionId: sessions[Math.floor(Math.random() * sessions.length)],
      model: models[Math.floor(Math.random() * models.length)],
      provider: 'demo'
    });
  }
  
  return calls.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function parseToolCalls() {
  if (DEMO_MODE) {
    return generateDemoData();
  }
  
  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.jsonl'));
  const toolCalls = [];

  for (const file of files) {
    const filePath = path.join(SESSIONS_DIR, file);
    const sessionId = file.replace('.jsonl', '');
    
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.message?.content && Array.isArray(obj.message.content)) {
            for (const item of obj.message.content) {
              if (item.type === 'toolCall') {
                // Truncate large argument values
                let args = item.arguments;
                if (args) {
                  args = Object.fromEntries(
                    Object.entries(args).map(([k, v]) => {
                      if (typeof v === 'string' && v.length > 500) return [k, v.slice(0, 500) + '…'];
                      return [k, v];
                    })
                  );
                }
                toolCalls.push({
                  id: item.id,
                  name: item.name,
                  arguments: args,
                  timestamp: obj.timestamp,
                  sessionId: sessionId,
                  model: obj.message?.model,
                  provider: obj.message?.provider
                });
              }
            }
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  return toolCalls.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function serveStatic(res, filePath, contentType) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    // Template the agent name and icon
    content = content.replace(/\{\{AGENT_NAME\}\}/g, AGENT_NAME);
    // Extract first emoji/character for favicon, strip from plain name
    const iconMatch = AGENT_NAME.match(/\p{Emoji}/u);
    const agentIcon = iconMatch ? iconMatch[0] : '🔧';
    const agentNamePlain = AGENT_NAME.replace(/\p{Emoji}\s*/gu, '').trim();
    content = content.replace(/\{\{AGENT_ICON\}\}/g, agentIcon);
    content = content.replace(/\{\{AGENT_NAME_PLAIN\}\}/g, agentNamePlain);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/' || req.url === '/index.html') {
    serveStatic(res, path.join(__dirname, 'index.html'), 'text/html');
  } else if (req.url.startsWith('/api/tools')) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const days = parseInt(url.searchParams.get('days') || '7', 10);
    const allData = url.searchParams.get('all') === 'true';
    let toolCalls = parseToolCalls();
    if (!allData && days > 0) {
      const cutoff = new Date(Date.now() - days * 86400000);
      toolCalls = toolCalls.filter(c => new Date(c.timestamp) >= cutoff);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(toolCalls));
  } else if (req.url === '/api/stats') {
    const toolCalls = parseToolCalls();
    const stats = {};
    for (const call of toolCalls) {
      stats[call.name] = (stats[call.name] || 0) + 1;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ total: toolCalls.length, byType: stats }));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tool Call Viewer running at http://0.0.0.0:${PORT}`);
  console.log(`Sessions directory: ${SESSIONS_DIR}`);
});
