#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let PORT = 3847;
let SESSIONS_DIR = path.join(process.env.HOME, '.openclaw/agents');
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
  -s, --sessions <path>   Path to agents/sessions directory tree
                          (default: ~/.openclaw/agents)
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

const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'toolcallviewer-index.json');
const INDEX_FORMAT_VERSION = 1;
const MAX_ARG_LENGTH = 500;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const _sseClients = new Set();
const SSE_DELTA_LIMIT = 20;

let _index = {
  version: INDEX_FORMAT_VERSION,
  root: SESSIONS_DIR,
  files: {},
};
let _datasetVersion = 0;
let _saveTimer = null;
let _watchDebounce = null;
let _lastDelta = { added: [], removed: 0, changedFiles: [] };

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function loadIndexCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed?.version === INDEX_FORMAT_VERSION && parsed?.root === SESSIONS_DIR && parsed?.files) {
      _index = parsed;
    }
  } catch {}
}

function scheduleSaveIndex() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try {
      ensureCacheDir();
      fs.writeFileSync(CACHE_FILE, JSON.stringify(_index));
    } catch (e) {
      console.error('Failed to save cache:', e.message);
    }
  }, 250);
}

function generateDemoData() {
  const tools = ['exec', 'read', 'write', 'edit', 'web_search', 'web_fetch', 'browser', 'message', 'cron', 'memory_search'];
  const models = ['claude-sonnet-4', 'claude-opus-4', 'gpt-4o', 'gemini-pro'];
  const agents = ['main', 'atlas', 'codex'];
  const calls = [];
  const now = Date.now();

  for (let i = 0; i < 500; i++) {
    const tool = tools[Math.floor(Math.random() * tools.length)];
    const agent = agents[Math.floor(Math.random() * agents.length)];
    const sessionId = `${agent}/sessions/demo-${(i % 25).toString().padStart(3, '0')}`;
    calls.push({
      id: `toolu_demo_${i.toString().padStart(5, '0')}`,
      name: tool,
      arguments: { demo: true, i },
      timestamp: new Date(now - Math.random() * 7 * 86400000).toISOString(),
      sessionId,
      model: models[Math.floor(Math.random() * models.length)],
      provider: 'demo',
      agent,
      archived: i % 7 === 0,
    });
  }

  return calls.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function isArchivedLog(filePath) {
  return path.basename(filePath).includes('.jsonl.reset.');
}

function isSessionLog(filePath) {
  const base = path.basename(filePath);
  return base.endsWith('.jsonl') || base.includes('.jsonl.reset.');
}

function collectSessionFiles(rootDir) {
  const files = [];

  function walk(dir) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && isSessionLog(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

function getFileMeta(filePath) {
  const relativePath = path.relative(SESSIONS_DIR, filePath);
  const parts = relativePath.split(path.sep);
  const agent = parts[0] || 'unknown';
  return {
    relativePath,
    sessionId: relativePath.replace(/\.jsonl(?:\.reset\..+)?$/, ''),
    agent,
    archived: isArchivedLog(filePath),
  };
}

function truncateArguments(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  return Object.fromEntries(
    Object.entries(args).map(([k, v]) => {
      if (typeof v === 'string' && v.length > MAX_ARG_LENGTH) {
        return [k, `${v.slice(0, MAX_ARG_LENGTH)}…`];
      }
      return [k, v];
    })
  );
}

function parseToolCallLines(lines, meta) {
  const calls = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (!obj.message?.content || !Array.isArray(obj.message.content)) continue;
      for (const item of obj.message.content) {
        if (item.type !== 'toolCall') continue;
        calls.push({
          id: item.id,
          name: item.name,
          arguments: truncateArguments(item.arguments),
          timestamp: obj.timestamp,
          sessionId: meta.sessionId,
          model: obj.message?.model,
          provider: obj.message?.provider,
          agent: meta.agent,
          archived: meta.archived,
        });
      }
    } catch {}
  }
  return calls;
}

function readFileSlice(filePath, start, end) {
  const length = Math.max(0, end - start);
  if (length === 0) return Buffer.alloc(0);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

function rebuildFileEntry(filePath, stat, meta) {
  const content = fs.readFileSync(filePath, 'utf8');
  const endsWithNewline = content.endsWith('\n');
  const lines = content.split('\n');
  const leftover = endsWithNewline ? '' : (lines.pop() || '');
  const calls = parseToolCallLines(lines, meta);

  return {
    entry: {
      path: filePath,
      relativePath: meta.relativePath,
      sessionId: meta.sessionId,
      agent: meta.agent,
      archived: meta.archived,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      offset: stat.size,
      leftover,
      calls,
    },
    newCalls: calls,
  };
}

function appendFileEntry(entry, filePath, stat, meta) {
  const buffer = readFileSlice(filePath, entry.offset, stat.size);
  const chunk = buffer.toString('utf8');
  const combined = `${entry.leftover || ''}${chunk}`;
  const lines = combined.split('\n');
  const leftover = combined.endsWith('\n') ? '' : (lines.pop() || '');
  const newCalls = parseToolCallLines(lines, meta);

  entry.path = filePath;
  entry.relativePath = meta.relativePath;
  entry.sessionId = meta.sessionId;
  entry.agent = meta.agent;
  entry.archived = meta.archived;
  entry.size = stat.size;
  entry.mtimeMs = stat.mtimeMs;
  entry.ino = stat.ino;
  entry.offset = stat.size;
  entry.leftover = leftover;
  entry.calls = (entry.calls || []).concat(newCalls);
  return { entry, newCalls };
}

function syncSingleFile(filePath) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    if (_index.files[filePath]) {
      delete _index.files[filePath];
      return { changed: true, newCalls: [], removed: 1, changedFiles: [path.relative(SESSIONS_DIR, filePath)] };
    }
    return { changed: false, newCalls: [], removed: 0, changedFiles: [] };
  }

  const meta = getFileMeta(filePath);
  const existing = _index.files[filePath];

  if (!existing) {
    const rebuilt = rebuildFileEntry(filePath, stat, meta);
    _index.files[filePath] = rebuilt.entry;
    return { changed: true, newCalls: rebuilt.newCalls, removed: 0, changedFiles: [meta.relativePath] };
  }

  if (existing.ino === stat.ino && existing.size === stat.size && existing.mtimeMs === stat.mtimeMs) {
    return { changed: false, newCalls: [], removed: 0, changedFiles: [] };
  }

  if (existing.ino === stat.ino && stat.size >= existing.offset) {
    const appended = appendFileEntry(existing, filePath, stat, meta);
    _index.files[filePath] = appended.entry;
    return { changed: true, newCalls: appended.newCalls, removed: 0, changedFiles: [meta.relativePath] };
  }

  const rebuilt = rebuildFileEntry(filePath, stat, meta);
  const removed = Array.isArray(existing.calls) ? existing.calls.length : 0;
  _index.files[filePath] = rebuilt.entry;
  return { changed: true, newCalls: rebuilt.newCalls, removed, changedFiles: [meta.relativePath] };
}

function syncIndex(fullRescan = true, changedPath = null) {
  let changed = false;
  const added = [];
  let removed = 0;
  const changedFiles = new Set();

  if (DEMO_MODE) {
    _datasetVersion++;
    _lastDelta = { added: [], removed: 0, changedFiles: [] };
    return true;
  }

  if (changedPath && isSessionLog(changedPath)) {
    const result = syncSingleFile(changedPath);
    changed = result.changed || changed;
    added.push(...result.newCalls);
    removed += result.removed;
    result.changedFiles.forEach(f => changedFiles.add(f));
  }

  if (fullRescan || !changedPath) {
    const discovered = new Set(collectSessionFiles(SESSIONS_DIR));
    for (const filePath of discovered) {
      const result = syncSingleFile(filePath);
      changed = result.changed || changed;
      added.push(...result.newCalls);
      removed += result.removed;
      result.changedFiles.forEach(f => changedFiles.add(f));
    }
    for (const filePath of Object.keys(_index.files)) {
      if (!discovered.has(filePath)) {
        removed += Array.isArray(_index.files[filePath]?.calls) ? _index.files[filePath].calls.length : 0;
        changedFiles.add(path.relative(SESSIONS_DIR, filePath));
        delete _index.files[filePath];
        changed = true;
      }
    }
  }

  if (changed) {
    _datasetVersion++;
    _lastDelta = {
      added: sortCalls(added, 'timestamp', 'desc').slice(0, SSE_DELTA_LIMIT),
      removed,
      changedFiles: Array.from(changedFiles).slice(0, SSE_DELTA_LIMIT),
    };
    scheduleSaveIndex();
  }
  return changed;
}

function getAllCalls(includeArchived = false, archivedOnly = false) {
  if (DEMO_MODE) {
    return generateDemoData().filter(call => archivedOnly ? call.archived : includeArchived || !call.archived);
  }

  const calls = [];
  for (const entry of Object.values(_index.files)) {
    if (archivedOnly) {
      if (!entry.archived) continue;
    } else if (!includeArchived && entry.archived) {
      continue;
    }
    if (Array.isArray(entry.calls)) calls.push(...entry.calls);
  }
  calls.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return calls;
}

function parseSetParam(url, key) {
  const values = [];
  for (const value of url.searchParams.getAll(key)) {
    value.split(',').map(v => v.trim()).filter(Boolean).forEach(v => values.push(v));
  }
  return new Set(values);
}

function applyFilters(calls, url) {
  const tools = parseSetParam(url, 'tool');
  const models = parseSetParam(url, 'model');
  const sessions = parseSetParam(url, 'session');
  const agents = parseSetParam(url, 'agent');
  const search = (url.searchParams.get('search') || '').toLowerCase();
  const dateFrom = url.searchParams.get('dateFrom') || '';
  const dateTo = url.searchParams.get('dateTo') || '';

  return calls.filter(call => {
    if (tools.size && !tools.has(call.name)) return false;
    if (models.size && !models.has(call.model || 'unknown')) return false;
    if (sessions.size && !sessions.has(call.sessionId || 'unknown')) return false;
    if (agents.size && !agents.has(call.agent || 'unknown')) return false;

    if (dateFrom || dateTo) {
      const callDate = new Date(call.timestamp);
      if (dateFrom && callDate < new Date(dateFrom)) return false;
      if (dateTo && callDate > new Date(`${dateTo}T23:59:59`)) return false;
    }

    if (search) {
      const argsStr = JSON.stringify(call.arguments || {}).toLowerCase();
      if (!call.name.toLowerCase().includes(search) && !argsStr.includes(search)) return false;
    }

    return true;
  });
}

function sortCalls(calls, sortField, sortOrder) {
  const dir = sortOrder === 'asc' ? 1 : -1;
  calls.sort((a, b) => {
    let cmp = 0;
    if (sortField === 'name') cmp = a.name.localeCompare(b.name);
    else if (sortField === 'model') cmp = (a.model || '').localeCompare(b.model || '');
    else if (sortField === 'sessionId') cmp = (a.sessionId || '').localeCompare(b.sessionId || '');
    else if (sortField === 'agent') cmp = (a.agent || '').localeCompare(b.agent || '');
    else cmp = new Date(a.timestamp) - new Date(b.timestamp);
    return cmp * dir;
  });
  return calls;
}

function buildMeta(calls) {
  const byType = {};
  const byModel = {};
  const bySession = {};
  const byAgent = {};

  for (const call of calls) {
    byType[call.name] = (byType[call.name] || 0) + 1;
    byModel[call.model || 'unknown'] = (byModel[call.model || 'unknown'] || 0) + 1;
    bySession[call.sessionId || 'unknown'] = (bySession[call.sessionId || 'unknown'] || 0) + 1;
    byAgent[call.agent || 'unknown'] = (byAgent[call.agent || 'unknown'] || 0) + 1;
  }

  return {
    total: calls.length,
    tools: byType,
    models: byModel,
    sessions: bySession,
    agents: byAgent,
    uniqueTypes: Object.keys(byType).length,
    uniqueSessions: Object.keys(bySession).length,
    uniqueAgents: Object.keys(byAgent).length,
    indexedFiles: Object.keys(_index.files).length,
    datasetVersion: _datasetVersion,
  };
}

function getLiveEventPayload() {
  const activeCalls = getAllCalls(false, false);
  return {
    version: _datasetVersion,
    delta: _lastDelta,
    meta: buildMeta(activeCalls),
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function serveStatic(res, filePath, contentType) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(/\{\{AGENT_NAME\}\}/g, AGENT_NAME);
    const iconMatch = AGENT_NAME.match(/\p{Emoji}/u);
    const agentIcon = iconMatch ? iconMatch[0] : '🔧';
    const agentNamePlain = AGENT_NAME.replace(/\p{Emoji}\s*/gu, '').trim();
    content = content.replace(/\{\{AGENT_ICON\}\}/g, agentIcon);
    content = content.replace(/\{\{AGENT_NAME_PLAIN\}\}/g, agentNamePlain);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function getArchiveMode(url) {
  const mode = url.searchParams.get('archived') || 'exclude';
  return ['exclude', 'include', 'only'].includes(mode) ? mode : 'exclude';
}

function getCallsForRequest(url) {
  const archiveMode = getArchiveMode(url);
  return getAllCalls(archiveMode === 'include', archiveMode === 'only');
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/' || req.url === '/index.html') {
    serveStatic(res, path.join(__dirname, 'index.html'), 'text/html');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/meta') {
    const calls = applyFilters(getCallsForRequest(url), url);
    sendJson(res, 200, buildMeta(calls));
    return;
  }

  if (url.pathname === '/api/tools') {
    const sortField = url.searchParams.get('sortField') || 'timestamp';
    const sortOrder = url.searchParams.get('sortOrder') || 'desc';
    const allData = url.searchParams.get('all') === 'true';
    let calls = applyFilters(getCallsForRequest(url), url);
    calls = sortCalls(calls, sortField, sortOrder);

    if (allData) {
      sendJson(res, 200, calls);
      return;
    }

    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get('pageSize') || String(DEFAULT_PAGE_SIZE), 10)));
    const total = calls.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(page, totalPages);
    const start = (safePage - 1) * pageSize;
    const items = calls.slice(start, start + pageSize);

    sendJson(res, 200, {
      items,
      pagination: {
        page: safePage,
        pageSize,
        total,
        totalPages,
      },
      summary: buildMeta(calls),
    });
    return;
  }

  if (url.pathname === '/api/stats') {
    const calls = getCallsForRequest(url);
    sendJson(res, 200, buildMeta(calls));
    return;
  }

  if (url.pathname === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`data: ${JSON.stringify(getLiveEventPayload())}\n\n`);
    _sseClients.add(res);
    req.on('close', () => _sseClients.delete(res));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function broadcastUpdate() {
  const payload = JSON.stringify(getLiveEventPayload());
  for (const client of _sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch {
      _sseClients.delete(client);
    }
  }
}

function onFilesystemChange(filename) {
  if (_watchDebounce) clearTimeout(_watchDebounce);
  _watchDebounce = setTimeout(() => {
    const fullPath = filename ? path.join(SESSIONS_DIR, filename) : null;
    const changed = syncIndex(!fullPath, fullPath);
    if (changed) broadcastUpdate();
  }, 150);
}

loadIndexCache();
syncIndex(true);

try {
  fs.watch(SESSIONS_DIR, { persistent: false, recursive: true }, (_eventType, filename) => {
    if (!filename || !isSessionLog(filename)) return;
    onFilesystemChange(filename);
  });
} catch (e) {
  console.error('fs.watch failed, falling back to startup indexing only:', e.message);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tool Call Viewer running at http://0.0.0.0:${PORT}`);
  console.log(`Sessions directory: ${SESSIONS_DIR}`);
  console.log(`Cache file: ${CACHE_FILE}`);
});
