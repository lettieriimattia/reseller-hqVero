// frontend/src/components/DynamicForm.tsx
// Pilastro 3: Form generato dinamicamente dallo schema JSON della CategoryTemplate.
// Non aggiungere codice per ogni nuova categoria: basta creare/aggiornare il template via API.

import React from 'react';

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'boolean';
  options?: string[];
  required?: boolean;
  unit?: string;
}

interface DynamicFormProps {
  fields: FieldDef[];
  values: Record<string, any>;
  onChange: (key: string, value: any) => void;
  disabled?: boolean;
  className?: string;
}

const base =
  'w-full bg-[#111] border border-[#222] rounded-xl px-3 py-2 text-sm text-white ' +
  'focus:outline-none focus:border-[#444] transition-colors disabled:opacity-40 placeholder-gray-700';

export function DynamicForm({ fields, values, onChange, disabled, className }: DynamicFormProps) {
  if (!fields?.length) return null;

  return (
    <div className={`grid grid-cols-2 gap-x-3 gap-y-4 ${className ?? ''}`}>
      {fields.map(field => {
        // I campi di testo non-select occupano tutta la larghezza
        const fullRow = field.type === 'text' || field.type === 'boolean';

        return (
          <div key={field.key} className={fullRow ? 'col-span-2' : 'col-span-1'}>
            {field.type !== 'boolean' && (
              <label className="block text-[11px] uppercase tracking-wider text-gray-500 mb-1.5">
                {field.label}
                {field.unit && <span className="text-gray-700 ml-1">({field.unit})</span>}
              </label>
            )}

            {field.type === 'select' && field.options ? (
              <select
                value={values[field.key] ?? ''}
                onChange={e => onChange(field.key, e.target.value || undefined)}
                disabled={disabled}
                className={base}
              >
                <option value="">—</option>
                {field.options.map(opt => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>

            ) : field.type === 'boolean' ? (
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <div
                  role="checkbox"
                  aria-checked={!!values[field.key]}
                  onClick={() => !disabled && onChange(field.key, !values[field.key])}
                  className={`w-9 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer ${
                    values[field.key] ? 'bg-white' : 'bg-[#2a2a2a]'
                  } ${disabled ? 'opacity-40 pointer-events-none' : ''}`}
                >
                  <div
                    className={`w-4 h-4 rounded-full mt-0.5 ml-0.5 transition-transform ${
                      values[field.key] ? 'bg-black translate-x-4' : 'bg-gray-600'
                    }`}
                  />
                </div>
                <span className="text-sm text-gray-300">{field.label}</span>
              </label>

            ) : (
              <div className="relative">
                <input
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={values[field.key] ?? ''}
                  onChange={e =>
                    onChange(
                      field.key,
                      field.type === 'number'
                        ? (e.target.value === '' ? undefined : parseFloat(e.target.value))
                        : (e.target.value || undefined)
                    )
                  }
                  disabled={disabled}
                  placeholder="—"
                  className={`${base} ${field.unit ? 'pr-10' : ''}`}
                />
                {field.unit && (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-gray-600 pointer-events-none">
                    {field.unit}
                  </span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
