import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from './theme.js';
import { SelectList, type SelectItem } from './components/SelectList.js';
import { ProviderWizard } from './ProviderWizard.js';
import { isGlobalOnlyKey } from '../../config/loader.js';
import { getByDotPath } from '../../config/dot-path.js';
import { upsertProvider } from '../../config/writer.js';
import {
  CONFIG_SECTIONS,
  ORIGIN_LABEL,
  displayValue,
  fieldKind,
  fieldValue,
  parseFieldInput,
  readConfigLayers,
  schemaAt,
  writeField,
  type ConfigLayers,
  type ConfigScope,
  type FieldValue,
} from '../../config/editor.js';

/**
 * `stratum config` interactivo: primero dónde se escribe (proyecto o global),
 * luego secciones con nombre y, en «Avanzado», cualquier clave del schema.
 * Cada campo dice su valor efectivo y de qué capa sale; quitarlo de un fichero
 * lo deja heredar de la capa de abajo. Esc vuelve atrás; en la primera
 * pantalla, sale.
 */

type View =
  | { kind: 'scope' }
  | { kind: 'sections' }
  | { kind: 'fields'; sectionId: string }
  | { kind: 'tree'; path: string }
  | { kind: 'edit'; key: string; label: string; back: View }
  | { kind: 'provider' }
  | { kind: 'provider-default' }
  | { kind: 'provider-add' };

type Notice = { tone: 'ok' | 'error'; text: string } | null;

export interface ConfigMenuProps {
  cwd: string;
  globalPath?: string;
  onExit: () => void;
}

const SCOPE_LABEL: Record<ConfigScope, string> = { project: 'Proyecto', global: 'Global' };

export function ConfigMenu({ cwd, globalPath, onExit }: ConfigMenuProps) {
  const [scope, setScope] = useState<ConfigScope>('project');
  const [view, setView] = useState<View>({ kind: 'scope' });
  const [notice, setNotice] = useState<Notice>(null);
  const [version, setVersion] = useState(0);

  const layers = useMemo<ConfigLayers | Error>(() => {
    try {
      return readConfigLayers(cwd, globalPath);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
    // `version` relee los ficheros tras cada escritura.
  }, [cwd, globalPath, version]);

  if (layers instanceof Error) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text color={theme.error}>No se pudo leer la config: {layers.message}</Text>
        <Text color={theme.textFaint}>Corrige el fichero y vuelve a abrir `stratum config`.</Text>
      </Box>
    );
  }

  const go = (next: View) => {
    setNotice(null);
    setView(next);
  };

  const save = (key: string, value: unknown, back: View) => {
    try {
      const { path, backupPath } = writeField(layers, scope, key, value);
      setVersion((v) => v + 1);
      setView(back);
      setNotice({
        tone: 'ok',
        text:
          (value === undefined ? `${key} quitado de ${path}` : `${key} guardado en ${path}`) +
          (backupPath ? ' (backup .bak)' : ''),
      });
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const targetPath = scope === 'project' ? layers.projectPath : layers.globalPath;
  const fieldHint = (key: string): string => {
    if (scope === 'project' && isGlobalOnlyKey(key)) return 'solo global';
    const v = fieldValue(layers, key, scope);
    return `${displayValue(key, v.value)} · ${ORIGIN_LABEL[v.origin]}`;
  };

  const openField = (key: string, label: string, back: View) => {
    if (scope === 'project' && isGlobalOnlyKey(key)) {
      setNotice({ tone: 'error', text: `${key} solo cuenta en la config global.` });
      return;
    }
    go({ kind: 'edit', key, label, back });
  };

  const body = (() => {
    switch (view.kind) {
      case 'scope':
        return (
          <SelectList<ConfigScope>
            key="scope"
            items={[
              {
                label: 'Proyecto',
                value: 'project',
                hint: layers.projectExists
                  ? layers.projectPath
                  : `${layers.projectPath} (se creará)`,
              },
              { label: 'Global', value: 'global', hint: layers.globalPath },
            ]}
            onSelect={(item) => {
              setScope(item.value);
              go({ kind: 'sections' });
            }}
            onCancel={onExit}
          />
        );

      case 'sections': {
        const items: SelectItem<string>[] = [
          { label: 'Provider y modelo', value: '@provider' },
          ...CONFIG_SECTIONS.map((s) => ({
            label: s.label,
            value: s.id,
            hint: s.globalOnly && scope === 'project' ? '(solo global)' : undefined,
          })),
          { label: 'Avanzado (todas las claves)', value: '@tree' },
          { label: 'Salir', value: '@exit' },
        ];
        return (
          <SelectList
            key="sections"
            items={items}
            maxVisible={12}
            onSelect={(item) => {
              if (item.value === '@exit') onExit();
              else if (item.value === '@provider') go({ kind: 'provider' });
              else if (item.value === '@tree') go({ kind: 'tree', path: '' });
              else {
                const section = CONFIG_SECTIONS.find((s) => s.id === item.value);
                if (section?.globalOnly && scope === 'project') {
                  setNotice({ tone: 'error', text: `${section.label}: solo en la config global.` });
                } else go({ kind: 'fields', sectionId: item.value });
              }
            }}
            onCancel={() => go({ kind: 'scope' })}
          />
        );
      }

      case 'fields': {
        const section = CONFIG_SECTIONS.find((s) => s.id === view.sectionId)!;
        return (
          <SelectList
            key={`fields-${section.id}`}
            items={section.fields.map((f) => ({
              label: f.label,
              value: f.key,
              hint: fieldHint(f.key),
            }))}
            maxVisible={12}
            onSelect={(item) => {
              const field = section.fields.find((f) => f.key === item.value)!;
              openField(field.key, field.label, view);
            }}
            onCancel={() => go({ kind: 'sections' })}
          />
        );
      }

      case 'tree': {
        const schema = schemaAt(view.path);
        const kind = schema ? fieldKind(schema) : null;
        const keys = kind?.kind === 'object' ? kind.keys.filter((k) => k !== 'schemaVersion') : [];
        const parent = view.path.includes('.')
          ? view.path.slice(0, view.path.lastIndexOf('.'))
          : '';
        return (
          <SelectList
            key={`tree-${view.path}`}
            items={keys.map((k) => {
              const full = view.path ? `${view.path}.${k}` : k;
              const child = fieldKind(schemaAt(full)!);
              return {
                label: child.kind === 'object' ? `${k}/` : k,
                value: full,
                hint: child.kind === 'object' ? undefined : fieldHint(full),
              };
            })}
            maxVisible={14}
            onSelect={(item) => {
              const child = fieldKind(schemaAt(item.value)!);
              if (child.kind === 'object') go({ kind: 'tree', path: item.value });
              else openField(item.value, item.value, view);
            }}
            onCancel={() => go(view.path ? { kind: 'tree', path: parent } : { kind: 'sections' })}
          />
        );
      }

      case 'edit':
        return (
          <FieldEditor
            key={view.key}
            fieldKey={view.key}
            label={view.label}
            current={fieldValue(layers, view.key, scope)}
            onSave={(value) => save(view.key, value, view.back)}
            onCancel={() => go(view.back)}
          />
        );

      case 'provider': {
        const def = fieldValue(layers, 'provider.default', scope);
        return (
          <SelectList
            key="provider"
            items={[
              {
                label: 'Provider por defecto',
                value: 'default',
                hint: `${displayValue('provider.default', def.value)} · ${ORIGIN_LABEL[def.origin]}`,
              },
              { label: 'Añadir un provider…', value: 'add' },
            ]}
            onSelect={(item) =>
              go(item.value === 'add' ? { kind: 'provider-add' } : { kind: 'provider-default' })
            }
            onCancel={() => go({ kind: 'sections' })}
          />
        );
      }

      case 'provider-default': {
        const names = providerNames(layers);
        if (names.length === 0) {
          return <Text color={theme.textFaint}>No hay providers: añade uno primero. (Esc)</Text>;
        }
        const current = fieldValue(layers, 'provider.default', scope);
        const items: SelectItem<string | null>[] = names.map((n) => ({
          label: n,
          value: n,
          hint: n === current.value ? '(actual)' : undefined,
        }));
        if (current.inScope !== undefined && scope === 'project') {
          items.push({
            label: 'Quitar del proyecto',
            value: null,
            hint: `hereda ${displayValue('provider.default', current.inherited)}`,
          });
        }
        return (
          <SelectList<string | null>
            key="provider-default"
            items={items}
            initialIndex={Math.max(0, names.indexOf(String(current.value)))}
            onSelect={(item) =>
              save('provider.default', item.value ?? undefined, { kind: 'provider' })
            }
            onCancel={() => go({ kind: 'provider' })}
          />
        );
      }

      case 'provider-add':
        return (
          <ProviderWizard
            mode="add"
            existingNames={providerNames(layers)}
            onComplete={(result) => {
              try {
                const { configPath } = upsertProvider(
                  result.name,
                  result.config,
                  result.makeDefault,
                  targetPath,
                );
                setVersion((v) => v + 1);
                setView({ kind: 'provider' });
                setNotice({
                  tone: 'ok',
                  text: `Provider "${result.name}" guardado en ${configPath}`,
                });
              } catch (err) {
                setView({ kind: 'provider' });
                setNotice({
                  tone: 'error',
                  text: err instanceof Error ? err.message : String(err),
                });
              }
            }}
            onCancel={() => go({ kind: 'provider' })}
          />
        );
    }
  })();

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={theme.accent} bold>
          Stratum · configuración
        </Text>
        {view.kind !== 'scope' && (
          <Text color={theme.textMuted}>
            {'  '}
            {SCOPE_LABEL[scope]} — {targetPath}
          </Text>
        )}
      </Text>
      <Text color={theme.textFaint}>{breadcrumb(view)}</Text>
      <Box marginTop={1} flexDirection="column">
        {body}
      </Box>
      {notice && (
        <Box marginTop={1}>
          <Text color={notice.tone === 'ok' ? theme.success : theme.error}>
            {notice.tone === 'ok' ? '✓ ' : '✗ '}
            {notice.text}
          </Text>
        </Box>
      )}
      <Text color={theme.textDisabled}>↑↓ navegar · Enter elegir · Esc volver</Text>
    </Box>
  );
}

function providerNames(layers: ConfigLayers): string[] {
  const of = (raw: Record<string, unknown>) =>
    Object.keys((getByDotPath(raw, 'provider.providers') as Record<string, unknown>) ?? {});
  return [...new Set([...of(layers.global), ...of(layers.project)])];
}

function breadcrumb(view: View): string {
  switch (view.kind) {
    case 'scope':
      return '¿Qué fichero quieres editar?';
    case 'sections':
      return 'Secciones';
    case 'fields':
      return CONFIG_SECTIONS.find((s) => s.id === view.sectionId)?.label ?? '';
    case 'tree':
      return `Avanzado › ${view.path || '(raíz)'}`;
    case 'edit':
      return view.key;
    default:
      return 'Provider y modelo';
  }
}

// ---------------------------------------------------------------------------
// Editor de un campo
// ---------------------------------------------------------------------------

interface FieldEditorProps {
  fieldKey: string;
  label: string;
  current: FieldValue;
  onSave: (value: unknown) => void;
  onCancel: () => void;
}

const INHERIT = Symbol('inherit');

function FieldEditor({ fieldKey, label, current, onSave, onCancel }: FieldEditorProps) {
  const schema = schemaAt(fieldKey);
  const kind = schema ? fieldKind(schema) : ({ kind: 'complex' } as const);
  const help = findHelp(fieldKey);
  const canInherit = current.inScope !== undefined;
  const inheritLabel = `Quitar de este fichero (hereda ${displayValue(fieldKey, current.inherited)} · ${ORIGIN_LABEL[current.inheritedOrigin]})`;

  const header = (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={theme.textPrimary}>{label}</Text>
      <Text color={theme.textFaint}>
        Ahora: {displayValue(fieldKey, current.value)} ({ORIGIN_LABEL[current.origin]})
      </Text>
      {help && <Text color={theme.textFaint}>{help}</Text>}
    </Box>
  );

  if (kind.kind === 'boolean' || kind.kind === 'enum') {
    const options: SelectItem<unknown>[] =
      kind.kind === 'boolean'
        ? [
            { label: 'Sí (true)', value: true },
            { label: 'No (false)', value: false },
          ]
        : kind.options.map((o) => ({ label: o, value: o }));
    if (canInherit) options.push({ label: inheritLabel, value: INHERIT });
    const index = options.findIndex((o) => o.value === current.value);
    return (
      <Box flexDirection="column">
        {header}
        <SelectList<unknown>
          items={options}
          initialIndex={Math.max(0, index)}
          onSelect={(item) => onSave(item.value === INHERIT ? undefined : item.value)}
          onCancel={onCancel}
        />
      </Box>
    );
  }

  if (kind.kind === 'number' || kind.kind === 'string' || kind.kind === 'mixed') {
    return (
      <TextFieldEditor
        fieldKey={fieldKey}
        header={header}
        initial={current.value === undefined ? '' : String(current.value)}
        canInherit={canInherit}
        inheritLabel={inheritLabel}
        onSave={onSave}
        onCancel={onCancel}
      />
    );
  }

  return <ComplexField header={header} onCancel={onCancel} />;
}

function TextFieldEditor({
  fieldKey,
  header,
  initial,
  canInherit,
  inheritLabel,
  onSave,
  onCancel,
}: {
  fieldKey: string;
  header: React.ReactNode;
  initial: string;
  canInherit: boolean;
  inheritLabel: string;
  onSave: (value: unknown) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  useInput((input, key) => {
    if (key.escape) onCancel();
    else if (key.ctrl && input === 'r' && canInherit) onSave(undefined);
  });

  return (
    <Box flexDirection="column">
      {header}
      <Box>
        <Text color={theme.accent}>❯ </Text>
        <TextInput
          value={text}
          onChange={(v) => {
            setText(v);
            setError(null);
          }}
          onSubmit={(v) => {
            const parsed = parseFieldInput(fieldKey, v);
            if (!parsed.ok) setError(parsed.error);
            else onSave(parsed.value);
          }}
          showCursor
        />
      </Box>
      {error && <Text color={theme.error}> {error}</Text>}
      <Text color={theme.textFaint}>
        {' '}
        Enter guarda · Esc vuelve{canInherit ? ` · Ctrl+R: ${inheritLabel}` : ''}
      </Text>
    </Box>
  );
}

function ComplexField({ header, onCancel }: { header: React.ReactNode; onCancel: () => void }) {
  useInput((_input, key) => {
    if (key.escape || key.return) onCancel();
  });
  return (
    <Box flexDirection="column">
      {header}
      <Text color={theme.textMuted}>
        Listas y mapas se editan en el fichero, o con `stratum config set` para un valor suelto.
      </Text>
    </Box>
  );
}

function findHelp(key: string): string | undefined {
  for (const section of CONFIG_SECTIONS) {
    const field = section.fields.find((f) => f.key === key);
    if (field) return field.help;
  }
  return undefined;
}
