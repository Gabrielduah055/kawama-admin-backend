import { getEnvironment } from '../config/environment.js';

export interface StorePolicies {
  storeName: 'Kawama';
  currency: 'GHS';
  checkout: {
    productPaymentProvider: 'Paystack';
    productPaymentScope: 'products_only';
    deliveryPaymentMethod: 'pay_on_delivery';
  };
  deliveryPolicy: string | null;
  paymentPolicy: string | null;
  returnPolicy: string | null;
  contact: {
    email: string | null;
    phone: string | null;
    whatsappUrl: string | null;
  };
}

export function getApprovedStorePolicies(): StorePolicies {
  const environment = getEnvironment();
  return {
    storeName: 'Kawama',
    currency: 'GHS',
    checkout: {
      productPaymentProvider: 'Paystack',
      productPaymentScope: 'products_only',
      deliveryPaymentMethod: 'pay_on_delivery',
    },
    deliveryPolicy: environment.STORE_DELIVERY_POLICY ?? null,
    paymentPolicy: environment.STORE_PAYMENT_POLICY ?? null,
    returnPolicy: environment.STORE_RETURN_POLICY ?? null,
    contact: {
      email: environment.STORE_CONTACT_EMAIL ?? null,
      phone: environment.STORE_CONTACT_PHONE ?? null,
      whatsappUrl: environment.STORE_CONTACT_WHATSAPP_URL ?? null,
    },
  };
}
