(() => {
  "use strict";

  const page = document.body.dataset.staffPage;
  const state = { user: null, csrfToken: "", couriers: [], openOrderId: null };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const formatMoney = value => new Intl.NumberFormat("en-EG", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(Number(value || 0));
  const statusLabels = {
    new: "New", confirmed: "Confirmed", preparing: "Preparing", ready: "Ready",
    out_for_delivery: "Out for delivery", delivered: "Delivered", cancelled: "Cancelled", failed_delivery: "Failed delivery"
  };

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
  }

  function notice(element, message, type = "error") {
    if (!element) return;
    element.textContent = message;
    element.className = `staff-notice is-visible is-${type}`;
  }

  async function api(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (state.csrfToken && options.method && options.method !== "GET") headers["X-CSRF-Token"] = state.csrfToken;
    const response = await fetch(url, { credentials: "same-origin", ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    const result = contentType.includes("application/json") ? await response.json() : { message: await response.text() };
    if (response.status === 401) {
      if (page !== "login") location.href = "/staff-login.html";
      throw new Error(result.message || "Sign in required.");
    }
    if (!response.ok) throw new Error(result.message || "Request failed.");
    return result;
  }

  async function initLogin() {
    const form = $("[data-login-form]");
    form?.addEventListener("submit", async event => {
      event.preventDefault();
      const button = $("button[type=submit]", form);
      const output = $("[data-login-notice]");
      button.disabled = true;
      button.textContent = "Signing in…";
      output.className = "staff-notice";
      try {
        const data = Object.fromEntries(new FormData(form).entries());
        const result = await api("/api/staff/login", { method: "POST", body: JSON.stringify(data) });
        location.href = result.redirect;
      } catch (error) {
        notice(output, error.message);
        button.disabled = false;
        button.textContent = "Sign in";
      }
    });
  }

  async function initDashboard() {
    const me = await api("/api/staff/me");
    state.user = me.user;
    state.csrfToken = me.csrfToken;
    const label = $("[data-user-label]");
    if (label) label.textContent = `${state.user.displayName || state.user.username} / ${state.user.role}`;
    if (page === "admin" && state.user.role !== "admin") { location.href = "/courier.html"; return; }
    if (page === "admin") await loadWorkers();
    await refreshDashboard();
    bindDashboardEvents();
  }

  async function refreshDashboard() {
    const [dashboardData, ordersData] = await Promise.all([api("/api/staff/dashboard"), loadOrdersData()]);
    renderMetrics(dashboardData.money);
    renderStatuses(dashboardData.statuses);
    renderOrders(ordersData.orders);
  }

  async function loadOrdersData() {
    const status = $("[data-order-status]")?.value || "all";
    const q = $("[data-order-search]")?.value.trim() || "";
    return api(`/api/staff/orders?status=${encodeURIComponent(status)}&q=${encodeURIComponent(q)}&limit=100`);
  }

  function renderMetrics(money) {
    const target = $("[data-metrics]");
    if (!target) return;
    const metrics = page === "courier"
      ? [
          ["Assigned orders", money.total_orders], ["Outstanding cash", formatMoney(money.cash_outstanding)],
          ["Collected", formatMoney(money.collected_revenue)], ["Today orders", money.today_orders],
          ["Today value", formatMoney(money.today_value)], ["Delivery value", formatMoney(money.delivery_fees)]
        ]
      : [
          ["All orders", money.total_orders], ["Active value", formatMoney(money.active_order_value)],
          ["Collected revenue", formatMoney(money.collected_revenue)], ["Cash outstanding", formatMoney(money.cash_outstanding)],
          ["Delivery fees", formatMoney(money.delivery_fees)], ["Discounts", formatMoney(money.discounts)]
        ];
    target.innerHTML = metrics.map(([label, value]) => `<article class="metric-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
  }

  function renderStatuses(statuses) {
    const target = $("[data-statuses]");
    if (!target) return;
    const allowed = page === "courier" ? ["ready", "out_for_delivery", "delivered", "failed_delivery"] : Object.keys(statusLabels);
    target.innerHTML = allowed.map(status => `<article class="status-card" data-status="${status}"><span>${statusLabels[status]}</span><strong>${Number(statuses[status]?.count || 0)}</strong></article>`).join("");
  }

  function statusPill(status) {
    return `<span class="status-pill status-pill--${escapeHtml(status)}">${escapeHtml(statusLabels[status] || status)}</span>`;
  }

  function renderOrders(orders) {
    const empty = $("[data-orders-empty]");
    if (empty) empty.hidden = orders.length > 0;
    if (page === "courier") return renderCourierOrders(orders);
    const body = $("[data-orders-body]");
    if (!body) return;
    body.innerHTML = orders.map(order => `<tr>
      <td><div class="order-id">${escapeHtml(order.id)}</div><div class="staff-muted staff-small">${formatDate(order.createdAt)}</div></td>
      <td class="order-customer"><strong>${escapeHtml(order.customer.firstName)} ${escapeHtml(order.customer.lastName)}</strong><span>${escapeHtml(order.customer.phone)} / ${escapeHtml(order.customer.governorate)}</span></td>
      <td>${statusPill(order.status)}</td>
      <td>${order.assignedCourier ? escapeHtml(order.assignedCourier.displayName || order.assignedCourier.username) : '<span class="staff-muted">Unassigned</span>'}</td>
      <td>${Number(order.itemCount)} item${Number(order.itemCount) === 1 ? "" : "s"}</td>
      <td><strong>${formatMoney(order.total)}</strong>${order.cashCollected ? '<div class="staff-muted staff-small">Collected</div>' : ''}</td>
      <td><button class="staff-link-button" data-view-order="${escapeHtml(order.id)}">View</button></td>
    </tr>`).join("");
  }

  function renderCourierOrders(orders) {
    const target = $("[data-courier-orders]");
    if (!target) return;
    target.innerHTML = orders.map(order => `<article class="courier-order">
      <div class="courier-order-top"><div><h3>${escapeHtml(order.customer.firstName)} ${escapeHtml(order.customer.lastName)}</h3><div class="order-id">${escapeHtml(order.id)}</div></div>${statusPill(order.status)}</div>
      <address>${escapeHtml(order.customer.city)}, ${escapeHtml(order.customer.governorate)}<br>${escapeHtml(order.customer.phone)}</address>
      <div>${Number(order.itemCount)} item${Number(order.itemCount) === 1 ? "" : "s"}</div>
      <div class="cash-box"><span>Collect</span><strong>${formatMoney(order.total)}</strong></div>
      <div class="courier-order-actions"><button class="staff-button staff-button--secondary" data-view-order="${escapeHtml(order.id)}">Details</button>${courierQuickActions(order)}</div>
    </article>`).join("");
  }

  function courierQuickActions(order) {
    if (order.status === "ready") return `<button class="staff-button" data-quick-status="out_for_delivery" data-order-id="${escapeHtml(order.id)}">Start delivery</button>`;
    if (order.status === "out_for_delivery") return `<button class="staff-button" data-quick-status="delivered" data-order-id="${escapeHtml(order.id)}">Delivered</button><button class="staff-button staff-button--secondary" data-quick-status="failed_delivery" data-order-id="${escapeHtml(order.id)}">Failed</button>`;
    return "";
  }

  async function openOrder(orderId) {
    const { order } = await api(`/api/staff/orders/${encodeURIComponent(orderId)}`);
    state.openOrderId = order.id;
    $("[data-order-title]").textContent = order.id;
    $("[data-order-detail]").innerHTML = renderOrderDetail(order);
    $("[data-order-drawer]").classList.add("is-open");
    document.body.style.overflow = "hidden";
  }

  function renderOrderDetail(order) {
    const courierOptions = [`<option value="">Unassigned</option>`, ...state.couriers.map(user => `<option value="${user.id}" ${order.assignedCourier?.id === user.id ? "selected" : ""}>${escapeHtml(user.displayName || user.username)}</option>`)].join("");
    const adminControls = state.user.role === "admin" ? `<div class="order-control detail-card detail-card--full">
      <div class="control-row"><label>Status<select data-detail-status>${Object.entries(statusLabels).map(([value,label]) => `<option value="${value}" ${value === order.status ? "selected" : ""}>${label}</option>`).join("")}</select></label><label>Courier<select data-detail-courier>${courierOptions}</select></label></div>
      <label>Internal notes<textarea data-detail-notes rows="4">${escapeHtml(order.internalNotes || "")}</textarea></label>
      <label class="check-row"><input type="checkbox" data-detail-cash ${order.cashCollected ? "checked" : ""}> Cash has been collected</label>
      <button class="staff-button" data-save-order>Save order changes</button><div class="staff-notice" data-order-notice></div>
    </div>` : `<div class="order-control detail-card detail-card--full"><div class="courier-order-actions">${order.status === "ready" ? `<button class="staff-button" data-quick-status="out_for_delivery" data-order-id="${escapeHtml(order.id)}">Start delivery</button>` : ""}${order.status === "out_for_delivery" ? `<button class="staff-button" data-quick-status="delivered" data-order-id="${escapeHtml(order.id)}">Mark delivered</button><button class="staff-button staff-button--secondary" data-quick-status="failed_delivery" data-order-id="${escapeHtml(order.id)}">Failed delivery</button>` : ""}</div></div>`;

    return `<div class="detail-grid">
      <section class="detail-card"><div class="detail-label">Customer</div><h3>${escapeHtml(order.customer.firstName)} ${escapeHtml(order.customer.lastName)}</h3><p><a href="tel:${escapeHtml(order.customer.phone)}">${escapeHtml(order.customer.phone)}</a></p><p><a href="mailto:${escapeHtml(order.customer.email)}">${escapeHtml(order.customer.email)}</a></p></section>
      <section class="detail-card"><div class="detail-label">Delivery address</div><h3>${escapeHtml(order.customer.governorate)}</h3><p>${escapeHtml(order.customer.address)}<br>${escapeHtml(order.customer.city)}, ${escapeHtml(order.customer.governorate)}</p>${order.customer.notes ? `<p><strong>Customer note:</strong> ${escapeHtml(order.customer.notes)}</p>` : ""}</section>
      <section class="detail-card detail-card--full"><div class="detail-label">Items</div>${order.items.map(item => `<div class="order-item-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.color)} / ${escapeHtml(item.size)} / Qty ${Number(item.qty)}</small></div><strong>${formatMoney(item.lineTotal)}</strong></div>`).join("")}</section>
      <section class="detail-card"><div class="detail-label">Money</div><div class="money-list"><div class="money-row"><span>Subtotal</span><span>${formatMoney(order.subtotal)}</span></div>${order.discount ? `<div class="money-row"><span>Discount</span><span>−${formatMoney(order.discount)}</span></div>` : ""}<div class="money-row"><span>Delivery</span><span>${formatMoney(order.delivery)}</span></div><div class="money-row money-row--total"><strong>COD total</strong><strong>${formatMoney(order.total)}</strong></div></div></section>
      <section class="detail-card"><div class="detail-label">Status</div><h3>${statusLabels[order.status] || order.status}</h3><p>Courier: ${order.assignedCourier ? escapeHtml(order.assignedCourier.displayName || order.assignedCourier.username) : "Unassigned"}</p><p>Cash: ${order.cashCollected ? "Collected" : "Outstanding"}</p><p>Created: ${formatDate(order.createdAt)}</p></section>
      ${adminControls}
      <section class="detail-card detail-card--full"><div class="detail-label">History</div><div class="event-list">${order.events.length ? order.events.map(event => `<div class="event-row"><strong>${escapeHtml(event.type.replaceAll("_", " "))}</strong> ${event.fromStatus && event.toStatus ? `${escapeHtml(statusLabels[event.fromStatus] || event.fromStatus)} → ${escapeHtml(statusLabels[event.toStatus] || event.toStatus)}` : ""}<br>${formatDate(event.createdAt)}${event.actorUsername ? ` / ${escapeHtml(event.actorName || event.actorUsername)}` : ""}${event.note ? `<br>${escapeHtml(event.note)}` : ""}</div>`).join("") : '<div class="staff-muted">No history yet.</div>'}</div></section>
    </div>`;
  }

  async function saveOpenOrder() {
    if (!state.openOrderId) return;
    const output = $("[data-order-notice]");
    const payload = {
      status: $("[data-detail-status]")?.value,
      assignedCourierId: $("[data-detail-courier]")?.value || null,
      internalNotes: $("[data-detail-notes]")?.value || "",
      cashCollected: Boolean($("[data-detail-cash]")?.checked)
    };
    try {
      await api(`/api/staff/orders/${encodeURIComponent(state.openOrderId)}`, { method: "PATCH", body: JSON.stringify(payload) });
      notice(output, "Order updated.", "success");
      await refreshDashboard();
      await openOrder(state.openOrderId);
    } catch (error) { notice(output, error.message); }
  }

  async function quickStatus(orderId, status) {
    try {
      await api(`/api/staff/orders/${encodeURIComponent(orderId)}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await refreshDashboard();
      if ($("[data-order-drawer]")?.classList.contains("is-open")) await openOrder(orderId);
    } catch (error) { alert(error.message); }
  }

  function closeOrder() {
    $("[data-order-drawer]")?.classList.remove("is-open");
    document.body.style.overflow = "";
    state.openOrderId = null;
  }

  async function loadWorkers() {
    const { users } = await api("/api/staff/users");
    state.couriers = users.filter(user => user.role === "courier" && user.isActive);
    renderWorkers(users);
  }

  function renderWorkers(users) {
    const target = $("[data-worker-list]");
    if (!target) return;
    target.innerHTML = users.map(user => `<article class="worker-row"><div><strong>${escapeHtml(user.displayName || user.username)}</strong><div class="worker-meta">${escapeHtml(user.username)} / ${escapeHtml(user.role)} / ${user.isActive ? "Active" : "Disabled"}${user.lastLoginAt ? ` / Last login ${formatDate(user.lastLoginAt)}` : ""}</div></div><div class="worker-actions"><button class="staff-link-button" data-reset-worker="${user.id}">Reset password</button><button class="staff-link-button" data-toggle-worker="${user.id}" data-active="${user.isActive}">${user.isActive ? "Disable" : "Enable"}</button></div></article>`).join("");
  }

  async function createWorker(form) {
    const output = $("[data-worker-notice]");
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      await api("/api/staff/users", { method: "POST", body: JSON.stringify(payload) });
      form.reset();
      notice(output, "Worker account created.", "success");
      await loadWorkers();
    } catch (error) { notice(output, error.message); }
  }

  async function toggleWorker(userId, currentActive) {
    try {
      await api(`/api/staff/users/${userId}`, { method: "PATCH", body: JSON.stringify({ isActive: !currentActive }) });
      await loadWorkers();
    } catch (error) { alert(error.message); }
  }

  async function resetWorkerPassword(userId) {
    const password = prompt("Enter a new temporary password (12+ characters with uppercase, lowercase, number and symbol):");
    if (!password) return;
    try {
      await api(`/api/staff/users/${userId}`, { method: "PATCH", body: JSON.stringify({ password }) });
      alert("Password reset. Existing sessions for that worker were signed out.");
    } catch (error) { alert(error.message); }
  }

  async function changeOwnPassword(form) {
    const output = $("[data-password-notice]", form.parentElement) || $("[data-password-notice]");
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.newPassword !== data.confirmPassword) return notice(output, "New passwords do not match.");
    try {
      await api("/api/staff/change-password", { method: "POST", body: JSON.stringify({ currentPassword: data.currentPassword, newPassword: data.newPassword }) });
      form.reset();
      notice(output, "Password updated.", "success");
    } catch (error) { notice(output, error.message); }
  }

  function formatDate(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("en-EG", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  }

  function bindDashboardEvents() {
    document.addEventListener("click", async event => {
      const target = event.target.closest("button, [data-section-button]");
      if (!target) return;
      if (target.matches("[data-logout]")) {
        try { await api("/api/staff/logout", { method: "POST", body: "{}" }); } finally { location.href = "/staff-login.html"; }
      }
      if (target.matches("[data-refresh], [data-order-filter]")) await refreshDashboard();
      if (target.matches("[data-view-order]")) await openOrder(target.dataset.viewOrder);
      if (target.matches("[data-close-order]")) closeOrder();
      if (target.matches("[data-save-order]")) await saveOpenOrder();
      if (target.matches("[data-quick-status]")) await quickStatus(target.dataset.orderId, target.dataset.quickStatus);
      if (target.matches("[data-reload-workers]")) await loadWorkers();
      if (target.matches("[data-toggle-worker]")) await toggleWorker(Number(target.dataset.toggleWorker), target.dataset.active === "true");
      if (target.matches("[data-reset-worker]")) await resetWorkerPassword(Number(target.dataset.resetWorker));
      if (target.matches("[data-section-button]")) {
        const section = target.dataset.sectionButton;
        $$('[data-section-button]').forEach(button => button.classList.toggle('is-active', button === target));
        $$('[data-section]').forEach(panel => panel.hidden = panel.dataset.section !== section);
      }
    });
    $("[data-order-drawer]")?.addEventListener("click", event => { if (event.target === event.currentTarget) closeOrder(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape") closeOrder(); });
    document.addEventListener("submit", async event => {
      if (event.target.matches("[data-worker-form]")) { event.preventDefault(); await createWorker(event.target); }
      if (event.target.matches("[data-password-form]")) { event.preventDefault(); await changeOwnPassword(event.target); }
    });
    $("[data-order-search]")?.addEventListener("keydown", event => { if (event.key === "Enter") refreshDashboard(); });
  }

  if (page === "login") initLogin();
  else initDashboard().catch(error => {
    console.error(error);
    if (!document.body.textContent.includes("Sign in")) alert(error.message);
  });
})();
