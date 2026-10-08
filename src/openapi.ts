export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Kawama API',
    version: '1.0.0',
    description: 'Public catalog/review API and JWT-protected owner administration API.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Authentication' },
    { name: 'Public catalog' },
    { name: 'Public reviews' },
    { name: 'Admin products' },
    { name: 'Admin categories' },
    { name: 'Admin reviews' },
    { name: 'Admin uploads' },
  ],
  paths: {
    '/': { get: { responses: { '200': { description: 'Kawama API is running.' } } } },
    '/health/live': { get: { responses: { '200': { description: 'Process is alive.' } } } },
    '/health/ready': { get: { responses: { '200': { description: 'Database is connected.' }, '503': { description: 'Database is unavailable.' } } } },
    '/api/v1/auth/login': {
      post: {
        tags: ['Authentication'],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AdminLogin' } } } },
        responses: {
          '200': { description: 'Administrator authenticated.', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthResponse' } } } },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '429': { description: 'LOGIN_RATE_LIMIT.' },
        },
      },
    },
    '/api/admin/login': {
      post: {
        tags: ['Authentication'],
        description: 'Simplified login route matching the Slipper API route style.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AdminLogin' } } } },
        responses: { '200': { description: 'Administrator authenticated.' }, '401': { $ref: '#/components/responses/Unauthorized' } },
      },
    },
    '/api/product': {
      get: { tags: ['Public catalog'], description: 'Simplified alias for GET /api/v1/products.', responses: { '200': { description: 'Paginated active products.' } } },
      post: { tags: ['Admin products'], security: [{ bearerAuth: [] }], description: 'Simplified alias for creating a product.', responses: { '201': { description: 'Product created.' } } },
    },
    '/api/product/categories': {
      get: { tags: ['Public catalog'], description: 'Simplified alias for GET /api/v1/categories.', responses: { '200': { description: 'Ordered active categories.' } } },
    },
    '/api/v1/categories': {
      get: { tags: ['Public catalog'], responses: { '200': { description: 'Ordered active categories.', content: { 'application/json': { schema: { $ref: '#/components/schemas/CategoryList' } } } } } },
    },
    '/api/v1/products': {
      get: {
        tags: ['Public catalog'],
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'category', in: 'query', schema: { type: 'string' }, description: 'Category slug.' },
          { name: 'featured', in: 'query', schema: { type: 'boolean' } },
          { name: 'inStock', in: 'query', schema: { type: 'boolean' } },
          { name: 'sort', in: 'query', schema: { enum: ['featured', 'newest', 'name', 'priceAsc', 'priceDesc'] } },
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/Limit' },
        ],
        responses: { '200': { description: 'Paginated active products.', content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductList' } } } }, '400': { $ref: '#/components/responses/BadRequest' } },
      },
    },
    '/api/v1/products/{slug}': {
      get: { tags: ['Public catalog'], parameters: [{ name: 'slug', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Active product.', content: { 'application/json': { schema: { type: 'object', properties: { data: { $ref: '#/components/schemas/Product' } } } } } }, '404': { $ref: '#/components/responses/NotFound' } } },
    },
    '/api/v1/products/{productId}/reviews': {
      get: { tags: ['Public reviews'], parameters: [{ $ref: '#/components/parameters/ProductId' }], responses: { '200': { description: 'Approved reviews.' }, '404': { $ref: '#/components/responses/NotFound' } } },
      post: { tags: ['Public reviews'], parameters: [{ $ref: '#/components/parameters/ProductId' }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ReviewInput' } } } }, responses: { '202': { description: 'Review accepted for moderation.' }, '400': { $ref: '#/components/responses/BadRequest' }, '429': { description: 'Review rate limit exceeded.' } } },
    },
    '/api/v1/admin/products': {
      get: { tags: ['Admin products'], security: [{ bearerAuth: [] }], parameters: [{ $ref: '#/components/parameters/Page' }, { $ref: '#/components/parameters/Limit' }, { name: 'status', in: 'query', schema: { enum: ['draft', 'active', 'archived'] } }, { name: 'categoryId', in: 'query', schema: { type: 'string' } }, { name: 'q', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'Paginated admin product list.' }, '401': { $ref: '#/components/responses/Unauthorized' } } },
      post: { tags: ['Admin products'], security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductInput' } } } }, responses: { '201': { description: 'Product created.' }, '400': { $ref: '#/components/responses/BadRequest' }, '401': { $ref: '#/components/responses/Unauthorized' }, '409': { $ref: '#/components/responses/Conflict' } } },
    },
    '/api/v1/admin/products/{id}': {
      get: { tags: ['Admin products'], security: [{ bearerAuth: [] }], parameters: [{ $ref: '#/components/parameters/Id' }], responses: { '200': { description: 'Admin product detail.' }, '404': { $ref: '#/components/responses/NotFound' } } },
      patch: { tags: ['Admin products'], security: [{ bearerAuth: [] }], parameters: [{ $ref: '#/components/parameters/Id' }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ProductPatch' } } } }, responses: { '200': { description: 'Product updated; slug is immutable.' }, '400': { $ref: '#/components/responses/BadRequest' }, '404': { $ref: '#/components/responses/NotFound' } } },
      delete: { tags: ['Admin products'], security: [{ bearerAuth: [] }], parameters: [{ $ref: '#/components/parameters/Id' }], responses: { '200': { description: 'Product archived.' }, '404': { $ref: '#/components/responses/NotFound' } } },
    },
    '/api/v1/admin/products/{id}/restore': { post: { tags: ['Admin products'], security: [{ bearerAuth: [] }], parameters: [{ $ref: '#/components/parameters/Id' }], responses: { '200': { description: 'Product restored as a draft.' }, '404': { $ref: '#/components/responses/NotFound' } } } },
    '/api/v1/admin/categories': {
      get: { tags: ['Admin categories'], security: [{ bearerAuth: [] }], responses: { '200': { description: 'All categories.' }, '401': { $ref: '#/components/responses/Unauthorized' } } },
      post: { tags: ['Admin categories'], security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CategoryInput' } } } }, responses: { '201': { description: 'Category created.' }, '409': { $ref: '#/components/responses/Conflict' } } },
    },
    '/api/v1/admin/categories/{id}': {
      get: { tags: ['Admin categories'], security: [{ bearerAuth: [] }], parameters: [{ $ref: '#/components/parameters/Id' }], responses: { '200': { description: 'Category detail.' }, '404': { $ref: '#/components/responses/NotFound' } } },
      patch: { tags: ['Admin categories'], security: [{ bearerAuth: [] }], parameters: [{ $ref: '#/components/parameters/Id' }], requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/CategoryPatch' } } } }, responses: { '200': { description: 'Category updated; slug is immutable.' } } },
      delete: { tags: ['Admin categories'], security: [{ bearerAuth: [] }], parameters: [{ $ref: '#/components/parameters/Id' }], responses: { '200': { description: 'Category archived.' }, '409': { description: 'CATEGORY_IN_USE.' } } },
    },
    '/api/v1/admin/categories/order': { patch: { tags: ['Admin categories'], security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { type: 'object', required: ['id', 'displayOrder'], properties: { id: { type: 'string' }, displayOrder: { type: 'integer', minimum: 0 } } } } } } } } }, responses: { '200': { description: 'Display order updated.' } } } },
    '/api/v1/admin/categories/{id}/restore': { post: { tags: ['Admin categories'], security: [{ bearerAuth: [] }], parameters: [{ $ref: '#/components/parameters/Id' }], responses: { '200': { description: 'Category restored.' } } } },
    '/api/v1/admin/reviews': { get: { tags: ['Admin reviews'], security: [{ bearerAuth: [] }], parameters: [{ name: 'status', in: 'query', schema: { enum: ['pending', 'approved', 'rejected', 'archived'] } }, { name: 'productId', in: 'query', schema: { type: 'string' } }, { $ref: '#/components/parameters/Page' }, { $ref: '#/components/parameters/Limit' }], responses: { '200': { description: 'Paginated moderation queue.' } } } },
    '/api/v1/admin/reviews/{id}/status': { patch: { tags: ['Admin reviews'], security: [{ bearerAuth: [] }], parameters: [{ $ref: '#/components/parameters/Id' }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { enum: ['approved', 'rejected', 'archived'] } } } } } }, responses: { '200': { description: 'Review moderated.' }, '404': { $ref: '#/components/responses/NotFound' } } } },
    '/api/v1/admin/reviews/{id}': { delete: { tags: ['Admin reviews'], security: [{ bearerAuth: [] }], parameters: [{ $ref: '#/components/parameters/Id' }], responses: { '200': { description: 'Review archived.' } } } },
    '/api/v1/admin/uploads/signature': { post: { tags: ['Admin uploads'], security: [{ bearerAuth: [] }], responses: { '200': { description: 'Short-lived direct Cloudinary upload signature.' }, '503': { description: 'Cloudinary is not configured.' } } } },
    '/api/v1/admin/uploads': { delete: { tags: ['Admin uploads'], security: [{ bearerAuth: [] }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['publicId'], properties: { publicId: { type: 'string' } } } } } }, responses: { '200': { description: 'Unreferenced asset destroyed.' }, '409': { description: 'ASSET_IN_USE.' } } } },
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    parameters: {
      Page: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
      Limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 24 } },
      Id: { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } },
      ProductId: { name: 'productId', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } },
    },
    responses: {
      BadRequest: { description: 'VALIDATION_ERROR, INVALID_ID, INVALID_CATEGORY, INACTIVE_CATEGORY, INVALID_PRICE, or INVALID_MEDIA_ASSET.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Unauthorized: { description: 'INVALID_CREDENTIALS, ADMIN_TOKEN_REQUIRED, or INVALID_ADMIN_TOKEN.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      NotFound: { description: 'Requested resource does not exist.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      Conflict: { description: 'DUPLICATE_RESOURCE, CATEGORY_IN_USE, or ASSET_IN_USE.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
    schemas: {
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'object', required: ['code', 'message', 'requestId'], properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, details: {} } } } },
      AdminLogin: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string', minLength: 3, maxLength: 254 }, password: { type: 'string', minLength: 8, maxLength: 200 } } },
      AuthResponse: { type: 'object', required: ['data'], properties: { data: { type: 'object', required: ['token', 'tokenType', 'expiresIn', 'admin'], properties: { token: { type: 'string' }, tokenType: { const: 'Bearer' }, expiresIn: { type: 'integer' }, admin: { type: 'object', required: ['id', 'email', 'role'], properties: { id: { type: 'string' }, email: { type: 'string' }, role: { const: 'owner' } } } } } } },
      Meta: { type: 'object', required: ['page', 'limit', 'total'], properties: { page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' } } },
      Image: { type: 'object', required: ['src', 'alt'], properties: { src: { type: 'string', format: 'uri' }, alt: { type: 'string' }, publicId: { type: 'string' }, position: { type: 'integer', minimum: 0 } } },
      Category: { type: 'object', required: ['id', 'name', 'slug', 'displayOrder'], properties: { id: { type: 'string' }, name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string' }, image: { $ref: '#/components/schemas/Image' }, displayOrder: { type: 'integer' } } },
      CategoryList: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Category' } } } },
      CategoryInput: { type: 'object', required: ['name', 'slug'], properties: { name: { type: 'string' }, slug: { type: 'string' }, description: { type: 'string' }, image: { $ref: '#/components/schemas/Image' }, displayOrder: { type: 'integer' }, status: { enum: ['active', 'archived'] } } },
      CategoryPatch: { allOf: [{ $ref: '#/components/schemas/CategoryInput' }], description: 'All properties optional; slug is not accepted.' },
      Product: { type: 'object', required: ['id', 'slug', 'name', 'category', 'categorySlug', 'price', 'currency', 'images', 'inStock', 'stockLevel', 'featured'], properties: { id: { type: 'string' }, slug: { type: 'string' }, name: { type: 'string' }, category: { type: 'string' }, categorySlug: { type: 'string' }, shortDescription: { type: 'string' }, description: { type: 'string' }, price: { type: 'number' }, compareAtPrice: { type: 'number' }, currency: { const: 'GHS' }, images: { type: 'array', items: { $ref: '#/components/schemas/Image' } }, inStock: { type: 'boolean' }, stockLevel: { enum: ['in_stock', 'low_stock', 'out_of_stock'] }, featured: { type: 'boolean' }, isNew: { type: 'boolean' }, isBestSeller: { type: 'boolean' }, complementaryCategories: { type: 'array', items: { type: 'string' } }, details: { type: 'array', items: { type: 'string' } }, specifications: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' } } } } } },
      ProductList: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/Product' } }, meta: { $ref: '#/components/schemas/Meta' } } },
      ProductInput: { type: 'object', required: ['slug', 'name', 'categoryId'], properties: { slug: { type: 'string' }, name: { type: 'string' }, categoryId: { type: 'string' }, shortDescription: { type: 'string' }, description: { type: 'string' }, price: { type: 'number', minimum: 0 }, compareAtPrice: { type: 'number' }, images: { type: 'array', maxItems: 8, items: { $ref: '#/components/schemas/Image' } }, stockQuantity: { type: 'integer', minimum: 0 }, lowStockThreshold: { type: 'integer', minimum: 0 }, featured: { type: 'boolean' }, isNew: { type: 'boolean' }, isBestSeller: { type: 'boolean' }, complementaryCategoryIds: { type: 'array', items: { type: 'string' } }, details: { type: 'array', items: { type: 'string' } }, specifications: { type: 'array', items: { type: 'object', required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'string' } } } }, status: { enum: ['draft', 'active'] } } },
      ProductPatch: { allOf: [{ $ref: '#/components/schemas/ProductInput' }], description: 'All properties optional; slug is not accepted.' },
      ReviewInput: { type: 'object', required: ['reviewerName', 'rating', 'comment'], properties: { reviewerName: { type: 'string', minLength: 2, maxLength: 60 }, rating: { type: 'integer', minimum: 1, maximum: 5 }, comment: { type: 'string', minLength: 10, maxLength: 500 } } },
    },
  },
} as const;
