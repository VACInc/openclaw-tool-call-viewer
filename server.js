const http = require('http');
const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = path.join(process.env.HOME, '.openclaw/agents/main/sessions');
const PORT = 3847;

function parseToolCalls() {
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
                toolCalls.push({
                  id: item.id,
                  name: item.name,
                  arguments: item.arguments,
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
    const content = fs.readFileSync(filePath, 'utf8');
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
  } else if (req.url === '/api/tools') {
    const toolCalls = parseToolCalls();
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
  console.log(`Tool Viewer running at http://0.0.0.0:${PORT}`);
});
