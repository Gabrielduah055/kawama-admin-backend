import type { RequestHandler } from 'express';
import mongoose, { type ClientSession } from 'mongoose';
import { AppError } from '../errors/AppError.js';
import {
  toAdminCustomer,
  toAdminOrderDetail,
  toAdminOrderSummary,
} from '../lib/admin-commerce.js';
import { escapeRegex, toPesewas } from '../lib/catalog.js';
import { CustomerModel } from '../models/CustomerSchema.js';
import { OrderModel } from '../models/OrderSchema.js';
import { PaymentAttemptModel } from '../models/PaymentAttemptSchema.js';
import { ProductModel } from '../models/ProductSchema.js';
import {
  adminCustomerListQuerySchema,
  adminOrderListQuerySchema,
  deliveryUpdateSchema,
  fulfillmentUpdateSchema,
  objectIdSchema,
} from '../validation/schemas.js';

async function orderDetail(id: string): Promise<Record<string, unknown>> {
  const order = await OrderModel.findById(id).lean();
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  const attempts = await PaymentAttemptModel.find({ order: order._id }).sort({ createdAt: -1 }).lean();
  return toAdminOrderDetail(order as Record<string, any>, attempts as Array<Record<string, any>>);
}

export const getAdminOrders: RequestHandler = async (request, response) => {
  const query = adminOrderListQuerySchema.parse(request.query);
  const filter: Record<string, any> = {};
  if (query.paymentStatus) filter.paymentStatus = query.paymentStatus;
  if (query.fulfillmentStatus) filter.fulfillmentStatus = query.fulfillmentStatus;
  if (query.deliveryFeeStatus) filter.deliveryFeeStatus = query.deliveryFeeStatus;
  if (query.q) {
    const expression = new RegExp(escapeRegex(query.q), 'i');
    filter.$or = [
      { orderNumber: expression },
      { paymentReference: expression },
      { 'customer.fullName': expression },
      { 'customer.email': expression },
      { 'customer.whatsappNumber': expression },
    ];
  }
  if (query.from || query.to) {
    const createdAt: Record<string, Date> = {};
    if (query.from) createdAt.$gte = query.from;
    if (query.to) {
      const rawTo = typeof request.query.to === 'string' ? request.query.to : '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(rawTo)) {
        const exclusiveEnd = new Date(query.to);
        exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
        createdAt.$lt = exclusiveEnd;
      } else {
        createdAt.$lte = query.to;
      }
    }
    filter.createdAt = createdAt;
  }

  const [orders, total] = await Promise.all([
    OrderModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    OrderModel.countDocuments(filter),
  ]);
  response.status(200).json({
    message: 'Orders fetched successfully',
    data: orders.map((order) => toAdminOrderSummary(order as Record<string, any>)),
    meta: { page: query.page, limit: query.limit, total },
  });
};

export const getAdminOrderById: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.id);
  response.status(200).json({ message: 'Order fetched successfully', data: await orderDetail(id) });
};

const allowedFulfillmentTransitions: Readonly<Record<string, readonly string[]>> = {
  awaiting_payment: ['cancelled'],
  paid_awaiting_delivery: ['processing', 'out_for_delivery', 'delivered'],
  processing: ['out_for_delivery', 'delivered'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
  needs_attention: [],
};

async function releaseReservedInventory(order: any, session: ClientSession): Promise<void> {
  if (order.stockReservationStatus !== 'active') return;
  for (const item of order.items) {
    const result = await ProductModel.updateOne(
      { _id: item.product, reservedQuantity: { $gte: item.quantity } },
      { $inc: { reservedQuantity: -item.quantity } },
      { session },
    );
    if (result.modifiedCount !== 1) {
      throw new AppError(409, 'RESERVATION_RELEASE_FAILED', 'Reserved inventory could not be released safely.');
    }
  }
  order.stockReservationStatus = 'released';
}

export const updateAdminOrderFulfillment: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.id);
  const { status } = fulfillmentUpdateSchema.parse(request.body);

  await mongoose.connection.transaction(async (session) => {
    const order = await OrderModel.findById(id).session(session);
    if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
    if (order.fulfillmentStatus === status) return;

    if (status === 'cancelled' && (order.paymentStatus === 'paid' || order.paymentStatus === 'refunded')) {
      throw new AppError(409, 'PAID_ORDER_REQUIRES_REFUND', 'A paid order must use a refund workflow before cancellation.');
    }

    const allowed = allowedFulfillmentTransitions[order.fulfillmentStatus] ?? [];
    if (!allowed.includes(status)) {
      throw new AppError(
        409,
        'FULFILLMENT_TRANSITION_NOT_ALLOWED',
        `The order cannot move from ${order.fulfillmentStatus} to ${status}.`,
        { currentStatus: order.fulfillmentStatus, requestedStatus: status },
      );
    }

    if (status === 'cancelled') {
      await releaseReservedInventory(order, session);
      order.fulfillmentStatus = 'cancelled';
      order.paymentStatus = 'failed';
      order.cancelledAt = new Date();
      await PaymentAttemptModel.updateMany(
        { order: order._id, status: { $in: ['initializing', 'initialized'] } },
        { status: 'failed', lastErrorCode: 'ADMIN_CANCELLED' },
        { session },
      );
    } else {
      if (order.paymentStatus !== 'paid') {
        throw new AppError(409, 'ORDER_NOT_PAID', 'Only a verified paid order can enter fulfillment.');
      }
      order.fulfillmentStatus = status;
      if (status === 'delivered') order.deliveredAt = new Date();
    }
    await order.save({ session });
  });

  response.status(200).json({
    message: 'Order fulfillment updated successfully',
    data: await orderDetail(id),
  });
};

export const updateAdminOrderDelivery: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.id);
  const input = deliveryUpdateSchema.parse(request.body);
  const order = await OrderModel.findById(id);
  if (!order) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  if (order.paymentStatus !== 'paid') {
    throw new AppError(409, 'ORDER_NOT_PAID', 'Delivery details can only be updated for a verified paid order.');
  }

  if (input.deliveryFeeStatus === 'not_quoted') {
    order.deliveryFeePesewas = null;
  } else if (input.deliveryFeeStatus === 'waived') {
    order.deliveryFeePesewas = 0;
  } else {
    if (input.deliveryFee !== undefined) order.deliveryFeePesewas = toPesewas(input.deliveryFee);
    if (order.deliveryFeePesewas === null || order.deliveryFeePesewas === undefined) {
      throw new AppError(409, 'DELIVERY_FEE_REQUIRED', 'Set a delivery fee before marking it quoted or collected.');
    }
  }
  order.deliveryFeeStatus = input.deliveryFeeStatus;
  await order.save();

  response.status(200).json({
    message: 'Order delivery details updated successfully',
    data: await orderDetail(id),
  });
};

export const getAdminCustomers: RequestHandler = async (request, response) => {
  const query = adminCustomerListQuerySchema.parse(request.query);
  const filter: Record<string, any> = {};
  if (query.status) filter.status = query.status;
  if (query.q) {
    const expression = new RegExp(escapeRegex(query.q), 'i');
    filter.$or = [
      { fullName: expression },
      { email: expression },
      { whatsappNumber: expression },
    ];
  }
  const [customers, total] = await Promise.all([
    CustomerModel.find(filter)
      .sort({ lastPaidOrderAt: -1, createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean(),
    CustomerModel.countDocuments(filter),
  ]);
  response.status(200).json({
    message: 'Customers fetched successfully',
    data: customers.map((customer) => toAdminCustomer(customer as Record<string, any>)),
    meta: { page: query.page, limit: query.limit, total },
  });
};

export const getAdminCustomerById: RequestHandler = async (request, response) => {
  const id = objectIdSchema.parse(request.params.id);
  const customer = await CustomerModel.findById(id).lean();
  if (!customer) throw new AppError(404, 'CUSTOMER_NOT_FOUND', 'Customer not found.');
  const [orders, orderCount] = await Promise.all([
    OrderModel.find({ customerRecord: customer._id }).sort({ createdAt: -1 }).limit(20).lean(),
    OrderModel.countDocuments({ customerRecord: customer._id }),
  ]);
  response.status(200).json({
    message: 'Customer fetched successfully',
    data: {
      ...toAdminCustomer(customer as Record<string, any>),
      orderCount,
      recentOrders: orders.map((order) => toAdminOrderSummary(order as Record<string, any>)),
    },
  });
};

export const getAdminDashboardSummary: RequestHandler = async (_request, response) => {
  const [orderRows, customerRows, inventoryRows, recentOrders] = await Promise.all([
    OrderModel.aggregate([
      {
        $group: {
          _id: null,
          totalOrders: { $sum: 1 },
          pendingPaymentOrders: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'pending'] }, 1, 0] } },
          paidOrders: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, 1, 0] } },
          refundedOrders: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'refunded'] }, 1, 0] } },
          needsAttentionOrders: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'needs_attention'] }, 1, 0] } },
          awaitingDeliveryOrders: {
            $sum: {
              $cond: [
                { $in: ['$fulfillmentStatus', ['paid_awaiting_delivery', 'processing', 'out_for_delivery']] },
                1,
                0,
              ],
            },
          },
          deliveredOrders: { $sum: { $cond: [{ $eq: ['$fulfillmentStatus', 'delivered'] }, 1, 0] } },
          cancelledOrders: { $sum: { $cond: [{ $eq: ['$fulfillmentStatus', 'cancelled'] }, 1, 0] } },
          grossProductRevenuePesewas: {
            $sum: { $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$productPaymentTotalPesewas', 0] },
          },
          collectedDeliveryFeesPesewas: {
            $sum: { $cond: [{ $eq: ['$deliveryFeeStatus', 'collected'] }, { $ifNull: ['$deliveryFeePesewas', 0] }, 0] },
          },
        },
      },
    ]),
    CustomerModel.aggregate([
      {
        $group: {
          _id: null,
          totalCustomers: { $sum: 1 },
          activeCustomers: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
          repeatCustomers: { $sum: { $cond: [{ $gt: ['$paidOrderCount', 1] }, 1, 0] } },
        },
      },
    ]),
    ProductModel.aggregate([
      { $match: { status: 'active' } },
      {
        $addFields: {
          availableForSale: {
            $max: [0, { $subtract: ['$stockQuantity', { $ifNull: ['$reservedQuantity', 0] }] }],
          },
        },
      },
      {
        $group: {
          _id: null,
          activeProducts: { $sum: 1 },
          reservedUnits: { $sum: { $ifNull: ['$reservedQuantity', 0] } },
          lowStockProducts: {
            $sum: {
              $cond: [
                { $and: [{ $gt: ['$availableForSale', 0] }, { $lte: ['$availableForSale', '$lowStockThreshold'] }] },
                1,
                0,
              ],
            },
          },
          outOfStockProducts: { $sum: { $cond: [{ $lte: ['$availableForSale', 0] }, 1, 0] } },
        },
      },
    ]),
    OrderModel.find({}).sort({ createdAt: -1 }).limit(6).lean(),
  ]);

  const orders = orderRows[0] ?? {};
  const customers = customerRows[0] ?? {};
  const inventory = inventoryRows[0] ?? {};
  response.status(200).json({
    message: 'Dashboard summary fetched successfully',
    data: {
      orders: {
        total: orders.totalOrders ?? 0,
        pendingPayment: orders.pendingPaymentOrders ?? 0,
        paid: orders.paidOrders ?? 0,
        refunded: orders.refundedOrders ?? 0,
        needsAttention: orders.needsAttentionOrders ?? 0,
        awaitingDelivery: orders.awaitingDeliveryOrders ?? 0,
        delivered: orders.deliveredOrders ?? 0,
        cancelled: orders.cancelledOrders ?? 0,
      },
      revenue: {
        currency: 'GHS',
        grossProductRevenuePesewas: orders.grossProductRevenuePesewas ?? 0,
        collectedDeliveryFeesPesewas: orders.collectedDeliveryFeesPesewas ?? 0,
      },
      customers: {
        total: customers.totalCustomers ?? 0,
        active: customers.activeCustomers ?? 0,
        repeat: customers.repeatCustomers ?? 0,
      },
      inventory: {
        activeProducts: inventory.activeProducts ?? 0,
        reservedUnits: inventory.reservedUnits ?? 0,
        lowStockProducts: inventory.lowStockProducts ?? 0,
        outOfStockProducts: inventory.outOfStockProducts ?? 0,
      },
      recentOrders: recentOrders.map((order) => toAdminOrderSummary(order as Record<string, any>)),
    },
  });
};
