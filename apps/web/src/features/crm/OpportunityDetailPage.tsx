import { PERMISSIONS } from '@ubmp/domain';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { ApiError, apiRequest } from '../../lib/api.js';
import { useSession } from '../auth/session.js';
import { CustomFieldInputs } from './CustomFieldInputs.js';
import {
  opportunitySchema,
  useCustomFields,
  useMoveOpportunity,
  usePipelines,
  useUpdateOpportunity,
} from './crm-api.js';
import { MoveToStageMenu } from './MoveToStageMenu.js';

/**
 * One opportunity, with its pipeline's custom fields rendered from their
 * definitions (F2.2, F2.3).
 *
 * The move control and the field editor are deliberately adjacent: a blocked
 * move names the fields it needs, and they are right there to fill in (F2.4).
 */
export function OpportunityDetailPage() {
  const { opportunityId = '' } = useParams();
  const session = useSession();

  const opportunity = useQuery({
    queryKey: ['opportunity', opportunityId],
    queryFn: () => apiRequest(`/api/opportunities/${opportunityId}`, opportunitySchema),
  });

  const pipelines = usePipelines();
  const pipeline = (pipelines.data?.pipelines ?? []).find(
    (candidate) => candidate.id === opportunity.data?.pipelineId,
  );
  const customFields = useCustomFields('opportunity', pipeline?.id);

  const update = useUpdateOpportunity();
  const move = useMoveOpportunity();

  const [values, setValues] = useState<Record<string, unknown>>({});

  // Seeded from the record once it arrives, so the editor starts from what is
  // stored rather than from empty inputs.
  useEffect(() => {
    if (opportunity.data !== undefined) setValues(opportunity.data.customFields);
  }, [opportunity.data]);

  const permissions = session.data?.membership.permissions ?? [];
  const canEdit = permissions.includes(PERMISSIONS.CRM_EDIT);

  const fieldErrors =
    move.error instanceof ApiError
      ? (move.error.fields ?? {})
      : update.error instanceof ApiError
        ? (update.error.fields ?? {})
        : {};

  if (opportunity.isPending) {
    return (
      <p role="status" className="p-6 text-sm text-slate-600 dark:text-slate-400">
        Loading the opportunity…
      </p>
    );
  }

  if (opportunity.error !== null) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <Alert error={opportunity.error} />
        <p className="mt-4">
          <Link to="/pipeline" className="text-sm underline">
            Back to the pipeline
          </Link>
        </p>
      </div>
    );
  }

  const record = opportunity.data;
  if (record === undefined) return null;

  const stage = pipeline?.stages.find((candidate) => candidate.id === record.stageId);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
      <p className="text-sm">
        <Link
          to="/pipeline"
          className="text-slate-600 underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none dark:text-slate-400"
        >
          ← Pipeline
        </Link>
      </p>

      <h1 className="mt-3 text-2xl font-bold break-words text-slate-900 dark:text-slate-50">
        {record.name}
      </h1>

      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-slate-600 dark:text-slate-400">
        <div className="flex gap-1">
          <dt>Stage:</dt>
          <dd className="text-slate-900 dark:text-slate-100">{stage?.name ?? record.stageId}</dd>
        </div>
        <div className="flex gap-1">
          <dt>Outcome:</dt>
          <dd className="text-slate-900 dark:text-slate-100">{record.stageOutcome}</dd>
        </div>
        <div className="flex gap-1">
          <dt>Value:</dt>
          <dd className="text-slate-900 dark:text-slate-100">
            {record.valueMasked === true
              ? 'Hidden from you'
              : record.value === null
                ? 'Not recorded'
                : `${record.currency ?? ''} ${(record.value / 100).toFixed(2)}`}
          </dd>
        </div>
        {record.contactId !== null && (
          <div className="flex gap-1">
            <dt>Contact:</dt>
            <dd>
              <Link
                to={`/contacts/${record.contactId}`}
                className="text-slate-900 underline focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none dark:text-slate-100"
              >
                Open contact
              </Link>
            </dd>
          </div>
        )}
      </dl>

      {canEdit && pipeline !== undefined && (
        <section
          aria-labelledby="stage-heading"
          className="mt-8 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900"
        >
          <h2
            id="stage-heading"
            className="text-base font-semibold text-slate-900 dark:text-slate-50"
          >
            Move to another stage
          </h2>

          <div className="mt-3 max-w-sm">
            <MoveToStageMenu
              stages={pipeline.stages}
              currentStageId={record.stageId}
              busy={move.isPending}
              label={`Move ${record.name} to`}
              onMove={(stageId) => {
                if (stageId === record.stageId) return;
                // The current field values travel with the move, so filling the
                // missing fields and moving is one action (F2.4).
                move.mutate({
                  id: record.id,
                  stageId,
                  version: record.version,
                  customFields: values,
                });
              }}
            />
          </div>

          <div aria-live="polite" className="mt-3">
            {move.error !== null && <Alert error={move.error} />}
            {move.isSuccess && <Notice>Moved.</Notice>}
          </div>
        </section>
      )}

      <section
        aria-labelledby="fields-heading"
        className="mt-8 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900"
      >
        <h2
          id="fields-heading"
          className="text-base font-semibold text-slate-900 dark:text-slate-50"
        >
          Details
        </h2>

        {(customFields.data?.customFields ?? []).length === 0 ? (
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
            This pipeline has no custom fields yet.
          </p>
        ) : (
          <form
            noValidate
            className="mt-4 flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              update.mutate({ id: record.id, customFields: values, version: record.version });
            }}
          >
            {/* Rendered from this pipeline's definitions, so two pipelines show
                different fields for the same contact (F2.3). */}
            <CustomFieldInputs
              definitions={customFields.data?.customFields ?? []}
              values={values}
              stageId={record.stageId}
              errors={fieldErrors}
              disabled={!canEdit}
              onChange={(key, value) => {
                setValues((current) => ({ ...current, [key]: value }));
              }}
            />

            <div aria-live="polite">
              {update.error !== null && <Alert error={update.error} />}
              {update.isSuccess && <Notice>Saved.</Notice>}
            </div>

            {canEdit && (
              <div>
                <Button type="submit" busy={update.isPending} busyLabel="Saving…">
                  Save details
                </Button>
              </div>
            )}
          </form>
        )}
      </section>
    </div>
  );
}
