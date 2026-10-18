import type { Types } from 'mongoose';

import { loadServerConfig, type ServerConfig } from '../config.js';
import { MembershipModel } from '../db/models/membership.js';
import { PipelineModel } from '../db/models/pipeline.js';
import { UserModel } from '../db/models/user.js';
import { WorkspaceSettingsModel } from '../db/models/workspace-settings.js';
import { LeadFormModel } from '../db/models/lead-form.js';
import { connectToDatabase, disconnectFromDatabase } from '../db/mongoose.js';
import { createLogger, type Logger } from '../logger.js';
import { signUp } from '../services/auth-service.js';
import { actorFor, createCompany, createContact } from '../services/crm-service.js';
import { connectIntegration } from '../services/integration-service.js';
import { createLead, settingsFor } from '../services/lead-service.js';
import { acceptInvite, inviteMember } from '../services/membership-service.js';
import { createOpportunity } from '../services/opportunity-service.js';
import { issueSession, resolveSession, type AuthContext } from '../services/session-service.js';

/**
 * `pnpm seed`: demo workspaces, users, contacts, a pipeline with opportunities
 * and sample leads (Q13). Safe to run twice: an existing demo owner stops it.
 *
 * Timers are short (30-second acknowledgement window) so escalation can be
 * watched live during a demo. Integrations are connected for the first
 * workspace only when their credentials are present in the environment.
 */
export const DEMO_PASSWORD = 'demo-password-123';

async function contextFor(
  ids: { userId: Types.ObjectId; workspaceId: Types.ObjectId; membershipId: Types.ObjectId },
  config: ServerConfig,
): Promise<AuthContext> {
  const session = await issueSession({ ...ids, ttlMs: config.sessionTtlMs });
  const auth = await resolveSession(session.token);
  if (auth === null) throw new Error('seed session did not resolve');
  return auth;
}

async function addMember(
  owner: AuthContext,
  email: string,
  name: string,
  baseLevel: 'admin' | 'user',
  config: ServerConfig,
): Promise<Types.ObjectId> {
  const invite = await inviteMember(owner, { email, baseLevel, ttlMs: config.inviteTtlMs });
  await acceptInvite({ token: invite.token, name, password: DEMO_PASSWORD });
  const user = await UserModel.findOne({ email }).lean();
  if (user === null) throw new Error(`user ${email} missing`);
  const membership = await MembershipModel.findOne({
    workspaceId: owner.workspaceId,
    userId: user._id,
  }).lean();
  if (membership === null) throw new Error(`membership for ${email} missing`);
  return membership._id;
}

async function connectDemoIntegrations(owner: AuthContext, config: ServerConfig, logger: Logger) {
  const { demo } = config.integrations;
  const attempts: [string, 'twilio' | 'stripe' | 'telegram', Record<string, string> | null][] = [
    ['Twilio', 'twilio', demo.twilio],
    ['Stripe', 'stripe', demo.stripe],
    [
      'Telegram',
      'telegram',
      demo.telegramBotToken === null ? null : { botToken: demo.telegramBotToken },
    ],
  ];
  for (const [label, provider, values] of attempts) {
    if (values === null) continue;
    try {
      await connectIntegration({
        workspaceId: owner.workspaceId,
        provider,
        values,
        actor: await actorFor(owner),
        config: config.integrations,
      });
      logger.info({ provider }, `${label} connected for the demo workspace`);
    } catch (error) {
      logger.warn(
        { provider, err: error },
        `${label} could not be connected; connect it in the UI`,
      );
    }
  }
}

async function seedAcme(config: ServerConfig, logger: Logger): Promise<void> {
  const created = await signUp({
    email: 'owner@acme.test',
    password: DEMO_PASSWORD,
    name: 'Olivia Owner',
    workspaceName: 'Acme Solar',
  });
  const owner = await contextFor(created, config);

  const admin = await addMember(owner, 'admin@acme.test', 'Adam Admin', 'admin', config);
  const sara = await addMember(owner, 'sara@acme.test', 'Sara Sales', 'user', config);
  const omar = await addMember(owner, 'omar@acme.test', 'Omar Sales', 'user', config);

  await MembershipModel.updateMany(
    { workspaceId: owner.workspaceId },
    { $set: { availabilityStatus: 'available' } },
  );

  await settingsFor(owner.workspaceId);
  await WorkspaceSettingsModel.updateOne(
    { workspaceId: owner.workspaceId },
    {
      $set: {
        acknowledgementWindowSeconds: 30,
        maxOpenLeadsPerEmployee: 5,
        escalationLevels: [
          { target: 'next_eligible', windowSeconds: 30 },
          { target: 'backup', windowSeconds: 30 },
          { target: 'manager', windowSeconds: 60 },
        ],
        backupMembershipId: admin,
        managerMembershipId: created.membershipId,
        idleRecoveryMinutes: 10,
        recoveryMinEscalations: 2,
      },
    },
  );

  await LeadFormModel.create({
    workspaceId: owner.workspaceId,
    name: 'Website quote form',
    sourceLabel: 'Website quote form',
  });

  const actor = await actorFor(owner);
  const sunny = await createCompany(
    owner,
    { name: 'Sunny Homes Ltd', domain: 'sunnyhomes.test' },
    actor,
  );
  const contacts = [
    {
      firstName: 'Ayesha',
      lastName: 'Khan',
      email: 'ayesha@example.com',
      phone: '+923001234567',
      owner: sara,
    },
    {
      firstName: 'Bilal',
      lastName: 'Ahmed',
      email: 'bilal@example.com',
      phone: '+923007654321',
      owner: omar,
    },
    {
      firstName: 'Clara',
      lastName: 'Stone',
      email: 'clara@sunnyhomes.test',
      phone: '+15551230001',
      owner: sara,
    },
    {
      firstName: 'David',
      lastName: 'Lee',
      email: 'david@example.com',
      phone: '+15551230002',
      owner: omar,
    },
  ];

  const pipeline = await PipelineModel.findOne({
    workspaceId: owner.workspaceId,
    isDefault: true,
  }).lean();
  const stages = pipeline?.stages.filter((stage) => stage.outcome === 'open') ?? [];

  let index = 0;
  for (const entry of contacts) {
    const contact = await createContact(
      owner,
      {
        firstName: entry.firstName,
        lastName: entry.lastName,
        email: entry.email,
        phone: entry.phone,
        companyId: index === 2 ? sunny._id.toString() : null,
        tags: index % 2 === 0 ? ['residential'] : ['commercial'],
        ownerMembershipId: entry.owner.toString(),
      },
      actor,
    );
    const stage = stages[index % Math.max(stages.length, 1)];
    await createOpportunity(
      owner,
      {
        name: `${entry.firstName} — ${index % 2 === 0 ? 'rooftop system' : 'commercial array'}`,
        contactId: contact._id.toString(),
        value: (index + 1) * 250_000,
        currency: 'USD',
        ...(stage === undefined ? {} : { stageId: stage.id }),
      },
      actor,
    );
    index += 1;
  }

  for (const name of ['Hamza', 'Iqra', 'Jamal']) {
    await createLead({
      workspaceId: owner.workspaceId,
      source: 'manual',
      sourceLabel: 'Phone call',
      contact: { firstName: name, phone: null, email: `${name.toLowerCase()}@example.com` },
      actor,
    });
  }

  await connectDemoIntegrations(owner, config, logger);
}

async function seedBeta(config: ServerConfig): Promise<void> {
  const created = await signUp({
    email: 'owner@beta.test',
    password: DEMO_PASSWORD,
    name: 'Bella Owner',
    workspaceName: 'Beta Clinic',
  });
  const owner = await contextFor(created, config);
  const actor = await actorFor(owner);
  await createContact(
    owner,
    { firstName: 'Private', lastName: 'Patient', phone: '+15559990000' },
    actor,
  );
}

async function seed(): Promise<void> {
  const config = loadServerConfig();
  const logger = createLogger(config);

  if (config.isProduction) {
    throw new Error('Refusing to seed: NODE_ENV is production.');
  }

  await connectToDatabase({ uri: config.mongoUri, logger });

  if ((await UserModel.countDocuments({ email: 'owner@acme.test' })) > 0) {
    logger.info('demo data already present; nothing inserted');
  } else {
    await seedAcme(config, logger);
    await seedBeta(config);
    logger.info(
      {
        password: DEMO_PASSWORD,
        acme: ['owner@acme.test', 'admin@acme.test', 'sara@acme.test', 'omar@acme.test'],
        beta: ['owner@beta.test'],
      },
      'seed complete: two isolated workspaces',
    );
  }

  await disconnectFromDatabase();
}

seed()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
