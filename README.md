# Kawama API

Express/TypeScript backend for the Kawama customer storefront. It exposes a public catalog and approved reviews while protecting product, category, review-moderation, and media operations with a database-backed administrator account and JWT bearer tokens.

## Local setup

1. Copy `.env.example` to `.env` and fill in MongoDB Atlas, administrator bootstrap, JWT, and Cloudinary values.
2. Temporarily set `ADMIN_EMAIL` and `ADMIN_PASSWORD`, then run `npm install` and `npm run seed:admin` once to create or update the owner account with a bcrypt password hash. Remove `ADMIN_PASSWORD` from `.env` after the command succeeds; the running API reads the hash from MongoDB.
3. Run `npm run dev`. Nodemon restarts the TypeScript server when files in `src` change.
4. Open `http://localhost:3000/openapi.json` for the OpenAPI 3.1 contract.

Opening `http://localhost:3000/` now returns a small success response, matching the structure used by `slipper-api-updated`.

Useful checks:

```text
npm run typecheck
npm test
npm run build
npm run seed:admin
npm run seed:dry-run
npm run seed
```

The seed command imports the existing four categories, twelve products, and six approved reviews. Existing Cloudinary images and MongoDB records are reused by slug, so the command is safe to rerun.

## Postman authentication

Send a `POST` request to `http://localhost:3000/api/admin/login` with a JSON body containing the login and password used when the owner account was seeded:

```json
{
  "email": "your-admin-login",
  "password": "your-admin-password"
}
```

Copy `data.token` from the response. In Postman, choose **Authorization → Bearer Token** for an admin request and paste that token. For example, `GET http://localhost:3000/api/v1/admin/products` should then return the admin product list. Tokens expire after `JWT_EXPIRES_IN` seconds.

The simpler Slipper-style storefront routes are `GET /api/product`, `GET /api/product/categories`, and `GET /api/product/:slug`. Product mutations are `POST /api/product`, `PUT /api/product/:id`, and `DELETE /api/product/:id` with the same bearer token. Existing `/api/v1` routes remain available for the Angular storefront.

Alternatively, import `postman/Kawama API.postman_collection.json`, set its `adminPassword` collection variable, and run **Admin Login** first. The collection stores the returned token automatically and includes public checks plus category/product CRUD requests. The included create requests use fixed test slugs, so archive or rename old test records before rerunning them.

## Uploads

For product media, call `POST /api/v1/admin/uploads/signature`, upload directly to Cloudinary with the returned values, then store the returned `secure_url` and `public_id` in the product payload. Asset deletion is rejected while a category or product references it.

## Paystack checkout

Configure `PAYSTACK_SECRET_KEY` and `PAYSTACK_CALLBACK_URL` on the API. The secret key is server-only and must never be placed in Angular source or returned by an endpoint. `PAYSTACK_PUBLIC_KEY` is recorded for the later storefront integration, although the current backend-first flow opens Paystack using the returned access code.

Create a checkout with `POST /api/v1/checkout/sessions`. Send a fresh UUID-like value in the `Idempotency-Key` header and the customer/cart payload in the body. The API recalculates prices from MongoDB, reserves stock for 30 minutes, creates the order, and returns Paystack's `accessCode`. Reusing the same idempotency key returns the same checkout without reserving stock twice.

The storefront can poll `GET /api/v1/checkout/sessions/:checkoutToken`. This endpoint returns limited status information and never treats a browser callback as proof of payment.

In the Paystack test dashboard, set the webhook URL to:

```text
https://YOUR-API-HOST/api/v1/webhooks/paystack
```

The webhook handler validates `x-paystack-signature` against the untouched request body, calls Paystack's transaction verification endpoint, and compares the reference, status, amount, currency, and customer email before committing inventory. Repeated webhooks are idempotent. Invalid or mismatched payments are held for manual attention rather than fulfilled.

## Deployment

`render.yaml` defines the Render web service and readiness health check. Add every secret marked `sync: false` in Render, including `JWT_SECRET`; keep MongoDB Atlas near the Render region, allow Render to connect to Atlas, and set `FRONTEND_ORIGINS` to the comma-separated production/preview storefront origins. Run `npm run seed:admin` from a trusted environment whenever the production owner password must be created or rotated; do not store `ADMIN_PASSWORD` in Render after bootstrap.
