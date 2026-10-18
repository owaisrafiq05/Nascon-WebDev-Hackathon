import express, { Router, type Request, type Response } from 'express';

import type { IntegrationsConfig } from '../../config.js';
import { IntegrationModel, type IntegrationDoc } from '../../db/models/integration.js';
import { verifyStripeSignature } from '../../integrations/stripe/stripe.js';
import { verifyTwilioSignature } from '../../integrations/twilio/twilio.js';
import type { Logger } from '../../logger.js';
import {
  recordIntegrationEvent,
  isDuplicateKeyError,
} from '../../repositories/integration-events.js';
import { decryptSecret } from '../../services/secret-box.js';
import { applyStatusCallback, receiveInboundMessage } from '../../services/messaging-service.js';
import { applyStripeEvent } from '../../services/payment-service.js';
import { requireParam } from '../params.js';

/**
 * Provider webhooks (I1.1, I1.2, I1.4, I2.2 - I2.5).
 *
 * Mounted **before** the JSON and form parsers, with a raw body parser of its
 * own, so the signature is checked on the exact bytes the provider signed and
 * before anything is parsed or written (CLAUDE.md). A request that fails the
 * check is recorded in the synchronization history as `rejected` and changes
 * nothing.
 *
 * The workspace comes from the unguessable `webhookKey` in the path, never from
 * the body; the signature then proves the request came from the provider
 * holding that workspace's secret.
 */
const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

async function integrationFor(
  provider: 'twilio' | 'stripe',
  key: string,
): Promise<IntegrationDoc | null> {
  if (!/^[0-9a-f]{48}$/.test(key)) return null;
  return IntegrationModel.findOne({
    provider,
    webhookKey: key,
    status: { $ne: 'disconnected' },
  }).lean();
}

/** A redelivery is acknowledged and recorded, never processed again (I1.8, I2.4). */
async function recordDuplicate(
  provider: 'twilio' | 'stripe',
  integration: IntegrationDoc,
  kind: string,
  reference: string | null,
): Promise<void> {
  await recordIntegrationEvent({
    workspaceId: integration.workspaceId,
    provider,
    direction: 'inbound',
    kind,
    result: 'duplicate',
    reference,
  });
}

function rawBody(req: Request): Buffer {
  return Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
}

export function createWebhooksRouter(config: IntegrationsConfig, logger: Logger): Router {
  const router = Router();
  // Per route, never `router.use`: this router is mounted on /api, and a
  // router-level parser would consume every other endpoint's body too.
  const raw = express.raw({ type: () => true, limit: '256kb' });

  /** The URL Twilio signed: the public address it called, path included. */
  const signedUrl = (req: Request): string =>
    `${config.publicBaseUrl ?? `${req.protocol}://${req.get('host') ?? ''}`}${req.originalUrl}`;

  const twilioHandler =
    (kind: 'inbound' | 'status') =>
    async (req: Request, res: Response): Promise<void> => {
      const key = requireParam(req, 'key');
      const integration = await integrationFor('twilio', key);
      if (integration === null || config.encryptionKey === null) {
        await recordIntegrationEvent({
          workspaceId: null,
          provider: 'twilio',
          direction: 'inbound',
          kind: `webhook.${kind}`,
          result: 'rejected',
          error: 'unknown webhook address',
        });
        res.status(404).type('text/plain').send('Not found');
        return;
      }

      const params = Object.fromEntries(new URLSearchParams(rawBody(req).toString('utf8')));
      const authToken = decryptSecret(integration.secrets['authToken'] ?? '', config.encryptionKey);
      if (
        !verifyTwilioSignature(authToken, signedUrl(req), params, req.get('x-twilio-signature'))
      ) {
        // Forged or altered: rejected and recorded, nothing written (I1.2).
        await recordIntegrationEvent({
          workspaceId: integration.workspaceId,
          provider: 'twilio',
          direction: 'inbound',
          kind: `webhook.${kind}`,
          result: 'rejected',
          reference: params['MessageSid'] ?? null,
          error: 'invalid X-Twilio-Signature',
        });
        res.status(403).type('text/plain').send('Invalid signature');
        return;
      }

      try {
        const outcome =
          kind === 'inbound'
            ? (await receiveInboundMessage(integration, params)).outcome
            : await applyStatusCallback(integration, params);
        if (outcome === 'duplicate')
          await recordDuplicate(
            'twilio',
            integration,
            `webhook.${kind}`,
            params['MessageSid'] ?? null,
          );
        res.status(200).type('text/xml').send(TWIML_EMPTY);
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          // Two deliveries raced; the other one stored it (I1.8).
          res.status(200).type('text/xml').send(TWIML_EMPTY);
          return;
        }
        logger.error({ err: error }, 'twilio webhook processing failed');
        await recordIntegrationEvent({
          workspaceId: integration.workspaceId,
          provider: 'twilio',
          direction: 'inbound',
          kind: `webhook.${kind}`,
          result: 'error',
          reference: params['MessageSid'] ?? null,
          error,
        });
        // 500 so Twilio retries; the claim rolled back with the failure.
        res.status(500).type('text/plain').send('Processing failed');
      }
    };

  router.post('/webhooks/twilio/:key/inbound', raw, twilioHandler('inbound'));
  router.post('/webhooks/twilio/:key/status', raw, twilioHandler('status'));

  router.post('/webhooks/stripe/:key', raw, async (req, res) => {
    const key = requireParam(req, 'key');
    const integration = await integrationFor('stripe', key);
    if (integration === null || config.encryptionKey === null) {
      await recordIntegrationEvent({
        workspaceId: null,
        provider: 'stripe',
        direction: 'inbound',
        kind: 'webhook',
        result: 'rejected',
        error: 'unknown webhook address',
      });
      res.status(404).json({ received: false });
      return;
    }

    const body = rawBody(req);
    const secret = decryptSecret(integration.secrets['webhookSecret'] ?? '', config.encryptionKey);
    if (!verifyStripeSignature(secret, body, req.get('stripe-signature'))) {
      await recordIntegrationEvent({
        workspaceId: integration.workspaceId,
        provider: 'stripe',
        direction: 'inbound',
        kind: 'webhook',
        result: 'rejected',
        error: 'invalid Stripe-Signature',
      });
      res.status(400).json({ received: false, error: 'invalid signature' });
      return;
    }

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(body.toString('utf8')) as Record<string, unknown>;
    } catch {
      res.status(400).json({ received: false, error: 'invalid JSON' });
      return;
    }

    try {
      const outcome = await applyStripeEvent(integration, event);
      if (outcome === 'duplicate') {
        await recordDuplicate(
          'stripe',
          integration,
          'webhook',
          typeof event['id'] === 'string' ? event['id'] : null,
        );
      }
      res.status(200).json({ received: true, outcome });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        res.status(200).json({ received: true, outcome: 'duplicate' });
        return;
      }
      logger.error({ err: error }, 'stripe webhook processing failed');
      await recordIntegrationEvent({
        workspaceId: integration.workspaceId,
        provider: 'stripe',
        direction: 'inbound',
        kind: `webhook.${typeof event['type'] === 'string' ? event['type'] : 'unknown'}`,
        result: 'error',
        reference: typeof event['id'] === 'string' ? event['id'] : null,
        error,
      });
      res.status(500).json({ received: false });
    }
  });

  return router;
}
