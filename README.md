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

## Deployment

`render.yaml` defines the Render web service and readiness health check. Add every secret marked `sync: false` in Render, including `JWT_SECRET`; keep MongoDB Atlas near the Render region, allow Render to connect to Atlas, and set `FRONTEND_ORIGINS` to the comma-separated production/preview storefront origins. Run `npm run seed:admin` from a trusted environment whenever the production owner password must be created or rotated; do not store `ADMIN_PASSWORD` in Render after bootstrap.
