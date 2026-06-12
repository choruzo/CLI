import React, { useState, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from './theme.js';
import { SelectList, type SelectItem } from './components/SelectList.js';
import { MaskedInput } from './components/MaskedInput.js';
import {
  PROVIDER_TYPE_PRESETS,
  validateAlias,
  validateBaseUrl,
  discoverModels,
  buildProviderEntry,
  type ProviderTypePreset,
  type WizardResult,
} from './wizard-logic.js';

type Step =
  | 'type'
  | 'baseUrl'
  | 'apiKey'
  | 'name'
  | 'fetching'
  | 'model-select'
  | 'model-manual'
  | 'activate'
  | 'confirm-edit';

export interface ProviderWizardProps {
  /** 'add' = stratum provider add · 'edit' = /config_provider (pre-rellenado). */
  mode: 'add' | 'edit';
  /** Aliases ya existentes en la config (para validar colisiones en modo add). */
  existingNames: string[];
  /** Valores iniciales (modo edit, o re-ejecución). */
  initial?: { name?: string; baseUrl?: string; apiKey?: string; model?: string; contextWindow?: number };
  onComplete: (result: WizardResult) => void;
  onCancel: () => void;
}

const STEP_TITLES: Record<Step, string> = {
  type: 'Tipo de provider',
  baseUrl: 'Base URL',
  apiKey: 'API key',
  name: 'Nombre del provider',
  fetching: 'Detectando modelos',
  'model-select': 'Modelo por defecto',
  'model-manual': 'Modelo por defecto (manual)',
  activate: '¿Activar ahora?',
  'confirm-edit': 'Guardar cambios',
};

/**
 * Wizard interactivo de configuración de providers (Hito 3.5).
 * Flujo: tipo → URL → API key → alias → fetch /models → modelo → activar.
 * Esc en cualquier paso cancela el wizard completo.
 */
export function ProviderWizard({ mode, existingNames, initial, onComplete, onCancel }: ProviderWizardProps) {
  const [step, setStep] = useState<Step>(mode === 'edit' ? 'baseUrl' : 'type');
  const [preset, setPreset] = useState<ProviderTypePreset | null>(null);

  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [model, setModel] = useState(initial?.model ?? '');
  const [models, setModels] = useState<string[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Esc global: cancela el wizard (SelectList ya maneja su propio Esc → onCancel)
  useInput((_input, key) => {
    if (key.escape && step !== 'type' && step !== 'model-select' && step !== 'activate' && step !== 'confirm-edit') {
      onCancel();
    }
  });

  const startFetch = useCallback(
    (url: string, key: string) => {
      setStep('fetching');
      void discoverModels(url, key).then((discovery) => {
        if (discovery.manualFallback) {
          setFetchError(discovery.error ?? null);
          setStep('model-manual');
        } else {
          setModels(discovery.models);
          setStep('model-select');
        }
      });
    },
    [],
  );

  const finish = useCallback(
    (makeDefault: boolean) => {
      onComplete({
        name: name.trim(),
        config: buildProviderEntry({ baseUrl, apiKey, model, contextWindow: initial?.contextWindow }),
        makeDefault,
      });
    },
    [onComplete, name, baseUrl, apiKey, model, initial?.contextWindow],
  );

  // ---------------------------------------------------------------------------

  const renderStep = () => {
    switch (step) {
      case 'type':
        return (
          <SelectList
            items={PROVIDER_TYPE_PRESETS.map((p): SelectItem<ProviderTypePreset> => ({ label: p.label, value: p }))}
            onSelect={(item) => {
              setPreset(item.value);
              setBaseUrl(item.value.defaultBaseUrl);
              if (!item.value.requiresApiKey) setApiKey(item.value.defaultApiKey);
              setStep('baseUrl');
            }}
            onCancel={onCancel}
          />
        );

      case 'baseUrl':
        return (
          <Box flexDirection="column">
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <TextInput
                value={baseUrl}
                onChange={(v) => {
                  setBaseUrl(v);
                  setValidationError(null);
                }}
                onSubmit={(v) => {
                  const err = validateBaseUrl(v);
                  if (err) {
                    setValidationError(err);
                    return;
                  }
                  setValidationError(null);
                  if (mode === 'edit') setStep('apiKey');
                  else if (preset && !preset.requiresApiKey) setStep('name');
                  else setStep('apiKey');
                }}
                placeholder={preset?.defaultBaseUrl || 'http://localhost:11434/v1'}
                showCursor
              />
            </Box>
            <Text color={theme.textFaint}>  Debe incluir el prefijo de la API (ej. /v1)</Text>
          </Box>
        );

      case 'apiKey':
        return (
          <Box flexDirection="column">
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <MaskedInput
                value={apiKey}
                onChange={setApiKey}
                onSubmit={(v) => {
                  if (mode === 'edit') startFetch(baseUrl, v);
                  else setStep('name');
                }}
                placeholder="sk-... (Enter para dejar vacía)"
              />
            </Box>
            <Text color={theme.textFaint}>
              {'  '}Puedes usar {'${VAR}'} editando el archivo después; aquí se guarda literal
            </Text>
          </Box>
        );

      case 'name':
        return (
          <Box flexDirection="column">
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <TextInput
                value={name}
                onChange={(v) => {
                  setName(v);
                  setValidationError(null);
                }}
                onSubmit={(v) => {
                  const err = validateAlias(v, existingNames, mode === 'edit');
                  if (err) {
                    setValidationError(err);
                    return;
                  }
                  setValidationError(null);
                  startFetch(baseUrl, apiKey);
                }}
                placeholder={preset ? `mi-${preset.id}` : 'mi-provider'}
                showCursor
              />
            </Box>
            <Text color={theme.textFaint}>  Alias en la config (ej. local-ollama, litellm-prod)</Text>
          </Box>
        );

      case 'fetching':
        return (
          <Text color={theme.textMuted}>
            ◌ Consultando {baseUrl.replace(/\/$/, '')}/models...
          </Text>
        );

      case 'model-select':
        return (
          <Box flexDirection="column">
            <SelectList
              items={models.map((m): SelectItem => ({
                label: m,
                value: m,
                hint: m === model ? '(actual)' : undefined,
              }))}
              initialIndex={Math.max(models.indexOf(model), 0)}
              onSelect={(item) => {
                setModel(item.value);
                setStep(mode === 'edit' ? 'confirm-edit' : 'activate');
              }}
              onCancel={onCancel}
            />
            <Text color={theme.textFaint}>  {models.length} modelos disponibles</Text>
          </Box>
        );

      case 'model-manual':
        return (
          <Box flexDirection="column">
            {fetchError && (
              <Text color={theme.warning}>  ⚠ No se pudieron listar modelos: {fetchError}</Text>
            )}
            <Box>
              <Text color={theme.accent}>❯ </Text>
              <TextInput
                value={model}
                onChange={(v) => {
                  setModel(v);
                  setValidationError(null);
                }}
                onSubmit={(v) => {
                  if (!v.trim()) {
                    setValidationError('El modelo no puede estar vacío');
                    return;
                  }
                  setStep(mode === 'edit' ? 'confirm-edit' : 'activate');
                }}
                placeholder="ej. qwen2.5-coder:32b"
                showCursor
              />
            </Box>
          </Box>
        );

      case 'activate':
        return (
          <SelectList
            items={[
              { label: 'Sí — usar este provider como activo', value: 'yes' },
              { label: 'No — solo añadirlo a la config', value: 'no' },
            ]}
            onSelect={(item) => finish(item.value === 'yes')}
            onCancel={onCancel}
          />
        );

      case 'confirm-edit':
        return (
          <SelectList
            items={[
              { label: 'Guardar cambios en .stratumrc.json', value: 'save' },
              { label: 'Cancelar', value: 'cancel' },
            ]}
            onSelect={(item) => {
              if (item.value === 'save') finish(false);
              else onCancel();
            }}
            onCancel={onCancel}
          />
        );

      default:
        return null;
    }
  };

  const summaryParts: string[] = [];
  if (baseUrl && step !== 'baseUrl') summaryParts.push(baseUrl);
  if (name && step !== 'name') summaryParts.push(`alias: ${name}`);
  if (model && step !== 'model-select' && step !== 'model-manual') summaryParts.push(`modelo: ${model}`);

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={theme.borderAccent} paddingX={1}>
      <Text color={theme.accent} bold>
        {mode === 'add' ? 'Nuevo provider' : `Editando provider: ${initial?.name ?? ''}`}
        <Text color={theme.textMuted} bold={false}>
          {'  ·  '}
          {STEP_TITLES[step]}
        </Text>
      </Text>
      {summaryParts.length > 0 && (
        <Text color={theme.textFaint}>{summaryParts.join('  ·  ')}</Text>
      )}
      <Text> </Text>
      {renderStep()}
      {validationError && <Text color={theme.error}>  ✗ {validationError}</Text>}
      <Text color={theme.textDisabled}>  Esc para cancelar</Text>
    </Box>
  );
}
