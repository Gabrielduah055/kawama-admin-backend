function isoDate(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function compactDateFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export function toAdminOrderSummary(order: Record<string, any>): Record<string, unknown> {
  const items = Array.isArray(order.items) ? order.items : [];
  const deliveryFeePesewas = typeof order.deliveryFeePesewas === 'number' ? order.deliveryFeePesewas : null;
  return {
    id: String(order._id),
    orderNumber: order.orderNumber,
    customer: {
      fullName: order.customer?.fullName,
      email: order.customer?.email,
      whatsappNumber: order.customer?.whatsappNumber,
    },
    itemCount: items.length,
    unitCount: items.reduce((total: number, item: Record<string, any>) => total + Number(item.quantity ?? 0), 0),
    currency: order.currency,
    subtotalPesewas: order.subtotalPesewas,
    productPaymentTotalPesewas: order.productPaymentTotalPesewas,
    deliveryFeePesewas,
    grandTotalPesewas: Number(order.productPaymentTotalPesewas ?? 0) + (deliveryFeePesewas ?? 0),
    deliveryPaymentMethod: order.deliveryPaymentMethod,
    deliveryFeeStatus: order.deliveryFeeStatus,
    paymentProvider: order.paymentProvider,
    paymentReference: order.paymentReference,
    paymentStatus: order.paymentStatus,
    fulfillmentStatus: order.fulfillmentStatus,
    stockReservationStatus: order.stockReservationStatus,
    ...compactDateFields({
      stockReservationExpiresAt: isoDate(order.stockReservationExpiresAt),
      paidAt: isoDate(order.paidAt),
      deliveredAt: isoDate(order.deliveredAt),
      cancelledAt: isoDate(order.cancelledAt),
      createdAt: isoDate(order.createdAt),
      updatedAt: isoDate(order.updatedAt),
    }),
  };
}

export function toAdminPaymentAttempt(attempt: Record<string, any>): Record<string, unknown> {
  return {
    id: String(attempt._id),
    provider: attempt.provider,
    reference: attempt.reference,
    amountPesewas: attempt.amountPesewas,
    currency: attempt.currency,
    status: attempt.status,
    ...(attempt.providerTransactionId ? { providerTransactionId: attempt.providerTransactionId } : {}),
    ...(attempt.providerStatus ? { providerStatus: attempt.providerStatus } : {}),
    ...(attempt.lastErrorCode ? { lastErrorCode: attempt.lastErrorCode } : {}),
    ...compactDateFields({
      initializedAt: isoDate(attempt.initializedAt),
      verifiedAt: isoDate(attempt.verifiedAt),
      paidAt: isoDate(attempt.paidAt),
      createdAt: isoDate(attempt.createdAt),
      updatedAt: isoDate(attempt.updatedAt),
    }),
  };
}

export function toAdminOrderDetail(
  order: Record<string, any>,
  paymentAttempts: ReadonlyArray<Record<string, any>> = [],
): Record<string, unknown> {
  return {
    ...toAdminOrderSummary(order),
    customerRecordId: order.customerRecord ? String(order.customerRecord._id ?? order.customerRecord) : null,
    customer: {
      fullName: order.customer?.fullName,
      email: order.customer?.email,
      whatsappNumber: order.customer?.whatsappNumber,
      deliveryAddress: order.customer?.deliveryAddress,
      whatsappConsent: order.customer?.whatsappConsent,
    },
    orderNotes: order.orderNotes ?? '',
    items: (order.items ?? []).map((item: Record<string, any>) => ({
      productId: String(item.product?._id ?? item.product),
      slug: item.slug,
      name: item.name,
      ...(item.image?.src ? { image: { src: item.image.src, alt: item.image.alt ?? '' } } : {}),
      unitPricePesewas: item.unitPricePesewas,
      quantity: item.quantity,
      lineTotalPesewas: item.lineTotalPesewas,
    })),
    ...(order.paystackTransactionId ? { paystackTransactionId: order.paystackTransactionId } : {}),
    ...(order.receipt ? { receipt: order.receipt } : {}),
    ...compactDateFields({
      paymentVerifiedAt: isoDate(order.paymentVerifiedAt),
      inventoryCommittedAt: isoDate(order.inventoryCommittedAt),
    }),
    paymentAttempts: paymentAttempts.map(toAdminPaymentAttempt),
  };
}

export function toAdminCustomer(customer: Record<string, any>): Record<string, unknown> {
  return {
    id: String(customer._id),
    fullName: customer.fullName,
    email: customer.email,
    whatsappNumber: customer.whatsappNumber,
    whatsappConsentAt: isoDate(customer.whatsappConsentAt),
    defaultDeliveryAddress: customer.defaultDeliveryAddress,
    paidOrderCount: customer.paidOrderCount ?? 0,
    lifetimeValuePesewas: customer.lifetimeValuePesewas ?? 0,
    lastPaidOrderAt: isoDate(customer.lastPaidOrderAt),
    status: customer.status,
    createdAt: isoDate(customer.createdAt),
    updatedAt: isoDate(customer.updatedAt),
  };
}
