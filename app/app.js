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

const httpRequestsInFlight = new client.Gauge({
  name: 'http_requests_in_flight',
  help: 'Requisições HTTP em processamento',
  registers: [register],
});

const registeredUsersTotal = new client.Gauge({
  name: 'registered_users_total',
  help: 'Total de usuários cadastrados',
  registers: [register],
});

const crudOperationsTotal = new client.Counter({
  name: 'crud_operations_total',
  help: 'Operações CRUD por tipo e resultado',
  labelNames: ['operation', 'result'],
  registers: [register],
});

const authAttemptsTotal = new client.Counter({
  name: 'auth_attempts_total',
  help: 'Tentativas de autenticação e cadastro',
  labelNames: ['action', 'result', 'reason'],
  registers: [register],
});

const httpClientErrorsTotal = new client.Counter({
  name: 'http_client_errors_total',
  help: 'Erros HTTP 4xx',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpServerErrorsTotal = new client.Counter({
  name: 'http_server_errors_total',
  help: 'Erros HTTP 5xx',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const slowRequestsTotal = new client.Counter({
  name: 'slow_requests_total',
  help: 'Requisições acima do limiar de latência',
  labelNames: ['method', 'route'],
  registers: [register],
});

const logEventsTotal = new client.Counter({
  name: 'log_events_total',
  help: 'Eventos de log emitidos pela aplicação',
  labelNames: ['level', 'event_type'],
  registers: [register],
});

serviceUp.set(1);

const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS) || 1000;

function syncUsersGauge() {
  registeredUsersTotal.set(users.size);
}

// Logs estruturados com correlação (requestId) e categorização (event_type)
function log(level, message, meta = {}) {
  const { event_type = 'system', request_id, ...rest } = meta;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    event_type,
    service: 'observability-api',
    ...(request_id ? { request_id } : {}),
    ...rest,
  };
  logEventsTotal.inc({ level, event_type });
  if (level === 'error') {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

function logFromReq(req, level, message, meta = {}) {
  log(level, message, { request_id: req.requestId, ...meta });
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
    syncUsersGauge();
    return users.size;
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      await fs.writeFile(USERS_FILE, JSON.stringify({ users: [] }, null, 2), 'utf-8');
      syncUsersGauge();
      return 0;
    }
    log('error', 'users_load_failed', { event_type: 'persistence', error: err?.message });
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
      log('error', 'users_persist_failed', { event_type: 'persistence', error: err?.message });
    });

  return usersPersistQueue;
}

// estado para simulação de incidentes
let errorStormActive = false;
let instabilityMode = false;
let requestsInFlightCount = 0;

// Correlação de logs por requisição
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || uuidv4();
  res.setHeader('X-Request-Id', req.requestId);
  next();
});

// Middleware de métricas e logs HTTP
app.use((req, res, next) => {
  const start = Date.now();
  httpRequestsInFlight.inc();
  requestsInFlightCount += 1;

  res.on('finish', () => {
    httpRequestsInFlight.dec();
    requestsInFlightCount -= 1;
    const durationMs = Date.now() - start;
    const duration = durationMs / 1000;
    const route = req.route?.path || req.path;
    const status = res.statusCode;
    const labels = { method: req.method, route, status: String(status) };

    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, duration);

    if (status >= 400 && status < 500) {
      httpClientErrorsTotal.inc(labels);
    }
    if (status >= 500) {
      httpServerErrorsTotal.inc(labels);
    }
    if (durationMs >= SLOW_REQUEST_MS) {
      slowRequestsTotal.inc({ method: req.method, route });
      logFromReq(req, 'warn', 'slow_request', {
        event_type: 'http',
        method: req.method,
        path: req.originalUrl,
        status,
        duration_ms: durationMs,
        threshold_ms: SLOW_REQUEST_MS,
      });
    }

    logFromReq(req, 'info', 'request_completed', {
      event_type: 'http',
      method: req.method,
      path: req.originalUrl,
      status,
      duration_ms: durationMs,
      ip: req.ip,
    });
  });

  next();
});

//rotas de saúde e métricas 
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    users: users.size,
    requests_in_flight: requestsInFlightCount,
  });
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
      authAttemptsTotal.inc({ action: 'register', result: 'failure', reason: 'validation' });
      crudOperationsTotal.inc({ operation: 'create', result: 'error' });
      logFromReq(req, 'warn', 'register_validation_failed', { event_type: 'auth', email: email || 'unknown' });
      return res.status(400).json({ error: 'email e password são obrigatórios' });
    }
    if (users.has(email)) {
      authAttemptsTotal.inc({ action: 'register', result: 'failure', reason: 'duplicate' });
      crudOperationsTotal.inc({ operation: 'create', result: 'error' });
      logFromReq(req, 'warn', 'register_duplicate', { event_type: 'auth', email });
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
    syncUsersGauge();
    authAttemptsTotal.inc({ action: 'register', result: 'success', reason: 'none' });
    crudOperationsTotal.inc({ operation: 'create', result: 'success' });
    logFromReq(req, 'info', 'user_registered', { event_type: 'crud', userId: user.id, email });
    res.status(201).json({
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    });
  } catch (err) {
    applicationErrorsTotal.inc({ route: '/register', type: 'unhandled' });
    crudOperationsTotal.inc({ operation: 'create', result: 'error' });
    logFromReq(req, 'error', 'register_failed', { event_type: 'crud', error: err.message });
    res.status(500).json({ error: 'falha no cadastro' });
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (errorStormActive || SIMULATE_ERROR_STORM) {
    loginErrorsTotal.inc({ reason: 'simulated_storm' });
    applicationErrorsTotal.inc({ route: '/login', type: 'simulated_500' });
    authAttemptsTotal.inc({ action: 'login', result: 'failure', reason: 'simulated_storm' });
    logFromReq(req, 'error', 'login_failed_simulated_storm', { event_type: 'auth', email: email || 'unknown' });
    return res.status(500).json({ error: 'falha interna simulada no login' });
  }

  try {
    if (!email || !password) {
      loginErrorsTotal.inc({ reason: 'missing_fields' });
      authAttemptsTotal.inc({ action: 'login', result: 'failure', reason: 'missing_fields' });
      logFromReq(req, 'error', 'login_failed', { event_type: 'auth', reason: 'missing_fields', email: email || 'unknown' });
      return res.status(400).json({ error: 'email e password são obrigatórios' });
    }

    const user = users.get(email);
    if (!user) {
      loginErrorsTotal.inc({ reason: 'user_not_found' });
      authAttemptsTotal.inc({ action: 'login', result: 'failure', reason: 'user_not_found' });
      logFromReq(req, 'error', 'login_failed', { event_type: 'auth', reason: 'user_not_found', email });
      return res.status(401).json({ error: 'credenciais inválidas' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      loginErrorsTotal.inc({ reason: 'invalid_password' });
      authAttemptsTotal.inc({ action: 'login', result: 'failure', reason: 'invalid_password' });
      logFromReq(req, 'error', 'login_failed', { event_type: 'auth', reason: 'invalid_password', email });
      return res.status(401).json({ error: 'credenciais inválidas' });
    }

    const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
    authAttemptsTotal.inc({ action: 'login', result: 'success', reason: 'none' });
    logFromReq(req, 'info', 'login_success', { event_type: 'auth', userId: user.id, email });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    loginErrorsTotal.inc({ reason: 'server_error' });
    applicationErrorsTotal.inc({ route: '/login', type: 'unhandled' });
    authAttemptsTotal.inc({ action: 'login', result: 'failure', reason: 'server_error' });
    logFromReq(req, 'error', 'login_failed', { event_type: 'auth', reason: 'server_error', error: err.message, email });
    res.status(500).json({ error: 'erro interno no login' });
  }
});

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    authAttemptsTotal.inc({ action: 'token', result: 'failure', reason: 'missing' });
    logFromReq(req, 'warn', 'auth_denied', { event_type: 'security', reason: 'token_missing' });
    return res.status(401).json({ error: 'token ausente' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    authAttemptsTotal.inc({ action: 'token', result: 'failure', reason: 'invalid' });
    logFromReq(req, 'warn', 'auth_denied', { event_type: 'security', reason: 'token_invalid' });
    return res.status(401).json({ error: 'token inválido' });
  }
}

app.get('/users', authMiddleware, (req, res) => {
  const list = [...users.values()].map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    createdAt: u.createdAt,
  }));
  crudOperationsTotal.inc({ operation: 'read', result: 'success' });
  logFromReq(req, 'info', 'users_listed', { event_type: 'crud', count: list.length });
  res.json(list);
});

app.put('/users/:id', authMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, password } = req.body;
    const entry = [...users.entries()].find(([, u]) => u.id === id);
    if (!entry) {
      crudOperationsTotal.inc({ operation: 'update', result: 'error' });
      logFromReq(req, 'warn', 'user_not_found', { event_type: 'crud', userId: id });
      return res.status(404).json({ error: 'usuário não encontrado' });
    }
    const [email, user] = entry;
    if (name) user.name = name;
    if (password) user.passwordHash = await bcrypt.hash(password, 10);
    users.set(email, user);
    await persistUsersToFile();
    crudOperationsTotal.inc({ operation: 'update', result: 'success' });
    logFromReq(req, 'info', 'user_updated', { event_type: 'crud', userId: id });
    res.json({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    applicationErrorsTotal.inc({ route: '/users/:id', type: 'unhandled' });
    crudOperationsTotal.inc({ operation: 'update', result: 'error' });
    logFromReq(req, 'error', 'user_update_failed', { event_type: 'crud', error: err.message });
    res.status(500).json({ error: 'falha ao atualizar usuário' });
  }
});

app.delete('/users/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  for (const [email, user] of users.entries()) {
    if (user.id === id) {
      users.delete(email);
      await persistUsersToFile();
      syncUsersGauge();
      crudOperationsTotal.inc({ operation: 'delete', result: 'success' });
      logFromReq(req, 'info', 'user_deleted', { event_type: 'crud', userId: id });
      return res.status(204).send();
    }
  }
  crudOperationsTotal.inc({ operation: 'delete', result: 'error' });
  logFromReq(req, 'warn', 'user_not_found', { event_type: 'crud', userId: id });
  res.status(404).json({ error: 'usuário não encontrado' });
});

//simulação de incidentes
app.post('/incidents/error-storm/start', (req, res) => {
  const count = Math.min(Number(req.body?.count) || 50, 500);
  errorStormActive = true;
  logFromReq(req, 'warn', 'incident_started', { event_type: 'incident', incident: 'error_storm', count });
  res.json({ message: 'Incidente 1 ativado: logins retornarão HTTP 500', count });

  setTimeout(() => {
    errorStormActive = false;
    log('info', 'incident_stopped', { event_type: 'incident', incident: 'error_storm' });
  }, 120_000);
});

app.post('/incidents/error-storm/stop', (_req, res) => {
  errorStormActive = false;
  logFromReq(_req, 'info', 'incident_stopped', { event_type: 'incident', incident: 'error_storm', manual: true });
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
  logFromReq(req, 'warn', 'incident_started', { event_type: 'incident', incident: 'instability', iterations });

  for (let i = 0; i < iterations; i++) {
    const delay = 500 + Math.random() * 4000;
    const shouldTimeout = Math.random() > 0.5;
    logFromReq(req, 'warn', 'instability_event', {
      event_type: 'incident',
      iteration: i + 1,
      delay_ms: delay,
      timeout: shouldTimeout,
    });

    await new Promise((r) => setTimeout(r, delay));

    if (shouldTimeout && !req.query.skipTimeout) {
      logFromReq(req, 'error', 'instability_timeout', { event_type: 'incident', iteration: i + 1 });
      applicationErrorsTotal.inc({ route: '/incidents/instability', type: 'timeout' });
      return res.status(504).json({ error: 'timeout simulado', iteration: i + 1 });
    }
  }

  instabilityMode = false;
  logFromReq(req, 'info', 'incident_completed', { event_type: 'incident', incident: 'instability' });
  res.json({ message: 'Incidente 3 concluído com delays intermitentes', iterations });
});

app.get('/incidents/cpu-burn', (req, res) => {
  const durationMs = Math.min(Number(req.query.durationMs) || 15000, 60000);
  const end = Date.now() + durationMs;
  logFromReq(req, 'warn', 'incident_started', { event_type: 'incident', incident: 'cpu_burn', durationMs });
  while (Date.now() < end) {
    Math.sqrt(Math.random() * 1e6);
  }
  logFromReq(req, 'info', 'incident_completed', { event_type: 'incident', incident: 'cpu_burn' });
  res.json({ message: `CPU burn por ${durationMs}ms concluído` });
});

// handler de erros
app.use((err, req, res, _next) => {
  applicationErrorsTotal.inc({ route: req.path, type: 'middleware' });
  logFromReq(req, 'error', 'unhandled_error', {
    event_type: 'system',
    path: req.path,
    error: err.message,
    stack: err.stack,
  });
  res.status(500).json({ error: 'erro interno' });
});

(async () => {
  const count = await loadUsersFromFile();
  syncUsersGauge();
  log('info', 'users_loaded', { event_type: 'system', count, file: USERS_FILE });

  app.listen(PORT, () => {
    log('info', 'system_startup', { event_type: 'system', port: PORT, nodeVersion: process.version });
  });
})();
