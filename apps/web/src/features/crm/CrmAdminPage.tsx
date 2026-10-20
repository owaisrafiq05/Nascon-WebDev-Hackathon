import { CUSTOM_FIELD_TYPES, PERMISSIONS, type CustomFieldType } from '@ubmp/domain';
import { useState } from 'react';

import { Alert, Notice } from '../../components/Alert.js';
import { Button } from '../../components/Button.js';
import { Field } from '../../components/Field.js';
import { PageTitle, SURFACE } from '../../components/ui.js';
import { ApiError } from '../../lib/api.js';
import { useSession } from '../auth/session.js';
import {
  useAddStage,
  useCreateCustomField,
  useCreatePipeline,
  useCustomFields,
  useDeleteCustomField,
  useDeleteStage,
  usePipelines,
  useRenameStage,
  useReorderStages,
  type Pipeline,
} from './crm-api.js';

/**
 * The Admin configuration screen (F2.2, F2.3, F2.5): custom fields, pipelines
 * and stages.
 *
 * Everything here needs `assignment_rules.manage`. The page refuses to render
 * its controls without it, and the server refuses the same calls regardless
 * (F1.5).
 */
export function CrmAdminPage() {
  const session = useSession();
  const permissions = session.data?.membership.permissions ?? [];
  const canConfigure = permissions.includes(PERMISSIONS.ASSIGNMENT_RULES_MANAGE);

  const pipelines = usePipelines();
  const [pipelineId, setPipelineId] = useState<string | null>(null);

  const available = pipelines.data?.pipelines ?? [];
  const selected = available.find((pipeline) => pipeline.id === pipelineId) ?? available[0];

  if (!canConfigure) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8">
        <PageTitle
          kicker="Workspace"
          sub="You need the “manage assignment rules” permission to change pipelines and fields. Ask an Owner or Admin to grant it."
        >
          Configuration
        </PageTitle>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <PageTitle
        kicker="Workspace"
        sub="Fields and pipelines are specific to this workspace, and changes apply immediately."
      >
        Configuration
      </PageTitle>

      <div aria-live="polite" className="mt-4">
        <Alert error={pipelines.error} />
      </div>

      <NewPipeline />

      {selected !== undefined && (
        <>
          {available.length > 1 && (
            <div className="mt-8 flex items-center gap-2">
              <label
                htmlFor="admin-pipeline"
                className="text-sm font-medium text-slate-800 dark:text-slate-200"
              >
                Configuring
              </label>
              <select
                id="admin-pipeline"
                value={selected.id}
                onChange={(event) => {
                  setPipelineId(event.target.value);
                }}
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              >
                {available.map((pipeline) => (
                  <option key={pipeline.id} value={pipeline.id}>
                    {pipeline.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <Stages pipeline={selected} />
          <CustomFieldAdmin pipeline={selected} />
        </>
      )}
    </div>
  );
}

function NewPipeline() {
  const create = useCreatePipeline();
  const [name, setName] = useState('');
  const [stages, setStages] = useState('');

  return (
    <section
      aria-labelledby="new-pipeline-heading"
      className={`mt-6 ${SURFACE} p-5`}
    >
      <h2
        id="new-pipeline-heading"
        className="text-base font-semibold text-slate-900 dark:text-slate-50"
      >
        New pipeline
      </h2>

      <form
        noValidate
        className="mt-4 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const stageNames = stages
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== '');

          create.mutate(
            { name: name.trim(), ...(stageNames.length === 0 ? {} : { stageNames }) },
            {
              onSuccess: () => {
                setName('');
                setStages('');
              },
            },
          );
        }}
      >
        <Field
          label="Name"
          name="pipelineName"
          required
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <Field
          label="Stages"
          name="stageNames"
          hint="Comma-separated. Leave empty for the default set."
          value={stages}
          onChange={(event) => {
            setStages(event.target.value);
          }}
        />

        <div aria-live="polite">
          <Alert error={create.error} />
          {create.isSuccess && <Notice>Pipeline created.</Notice>}
        </div>

        <div>
          <Button type="submit" busy={create.isPending} busyLabel="Creating…">
            Create pipeline
          </Button>
        </div>
      </form>
    </section>
  );
}

/**
 * Stage management (F2.5): add, rename, reorder and delete.
 *
 * Reordering uses Move up / Move down buttons rather than dragging, so it works
 * from the keyboard without a second mechanism (Q8).
 */
function Stages({ pipeline }: { pipeline: Pipeline }) {
  const addStage = useAddStage();
  const rename = useRenameStage();
  const reorder = useReorderStages();
  const remove = useDeleteStage();

  const [newStage, setNewStage] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState('');

  const move = (stageId: string, direction: -1 | 1): void => {
    const ids = pipeline.stages.map((stage) => stage.id);
    const index = ids.indexOf(stageId);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= ids.length) return;

    const next = [...ids];
    const [moved] = next.splice(index, 1);
    if (moved !== undefined) next.splice(target, 0, moved);

    reorder.mutate({ pipelineId: pipeline.id, stageIds: next });
  };

  /** The count and the destination the server asked for, when it refused (F2.5). */
  const blockedCount =
    remove.error instanceof ApiError &&
    typeof remove.error.fields === 'undefined' &&
    remove.error.code === 'CONFLICT'
      ? remove.error.message
      : null;

  return (
    <section aria-labelledby="stages-heading" className="mt-8">
      <h2 id="stages-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
        Stages in {pipeline.name}
      </h2>

      <div aria-live="polite" className="mt-3">
        <Alert error={addStage.error} />
        <Alert error={rename.error} />
        <Alert error={reorder.error} />
        <Alert error={remove.error} />
        {blockedCount !== null && pendingDelete !== null && (
          <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
            <p className="text-sm text-amber-900 dark:text-amber-200">
              Choose where those opportunities should go, then delete the stage.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="flex flex-col gap-1">
                <label
                  htmlFor="move-to-stage"
                  className="text-xs font-medium text-amber-900 dark:text-amber-200"
                >
                  Move them to
                </label>
                <select
                  id="move-to-stage"
                  value={moveTo}
                  onChange={(event) => {
                    setMoveTo(event.target.value);
                  }}
                  className="rounded-md border border-amber-300 bg-white px-2 py-1.5 text-sm dark:border-amber-800 dark:bg-slate-900 dark:text-slate-100"
                >
                  <option value="">Choose a stage</option>
                  {pipeline.stages
                    .filter((stage) => stage.id !== pendingDelete)
                    .map((stage) => (
                      <option key={stage.id} value={stage.id}>
                        {stage.name}
                      </option>
                    ))}
                </select>
              </div>
              <Button
                type="button"
                variant="danger"
                disabled={moveTo === ''}
                busy={remove.isPending}
                onClick={() => {
                  remove.mutate(
                    { pipelineId: pipeline.id, stageId: pendingDelete, moveToStageId: moveTo },
                    {
                      onSuccess: () => {
                        setPendingDelete(null);
                        setMoveTo('');
                      },
                    },
                  );
                }}
              >
                Move and delete
              </Button>
            </div>
          </div>
        )}
      </div>

      <ol className="mt-3 flex flex-col gap-2">
        {pipeline.stages.map((stage, index) => (
          <li
            key={stage.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-700 dark:bg-slate-900"
          >
            {renaming?.id === stage.id ? (
              <form
                className="flex flex-1 flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  rename.mutate(
                    { pipelineId: pipeline.id, stageId: stage.id, name: renaming.name.trim() },
                    {
                      onSuccess: () => {
                        setRenaming(null);
                      },
                    },
                  );
                }}
              >
                <div className="min-w-0 flex-1">
                  <Field
                    label={`Rename ${stage.name}`}
                    name="stageName"
                    value={renaming.name}
                    onChange={(event) => {
                      setRenaming({ id: stage.id, name: event.target.value });
                    }}
                  />
                </div>
                <Button type="submit" busy={rename.isPending}>
                  Save
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    setRenaming(null);
                  }}
                >
                  Cancel
                </Button>
              </form>
            ) : (
              <>
                <span className="min-w-0">
                  <span className="font-medium break-words text-slate-900 dark:text-slate-100">
                    {stage.name}
                  </span>
                  <span className="ml-2 text-xs text-slate-600 dark:text-slate-400">
                    {stage.outcome}
                  </span>
                </span>

                <span className="flex flex-wrap gap-1">
                  {/* Keyboard-operable reordering (Q8). */}
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={`Move ${stage.name} earlier`}
                    disabled={index === 0 || reorder.isPending}
                    onClick={() => {
                      move(stage.id, -1);
                    }}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={`Move ${stage.name} later`}
                    disabled={index === pipeline.stages.length - 1 || reorder.isPending}
                    onClick={() => {
                      move(stage.id, 1);
                    }}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => {
                      setRenaming({ id: stage.id, name: stage.name });
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    busy={remove.isPending && pendingDelete === stage.id}
                    onClick={() => {
                      setPendingDelete(stage.id);
                      // Tried without a destination first: the server answers
                      // with the count if the stage is occupied (F2.5).
                      remove.mutate({ pipelineId: pipeline.id, stageId: stage.id });
                    }}
                  >
                    Delete
                  </Button>
                </span>
              </>
            )}
          </li>
        ))}
      </ol>

      <form
        noValidate
        className="mt-4 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          addStage.mutate(
            { pipelineId: pipeline.id, name: newStage.trim(), outcome: 'open' },
            {
              onSuccess: () => {
                setNewStage('');
              },
            },
          );
        }}
      >
        <div className="min-w-0 flex-1">
          <Field
            label="Add a stage"
            name="newStage"
            value={newStage}
            onChange={(event) => {
              setNewStage(event.target.value);
            }}
          />
        </div>
        <Button type="submit" busy={addStage.isPending}>
          Add stage
        </Button>
      </form>
    </section>
  );
}

/** Creating and removing custom fields (F2.2, F2.4). */
function CustomFieldAdmin({ pipeline }: { pipeline: Pipeline }) {
  const [entity, setEntity] = useState<'contact' | 'company' | 'opportunity'>('contact');
  const definitions = useCustomFields(entity, entity === 'opportunity' ? pipeline.id : undefined);

  const create = useCreateCustomField();
  const remove = useDeleteCustomField();

  const [draft, setDraft] = useState({
    key: '',
    label: '',
    type: 'text' as CustomFieldType,
    options: '',
    required: false,
    requiredInStageIds: [] as string[],
  });

  const serverFields = create.error instanceof ApiError ? (create.error.fields ?? {}) : {};

  return (
    <section aria-labelledby="fields-heading" className="mt-10">
      <h2 id="fields-heading" className="text-base font-semibold text-slate-900 dark:text-slate-50">
        Custom fields
      </h2>

      <div className="mt-3 flex items-center gap-2">
        <label
          htmlFor="field-entity"
          className="text-sm font-medium text-slate-800 dark:text-slate-200"
        >
          For
        </label>
        <select
          id="field-entity"
          value={entity}
          onChange={(event) => {
            setEntity(event.target.value as typeof entity);
          }}
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
        >
          <option value="contact">Contacts</option>
          <option value="company">Companies</option>
          <option value="opportunity">Opportunities in {pipeline.name}</option>
        </select>
      </div>

      <ul className="mt-3 flex flex-col gap-2">
        {(definitions.data?.customFields ?? []).map((definition) => (
          <li
            key={definition.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm dark:border-slate-700 dark:bg-slate-900"
          >
            <span className="min-w-0">
              <span className="font-medium break-words text-slate-900 dark:text-slate-100">
                {definition.label}
              </span>
              <span className="ml-2 font-mono text-xs text-slate-600 dark:text-slate-400">
                {definition.key} · {definition.type}
                {definition.required && ' · required'}
                {definition.requiredInStageIds.length > 0 &&
                  ` · required in ${String(definition.requiredInStageIds.length)} stage(s)`}
              </span>
            </span>
            <Button
              type="button"
              variant="danger"
              busy={remove.isPending}
              onClick={() => {
                remove.mutate(definition.id);
              }}
            >
              Delete
            </Button>
          </li>
        ))}
        {(definitions.data?.customFields ?? []).length === 0 && (
          <li className="text-sm text-slate-600 dark:text-slate-400">No custom fields here yet.</li>
        )}
      </ul>

      <form
        noValidate
        className={`mt-5 flex flex-col gap-4 ${SURFACE} p-5`}
        onSubmit={(event) => {
          event.preventDefault();
          const options = draft.options
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry !== '');

          create.mutate(
            {
              entity,
              ...(entity === 'opportunity' ? { pipelineId: pipeline.id } : {}),
              key: draft.key.trim(),
              label: draft.label.trim(),
              type: draft.type,
              ...(draft.type === 'dropdown' ? { options } : {}),
              required: draft.required,
              ...(entity === 'opportunity' && draft.requiredInStageIds.length > 0
                ? { requiredInStageIds: draft.requiredInStageIds }
                : {}),
            },
            {
              onSuccess: () => {
                setDraft({
                  key: '',
                  label: '',
                  type: 'text',
                  options: '',
                  required: false,
                  requiredInStageIds: [],
                });
              },
            },
          );
        }}
      >
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-50">Add a field</h3>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Label"
            name="label"
            required
            value={draft.label}
            error={serverFields['label']}
            onChange={(event) => {
              setDraft((current) => ({ ...current, label: event.target.value }));
            }}
          />
          <Field
            label="Key"
            name="key"
            required
            hint="Lowercase letters, digits and underscores."
            value={draft.key}
            error={serverFields['key']}
            onChange={(event) => {
              setDraft((current) => ({ ...current, key: event.target.value }));
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="field-type"
            className="text-sm font-medium text-slate-800 dark:text-slate-200"
          >
            Type
          </label>
          <select
            id="field-type"
            value={draft.type}
            onChange={(event) => {
              setDraft((current) => ({ ...current, type: event.target.value as CustomFieldType }));
            }}
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
          >
            {CUSTOM_FIELD_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>

        {draft.type === 'dropdown' && (
          <Field
            label="Options"
            name="options"
            required
            hint="Comma-separated."
            value={draft.options}
            error={serverFields['options']}
            onChange={(event) => {
              setDraft((current) => ({ ...current, options: event.target.value }));
            }}
          />
        )}

        <label className="flex items-center gap-2 text-sm text-slate-800 dark:text-slate-200">
          <input
            type="checkbox"
            checked={draft.required}
            onChange={(event) => {
              setDraft((current) => ({ ...current, required: event.target.checked }));
            }}
            className="focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none"
          />
          Always required
        </label>

        {entity === 'opportunity' && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium text-slate-800 dark:text-slate-200">
              Required before entering these stages
            </legend>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              Moving an opportunity into a selected stage is blocked until this field is filled in.
            </p>
            {pipeline.stages.map((stage) => (
              <label key={stage.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={draft.requiredInStageIds.includes(stage.id)}
                  onChange={() => {
                    setDraft((current) => ({
                      ...current,
                      requiredInStageIds: current.requiredInStageIds.includes(stage.id)
                        ? current.requiredInStageIds.filter((id) => id !== stage.id)
                        : [...current.requiredInStageIds, stage.id],
                    }));
                  }}
                  className="focus-visible:ring-2 focus-visible:ring-slate-900 focus-visible:outline-none"
                />
                {stage.name}
              </label>
            ))}
          </fieldset>
        )}

        <div aria-live="polite">
          <Alert error={create.error} />
          <Alert error={remove.error} />
          {create.isSuccess && <Notice>Field added. It appears on forms immediately.</Notice>}
        </div>

        <div>
          <Button type="submit" busy={create.isPending} busyLabel="Adding…">
            Add field
          </Button>
        </div>
      </form>
    </section>
  );
}
