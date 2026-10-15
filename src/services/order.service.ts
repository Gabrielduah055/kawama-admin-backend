import { AppError } from '../errors/AppError.js';
import { createOrderNumber } from '../lib/orders.js';
import { ProductModel } from '../models/ProductSchema.js';
import type { checkoutCreateSchema } from '../validation/schemas.js';
import type { ClientSession } from 'mongoose';
import type { z } from 'zod';

export type CheckoutInput = z.infer<typeof checkoutCreateSchema>;

export interface PendingOrderDraft {
  orderNumber: string;
  customer: CheckoutInput['customer'];
  orderNotes: string;
  items: Array<{
    product: unknown;
    slug: string;
    name: string;
    image?: { src: string; alt: string };
    unitPricePesewas: number;
    quantity: number;
    lineTotalPesewas: number;
  }>;
  currency: 'GHS';
  subtotalPesewas: number;
  productPaymentTotalPesewas: number;
  deliveryPaymentMethod: 'pay_on_delivery';
  deliveryFeeStatus: 'not_quoted';
  paymentProvider: 'paystack';
  paymentStatus: 'pending';
  fulfillmentStatus: 'awaiting_payment';
}

export async function buildPendingOrderDraft(input: CheckoutInput, session?: ClientSession): Promise<PendingOrderDraft> {
  const productIds = input.items.map((item) => item.productId);
  const query = ProductModel.find({ _id: { $in: productIds }, status: 'active' });
  if (session) query.session(session);
  const products = await query.lean();
  const productsById = new Map(products.map((product) => [String(product._id), product]));

  const unavailableProductIds = productIds.filter((productId) => !productsById.has(productId));
  if (unavailableProductIds.length > 0) {
    throw new AppError(409, 'PRODUCT_UNAVAILABLE', 'One or more products are no longer available.', {
      productIds: unavailableProductIds,
    });
  }

  const insufficientStock = input.items.flatMap((item) => {
    const product = productsById.get(item.productId)!;
    const available = Math.max(0, product.stockQuantity - (product.reservedQuantity ?? 0));
    return available < item.quantity
      ? [{ productId: item.productId, available, requested: item.quantity }]
      : [];
  });
  if (insufficientStock.length > 0) {
    throw new AppError(409, 'INSUFFICIENT_STOCK', 'One or more products do not have enough stock.', {
      items: insufficientStock,
    });
  }

  const items = input.items.map((item) => {
    const product = productsById.get(item.productId)!;
    const image = [...(product.images ?? [])].sort((first: any, second: any) => first.position - second.position)[0];
    return {
      product: product._id,
      slug: product.slug,
      name: product.name,
      ...(image ? { image: { src: image.src, alt: image.alt } } : {}),
      unitPricePesewas: product.pricePesewas,
      quantity: item.quantity,
      lineTotalPesewas: product.pricePesewas * item.quantity,
    };
  });
  const subtotalPesewas = items.reduce((total, item) => total + item.lineTotalPesewas, 0);

  return {
    orderNumber: createOrderNumber(),
    customer: input.customer,
    orderNotes: input.orderNotes,
    items,
    currency: 'GHS',
    subtotalPesewas,
    productPaymentTotalPesewas: subtotalPesewas,
    deliveryPaymentMethod: 'pay_on_delivery',
    deliveryFeeStatus: 'not_quoted',
    paymentProvider: 'paystack',
    paymentStatus: 'pending',
    fulfillmentStatus: 'awaiting_payment',
  };
}
