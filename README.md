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

## AI shopping assistant

`POST /api/ai/chat` starts or continues a customer shopping conversation. It searches active MongoDB catalogue records through bounded server-side tools and returns only a final customer-facing reply plus canonical product cards. Product prices are returned in GHS. Current availability is calculated from stock minus active reservations. The assistant cannot mutate products, inventory, orders, payments, or customer records.

Configure the server with:

```text
AI_CHAT_ENABLED=true
OPENROUTER_API_KEY=your-server-only-key
OPENROUTER_MODEL=google/gemma-4-31b-it:free
```

`google/gemma-4-31b-it:free` is the default model. `OPENROUTER_MODEL` may explicitly select another OpenRouter model without a source change; the provider sends exactly that one model ID and never adds automatic fallback or upgrade models. A missing key or `AI_CHAT_ENABLED=false` affects only the chat route. `OPENROUTER_TIMEOUT_MS` and `AI_CHAT_CONVERSATION_TTL_HOURS` optionally control the provider timeout and guest-history expiry.

Store policy answers come from `STORE_DELIVERY_POLICY`, `STORE_PAYMENT_POLICY`, `STORE_RETURN_POLICY`, `STORE_CONTACT_EMAIL`, `STORE_CONTACT_PHONE`, and `STORE_CONTACT_WHATSAPP_URL`. Blank or whitespace-only optional settings are treated as unset; invalid nonblank emails and URLs are rejected. Unset policy values remain unknown. `STOREFRONT_PRODUCT_URL_TEMPLATE` may contain a literal `{slug}` for canonical product-card links.

Grounding is enforced in the application as well as the system prompt. Product questions, recommendations, comparisons, prices, availability, specifications, and warranties require a successful current-request catalogue search or detail lookup. Policy and contact answers require `getStorePolicies`. Greetings and fact-free clarification questions may skip tools. If a draft lacks the required evidence, the application allows one corrective model step within the existing four-call/six-tool limits, then returns a deterministic safe clarification instead of the unsupported draft. It also rejects unreturned product IDs, unsupported explicit GHS amounts, unrecorded warranty claims that are not described as unknown, obvious stock contradictions, and model-generated product links. Canonical product cards remain the authority for IDs, prices, availability, images, and links; the validator does not attempt to mathematically prove every descriptive phrase in natural-language prose.

Previously shown positions are stored as safe ID/name/slug snapshots. If an item is later archived, it keeps its original position but is marked unavailable; active items are re-retrieved before current facts are answered.

For a first Postman request, omit `X-Chat-Session`:

```http
POST http://localhost:3000/api/ai/chat
Content-Type: application/json

{
  "message": "I need a blender under 400 cedis",
  "context": { "productSlug": "smoothie-blender" }
}
```

The response has this shape:

```json
{
  "message": "Assistant response generated successfully",
  "data": {
    "conversationId": "00000000-0000-4000-8000-000000000000",
    "assistantMessage": "...",
    "products": [
      {
        "id": "000000000000000000000000",
        "slug": "example-product",
        "name": "Example product",
        "price": 350,
        "currency": "GHS",
        "availability": "in_stock"
      }
    ],
    "suggestedFollowUps": ["Would you like a comparison?"]
  }
}
```

Save the `X-Chat-Session` response header. To continue, send that header together with `data.conversationId`; the conversation ID alone cannot read another visitor's history:

```http
POST http://localhost:3000/api/ai/chat
Content-Type: application/json
X-Chat-Session: <43-character value returned by the server>

{
  "conversationId": "00000000-0000-4000-8000-000000000000",
  "message": "Compare the first and second."
}
```

Guest history retains at most twelve user/assistant messages and expires through a MongoDB TTL index. Do not log or place the session header in URLs. The OpenAPI document and included Postman collection contain the same contract.

## Uploads

For product media, call `POST /api/v1/admin/uploads/signature`, upload directly to Cloudinary with the returned values, then store the returned `secure_url` and `public_id` in the product payload. Asset deletion is rejected while a category or product references it.

## Paystack checkout

This is a backend-first hosted checkout. The Angular app calls this API and follows the returned Paystack `authorizationUrl`; it does not need a Paystack public key. `PAYSTACK_SECRET_KEY` is server-only and must never be placed in Angular source, returned by an endpoint, or written to logs.

The API accepts real Paystack test and live secret-key formats (`sk_test_...` and `sk_live_...`). Missing keys, `pk_...` public keys, malformed values, and obvious example placeholders are rejected as local configuration errors before an order is created or inventory is reserved. Catalog and review endpoints remain available when payment is not configured.

Create a checkout with `POST /api/v1/checkout/sessions`. Send a fresh UUID-like value in the `Idempotency-Key` header and the customer/cart payload in the body. The API recalculates prices from MongoDB, reserves stock for 30 minutes, creates the order, and returns Paystack's `accessCode`. Reusing the same idempotency key returns the same checkout without reserving stock twice.

A definitive provider rejection (for example, Paystack HTTP 401/403) fails the order and releases its reservation. A timeout, connection loss, provider 5xx, or malformed success response has an uncertain outcome: the API keeps the original order, reference, and reservation instead of risking a second charge. It returns `CHECKOUT_INITIALIZATION_UNCERTAIN`; the storefront must retain and reuse the same idempotency key and exact payload, never archive that checkout or silently generate a replacement.

An idempotent `POST` retry reconciles an uncertain attempt by calling Paystack's transaction-verification endpoint with the existing server-stored reference. It never initializes another transaction. Successful verification uses the same idempotent payment-finalization path as the webhook. Provider-pending, not-found, and unavailable results preserve the checkout for up to three on-demand reconciliation checks; there is no background recovery worker. If those checks cannot establish a safe result, the API returns the checkout with `paymentStatus` and `fulfillmentStatus` set to `needs_attention`, releases the reservation, and the customer must not submit another payment. A provider-confirmed unsuccessful transaction fails the checkout and permits a deliberate new checkout.

The storefront can poll `GET /api/v1/checkout/sessions/:checkoutToken`. This endpoint returns limited status information and never treats a browser callback as proof of payment. Reservations otherwise expire through the existing 30-minute request-triggered cleanup path if no verified payment arrives.

For the currently named deployed test API, set this webhook URL in the Paystack **test mode** dashboard:

```text
https://kawama-admin-backend.onrender.com/api/v1/webhooks/paystack
```

For another deployment, replace only the origin and keep `/api/v1/webhooks/paystack`. Paystack cannot call a localhost webhook; local webhook testing requires a trusted HTTPS tunnel to `http://localhost:3000`.

The webhook handler validates `x-paystack-signature` against the untouched request body, calls Paystack's transaction verification endpoint, and compares the reference, status, amount, currency, and customer email before committing inventory. Repeated webhooks are idempotent. Invalid or mismatched payments are held for manual attention rather than fulfilled.

### Local Paystack test setup

1. In the Paystack dashboard, switch to **Test mode**, open API keys, and copy the actual secret key beginning with `sk_test_`. A documentation placeholder will not work.
2. Copy `.env.example` to `.env`. Set `PAYSTACK_SECRET_KEY` to that actual test secret, keep `PAYSTACK_BASE_URL=https://api.paystack.co`, and set `PAYSTACK_CALLBACK_URL=http://localhost:4200/checkout/result`.
3. Run this API at `http://localhost:3000`; the Angular repository's local API base URL must be `http://localhost:3000/api/v1`.
4. Run the Angular storefront at `http://localhost:4200` and configure a public HTTPS tunnel as the Paystack test webhook if testing webhooks against the local API.
5. Restart the API after changing `.env`. Use Paystack test mode only; automated tests mock every Paystack request.

The developer must supply the real test secret and, when using a tunnel, its public HTTPS origin. No real key belongs in `.env.example` or source control.

### Render Paystack setup

In the Render dashboard for the deployed backend, set these service environment variables:

- `PAYSTACK_SECRET_KEY`: the actual `sk_test_...` key while validating the integration; switch to the matching live secret only for an intentional production launch.
- `PAYSTACK_BASE_URL`: `https://api.paystack.co`.
- `PAYSTACK_CALLBACK_URL`: the deployed Angular storefront origin plus `/checkout/result` (the developer must enter the real deployed frontend URL).
- `FRONTEND_ORIGINS`: the exact deployed Angular origin(s), comma-separated when more than one is required.

Save the Render environment changes, then restart or manually redeploy the backend service so the running process reads them. Editing `.env` on a laptop does **not** configure Render. In the Paystack dashboard's matching test/live mode, configure the deployed webhook URL shown above and confirm the selected API keys and webhook belong to the same mode.

Repository code cannot verify the values currently stored in Render or Paystack. Check the failed response's `error.code`/`requestId` and the matching Render log entry without exposing credentials or provider bodies. The gateway logs provider-specific configuration, authentication, timeout, connection, HTTP, and malformed-response codes; checkout initialization presents uncertain outcomes to clients as `CHECKOUT_INITIALIZATION_UNCERTAIN` so they cannot be mistaken for permission to replace the checkout.

Configuration is validated per operation: webhook HMAC verification requires only `PAYSTACK_SECRET_KEY`; server-side transaction verification requires the secret key plus a valid HTTPS `PAYSTACK_BASE_URL`; new checkout preflight/initialization also validates `PAYSTACK_CALLBACK_URL` when it is supplied. A bad callback blocks new checkout initialization but does not prevent verification of an existing reference or validation of a signed webhook.

## Admin commerce API

All admin commerce endpoints require the same administrator bearer token as the catalog endpoints.

- `GET /api/v1/admin/orders` lists orders with pagination plus `q`, `paymentStatus`, `fulfillmentStatus`, `deliveryFeeStatus`, `from`, and `to` filters.
- `GET /api/v1/admin/orders/:id` returns the full order snapshot and sanitized payment-attempt history. Paystack access codes and authorization URLs are never returned.
- `PATCH /api/v1/admin/orders/:id/fulfillment` accepts `processing`, `out_for_delivery`, `delivered`, or `cancelled`. Only verified paid orders can enter delivery fulfillment. Cancelling an unpaid order releases its stock reservation; paid orders require a separate refund workflow and cannot be cancelled here.
- `PATCH /api/v1/admin/orders/:id/delivery` accepts a `deliveryFeeStatus` and optional `deliveryFee` in Ghanaian cedis. Returned monetary fields use explicit `Pesewas` suffixes.
- `GET /api/v1/admin/customers` lists paid customers with pagination plus `q` and `status` filters.
- `GET /api/v1/admin/customers/:id` returns customer totals and up to 20 recent orders.
- `GET /api/v1/admin/dashboard/summary` returns order, revenue, customer, inventory, and recent-order metrics for the admin overview.

Example delivery quote:

```json
{
  "deliveryFeeStatus": "quoted",
  "deliveryFee": 35.5
}
```

See `/openapi.json` or the Postman collection for the complete request and response contract.

## Deployment

`render.yaml` defines the Render web service and readiness health check. Add every secret marked `sync: false` in Render, including `JWT_SECRET` and `PAYSTACK_SECRET_KEY`; keep MongoDB Atlas near the Render region, allow Render to connect to Atlas, and set `FRONTEND_ORIGINS` to the comma-separated production/preview storefront origins. Run `npm run seed:admin` from a trusted environment whenever the production owner password must be created or rotated; do not store `ADMIN_PASSWORD` in Render after bootstrap.
