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
const DATA_DIR = path.dirname(USERS_FILE);
const PRODUCTS_FILE = process.env.PRODUCTS_FILE || path.join(DATA_DIR, 'products.json');
const ORDERS_FILE = process.env.ORDERS_FILE || path.join(DATA_DIR, 'orders.json');
const CARTS_FILE = process.env.CARTS_FILE || path.join(DATA_DIR, 'carts.json');

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

const ordersCreatedTotal = new client.Counter({
  name: 'orders_created_total',
  help: 'Pedidos criados no e-commerce',
  labelNames: ['status'],
  registers: [register],
});

const checkoutFailuresTotal = new client.Counter({
  name: 'checkout_failures_total',
  help: 'Falhas no checkout',
  labelNames: ['reason'],
  registers: [register],
});

const cartAdditionsTotal = new client.Counter({
  name: 'cart_additions_total',
  help: 'Itens adicionados ao carrinho',
  registers: [register],
});

const orderValueReais = new client.Histogram({
  name: 'order_value_reais',
  help: 'Valor dos pedidos em reais',
  buckets: [50, 100, 200, 500, 1000, 2000, 5000, 10000],
  registers: [register],
});

const activeCartsGauge = new client.Gauge({
  name: 'active_carts_total',
  help: 'Carrinhos com pelo menos um item',
  registers: [register],
});

const productsStockGauge = new client.Gauge({
  name: 'products_in_stock_total',
  help: 'Unidades totais em estoque',
  registers: [register],
});

const usersOnlineTotal = new client.Gauge({
  name: 'users_online_total',
  help: 'Usuários ativos nos últimos 5 minutos',
  registers: [register],
});

const ordersPendingTotal = new client.Gauge({
  name: 'orders_pending_total',
  help: 'Pedidos aguardando pagamento',
  registers: [register],
});

const paymentsSuccessfulTotal = new client.Counter({
  name: 'payments_successful_total',
  help: 'Pagamentos efetivados com sucesso',
  registers: [register],
});

const paymentsFailedTotal = new client.Counter({
  name: 'payments_failed_total',
  help: 'Pagamentos com falha',
  labelNames: ['reason'],
  registers: [register],
});

const bruteForceAttemptsTotal = new client.Counter({
  name: 'brute_force_attempts_total',
  help: 'Tentativas de login por força bruta',
  registers: [register],
});

serviceUp.set(1);

const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS) || 1000;
const ONLINE_TTL_MS = 5 * 60 * 1000;
const onlineUsers = new Map();

function syncUsersGauge() {
  registeredUsersTotal.set(users.size);
}

function touchUserOnline(userId) {
  if (userId) onlineUsers.set(userId, Date.now());
}

function syncUsersOnlineGauge() {
  const now = Date.now();
  let count = 0;
  for (const [id, ts] of onlineUsers.entries()) {
    if (now - ts < ONLINE_TTL_MS) count++;
    else onlineUsers.delete(id);
  }
  usersOnlineTotal.set(count);
}

function syncOrdersPendingGauge() {
  ordersPendingTotal.set(orders.filter((o) => o.status === 'pending').length);
}

// Logs estruturados com correlação (requestId) e categorização (event_type)
function log(level, message, meta = {}) {
  const { event_type = 'system', request_id, ...rest } = meta;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    event_type,
    service: 'ecommerce-api',
    domain: 'ecommerce',
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

// Armazenamento
const users = new Map();
const products = new Map();
const orders = [];
const carts = new Map(); // userId -> { items: [] }

const DEFAULT_PRODUCTS = [
  { id: 'p1', name: 'Notebook Pro 15"', price: 4299.9, stock: 25, category: 'eletronicos' },
  { id: 'p2', name: 'Mouse Gamer RGB', price: 189.9, stock: 150, category: 'eletronicos' },
  { id: 'p3', name: 'Teclado Mecânico', price: 349.9, stock: 80, category: 'eletronicos' },
  { id: 'p4', name: 'Camiseta Premium', price: 89.9, stock: 200, category: 'moda' },
  { id: 'p5', name: 'Tênis Esportivo', price: 299.9, stock: 60, category: 'moda' },
  { id: 'p6', name: 'Fone Bluetooth', price: 249.9, stock: 100, category: 'eletronicos' },
];

const usersDir = path.dirname(USERS_FILE);
let persistQueue = Promise.resolve();

async function loadJsonFile(filePath, fallback) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      await fs.writeFile(filePath, JSON.stringify(fallback, null, 2), 'utf-8');
      return fallback;
    }
    throw err;
  }
}

async function saveJsonFile(filePath, data) {
  persistQueue = persistQueue
    .then(async () => {
      await fs.mkdir(DATA_DIR, { recursive: true });
      await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
    })
    .catch((err) => {
      log('error', 'persist_failed', { event_type: 'persistence', file: filePath, error: err?.message });
    });
  return persistQueue;
}

function syncEcommerceGauges() {
  let stock = 0;
  for (const p of products.values()) stock += p.stock;
  productsStockGauge.set(stock);

  let active = 0;
  for (const cart of carts.values()) {
    if (cart.items?.length > 0) active += 1;
  }
  activeCartsGauge.set(active);
}

function getCart(userId) {
  if (!carts.has(userId)) {
    carts.set(userId, { items: [] });
  }
  return carts.get(userId);
}

function cartTotal(cart) {
  return cart.items.reduce((sum, i) => sum + i.price * i.quantity, 0);
}

async function persistCarts() {
  const payload = Object.fromEntries(
    [...carts.entries()].map(([userId, cart]) => [userId, cart])
  );
  await saveJsonFile(CARTS_FILE, payload);
  syncEcommerceGauges();
}

async function persistOrders() {
  await saveJsonFile(ORDERS_FILE, { orders });
}

async function persistProducts() {
  await saveJsonFile(PRODUCTS_FILE, { products: [...products.values()] });
  syncEcommerceGauges();
}

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
  persistQueue = persistQueue
    .then(async () => {
      await fs.mkdir(usersDir, { recursive: true });
      await fs.writeFile(USERS_FILE, JSON.stringify(serializeUsers(), null, 2), 'utf-8');
    })
    .catch((err) => {
      log('error', 'users_persist_failed', { event_type: 'persistence', error: err?.message });
    });
  return persistQueue;
}

async function loadProductsFromFile() {
  const data = await loadJsonFile(PRODUCTS_FILE, { products: DEFAULT_PRODUCTS });
  const arr = data?.products?.length ? data.products : DEFAULT_PRODUCTS;
  products.clear();
  for (const p of arr) products.set(p.id, { ...p });
  if (!data?.products?.length) await persistProducts();
  syncEcommerceGauges();
  return products.size;
}

async function loadOrdersFromFile() {
  const data = await loadJsonFile(ORDERS_FILE, { orders: [] });
  orders.length = 0;
  for (const o of data.orders || []) orders.push(o);
  return orders.length;
}

async function loadCartsFromFile() {
  const data = await loadJsonFile(CARTS_FILE, {});
  carts.clear();
  for (const [userId, cart] of Object.entries(data)) {
    carts.set(userId, cart);
  }
  syncEcommerceGauges();
  return carts.size;
}

// estado para simulação de incidentes
let errorStormActive = false;
let paymentStormActive = false;
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
  let activeCarts = 0;
  for (const cart of carts.values()) {
    if (cart.items?.length > 0) activeCarts += 1;
  }
  syncUsersOnlineGauge();
  syncOrdersPendingGauge();
  let onlineCount = 0;
  const now = Date.now();
  for (const [, ts] of onlineUsers.entries()) {
    if (now - ts < ONLINE_TTL_MS) onlineCount++;
  }
  res.json({
    status: 'ok',
    domain: 'ecommerce',
    uptime: process.uptime(),
    users: users.size,
    users_online: onlineCount,
    products: products.size,
    orders: orders.length,
    orders_pending: orders.filter((o) => o.status === 'pending').length,
    active_carts: activeCarts,
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
    touchUserOnline(user.id);
    syncUsersOnlineGauge();
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
    touchUserOnline(req.user.sub);
    syncUsersOnlineGauge();
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

// --- E-commerce: catálogo, carrinho e pedidos ---

app.get('/products', (req, res) => {
  const list = [...products.values()].map(({ id, name, price, stock, category }) => ({
    id, name, price, stock, category,
  }));
  logFromReq(req, 'info', 'catalog_viewed', { event_type: 'ecommerce', count: list.length });
  res.json(list);
});

app.get('/products/:id', (req, res) => {
  const product = products.get(req.params.id);
  if (!product) {
    logFromReq(req, 'warn', 'product_not_found', { event_type: 'ecommerce', productId: req.params.id });
    return res.status(404).json({ error: 'produto não encontrado' });
  }
  logFromReq(req, 'info', 'product_viewed', { event_type: 'ecommerce', productId: product.id, name: product.name });
  res.json({ id: product.id, name: product.name, price: product.price, stock: product.stock, category: product.category });
});

app.get('/cart', authMiddleware, (req, res) => {
  const cart = getCart(req.user.sub);
  const total = cartTotal(cart);
  logFromReq(req, 'info', 'cart_viewed', { event_type: 'ecommerce', userId: req.user.sub, items: cart.items.length, total });
  res.json({ items: cart.items, total, itemCount: cart.items.length });
});

app.post('/cart/items', authMiddleware, async (req, res) => {
  const { productId, quantity = 1 } = req.body;
  const qty = Math.max(1, Math.min(Number(quantity) || 1, 99));
  const product = products.get(productId);

  if (!product) {
    checkoutFailuresTotal.inc({ reason: 'product_not_found' });
    logFromReq(req, 'warn', 'cart_add_failed', { event_type: 'ecommerce', reason: 'product_not_found', productId });
    return res.status(404).json({ error: 'produto não encontrado' });
  }
  if (product.stock < qty) {
    checkoutFailuresTotal.inc({ reason: 'insufficient_stock' });
    logFromReq(req, 'warn', 'cart_add_failed', { event_type: 'ecommerce', reason: 'insufficient_stock', productId, stock: product.stock });
    return res.status(409).json({ error: 'estoque insuficiente', available: product.stock });
  }

  const cart = getCart(req.user.sub);
  const existing = cart.items.find((i) => i.productId === productId);
  if (existing) {
    existing.quantity += qty;
  } else {
    cart.items.push({ productId, name: product.name, price: product.price, quantity: qty });
  }
  cartAdditionsTotal.inc();
  await persistCarts();
  logFromReq(req, 'info', 'cart_item_added', {
    event_type: 'ecommerce',
    userId: req.user.sub,
    productId,
    quantity: qty,
    cartTotal: cartTotal(cart),
  });
  res.status(201).json({ items: cart.items, total: cartTotal(cart) });
});

app.delete('/cart/items/:productId', authMiddleware, async (req, res) => {
  const cart = getCart(req.user.sub);
  const before = cart.items.length;
  cart.items = cart.items.filter((i) => i.productId !== req.params.productId);
  if (cart.items.length === before) {
    return res.status(404).json({ error: 'item não está no carrinho' });
  }
  await persistCarts();
  logFromReq(req, 'info', 'cart_item_removed', { event_type: 'ecommerce', productId: req.params.productId });
  res.json({ items: cart.items, total: cartTotal(cart) });
});

app.delete('/cart', authMiddleware, async (req, res) => {
  carts.set(req.user.sub, { items: [] });
  await persistCarts();
  logFromReq(req, 'info', 'cart_cleared', { event_type: 'ecommerce', userId: req.user.sub });
  res.status(204).send();
});

app.post('/orders', authMiddleware, async (req, res) => {
  const cart = getCart(req.user.sub);

  if (!cart.items.length) {
    checkoutFailuresTotal.inc({ reason: 'empty_cart' });
    logFromReq(req, 'warn', 'checkout_failed', { event_type: 'ecommerce', reason: 'empty_cart', userId: req.user.sub });
    return res.status(400).json({ error: 'carrinho vazio' });
  }

  logFromReq(req, 'info', 'checkout_started', { event_type: 'ecommerce', userId: req.user.sub, items: cart.items.length });

  for (const item of cart.items) {
    const product = products.get(item.productId);
    if (!product || product.stock < item.quantity) {
      checkoutFailuresTotal.inc({ reason: 'stock_changed' });
      logFromReq(req, 'error', 'checkout_failed', {
        event_type: 'ecommerce',
        reason: 'stock_changed',
        productId: item.productId,
        requested: item.quantity,
        available: product?.stock ?? 0,
      });
      return res.status(409).json({ error: 'estoque insuficiente', productId: item.productId });
    }
  }

  if (instabilityMode && Math.random() > 0.6) {
    const delay = 2000 + Math.random() * 3000;
    await new Promise((r) => setTimeout(r, delay));
    checkoutFailuresTotal.inc({ reason: 'checkout_timeout' });
    applicationErrorsTotal.inc({ route: '/orders', type: 'timeout' });
    logFromReq(req, 'error', 'checkout_timeout', { event_type: 'ecommerce', delay_ms: delay });
    return res.status(504).json({ error: 'timeout no checkout' });
  }

  try {
    for (const item of cart.items) {
      products.get(item.productId).stock -= item.quantity;
    }
    await persistProducts();

    const total = cartTotal(cart);
    const order = {
      id: uuidv4(),
      userId: req.user.sub,
      items: cart.items.map((i) => ({ ...i })),
      total,
      status: 'pending',
      paymentStatus: 'processing',
      createdAt: new Date().toISOString(),
    };
    orders.push(order);
    carts.set(req.user.sub, { items: [] });
    await persistOrders();
    await persistCarts();
    syncOrdersPendingGauge();

    logFromReq(req, 'info', 'order_pending_created', {
      event_type: 'ecommerce',
      orderId: order.id,
      userId: req.user.sub,
      total,
    });

    if (paymentStormActive) {
      order.status = 'payment_failed';
      order.paymentStatus = 'failed';
      paymentsFailedTotal.inc({ reason: 'payment_storm' });
      checkoutFailuresTotal.inc({ reason: 'payment_storm' });
      applicationErrorsTotal.inc({ route: '/orders', type: 'payment_storm' });
      syncOrdersPendingGauge();
      await persistOrders();
      logFromReq(req, 'error', 'payment_failed', { event_type: 'ecommerce', orderId: order.id, reason: 'payment_storm' });
      return res.status(500).json({ error: 'falha simulada no pagamento', orderId: order.id });
    }

    await new Promise((r) => setTimeout(r, 80));
    order.status = 'confirmed';
    order.paymentStatus = 'paid';
    ordersCreatedTotal.inc({ status: 'confirmed' });
    paymentsSuccessfulTotal.inc();
    orderValueReais.observe(total);
    syncOrdersPendingGauge();
    await persistOrders();

    logFromReq(req, 'info', 'order_created', {
      event_type: 'ecommerce',
      orderId: order.id,
      userId: req.user.sub,
      total,
      itemCount: order.items.length,
    });
    logFromReq(req, 'info', 'payment_successful', {
      event_type: 'ecommerce',
      orderId: order.id,
      total,
    });

    res.status(201).json({
      id: order.id,
      total: order.total,
      status: order.status,
      paymentStatus: order.paymentStatus,
      items: order.items,
      createdAt: order.createdAt,
    });
  } catch (err) {
    checkoutFailuresTotal.inc({ reason: 'server_error' });
    applicationErrorsTotal.inc({ route: '/orders', type: 'unhandled' });
    logFromReq(req, 'error', 'checkout_failed', { event_type: 'ecommerce', reason: 'server_error', error: err.message });
    res.status(500).json({ error: 'falha no checkout' });
  }
});

app.get('/orders', authMiddleware, (req, res) => {
  const userOrders = orders
    .filter((o) => o.userId === req.user.sub)
    .map(({ id, total, status, paymentStatus, createdAt, items }) => ({
      id, total, status, paymentStatus, createdAt, itemCount: items.length,
    }));
  logFromReq(req, 'info', 'orders_listed', { event_type: 'ecommerce', userId: req.user.sub, count: userOrders.length });
  res.json(userOrders);
});

app.get('/orders/:id', authMiddleware, (req, res) => {
  const order = orders.find((o) => o.id === req.params.id && o.userId === req.user.sub);
  if (!order) {
    return res.status(404).json({ error: 'pedido não encontrado' });
  }
  logFromReq(req, 'info', 'order_viewed', { event_type: 'ecommerce', orderId: order.id });
  res.json(order);
});

// Confirmar pagamento de pedido pendente
app.post('/orders/:id/confirm', authMiddleware, async (req, res) => {
  const order = orders.find((o) => o.id === req.params.id && o.userId === req.user.sub);
  if (!order) return res.status(404).json({ error: 'pedido não encontrado' });
  if (order.status !== 'pending') return res.status(409).json({ error: 'pedido não está pendente' });

  if (paymentStormActive) {
    order.status = 'payment_failed';
    order.paymentStatus = 'failed';
    paymentsFailedTotal.inc({ reason: 'payment_storm' });
    syncOrdersPendingGauge();
    logFromReq(req, 'error', 'payment_failed', { event_type: 'ecommerce', orderId: order.id });
    return res.status(500).json({ error: 'falha no pagamento' });
  }

  order.status = 'confirmed';
  order.paymentStatus = 'paid';
  ordersCreatedTotal.inc({ status: 'confirmed' });
  paymentsSuccessfulTotal.inc();
  orderValueReais.observe(order.total);
  syncOrdersPendingGauge();
  await persistOrders();
  logFromReq(req, 'info', 'payment_successful', { event_type: 'ecommerce', orderId: order.id, total: order.total });
  res.json(order);
});

// --- Simulação (rotas GET para botões no Grafana) ---
async function internalRegisterLogin(suffix) {
  const email = `sim${suffix}@loja.com`;
  if (!users.has(email)) {
    const hash = await bcrypt.hash('senha123', 10);
    const user = {
      id: uuidv4(),
      email,
      name: `Sim ${suffix}`,
      passwordHash: hash,
      createdAt: new Date().toISOString(),
    };
    users.set(email, user);
    await persistUsersToFile();
    syncUsersGauge();
  }
  const user = users.get(email);
  touchUserOnline(user.id);
  syncUsersOnlineGauge();
  const token = jwt.sign({ sub: user.id, email }, JWT_SECRET, { expiresIn: '1h' });
  return { user, token };
}

app.get('/simulate/brute-force', async (req, res) => {
  const count = Math.min(Number(req.query.count) || 30, 100);
  for (let i = 0; i < count; i++) {
    bruteForceAttemptsTotal.inc();
    authAttemptsTotal.inc({ action: 'login', result: 'failure', reason: 'brute_force' });
    loginErrorsTotal.inc({ reason: 'brute_force' });
    try {
      await fetch(`http://127.0.0.1:${PORT}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `attacker${i}@hack.com`, password: 'wrong' }),
      });
    } catch { /* ignore */ }
  }
  logFromReq(req, 'warn', 'brute_force_simulated', { event_type: 'security', count });
  res.json({ message: `Simuladas ${count} tentativas de força bruta`, metric: 'brute_force_attempts_total' });
});

app.get('/simulate/checkout-success', async (req, res) => {
  const count = Math.min(Number(req.query.count) || 3, 10);
  const results = [];
  for (let i = 0; i < count; i++) {
    const { token } = await internalRegisterLogin(`${Date.now()}${i}`);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    await fetch(`http://127.0.0.1:${PORT}/cart/items`, {
      method: 'POST', headers, body: JSON.stringify({ productId: 'p2', quantity: 1 }),
    });
    const r = await fetch(`http://127.0.0.1:${PORT}/orders`, { method: 'POST', headers });
    results.push(r.status);
  }
  logFromReq(req, 'info', 'checkout_success_simulated', { event_type: 'ecommerce', count });
  res.json({ message: `Simuladas ${count} compras`, statuses: results });
});

app.get('/simulate/pending-orders', async (req, res) => {
  const count = Math.min(Number(req.query.count) || 5, 15);
  const created = [];
  for (let i = 0; i < count; i++) {
    const { user } = await internalRegisterLogin(`pending${Date.now()}${i}`);
    const product = products.get('p2');
    if (!product || product.stock < 1) break;
    product.stock -= 1;
    const order = {
      id: uuidv4(),
      userId: user.id,
      items: [{ productId: 'p2', name: product.name, price: product.price, quantity: 1 }],
      total: product.price,
      status: 'pending',
      paymentStatus: 'awaiting',
      createdAt: new Date().toISOString(),
    };
    orders.push(order);
    created.push(order.id);
  }
  await persistProducts();
  await persistOrders();
  syncOrdersPendingGauge();
  logFromReq(req, 'info', 'pending_orders_simulated', { event_type: 'ecommerce', count: created.length });
  res.json({ message: `Criados ${created.length} pedidos em aberto`, orderIds: created });
});

app.get('/simulate/users-online', async (req, res) => {
  const count = Math.min(Number(req.query.count) || 8, 25);
  for (let i = 0; i < count; i++) {
    await internalRegisterLogin(`online${Date.now()}${i}`);
  }
  syncUsersOnlineGauge();
  let onlineCount = 0;
  const now = Date.now();
  for (const [, ts] of onlineUsers.entries()) {
    if (now - ts < ONLINE_TTL_MS) onlineCount++;
  }
  logFromReq(req, 'info', 'users_online_simulated', { event_type: 'auth', count });
  res.json({ message: `${count} usuários marcados como online`, users_online: onlineCount });
});

app.get('/simulate/payment-storm/start', (req, res) => {
  paymentStormActive = true;
  logFromReq(req, 'warn', 'incident_started', { event_type: 'incident', incident: 'payment_storm' });
  res.json({ message: 'Pagamentos falharão (HTTP 500) por 2 minutos' });
  setTimeout(() => { paymentStormActive = false; }, 120_000);
});

app.get('/simulate/payment-storm/stop', (req, res) => {
  paymentStormActive = false;
  logFromReq(req, 'info', 'incident_stopped', { event_type: 'incident', incident: 'payment_storm' });
  res.json({ message: 'Tempestade de pagamento desativada' });
});

//simulação de incidentes
app.post('/incidents/payment-storm/start', (req, res) => {
  paymentStormActive = true;
  logFromReq(req, 'warn', 'incident_started', { event_type: 'incident', incident: 'payment_storm' });
  res.json({ message: 'Checkout retornará HTTP 500 (falha de pagamento simulada)' });
  setTimeout(() => {
    paymentStormActive = false;
    log('info', 'incident_stopped', { event_type: 'incident', incident: 'payment_storm' });
  }, 120_000);
});

app.post('/incidents/payment-storm/stop', (req, res) => {
  paymentStormActive = false;
  logFromReq(req, 'info', 'incident_stopped', { event_type: 'incident', incident: 'payment_storm', manual: true });
  res.json({ message: 'Tempestade de pagamento desativada' });
});

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
  const userCount = await loadUsersFromFile();
  const productCount = await loadProductsFromFile();
  const orderCount = await loadOrdersFromFile();
  await loadCartsFromFile();
  syncUsersGauge();
  syncEcommerceGauges();
  syncOrdersPendingGauge();
  syncUsersOnlineGauge();
  log('info', 'data_loaded', {
    event_type: 'system',
    users: userCount,
    products: productCount,
    orders: orderCount,
    dataDir: DATA_DIR,
  });

  app.listen(PORT, () => {
    log('info', 'system_startup', {
      event_type: 'system',
      domain: 'ecommerce',
      port: PORT,
      nodeVersion: process.version,
    });
  });
})();
