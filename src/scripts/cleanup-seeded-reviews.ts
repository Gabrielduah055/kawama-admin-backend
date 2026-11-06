import { connectDatabase, disconnectDatabase } from '../config/mongodb.js';
import { ProductModel } from '../models/ProductSchema.js';
import { ReviewModel } from '../models/ReviewSchema.js';

const knownReviewFixtures = [
  { productSlug: 'onyx-everyday-frying-pan', reviewerName: 'Ama K.', rating: 5, comment: 'It heats evenly and cleans up quickly. The handle also feels very secure.', createdAt: '2026-07-12T10:00:00.000Z' },
  { productSlug: 'onyx-everyday-frying-pan', reviewerName: 'Esi N.', rating: 4, comment: 'A useful everyday size and the nonstick surface has been reliable so far.', createdAt: '2026-08-03T14:30:00.000Z' },
  { productSlug: 'tide-ceramic-mixing-bowls', reviewerName: 'Adwoa S.', rating: 5, comment: 'The sizes are practical and the colour looks beautiful on the table.', createdAt: '2026-08-20T09:15:00.000Z' },
  { productSlug: 'forge-seven-piece-knife-set', reviewerName: 'Kojo A.', rating: 4, comment: 'A tidy set with the knives I use most. The block does not take much space.', createdAt: '2026-06-28T16:45:00.000Z' },
  { productSlug: 'ember-compact-air-fryer', reviewerName: 'Naa D.', rating: 5, comment: 'Simple controls, quick results, and a good size for two people.', createdAt: '2026-08-29T18:20:00.000Z' },
  { productSlug: 'clearline-spice-jar-set', reviewerName: 'Akosua B.', rating: 4, comment: 'My spice shelf is much easier to use now. The lids close firmly.', createdAt: '2026-07-31T11:05:00.000Z' },
] as const;

const apply = process.argv.includes('--apply');

async function cleanupSeededReviews(): Promise<void> {
  await connectDatabase();

  const products = await ProductModel.find({
    slug: { $in: [...new Set(knownReviewFixtures.map((fixture) => fixture.productSlug))] },
  }).select('_id slug').lean();
  const productIdsBySlug = new Map(products.map((product) => [product.slug, product._id]));
  const fixtureFilters = knownReviewFixtures.flatMap((fixture) => {
    const productId = productIdsBySlug.get(fixture.productSlug);
    if (!productId) return [];
    const fixtureDate = new Date(fixture.createdAt);
    return [{
      product: productId,
      reviewerName: fixture.reviewerName,
      rating: fixture.rating,
      comment: fixture.comment,
      createdAt: fixtureDate,
      moderatedBy: 'seed',
      moderatedAt: fixtureDate,
      order: null,
      invitation: null,
      status: { $ne: 'archived' },
    }];
  });

  if (fixtureFilters.length === 0) {
    console.log('No matching seeded review fixtures found.');
    return;
  }

  const matches = await ReviewModel.find({ $or: fixtureFilters })
    .select('_id product reviewerName rating status createdAt')
    .sort({ createdAt: 1 })
    .lean();

  console.log(`${apply ? 'Apply' : 'Preview'}: ${matches.length} seeded review fixture(s) matched.`);
  for (const match of matches) {
    console.log({
      id: String(match._id),
      productId: String(match.product),
      reviewerName: match.reviewerName,
      rating: match.rating,
      status: match.status,
      createdAt: new Date(match.createdAt).toISOString(),
    });
  }

  if (!apply || matches.length === 0) {
    if (!apply) console.log('No records changed. Re-run with --apply to archive these exact matches.');
    return;
  }

  const result = await ReviewModel.updateMany(
    { $or: fixtureFilters },
    { $set: { status: 'archived' } },
    { runValidators: true },
  );
  console.log(`Archived ${result.modifiedCount} seeded review fixture(s).`);
}

try {
  await cleanupSeededReviews();
} finally {
  await disconnectDatabase();
}
