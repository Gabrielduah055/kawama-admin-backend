# Kawama Backend Agent Guide

## Purpose and ownership

This repository owns Kawama's backend APIs for the product catalog, categories, reviews, administrator authentication, Cloudinary media, Paystack checkout, orders, inventory reservations, customers, and dashboard summaries. Customer-storefront work belongs in the `Kawama` repository, while administrator screens belong in `kawamaAdmin-frontend`. Keep changes inside this repository unless the task explicitly includes another project, and preserve unrelated local work.

## Runtime and structure

The declared runtime is Node.js 22. The application uses Express 5, strict TypeScript, ES modules with NodeNext resolution, MongoDB through Mongoose, Zod validation, JWT and bcrypt for administrator authentication, Cloudinary for media, and Paystack for product payments. TypeScript source imports local modules with `.js` extensions because emitted code is ESM.

Source responsibilities are deliberately separated:

- `src/app.ts` assembles middleware and routes; `src/index.ts` connects MongoDB, starts the server, and handles shutdown.
- `src/route` (singular) defines route composition and compatibility mounts.
- `src/controllers` translates HTTP requests and responses.
- `src/services` contains workflows and external-provider integrations.
- `src/models` owns Mongoose schemas, states, and indexes.
- `src/validation` contains shared Zod request schemas.
- `src/middlewares` owns authentication, request context, and error handling.
- `src/lib` contains reusable catalog, order, media, and administration helpers.
- `src/config` parses environment settings and manages database connectivity; `src/scripts` contains seed operations.

## API conventions

Preserve the current API surfaces. Public v1 routes include categories, products, and product reviews under `/api/v1`; administrator login is `POST /api/v1/auth/login`, and authenticated administration routes are under `/api/v1/admin`. The older `/api/admin` login and `/api/product` catalog/administration mounts remain compatibility APIs. The OpenAPI contract is served at `GET /openapi.json` and should change with externally visible behavior.

Validate inputs with Zod at the boundary. Lists use `page` and `limit` (maximum 100) and return pagination metadata. Normal successes generally use `{ message, data }`, with list metadata where applicable; do not invent fields. Failures flow through `AppError` and use `{ error: { code, message, details?, requestId } }`. Preserve the `X-Request-Id` request/response correlation behavior and keep client messages safe. Authentication uses an exact Bearer token boundary for protected administration routes. Add or update meaningful tests and API documentation when behavior changes.

## Checkout, payment, and inventory invariants

The backend—not the browser—loads products and calculates authoritative prices and totals. Public product prices are in cedis; monetary fields ending in `Pesewas` are integer pesewas. Paystack charges cover products only in `GHS`. Delivery is quoted separately and remains `pay_on_delivery`; do not merge delivery collection into the product payment.

The payment endpoints are:

- `POST /api/v1/checkout/sessions`
- `GET /api/v1/checkout/sessions/:checkoutToken`
- `POST /api/v1/webhooks/paystack`

Checkout creation requires a valid `Idempotency-Key`. Preserve the hash-based uniqueness, order number/payment reference identity, MongoDB transaction boundaries, stock availability checks, reservation counters, and payment-attempt history. Configuration preflight must happen before a new order, attempt, or stock reservation is created, while an unconfigured payment provider must not make catalog endpoints unavailable.

Treat provider outcomes precisely. A definitive local configuration or provider rejection can cancel the pending order and transactionally release its reservation. A timeout, connection loss, provider failure, or malformed/lost response is uncertain: return `CHECKOUT_INITIALIZATION_UNCERTAIN`, retain the original order, Paystack reference, attempt, and reservation, and never silently create a replacement payment or fresh idempotency key. Idempotent retries verify the stored reference at most three times and never re-initialize it; unresolved recovery moves the order to `needs_attention`. Current reservations expire after 30 minutes. Expiration is checked during checkout creation and when the relevant checkout status is read; there is no scheduled cleanup worker.

A browser redirect, callback query, or client assertion is not payment proof. Finalization requires a valid Paystack signature computed over the untouched webhook body, followed by server-side transaction verification and matching reference, amount, and currency. Preserve idempotent duplicate-webhook handling. Keep payment, fulfillment, stock-reservation, and delivery-fee states distinct. No automatic refund service is currently implemented.

## Authentication, validation, and media

The owner account is database-backed. `npm run seed:admin` hashes the configured password with bcrypt; login issues a JWT with the expected issuer and audience, and protected requests verify both the token and an active database administrator. Do not weaken strict schemas, identifier checks, checkout consent, duplicate-item rejection, or rate limits.

Public review submissions begin pending; only approved reviews are public, and moderation is administrative. Preserve product/category archive and restore semantics. Cloudinary uploads use signed parameters from a protected endpoint. Deletion is limited to the configured Kawama folder and is rejected while an asset is referenced by a product or category.

## Secrets and configuration

Actual credentials belong only in ignored local environment files or the deployment platform's environment settings. Never read or commit `.env`; `.env.example` must contain variable names and unmistakably synthetic placeholders only. Local environment changes do not configure Render, and deployment changes generally require a backend restart or redeploy.

Relevant settings include `MONGODB_URI`, `MONGODB_DNS_SERVERS`, `FRONTEND_ORIGINS`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, the `CLOUDINARY_*` variables, and `PAYSTACK_SECRET_KEY`, `PAYSTACK_BASE_URL`, and `PAYSTACK_CALLBACK_URL`. The hosted backend checkout does not require an Angular Paystack public key. Never log or expose secret keys, tokens, Authorization headers, checkout tokens, full provider bodies, or customer details. Tests must use synthetic credentials and mocked Paystack requests.

## Commands and verification

- `npm run dev` starts the TypeScript development server with reload.
- `npm run build` compiles production JavaScript.
- `npm start` runs the compiled server.
- `npm run typecheck` checks application and test TypeScript.
- `npm test` runs Vitest.

API integration tests use Supertest and `MongoMemoryReplSet` because checkout relies on MongoDB transactions. Report unavailable MongoDB binaries or sandbox/network restrictions separately from code failures. Paystack tests must remain mocked; do not make live charges. For implementation changes, run affected tests, type checking, and the build. A passing build does not prove a deployed payment flow works.

Seed commands are operationally separate: `npm run seed:dry-run` validates seed input, while `npm run seed` and `npm run seed:admin` can modify databases and, for catalog seeding, media. Never run production seeds, change deployed configuration, or contact live payment services as routine verification. Prefer focused changes, follow existing patterns, and clearly separate implemented behavior from intended guarantees and known limitations.
