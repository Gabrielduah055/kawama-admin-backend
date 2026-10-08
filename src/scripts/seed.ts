import path from 'node:path';
import { access } from 'node:fs/promises';
import { connectDatabase, disconnectDatabase } from '../config/mongodb.js';
import { getEnvironment } from '../config/environment.js';
import { toPesewas } from '../lib/catalog.js';
import { CategoryModel } from '../models/CategorySchema.js';
import { ProductModel } from '../models/ProductSchema.js';
import { ReviewModel } from '../models/ReviewSchema.js';
import { cloudinaryMediaService } from '../services/cloudinary.service.js';
import { seedCategories, seedProducts, seedReviews } from '../data/seed-data.js';

const dryRun = process.argv.includes('--dry-run');
const assetDirectory = path.resolve(process.cwd(), getEnvironment().SEED_ASSET_DIR);

async function assetPath(filename: string): Promise<string> {
  const resolved = path.join(assetDirectory, filename);
  await access(resolved);
  return resolved;
}

async function uploadImage(filename: string, publicId: string, alt: string, position = 0) {
  const uploaded = await cloudinaryMediaService.uploadFile(await assetPath(filename), publicId);
  return { ...uploaded, alt, position };
}

async function seed(): Promise<void> {
  if (dryRun) {
    await Promise.all([
      ...seedCategories.map((category) => assetPath(category.imageFile)),
      ...seedProducts.flatMap((product) => product.imageFiles.map((image) => assetPath(image.file))),
    ]);
    console.log(`Dry run passed: ${seedCategories.length} categories, ${seedProducts.length} products, ${seedReviews.length} reviews.`);
    return;
  }

  await connectDatabase();
  const categoryIds = new Map<string, string>();
  for (const category of seedCategories) {
    const existing = await CategoryModel.findOne({ slug: category.slug }).lean();
    const image = existing?.image?.src
      ? existing.image
      : await uploadImage(category.imageFile, `categories/${category.slug}`, category.imageAlt);
    const saved = await CategoryModel.findOneAndUpdate(
      { slug: category.slug },
      {
        $set: {
          name: category.name,
          description: category.description,
          image,
          displayOrder: category.displayOrder,
          status: 'active',
          updatedBy: 'seed',
        },
        $setOnInsert: { slug: category.slug },
      },
      { returnDocument: 'after', upsert: true, runValidators: true },
    );
    categoryIds.set(category.slug, String(saved._id));
  }

  const productIds = new Map<string, string>();
  for (const product of seedProducts) {
    const existing = await ProductModel.findOne({ slug: product.slug }).lean();
    const images = existing?.images?.length
      ? existing.images
      : await Promise.all(
          product.imageFiles.map((image, index) =>
            uploadImage(image.file, `products/${product.slug}-${index + 1}`, image.alt, index),
          ),
        );
    const saved = await ProductModel.findOneAndUpdate(
      { slug: product.slug },
      {
        $set: {
          name: product.name,
          category: categoryIds.get(product.category),
          shortDescription: product.shortDescription,
          description: product.description,
          pricePesewas: toPesewas(product.price),
          compareAtPricePesewas: product.compareAtPrice === undefined ? undefined : toPesewas(product.compareAtPrice),
          images,
          stockQuantity: product.stockQuantity,
          lowStockThreshold: 5,
          featured: product.featured,
          newArrival: product.isNew ?? false,
          isBestSeller: product.isBestSeller ?? false,
          complementaryCategories: product.complementaryCategories.map((slug) => categoryIds.get(slug)),
          details: product.details,
          specifications: [],
          status: 'active',
          updatedBy: 'seed',
        },
        $setOnInsert: { slug: product.slug },
      },
      { returnDocument: 'after', upsert: true, runValidators: true },
    );
    productIds.set(product.slug, String(saved._id));
  }

  for (const review of seedReviews) {
    const productId = productIds.get(review.product);
    await ReviewModel.findOneAndUpdate(
      { product: productId, reviewerName: review.reviewerName, comment: review.comment },
      {
        $set: { rating: review.rating, status: 'approved', moderatedBy: 'seed', moderatedAt: new Date(review.createdAt) },
        $setOnInsert: { product: productId, reviewerName: review.reviewerName, comment: review.comment, createdAt: new Date(review.createdAt) },
      },
      { upsert: true, runValidators: true },
    );
  }
  console.log(`Seed complete: ${seedCategories.length} categories, ${seedProducts.length} products, ${seedReviews.length} reviews.`);
}

try {
  await seed();
} finally {
  await disconnectDatabase();
}
