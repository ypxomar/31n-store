# 31°N Storefront + Private Operations Dashboard

A responsive 31°N storefront with cash-on-delivery checkout, a private SQLite order database, and role-based dashboards for admins and couriers.

## Included

### Storefront

- Home, shop, product, collection, lookbook and policy pages
- Product colours connected to the correct imagery
- Cart and checkout
- Hidden `MOHCY30` discount support
- 3% delivery charge calculated after discounts
- Cash on delivery only
- Server-side validation of product prices, colours, sizes, quantities and totals

### Private staff system

- Staff login page: `/staff-login.html`
- Admin dashboard: `/admin.html`
- Courier dashboard: `/courier.html`
- Dashboard totals for order value, collected cash, outstanding cash, delivery fees and discounts
- Search and status filters
- Full customer, address, item and money details
- Order status workflow:
  - New
  - Confirmed
  - Preparing
  - Ready
  - Out for delivery
  - Delivered
  - Failed delivery
  - Cancelled
- Courier assignment
- Cash-collected tracking
- Internal admin notes
- Order event history
- Admin creation, password reset, role selection and disabling of worker accounts
- Personal password-change page for every worker

## Database

Orders and staff accounts are stored in:

```text
data/orders.sqlite
```

The database schema is also included as:

```text
data/schema.sql
```

The supplied first account is seeded as an **admin** under the username `mohyy.24`. Its password is stored only as a salted scrypt hash, never as readable text.

## Run locally

Node.js **22.5 or newer** is required because the project uses Node's built-in SQLite module.

```bash
npm start
```

Open:

```text
http://localhost:4173
```

The staff login is:

```text
http://localhost:4173/staff-login.html
```

There are no third-party npm dependencies.

## Environment settings

Copy `.env.example` to `.env` when needed:

```env
PORT=4173
NODE_ENV=development
COOKIE_SECURE=false
SESSION_HOURS=12
```

For a live HTTPS deployment, use:

```env
NODE_ENV=production
COOKIE_SECURE=true
```

## Security included

- Passwords hashed with scrypt and unique salts
- Random server-side sessions stored in SQLite
- HttpOnly and SameSite session cookies
- Secure cookies in production
- CSRF tokens on staff changes
- Role-based server authorization
- Admin page blocked for courier accounts
- Courier order access limited to assigned orders
- Login rate limiting
- Security response headers
- Server-side order and price validation
- No MyFatoorah or Printlet code, keys or endpoints

## Deployment warning

The SQLite file must live on **persistent storage**. Some hosts erase the local filesystem when an app restarts or redeploys. Mount a persistent disk and keep `data/orders.sqlite` on it, then back it up regularly.

Do not place the database inside a publicly served folder or upload it as a downloadable asset. The included server never exposes the `data` directory through HTTP.

## Adding workers

1. Sign in as an admin.
2. Open **Workers**.
3. Enter a display name, username, role and temporary password.
4. Give the credentials privately to the worker.
5. The worker can change their password in the dashboard.

Couriers see only orders assigned to them. Admins can see and manage all orders.

## Product data

- Browser catalog: `assets/js/store-data.js`
- Server validation catalog: `data/catalog.json`

When changing a product price, colour or size, update both files.
