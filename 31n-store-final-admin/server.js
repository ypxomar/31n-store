import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadLocalEnv() {
  try {
    const raw = await fs.readFile(path.join(__dirname, ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

await loadLocalEnv();

const port = Number(process.env.PORT || 4173);
const catalog = JSON.parse(await fs.readFile(path.join(__dirname, "data/catalog.json"), "utf8"));
const databasePath = path.join(__dirname, "data/orders.sqlite");
const schemaPath = path.join(__dirname, "data/schema.sql");
const sessionHours = Math.max(1, Math.min(168, Number(process.env.SESSION_HOURS || 12)));
const cookieSecure = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
const PROMO_CODE_UNITS = [77, 79, 72, 67, 89, 51, 48];
const PROMO_RATE = 0.30;
const DELIVERY_RATE = Number(catalog.deliveryRate || 0.03);
const DEFAULT_ADMIN = {
  username: "mohyy.24",
  displayName: "Mohyy",
  role: "admin",
  salt: "bc0ab6f9ddb608171faec62e4fc02174",
  hash: "3dfc5647854f19cead228a612cb5caef6a61e52515989f1a62f3d2dae8b444bc0761123b676cd85cd979a777d19157525b960c6bd379fc13faf6439d29f33fc7"
};
const ALLOWED_STATUSES = new Set(["new", "confirmed", "preparing", "ready", "out_for_delivery", "delivered", "cancelled", "failed_delivery"]);
const COURIER_STATUSES = new Set(["out_for_delivery", "delivered", "failed_delivery"]);
const loginAttempts = new Map();

const mime = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2"
};

await fs.mkdir(path.dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
db.exec(await fs.readFile(schemaPath, "utf8"));
seedDefaultAdmin();
purgeExpiredSessions();

function seedDefaultAdmin() {
  const existing = db.prepare("SELECT id FROM staff_users WHERE username = ? COLLATE NOCASE").get(DEFAULT_ADMIN.username);
  if (existing) return;
  db.prepare(`
    INSERT INTO staff_users (username, display_name, password_salt, password_hash, role, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(DEFAULT_ADMIN.username, DEFAULT_ADMIN.displayName, DEFAULT_ADMIN.salt, DEFAULT_ADMIN.hash, DEFAULT_ADMIN.role, now(), now());
}

function now() {
  return new Date().toISOString();
}

function normalizePromoCode(value = "") {
  return String(value).trim().toUpperCase();
}

function isValidPromoCode(value) {
  const normalized = normalizePromoCode(value);
  return normalized.length === PROMO_CODE_UNITS.length && [...normalized].every((char, index) => char.charCodeAt(0) === PROMO_CODE_UNITS[index]);
}

function cleanString(value, max = 180) {
  return String(value ?? "").trim().replace(/[\u0000-\u001F\u007F]/g, "").slice(0, max);
}

function cleanUsername(value) {
  const username = cleanString(value, 40).toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw httpError(400, "Username must be 3–40 characters using letters, numbers, dots, underscores or hyphens.", "INVALID_USERNAME");
  return username;
}

function validatePassword(value) {
  const password = String(value ?? "");
  if (password.length < 12 || password.length > 128) throw httpError(400, "Password must be between 12 and 128 characters.", "INVALID_PASSWORD");
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    throw httpError(400, "Password must include uppercase, lowercase, a number and a symbol.", "INVALID_PASSWORD");
  }
  return password;
}

function hashPassword(password, saltHex = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1 }).toString("hex");
  return { salt: saltHex, hash };
}

function verifyPassword(password, saltHex, expectedHashHex) {
  try {
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), 64, { N: 16384, r: 8, p: 1 });
    const expected = Buffer.from(expectedHashHex, "hex");
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function assertCustomer(customer = {}) {
  const normalized = {
    firstName: cleanString(customer.firstName, 80),
    lastName: cleanString(customer.lastName, 80),
    email: cleanString(customer.email, 160).toLowerCase(),
    phone: cleanString(customer.phone, 40),
    address: cleanString(customer.address, 220),
    city: cleanString(customer.city, 100),
    governorate: cleanString(customer.governorate, 100),
    notes: cleanString(customer.notes, 500)
  };
  if (!normalized.firstName || !normalized.lastName || !normalized.phone || !normalized.address || !normalized.city || !normalized.governorate) {
    throw httpError(400, "Please complete all required delivery details.", "INVALID_CUSTOMER");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) throw httpError(400, "Please enter a valid email address.", "INVALID_CUSTOMER");
  return normalized;
}

function createOrderId() {
  return `N31-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
}

function buildOrder(payload) {
  if (!Array.isArray(payload?.items) || !payload.items.length || payload.items.length > 50) throw httpError(400, "Your cart is empty or invalid.", "INVALID_ORDER");
  const items = payload.items.map(item => {
    const product = catalog.products[item.slug];
    if (!product) throw httpError(400, "One of the products is no longer available.", "INVALID_ORDER");
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) throw httpError(400, `Invalid quantity for ${product.name}.`, "INVALID_ORDER");
    const color = cleanString(item.color, 60);
    const size = cleanString(item.size, 30);
    if (!product.colors.includes(color) || !product.sizes.includes(size)) throw httpError(400, `Invalid variant selected for ${product.name}.`, "INVALID_ORDER");
    return { slug: product.slug, name: product.name, color, size, qty, unitPrice: product.price, lineTotal: product.price * qty };
  });

  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  const promoValid = isValidPromoCode(payload.promoCode);
  if (payload.promoCode && !promoValid) throw httpError(400, "Invalid discount code.", "INVALID_PROMO");
  const discount = promoValid ? Math.round(subtotal * PROMO_RATE) : 0;
  const merchandiseTotal = Math.max(0, subtotal - discount);
  const delivery = Math.round(merchandiseTotal * DELIVERY_RATE);
  const total = merchandiseTotal + delivery;
  return {
    id: createOrderId(), createdAt: now(), status: "new", paymentMethod: "cod", currency: catalog.currency,
    promo: promoValid ? { code: normalizePromoCode(payload.promoCode), rate: PROMO_RATE } : null,
    customer: assertCustomer(payload.customer), items, subtotal, discount, merchandiseTotal,
    deliveryRate: DELIVERY_RATE, delivery, total
  };
}

function insertOrder(order) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO orders (
        id, created_at, updated_at, status, payment_method, currency, promo_code, promo_rate,
        customer_first_name, customer_last_name, customer_email, customer_phone, customer_address,
        customer_city, customer_governorate, customer_notes, subtotal, discount, merchandise_total,
        delivery_rate, delivery, total, cash_collected
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      order.id, order.createdAt, order.createdAt, order.status, order.paymentMethod, order.currency,
      order.promo?.code || null, order.promo?.rate || null,
      order.customer.firstName, order.customer.lastName, order.customer.email, order.customer.phone,
      order.customer.address, order.customer.city, order.customer.governorate, order.customer.notes || null,
      order.subtotal, order.discount, order.merchandiseTotal, order.deliveryRate, order.delivery, order.total
    );
    const itemStmt = db.prepare(`
      INSERT INTO order_items (order_id, slug, name, color, size, qty, unit_price, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const item of order.items) itemStmt.run(order.id, item.slug, item.name, item.color, item.size, item.qty, item.unitPrice, item.lineTotal);
    db.prepare("INSERT INTO order_events (order_id, event_type, to_status, note, created_at) VALUES (?, 'order_created', ?, ?, ?)")
      .run(order.id, order.status, "Cash-on-delivery order submitted from storefront", order.createdAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function parseCookies(req) {
  const result = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { result[key] = decodeURIComponent(value); } catch { result[key] = value; }
  }
  return result;
}

function sessionCookie(token, maxAgeSeconds) {
  return `n31_staff_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${cookieSecure ? "; Secure" : ""}`;
}

function clearSessionCookie() {
  return `n31_staff_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecure ? "; Secure" : ""}`;
}

function purgeExpiredSessions() {
  db.prepare("DELETE FROM staff_sessions WHERE expires_at <= ?").run(now());
}

function getSession(req) {
  const token = parseCookies(req).n31_staff_session;
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const row = db.prepare(`
    SELECT s.token_hash, s.csrf_token, s.expires_at, u.id, u.username, u.display_name, u.role, u.is_active
    FROM staff_sessions s JOIN staff_users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(tokenHash, now());
  if (!row || !row.is_active) return null;
  return { tokenHash, csrfToken: row.csrf_token, expiresAt: row.expires_at, user: { id: row.id, username: row.username, displayName: row.display_name, role: row.role } };
}

function requireSession(req, roles = ["admin", "courier"]) {
  const session = getSession(req);
  if (!session) throw httpError(401, "Sign in required.", "AUTH_REQUIRED");
  if (!roles.includes(session.user.role)) throw httpError(403, "You do not have access to this area.", "FORBIDDEN");
  return session;
}

function assertCsrf(req, session) {
  const supplied = String(req.headers["x-csrf-token"] || "");
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(session.csrfToken);
  if (!supplied || actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw httpError(403, "Security token expired. Refresh the page and try again.", "CSRF_FAILED");
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const createdAt = now();
  const expiresAt = new Date(Date.now() + sessionHours * 60 * 60 * 1000).toISOString();
  db.prepare("INSERT INTO staff_sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(tokenHash, userId, csrfToken, createdAt, expiresAt);
  return { token, csrfToken, expiresAt };
}

function getClientIp(req) {
  return cleanString(String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0], 80);
}

function enforceLoginRateLimit(req, username) {
  const key = `${getClientIp(req)}|${String(username).toLowerCase()}`;
  const windowMs = 15 * 60 * 1000;
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= Date.now()) {
    loginAttempts.set(key, { count: 1, resetAt: Date.now() + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > 8) throw httpError(429, "Too many login attempts. Try again later.", "RATE_LIMITED");
}

function clearLoginAttempts(req, username) {
  loginAttempts.delete(`${getClientIp(req)}|${String(username).toLowerCase()}`);
}

function httpError(status, message, code = "ERROR") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function send(res, status, body, contentType = "application/json; charset=utf-8", extraHeaders = {}) {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    ...extraHeaders
  });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end();
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw httpError(413, "Request too large", "REQUEST_TOO_LARGE");
  }
  try { return JSON.parse(body || "{}"); }
  catch { throw httpError(400, "Invalid JSON request.", "INVALID_JSON"); }
}

function orderScope(session, alias = "o") {
  return session.user.role === "courier" ? { sql: ` AND ${alias}.assigned_courier_id = ?`, args: [session.user.id] } : { sql: "", args: [] };
}

function listOrders(session, url) {
  const status = cleanString(url.searchParams.get("status"), 40);
  const q = cleanString(url.searchParams.get("q"), 100);
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") || 50)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const where = ["1=1"];
  const args = [];
  if (status && status !== "all") {
    if (!ALLOWED_STATUSES.has(status)) throw httpError(400, "Invalid status filter.", "INVALID_STATUS");
    where.push("o.status = ?"); args.push(status);
  }
  if (q) {
    where.push("(o.id LIKE ? OR o.customer_first_name LIKE ? OR o.customer_last_name LIKE ? OR o.customer_phone LIKE ? OR o.customer_email LIKE ?)");
    const like = `%${q}%`; args.push(like, like, like, like, like);
  }
  const scope = orderScope(session);
  args.push(...scope.args);
  const rows = db.prepare(`
    SELECT o.*, u.username AS courier_username, u.display_name AS courier_name,
      (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS item_lines,
      (SELECT COALESCE(SUM(qty), 0) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
    FROM orders o LEFT JOIN staff_users u ON u.id = o.assigned_courier_id
    WHERE ${where.join(" AND ")}${scope.sql}
    ORDER BY o.created_at DESC LIMIT ? OFFSET ?
  `).all(...args, limit, offset);
  const countArgs = [...args];
  const total = db.prepare(`SELECT COUNT(*) AS count FROM orders o WHERE ${where.join(" AND ")}${scope.sql}`).get(...countArgs).count;
  return { orders: rows.map(publicOrderSummary), total, limit, offset };
}

function publicOrderSummary(row) {
  return {
    id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, status: row.status, paymentMethod: row.payment_method,
    customer: { firstName: row.customer_first_name, lastName: row.customer_last_name, phone: row.customer_phone, email: row.customer_email, city: row.customer_city, governorate: row.customer_governorate },
    subtotal: row.subtotal, discount: row.discount, delivery: row.delivery, total: row.total, currency: row.currency,
    cashCollected: Boolean(row.cash_collected), itemLines: row.item_lines, itemCount: row.item_count,
    assignedCourier: row.assigned_courier_id ? { id: row.assigned_courier_id, username: row.courier_username, displayName: row.courier_name } : null
  };
}

function getOrderDetail(session, orderId) {
  const scope = orderScope(session);
  const row = db.prepare(`
    SELECT o.*, u.username AS courier_username, u.display_name AS courier_name
    FROM orders o LEFT JOIN staff_users u ON u.id = o.assigned_courier_id
    WHERE o.id = ?${scope.sql}
  `).get(orderId, ...scope.args);
  if (!row) throw httpError(404, "Order not found.", "NOT_FOUND");
  const items = db.prepare("SELECT slug, name, color, size, qty, unit_price AS unitPrice, line_total AS lineTotal FROM order_items WHERE order_id = ? ORDER BY id").all(orderId);
  const events = db.prepare(`
    SELECT e.id, e.event_type AS type, e.from_status AS fromStatus, e.to_status AS toStatus, e.note, e.created_at AS createdAt,
      u.username AS actorUsername, u.display_name AS actorName
    FROM order_events e LEFT JOIN staff_users u ON u.id = e.actor_user_id
    WHERE e.order_id = ? ORDER BY e.id DESC
  `).all(orderId);
  return {
    ...publicOrderSummary({ ...row, item_lines: items.length, item_count: items.reduce((sum, item) => sum + item.qty, 0) }),
    customer: {
      firstName: row.customer_first_name, lastName: row.customer_last_name, email: row.customer_email, phone: row.customer_phone,
      address: row.customer_address, city: row.customer_city, governorate: row.customer_governorate, notes: row.customer_notes
    },
    promoCode: row.promo_code, promoRate: row.promo_rate, merchandiseTotal: row.merchandise_total, deliveryRate: row.delivery_rate,
    internalNotes: row.internal_notes || "", items, events
  };
}

function dashboard(session) {
  const scope = orderScope(session);
  const args = scope.args;
  const statusRows = db.prepare(`SELECT status, COUNT(*) AS count, COALESCE(SUM(total), 0) AS value FROM orders o WHERE 1=1${scope.sql} GROUP BY status`).all(...args);
  const money = db.prepare(`
    SELECT
      COUNT(*) AS total_orders,
      COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','failed_delivery') THEN total ELSE 0 END), 0) AS active_order_value,
      COALESCE(SUM(CASE WHEN status = 'delivered' OR cash_collected = 1 THEN total ELSE 0 END), 0) AS collected_revenue,
      COALESCE(SUM(CASE WHEN status IN ('new','confirmed','preparing','ready','out_for_delivery') AND cash_collected = 0 THEN total ELSE 0 END), 0) AS cash_outstanding,
      COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','failed_delivery') THEN delivery ELSE 0 END), 0) AS delivery_fees,
      COALESCE(SUM(CASE WHEN status NOT IN ('cancelled','failed_delivery') THEN discount ELSE 0 END), 0) AS discounts,
      COALESCE(SUM(CASE WHEN substr(created_at,1,10) = substr(?,1,10) THEN 1 ELSE 0 END), 0) AS today_orders,
      COALESCE(SUM(CASE WHEN substr(created_at,1,10) = substr(?,1,10) AND status NOT IN ('cancelled','failed_delivery') THEN total ELSE 0 END), 0) AS today_value
    FROM orders o WHERE 1=1${scope.sql}
  `).get(now(), now(), ...args);
  return { money, statuses: Object.fromEntries(statusRows.map(row => [row.status, { count: row.count, value: row.value }])) };
}

function updateOrder(session, orderId, payload) {
  const detail = getOrderDetail(session, orderId);
  const desiredStatus = payload.status == null ? detail.status : cleanString(payload.status, 40);
  if (!ALLOWED_STATUSES.has(desiredStatus)) throw httpError(400, "Invalid order status.", "INVALID_STATUS");
  if (session.user.role === "courier" && desiredStatus !== detail.status && !COURIER_STATUSES.has(desiredStatus)) throw httpError(403, "Couriers can only mark an assigned order out for delivery, delivered or failed delivery.", "FORBIDDEN");

  let assignedCourierId = detail.assignedCourier?.id || null;
  if (session.user.role === "admin" && Object.hasOwn(payload, "assignedCourierId")) {
    assignedCourierId = payload.assignedCourierId == null || payload.assignedCourierId === "" ? null : Number(payload.assignedCourierId);
    if (assignedCourierId != null) {
      const courier = db.prepare("SELECT id FROM staff_users WHERE id = ? AND role = 'courier' AND is_active = 1").get(assignedCourierId);
      if (!courier) throw httpError(400, "Selected courier is not active.", "INVALID_COURIER");
    }
  }
  if (session.user.role === "courier" && assignedCourierId !== session.user.id) throw httpError(403, "This order is not assigned to you.", "FORBIDDEN");

  const notes = session.user.role === "admin" && Object.hasOwn(payload, "internalNotes") ? cleanString(payload.internalNotes, 2000) : detail.internalNotes;
  let cashCollected = Object.hasOwn(payload, "cashCollected") ? Boolean(payload.cashCollected) : detail.cashCollected;
  if (desiredStatus === "delivered") cashCollected = true;
  if (["cancelled", "failed_delivery"].includes(desiredStatus)) cashCollected = false;
  const timestamp = now();

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE orders SET status = ?, assigned_courier_id = ?, internal_notes = ?, cash_collected = ?, updated_at = ?,
      confirmed_at = CASE WHEN ? = 'confirmed' AND confirmed_at IS NULL THEN ? ELSE confirmed_at END,
      dispatched_at = CASE WHEN ? = 'out_for_delivery' AND dispatched_at IS NULL THEN ? ELSE dispatched_at END,
      delivered_at = CASE WHEN ? = 'delivered' AND delivered_at IS NULL THEN ? ELSE delivered_at END,
      cancelled_at = CASE WHEN ? IN ('cancelled','failed_delivery') AND cancelled_at IS NULL THEN ? ELSE cancelled_at END
      WHERE id = ?`).run(
        desiredStatus, assignedCourierId, notes || null, cashCollected ? 1 : 0, timestamp,
        desiredStatus, timestamp, desiredStatus, timestamp, desiredStatus, timestamp, desiredStatus, timestamp, orderId
      );
    if (desiredStatus !== detail.status) {
      db.prepare("INSERT INTO order_events (order_id, event_type, from_status, to_status, note, actor_user_id, created_at) VALUES (?, 'status_changed', ?, ?, ?, ?, ?)")
        .run(orderId, detail.status, desiredStatus, cleanString(payload.note, 500) || null, session.user.id, timestamp);
    }
    if ((detail.assignedCourier?.id || null) !== assignedCourierId) {
      db.prepare("INSERT INTO order_events (order_id, event_type, note, actor_user_id, created_at) VALUES (?, 'courier_assigned', ?, ?, ?)")
        .run(orderId, assignedCourierId ? `Assigned courier user ID ${assignedCourierId}` : "Courier assignment removed", session.user.id, timestamp);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return getOrderDetail(session, orderId);
}

function listStaffUsers() {
  return db.prepare(`SELECT id, username, display_name AS displayName, role, is_active AS isActive, created_at AS createdAt, last_login_at AS lastLoginAt FROM staff_users ORDER BY role, username`).all()
    .map(user => ({ ...user, isActive: Boolean(user.isActive) }));
}

function createStaffUser(payload) {
  const username = cleanUsername(payload.username);
  const displayName = cleanString(payload.displayName, 80) || username;
  const role = payload.role === "admin" ? "admin" : "courier";
  const password = validatePassword(payload.password);
  const { salt, hash } = hashPassword(password);
  try {
    const result = db.prepare(`INSERT INTO staff_users (username, display_name, password_salt, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(username, displayName, salt, hash, role, now(), now());
    return db.prepare("SELECT id, username, display_name AS displayName, role, is_active AS isActive, created_at AS createdAt FROM staff_users WHERE id = ?").get(result.lastInsertRowid);
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) throw httpError(409, "That username already exists.", "USERNAME_EXISTS");
    throw error;
  }
}

function updateStaffUser(actor, userId, payload) {
  const target = db.prepare("SELECT * FROM staff_users WHERE id = ?").get(userId);
  if (!target) throw httpError(404, "Worker account not found.", "NOT_FOUND");
  if (target.id === actor.id && payload.isActive === false) throw httpError(400, "You cannot disable your own account.", "INVALID_ACTION");
  const displayName = Object.hasOwn(payload, "displayName") ? cleanString(payload.displayName, 80) || target.username : target.display_name;
  const role = Object.hasOwn(payload, "role") ? (payload.role === "admin" ? "admin" : "courier") : target.role;
  const isActive = Object.hasOwn(payload, "isActive") ? (payload.isActive ? 1 : 0) : target.is_active;
  let salt = target.password_salt;
  let hash = target.password_hash;
  if (payload.password) ({ salt, hash } = hashPassword(validatePassword(payload.password)));
  db.prepare("UPDATE staff_users SET display_name = ?, role = ?, is_active = ?, password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?")
    .run(displayName, role, isActive, salt, hash, now(), userId);
  if (!isActive || payload.password) db.prepare("DELETE FROM staff_sessions WHERE user_id = ?").run(userId);
  return db.prepare("SELECT id, username, display_name AS displayName, role, is_active AS isActive, created_at AS createdAt, last_login_at AS lastLoginAt FROM staff_users WHERE id = ?").get(userId);
}

async function serveStatic(req, res, url) {
  let requestPath = decodeURIComponent(url.pathname);
  if (requestPath === "/") requestPath = "/index.html";
  const session = getSession(req);
  if (requestPath === "/admin.html" && (!session || session.user.role !== "admin")) return redirect(res, "/staff-login.html");
  if (requestPath === "/courier.html" && !session) return redirect(res, "/staff-login.html");
  if (requestPath === "/staff-login.html" && session) return redirect(res, session.user.role === "admin" ? "/admin.html" : "/courier.html");
  const isPublicAsset = requestPath.startsWith("/assets/");
  const isPublicPage = /^\/[A-Za-z0-9_-]+\.html$/.test(requestPath);
  if (!isPublicAsset && !isPublicPage) return send(res, 404, "Not found", "text/plain; charset=utf-8");
  const filePath = path.normalize(path.join(__dirname, requestPath));
  if (!filePath.startsWith(__dirname)) return send(res, 403, "Forbidden", "text/plain; charset=utf-8");
  const data = await fs.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    "Content-Type": mime[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'"
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true, brand: "31°N", database: "sqlite", paymentMethod: "cash_on_delivery" });
    }

    if (req.method === "POST" && url.pathname === "/api/orders/cod") {
      const order = buildOrder(await readJson(req));
      insertOrder(order);
      return send(res, 201, { ok: true, order: { id: order.id, status: order.status, paymentMethod: order.paymentMethod, subtotal: order.subtotal, discount: order.discount, delivery: order.delivery, total: order.total, currency: order.currency } });
    }

    if (req.method === "POST" && url.pathname === "/api/staff/login") {
      const payload = await readJson(req);
      const username = cleanString(payload.username, 40).toLowerCase();
      enforceLoginRateLimit(req, username);
      const user = db.prepare("SELECT * FROM staff_users WHERE username = ? COLLATE NOCASE").get(username);
      if (!user || !user.is_active || !verifyPassword(payload.password, user.password_salt, user.password_hash)) throw httpError(401, "Invalid username or password.", "INVALID_LOGIN");
      clearLoginAttempts(req, username);
      db.prepare("DELETE FROM staff_sessions WHERE user_id = ? AND expires_at <= ?").run(user.id, now());
      const session = createSession(user.id);
      db.prepare("UPDATE staff_users SET last_login_at = ?, updated_at = ? WHERE id = ?").run(now(), now(), user.id);
      return send(res, 200, { ok: true, user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role }, redirect: user.role === "admin" ? "/admin.html" : "/courier.html" }, undefined, { "Set-Cookie": sessionCookie(session.token, sessionHours * 3600) });
    }

    if (req.method === "GET" && url.pathname === "/api/staff/me") {
      const session = requireSession(req);
      return send(res, 200, { user: session.user, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    }

    if (req.method === "POST" && url.pathname === "/api/staff/logout") {
      const session = requireSession(req);
      assertCsrf(req, session);
      db.prepare("DELETE FROM staff_sessions WHERE token_hash = ?").run(session.tokenHash);
      return send(res, 200, { ok: true }, undefined, { "Set-Cookie": clearSessionCookie() });
    }

    if (req.method === "POST" && url.pathname === "/api/staff/change-password") {
      const session = requireSession(req);
      assertCsrf(req, session);
      const payload = await readJson(req);
      const user = db.prepare("SELECT * FROM staff_users WHERE id = ?").get(session.user.id);
      if (!verifyPassword(payload.currentPassword, user.password_salt, user.password_hash)) throw httpError(400, "Current password is incorrect.", "INVALID_PASSWORD");
      const { salt, hash } = hashPassword(validatePassword(payload.newPassword));
      db.prepare("UPDATE staff_users SET password_salt = ?, password_hash = ?, updated_at = ? WHERE id = ?").run(salt, hash, now(), user.id);
      db.prepare("DELETE FROM staff_sessions WHERE user_id = ? AND token_hash <> ?").run(user.id, session.tokenHash);
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/staff/dashboard") {
      const session = requireSession(req);
      return send(res, 200, dashboard(session));
    }

    if (req.method === "GET" && url.pathname === "/api/staff/orders") {
      const session = requireSession(req);
      return send(res, 200, listOrders(session, url));
    }

    const orderMatch = url.pathname.match(/^\/api\/staff\/orders\/([^/]+)$/);
    if (orderMatch && req.method === "GET") {
      const session = requireSession(req);
      return send(res, 200, { order: getOrderDetail(session, cleanString(orderMatch[1], 100)) });
    }
    if (orderMatch && req.method === "PATCH") {
      const session = requireSession(req);
      assertCsrf(req, session);
      return send(res, 200, { order: updateOrder(session, cleanString(orderMatch[1], 100), await readJson(req)) });
    }

    if (req.method === "GET" && url.pathname === "/api/staff/users") {
      requireSession(req, ["admin"]);
      return send(res, 200, { users: listStaffUsers() });
    }
    if (req.method === "POST" && url.pathname === "/api/staff/users") {
      const session = requireSession(req, ["admin"]);
      assertCsrf(req, session);
      return send(res, 201, { user: createStaffUser(await readJson(req)) });
    }
    const userMatch = url.pathname.match(/^\/api\/staff\/users\/(\d+)$/);
    if (userMatch && req.method === "PATCH") {
      const session = requireSession(req, ["admin"]);
      assertCsrf(req, session);
      return send(res, 200, { user: updateStaffUser(session.user, Number(userMatch[1]), await readJson(req)) });
    }

    if (!["GET", "HEAD"].includes(req.method)) return send(res, 405, { message: "Method not allowed" });
    return await serveStatic(req, res, url);
  } catch (error) {
    if (error.code === "ENOENT") return send(res, 404, "Not found", "text/plain; charset=utf-8");
    const status = Number.isInteger(error.status) ? error.status : error.code?.startsWith("INVALID_") ? 400 : 500;
    if (status >= 500) console.error(error);
    return send(res, status, { message: error.message || "Server error", code: error.code || "SERVER_ERROR" });
  }
});

server.listen(port, "0.0.0.0", () => console.log(`31°N store running at http://localhost:${port}`));
