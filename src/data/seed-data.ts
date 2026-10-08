export interface SeedProduct {
  slug: string;
  name: string;
  category: string;
  shortDescription: string;
  description: string;
  price: number;
  compareAtPrice?: number;
  imageFiles: Array<{ file: string; alt: string }>;
  stockQuantity: number;
  featured: boolean;
  isNew?: boolean;
  isBestSeller?: boolean;
  complementaryCategories: string[];
  details: string[];
}

export const seedCategories = [
  { name: 'Cookware', slug: 'cookware', description: 'Pots, pans, baking pieces, and everyday cooking essentials.', imageFile: 'kawama-category-cookware-black.png', imageAlt: 'Black cookware set in a bright kitchen', displayOrder: 1 },
  { name: 'Appliances', slug: 'appliances', description: 'Practical countertop appliances for everyday meals.', imageFile: 'kawama-air-fryer-wide.png', imageAlt: 'Black digital air fryer on a kitchen counter', displayOrder: 2 },
  { name: 'Kitchen Tools', slug: 'kitchen-tools', description: 'Utensils, knives, and preparation tools.', imageFile: 'kawama-category-tools.png', imageAlt: 'Kitchen utensils in a countertop holder', displayOrder: 3 },
  { name: 'Storage', slug: 'storage', description: 'Pantry, counter, and dish-storage solutions.', imageFile: 'kawama-category-storage.png', imageAlt: 'Clear pantry containers with bamboo lids', displayOrder: 4 },
] as const;

export const seedProducts: SeedProduct[] = [
  {
    slug: 'onyx-everyday-frying-pan', name: 'Ceramic Cookware Set', category: 'cookware',
    shortDescription: 'A coordinated nonstick cookware set for everyday family meals.',
    description: 'This cream cookware collection brings together versatile pots and pans with fitted glass lids and comfortable wood-look handles.',
    price: 289, compareAtPrice: 329,
    imageFiles: [{ file: 'kawama-product-ceramic-set.png', alt: 'Cream ceramic cookware set on a white background' }],
    stockQuantity: 12, featured: true, isNew: true,
    complementaryCategories: ['kitchen-tools', 'storage'],
    details: ['Coordinated pot and pan set', 'Nonstick interiors', 'Fitted glass lids', 'Comfortable wood-look handles'],
  },
  {
    slug: 'tide-ceramic-mixing-bowls', name: 'Tide Ceramic Mixing Bowls', category: 'cookware',
    shortDescription: 'Four nesting bowls for mixing, serving, and countertop prep.',
    description: 'A calm sea-green bowl set designed to move from kitchen prep to the table. Each bowl nests neatly to save cabinet space.',
    price: 245, imageFiles: [{ file: 'product-mixing-bowls.webp', alt: 'Four sea-green ceramic mixing bowls' }],
    stockQuantity: 8, featured: true, isNew: true, isBestSeller: true,
    complementaryCategories: ['kitchen-tools', 'storage'],
    details: ['Set of four sizes', 'Glazed ceramic', 'Dishwasher safe', 'Nesting design'],
  },
  {
    slug: 'forge-seven-piece-knife-set', name: 'Forge 7pc Knife Set', category: 'kitchen-tools',
    shortDescription: 'Essential stainless blades in a compact dark wood block.',
    description: 'A practical knife collection for everyday prep, from slicing vegetables to carving proteins. The weighted block keeps each blade protected and within reach.',
    price: 499, compareAtPrice: 549,
    imageFiles: [{ file: 'product-knife-set.webp', alt: 'Seven-piece stainless knife set in a dark wood block' }],
    stockQuantity: 9, featured: true, isBestSeller: true,
    complementaryCategories: ['cookware', 'storage'],
    details: ['Seven-piece set', 'Stainless steel blades', 'Ergonomic handles', 'Compact storage block'],
  },
  {
    slug: 'clay-silicone-utensil-set', name: 'Clay Silicone Utensil Set', category: 'kitchen-tools',
    shortDescription: 'Heat-friendly utensils that are gentle on coated cookware.',
    description: 'A warm utensil collection with the core tools needed for stirring, serving, turning, and whisking.',
    price: 219, imageFiles: [{ file: 'product-utensil-set-new.png', alt: 'Black silicone utensils with wooden handles in a cream holder' }],
    stockQuantity: 0, featured: false,
    complementaryCategories: ['cookware', 'storage'],
    details: ['Utensil set', 'Heat-resistant silicone', 'Non-scratch edges', 'Countertop holder included'],
  },
  {
    slug: 'ember-compact-air-fryer', name: 'Ember Compact Air Fryer', category: 'appliances',
    shortDescription: 'Crisp everyday favourites with a small countertop footprint.',
    description: 'The Ember air fryer is sized for smaller households and quick meals. Simple controls make temperature and timing easy to manage.',
    price: 899,
    imageFiles: [
      { file: 'kawama-air-fryer-wide.png', alt: 'Black digital air fryer on a bright kitchen counter' },
      { file: 'air-fryer-front-new.png', alt: 'Front view of the black digital air fryer' },
      { file: 'air-fryer-control-new.png', alt: 'Close view of the air fryer digital control panel' },
      { file: 'air-fryer-open-new.png', alt: 'Black air fryer with its cooking basket open' },
    ],
    stockQuantity: 7, featured: true, isNew: true, isBestSeller: true,
    complementaryCategories: ['cookware', 'kitchen-tools'],
    details: ['4 litre basket', 'Adjustable temperature', '60 minute timer', 'Removable easy-clean basket'],
  },
  {
    slug: 'clearline-spice-jar-set', name: 'Clearline Spice Jar Set', category: 'storage',
    shortDescription: 'Keep everyday spices visible, tidy, and easy to reach.',
    description: 'Seven clear glass jars with matching deep-green lids bring order to shelves and drawers without hiding what is inside.',
    price: 178, imageFiles: [{ file: 'product-storage-set-new.png', alt: 'Clear pantry containers with bamboo lids' }],
    stockQuantity: 15, featured: false,
    complementaryCategories: ['kitchen-tools', 'cookware'],
    details: ['Set of seven jars', 'Clear glass bodies', 'Airtight lids', 'Stackable shape'],
  },
  {
    slug: 'granite-everyday-stock-pot', name: 'Granite Everyday Stock Pot', category: 'cookware',
    shortDescription: 'A roomy lidded pot for soups, stews, rice, and family meals.',
    description: 'This practical stock pot is sized for generous everyday cooking and has two easy-grip side handles for confident lifting.',
    price: 320, imageFiles: [{ file: 'kawama-category-cookware-black.png', alt: 'Black lidded cookware arranged in a bright kitchen' }],
    stockQuantity: 11, featured: false,
    complementaryCategories: ['kitchen-tools', 'storage'],
    details: ['Generous family size', 'Fitted lid', 'Twin side handles', 'Easy-clean interior'],
  },
  {
    slug: 'airtight-storage-container-set', name: 'Airtight Storage Container Set', category: 'storage',
    shortDescription: 'Clear containers that make pantry staples easy to see and organise.',
    description: 'A compact set for grains, pasta, snacks, and dry ingredients, with clear bodies that keep cupboards easy to scan.',
    price: 235, imageFiles: [{ file: 'product-storage-set-new.png', alt: 'Four clear pantry containers with bamboo lids' }],
    stockQuantity: 16, featured: false, isNew: true,
    complementaryCategories: ['cookware', 'kitchen-tools'],
    details: ['Clear containers', 'Airtight lids', 'Stackable profiles', 'Multiple sizes'],
  },
  {
    slug: 'countertop-kitchen-blender', name: 'Countertop Kitchen Blender', category: 'appliances',
    shortDescription: 'A versatile countertop blender for smoothies, sauces, and prep.',
    description: 'Built for familiar kitchen tasks with a straightforward control dial and a generous blending jug.',
    price: 420, imageFiles: [{ file: 'product-blender-new.png', alt: 'Stainless countertop blender with a clear jug' }],
    stockQuantity: 6, featured: false,
    complementaryCategories: ['storage', 'kitchen-tools'],
    details: ['Countertop design', 'Multi-speed control', 'Removable jug', 'Easy-clean parts'],
  },
  {
    slug: 'nonstick-baking-pan', name: 'Everyday Baking Pan', category: 'cookware',
    shortDescription: 'A simple rectangular pan for roasting and everyday baking.',
    description: 'A dependable oven pan with a clean rectangular profile and nonstick finish for easier release and washing.',
    price: 135, imageFiles: [{ file: 'product-baking-pan-new.png', alt: 'Rectangular black nonstick baking pan' }],
    stockQuantity: 18, featured: false,
    complementaryCategories: ['kitchen-tools', 'storage'],
    details: ['Rectangular shape', 'Nonstick finish', 'Raised rim', 'Easy to clean'],
  },
  {
    slug: 'stainless-electric-kettle', name: 'Stainless Electric Kettle', category: 'appliances',
    shortDescription: 'A compact stainless kettle for tea, coffee, and quick hot water.',
    description: 'A straightforward electric kettle with a clean stainless body, comfortable handle, and simple countertop footprint.',
    price: 189, imageFiles: [{ file: 'product-breakfast-station.png', alt: 'Stainless electric kettle on a kitchen counter' }],
    stockQuantity: 10, featured: false,
    complementaryCategories: ['storage', 'kitchen-tools'],
    details: ['Stainless body', 'Easy-grip handle', 'Corded base', 'Automatic shut-off'],
  },
  {
    slug: 'two-tier-dish-drying-rack', name: 'Two-Tier Dish Drying Rack', category: 'storage',
    shortDescription: 'Organised counter drying for plates, cups, and cutlery.',
    description: 'A space-conscious rack that separates plates, cups, and utensils while keeping the counter easy to manage.',
    price: 260, imageFiles: [{ file: 'product-storage-rack.png', alt: 'Two-tier dish drying rack with plates and cups' }],
    stockQuantity: 5, featured: false,
    complementaryCategories: ['cookware', 'kitchen-tools'],
    details: ['Two drying levels', 'Plate slots', 'Cutlery holder', 'Countertop footprint'],
  },
];

export const seedReviews = [
  { product: 'onyx-everyday-frying-pan', reviewerName: 'Ama K.', rating: 5, comment: 'It heats evenly and cleans up quickly. The handle also feels very secure.', createdAt: '2026-07-12T10:00:00.000Z' },
  { product: 'onyx-everyday-frying-pan', reviewerName: 'Esi N.', rating: 4, comment: 'A useful everyday size and the nonstick surface has been reliable so far.', createdAt: '2026-08-03T14:30:00.000Z' },
  { product: 'tide-ceramic-mixing-bowls', reviewerName: 'Adwoa S.', rating: 5, comment: 'The sizes are practical and the colour looks beautiful on the table.', createdAt: '2026-08-20T09:15:00.000Z' },
  { product: 'forge-seven-piece-knife-set', reviewerName: 'Kojo A.', rating: 4, comment: 'A tidy set with the knives I use most. The block does not take much space.', createdAt: '2026-06-28T16:45:00.000Z' },
  { product: 'ember-compact-air-fryer', reviewerName: 'Naa D.', rating: 5, comment: 'Simple controls, quick results, and a good size for two people.', createdAt: '2026-08-29T18:20:00.000Z' },
  { product: 'clearline-spice-jar-set', reviewerName: 'Akosua B.', rating: 4, comment: 'My spice shelf is much easier to use now. The lids close firmly.', createdAt: '2026-07-31T11:05:00.000Z' },
] as const;
