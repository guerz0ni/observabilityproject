const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs/promises');
const path = require('path');
const client = require('prom-client');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'observability-demo-secret';
const SIMULATE_ERROR_STORM = process.env.SIMULATE_ERROR_STORM === 'true';
const USERS_FILE = process.env.USERS_FILE || '/app/data/users.json';

const app = express();
app.use(express.json());

// métricas prometheus
const register = new client.Registry();
client.collectDefaultMetrics({ register, prefix: 'nodejs_' });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total de requisições HTTP',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duração das requisições HTTP em segundos',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
  registers: [register],
});

const loginErrorsTotal = new client.Counter({
  name: 'login_errors_total',
  help: 'Total de erros de login',
  labelNames: ['reason'],
  registers: [register],
});

const applicationErrorsTotal = new client.Counter({
  name: 'application_errors_total',
  help: 'Total de erros da aplicação (5xx)',
  labelNames: ['route', 'type'],
  registers: [register],
});

const serviceUp = new client.Gauge({
  name: 'service_up',
  help: 'Disponibilidade do serviço (1=up, 0=down)',
  registers: [register],
});

serviceUp.set(1);

//logs estruturados 
function log(level, message, meta = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    service: 'observability-api',
    ...meta,
  };
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

//armazenamento em memória
const users = new Map();

const usersDir = path.dirname(USERS_FILE);
let usersPersistQueue = Promise.resolve();

function serializeUsers() {
  return {
    users: [...users.values()].map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      passwordHash: u.passwordHash,
      createdAt: u.createdAt,
    })),
  };
}

async function loadUsersFromFile() {
  await fs.mkdir(usersDir, { recursive: true });

  try {
    const raw = await fs.readFile(USERS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : parsed?.users;
    if (!Array.isArray(arr)) return 0;

    for (const u of arr) {
      if (!u?.email) continue;
      users.set(u.email, {
        id: u.id,
        email: u.email,
        name: u.name,
        passwordHash: u.passwordHash,
        createdAt: u.createdAt,
      });
    }
    return users.size;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await fs.writeFile(USERS_FILE, JSON.stringify({ users: [] }, null, 2), 'utf-8');
      return 0;
    }
    log('error', 'users_load_failed', { error: err?.message });
    return 0;
  }
}

async function persistUsersToFile() {
  usersPersistQueue = usersPersistQueue
    .then(async () => {
      await fs.mkdir(usersDir, { recursive: true });
      const payload = serializeUsers();
      await fs.writeFile(USERS_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    })
    .catch((err) => {
      log('error', 'users_persist_failed', { error: err?.message });
    });

  return usersPersistQueue;
}

// estado para simulação de incidentes
let errorStormActive = false;
let instabilityMode = false;

// middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path;
    const labels = { method: req.method, route, status: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, duration);
    log('info', 'request_completed', {
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      duration_ms: Date.now() - start,
      ip: req.ip,
    });
  });
  next();
});

//rotas de saúde e métricas 
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.get('/metrics', async (_req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// CRUD 
app.post('/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'email e password são obrigatórios' });
    }
    if (users.has(email)) {
      return res.status(409).json({ error: 'usuário já existe' });
    }
    const hash = await bcrypt.hash(password, 10);
    const user = {
      id: uuidv4(),
      email,
      name: name || email.split('@')[0],
      passwordHash: hash,
      createdAt: new Date().toISOString(),
    };
    users.set(email, user);
    await persistUsersToFile();
    log('info', 'user_registered', { userId: user.id, email });
    res.status(201).json({
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    });
  } catch (err) {
    applicationErrorsTotal.inc({ route: '/register', type: 'unhandled' });
    log('error', 'register_failed', { error: err.message });
    res.status(500).json({ error: 'falha no cadastro' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (errorStormActive || SIMULATE_ERROR_STORM) {
    loginErrorsTotal.inc({ reason: 'simulated_storm' });
    applicationErrorsTotal.inc({ route: '/login', type: 'simulated_500' });
    log('error', 'login_failed_simulated_storm', { email: email || 'unknown' });
    return res.status(500).json({ error: 'falha interna simulada no login' });
  }

  try {
    if (!email || !password) {
      loginErrorsTotal.inc({ reason: 'missing_fields' });
      log('error', 'login_failed', { reason: 'missing_fields', email: email || 'unknown' });
      return res.status(400).json({ error: 'email e password são obrigatórios' });
    }

    const user = users.get(email);
    if (!user) {
      loginErrorsTotal.inc({ reason: 'user_not_found' });
      log('error', 'login_failed', { reason: 'user_not_found', email });
      return res.status(401).json({ error: 'credenciais inválidas' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      loginErrorsTotal.inc({ reason: 'invalid_password' });
      log('error', 'login_failed', { reason: 'invalid_password', email });
      return res.status(401).json({ error: 'credenciais inválidas' });
    }

    const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
    log('info', 'login_success', { userId: user.id, email });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    loginErrorsTotal.inc({ reason: 'server_error' });
    applicationErrorsTotal.inc({ route: '/login', type: 'unhandled' });
    log('error', 'login_failed', { reason: 'server_error', error: err.message, email });
    res.status(500).json({ error: 'erro interno no login' });
  }
});

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'token ausente' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'token inválido' });
  }
}

app.get('/users', authMiddleware, (_req, res) => {
  const list = [...users.values()].map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    createdAt: u.createdAt,
  }));
  res.json(list);
});

app.put('/users/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, password } = req.body;
    const entry = [...users.entries()].find(([, u]) => u.id === id);
    if (!entry) {
      return res.status(404).json({ error: 'usuário não encontrado' });
    }
    const [email, user] = entry;
    if (name) user.name = name;
    if (password) user.passwordHash = await bcrypt.hash(password, 10);
    users.set(email, user);
    await persistUsersToFile();
    log('info', 'user_updated', { userId: id });
    res.json({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    applicationErrorsTotal.inc({ route: '/users/:id', type: 'unhandled' });
    log('error', 'user_update_failed', { error: err.message });
    res.status(500).json({ error: 'falha ao atualizar usuário' });
  }
});

app.delete('/users/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  for (const [email, user] of users.entries()) {
    if (user.id === id) {
      users.delete(email);
      await persistUsersToFile();
      log('info', 'user_deleted', { userId: id });
      return res.status(204).send();
    }
  }
  res.status(404).json({ error: 'usuário não encontrado' });
});

//simulação de incidentes
app.post('/incidents/error-storm/start', (req, res) => {
  const count = Math.min(Number(req.body?.count) || 50, 500);
  errorStormActive = true;
  log('warn', 'incident_started', { incident: 'error_storm', count });
  res.json({ message: 'Incidente 1 ativado: logins retornarão HTTP 500', count });

  setTimeout(() => {
    errorStormActive = false;
    log('info', 'incident_stopped', { incident: 'error_storm' });
  }, 120_000);
});

app.post('/incidents/error-storm/stop', (_req, res) => {
  errorStormActive = false;
  log('info', 'incident_stopped', { incident: 'error_storm', manual: true });
  res.json({ message: 'Incidente 1 desativado' });
});

app.post('/incidents/error-storm/trigger', async (req, res) => {
  const count = Math.min(Number(req.body?.count) || 30, 200);
  errorStormActive = true;
  const results = [];
  for (let i = 0; i < count; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `storm${i}@demo.com`, password: 'wrong' }),
      });
      results.push(r.status);
    } catch (e) {
      results.push('failed');
    }
  }
  errorStormActive = false;
  res.json({ message: `Disparados ${count} logins com falha 500`, statuses: results.slice(0, 10) });
});

app.get('/incidents/instability', async (req, res) => {
  instabilityMode = true;
  const iterations = Math.min(Number(req.query.iterations) || 5, 20);
  log('warn', 'incident_started', { incident: 'instability', iterations });

  for (let i = 0; i < iterations; i++) {
    const delay = 500 + Math.random() * 4000;
    const shouldTimeout = Math.random() > 0.5;
    log('warn', 'instability_event', { iteration: i + 1, delay_ms: delay, timeout: shouldTimeout });

    await new Promise((r) => setTimeout(r, delay));

    if (shouldTimeout && !req.query.skipTimeout) {
      log('error', 'instability_timeout', { iteration: i + 1 });
      applicationErrorsTotal.inc({ route: '/incidents/instability', type: 'timeout' });
      return res.status(504).json({ error: 'timeout simulado', iteration: i + 1 });
    }
  }

  instabilityMode = false;
  log('info', 'incident_completed', { incident: 'instability' });
  res.json({ message: 'Incidente 3 concluído com delays intermitentes', iterations });
});

app.get('/incidents/cpu-burn', (req, res) => {
  const durationMs = Math.min(Number(req.query.durationMs) || 15000, 60000);
  const end = Date.now() + durationMs;
  log('warn', 'incident_started', { incident: 'cpu_burn', durationMs });
  while (Date.now() < end) {
    Math.sqrt(Math.random() * 1e6);
  }
  log('info', 'incident_completed', { incident: 'cpu_burn' });
  res.json({ message: `CPU burn por ${durationMs}ms concluído` });
});

// handler de erros
app.use((err, req, res, _next) => {
  applicationErrorsTotal.inc({ route: req.path, type: 'middleware' });
  log('error', 'unhandled_error', { path: req.path, error: err.message, stack: err.stack });
  res.status(500).json({ error: 'erro interno' });
});

(async () => {
  const count = await loadUsersFromFile();
  log('info', 'users_loaded', { count, file: USERS_FILE });

  app.listen(PORT, () => {
    log('info', 'system_startup', { port: PORT, nodeVersion: process.version });
  });
})();
