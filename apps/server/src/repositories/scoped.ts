import { notFound } from '@ubmp/shared';
import { Types, type Model } from 'mongoose';

/**
 * Tenant scoping (F1.6, Q2).
 *
 * Every query on tenant data must carry a `workspaceId`. Rather than trusting
 * each call site to remember, repositories are built from this factory: the
 * scope is bound once and injected into every filter and every insert, so
 * forgetting it is not possible through this interface.
 *
 * The `workspaceId` always comes from the authenticated session (CLAUDE.md), so
 * a scoped repository cannot be pointed at another workspace by a URL or a body.
 *
 * `findById` is the case that matters most: it becomes
 * `findOne({ _id, workspaceId })`, so a guessed identifier belonging to another
 * workspace returns nothing and the route answers 404 rather than data.
 */
export interface WorkspaceScope {
  readonly workspaceId: Types.ObjectId;
}

/**
 * Parses an identifier from a URL.
 *
 * A malformed id is reported as `NOT_FOUND`, not as a validation failure: a
 * caller probing for records should not be able to tell "that is not an id"
 * from "that id is not yours".
 */
export function parseObjectId(value: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(value)) {
    throw notFound('That record does not exist.');
  }
  return new Types.ObjectId(value);
}

export interface ScopedRepository<TDoc> {
  readonly workspaceId: Types.ObjectId;
  findById(id: Types.ObjectId | string): Promise<TDoc | null>;
  /** Like `findById`, but raises `NOT_FOUND` instead of returning `null`. */
  findByIdOrFail(id: Types.ObjectId | string): Promise<TDoc>;
  findOne(filter?: Record<string, unknown>): Promise<TDoc | null>;
  find(
    filter?: Record<string, unknown>,
    options?: { sort?: Record<string, 1 | -1>; skip?: number; limit?: number },
  ): Promise<TDoc[]>;
  count(filter?: Record<string, unknown>): Promise<number>;
  create(data: Record<string, unknown>): Promise<TDoc>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ): Promise<{ matched: number; modified: number }>;
  deleteOne(filter: Record<string, unknown>): Promise<number>;
}

export function scoped<TDoc>(model: Model<TDoc>, scope: WorkspaceScope): ScopedRepository<TDoc> {
  const { workspaceId } = scope;

  /** Every filter passes through here, so the scope cannot be left out. */
  const withScope = (filter: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...filter,
    workspaceId,
  });

  const repository: ScopedRepository<TDoc> = {
    workspaceId,

    async findById(id) {
      const _id = typeof id === 'string' ? parseObjectId(id) : id;
      return model.findOne(withScope({ _id })).lean<TDoc>();
    },

    async findByIdOrFail(id) {
      const found = await repository.findById(id);
      if (found === null) throw notFound('That record does not exist.');
      return found;
    },

    async findOne(filter) {
      return model.findOne(withScope(filter)).lean<TDoc>();
    },

    async find(filter, options) {
      let query = model.find(withScope(filter));
      if (options?.sort !== undefined) query = query.sort(options.sort);
      if (options?.skip !== undefined) query = query.skip(options.skip);
      if (options?.limit !== undefined) query = query.limit(options.limit);
      return query.lean<TDoc[]>();
    },

    async count(filter) {
      return model.countDocuments(withScope(filter));
    },

    async create(data) {
      // The scope is applied last, so a caller cannot write into another
      // workspace by putting a `workspaceId` in the payload.
      //
      // `data` is an open record by design: this factory is generic over every
      // tenant model, so the fields cannot be typed here. Mongoose validates
      // them against the schema at save time, which is the real check.
      const document = new model({ ...data, workspaceId });
      await document.save();
      return document.toObject();
    },

    async updateOne(filter, update) {
      const result = await model.updateOne(withScope(filter), update);
      return { matched: result.matchedCount, modified: result.modifiedCount };
    },

    async deleteOne(filter) {
      const result = await model.deleteOne(withScope(filter));
      return result.deletedCount;
    },
  };

  return repository;
}
