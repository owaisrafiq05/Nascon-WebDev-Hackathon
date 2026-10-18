import { googleCalendarProvider, type CalendarProvider } from './google/google.js';
import { stripePaymentProvider, type PaymentProvider } from './stripe/stripe.js';
import { telegramNotificationProvider, type NotificationProvider } from './telegram/telegram.js';
import { twilioMessagingProvider, type MessagingProvider } from './twilio/twilio.js';

/**
 * The providers business code talks to (Q14).
 *
 * Services ask this registry for a `MessagingProvider`, never for Twilio, so a
 * provider can be swapped (or faked in a test) without touching the services.
 */
export interface Providers {
  messaging: MessagingProvider;
  payments: PaymentProvider;
  calendar: CalendarProvider;
  notifications: NotificationProvider;
}

const defaults: Providers = {
  messaging: twilioMessagingProvider,
  payments: stripePaymentProvider,
  calendar: googleCalendarProvider,
  notifications: telegramNotificationProvider,
};

let current: Providers = { ...defaults };

export function providers(): Providers {
  return current;
}

/** Tests only: replace one or more providers with fakes. */
export function overrideProviders(overrides: Partial<Providers>): void {
  current = { ...current, ...overrides };
}

export function resetProviders(): void {
  current = { ...defaults };
}
