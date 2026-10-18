import { useId, type TextareaHTMLAttributes } from 'react';

import { CONTROL_CLASS } from './Select.js';

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  readonly label: string;
  readonly hint?: string | undefined;
}

export function TextArea({ label, hint, ...textarea }: TextAreaProps) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-slate-800 dark:text-slate-200">
        {label}
      </label>
      <textarea rows={3} {...textarea} id={id} className={CONTROL_CLASS} />
      {hint !== undefined && <p className="text-xs text-slate-600 dark:text-slate-400">{hint}</p>}
    </div>
  );
}
