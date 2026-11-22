/**
 * Escritura de la configuración de Home Assistant (M27 fase 2):
 * `ha_proponer_automatizacion` (crear o modificar) y `ha_borrar_automatizacion`.
 *
 * Una automatización actúa sola, sin aprobación: por eso solo se **propone**
 * (ambas tools son `forced` en el manifiesto: el runtime pide una confirmación
 * que enseña los argumentos enteros), solo se toca lo propio (ids `stratum_…`,
 * comprobado aquí y otra vez en el cliente), lo nuevo nace desactivado salvo que
 * se pida lo contrario y no se escribe en una versión de HA que no se conoce.
 *
 * Como en `grocy/write-tools.ts`: si la petición pudo llegar y no se sabe qué
 * pasó, se dice «No sé» y **nunca se reintenta**.
 */
import { z } from 'zod';
import { ToolUserError, type ConnectorTool } from '../lib/mcp-stdio.js';
import {
  HaHttpError,
  HaNetworkError,
  isRecord,
  type HaClient,
  type HaConfigKind,
  type HaState,
} from './client.js';
import { ENTITY_RE, parseArgs, type HaToolContext } from './args.js';
import { stateLabel } from './automations.js';
import { NO_DATA, safeField } from './format.js';

/**
 * Versiones de Home Assistant en las que se escribe, como año × 100 + mes. El
 * mínimo (2024.10) es cuando la configuración pasó a `triggers`/`actions` en
 * plural, que es la forma que se escribe aquí; el máximo es el último año que se
 * ha medido. Fuera de ese rango, la forma de la API podría ser otra y no se escribe.
 */
const MIN_VERSION = 2024 * 100 + 10;
const MAX_YEAR = 2027;

/** Intentos de ver la entidad recién escrita (tarda ~1 s en aparecer) y espera entre ellos. */
const LOOKUP_ATTEMPTS = 3;
const LOOKUP_WAIT_MS = 700;

const ID_RE = /^stratum_[a-z0-9_]{1,50}$/;
const ID_MSG =
  'id debe tener la forma stratum_nombre (solo minúsculas, números y _, hasta 56 caracteres): solo se crean o tocan ids con prefijo stratum_';

const TIPOS = ['automatizacion', 'script', 'escena'] as const;
type Tipo = (typeof TIPOS)[number];

const KIND: Record<Tipo, HaConfigKind> = {
  automatizacion: 'automation',
  script: 'script',
  escena: 'scene',
};
const TIPO_TEXT: Record<Tipo, string> = {
  automatizacion: 'la automatización',
  script: 'el script',
  escena: 'la escena',
};

// --- Validación de `config` ---------------------------------------------------------

const MODES = ['single', 'restart', 'queued', 'parallel'] as const;

const text = (field: string, min: number, max: number) =>
  z
    .string({ message: `${field} debe ser un texto` })
    .min(min, `${field} no puede estar vacío`)
    .max(max, `${field} admite como máximo ${max} caracteres`);
const objectList = (field: string, min: number, max: number) =>
  z
    .array(z.record(z.unknown(), { message: `${field} debe ser una lista de objetos` }), {
      message: `${field} debe ser una lista de objetos`,
    })
    .min(min, `${field} necesita al menos ${min} elemento${min === 1 ? '' : 's'}`)
    .max(max, `${field} admite como máximo ${max} elementos`);
const object = (field: string) => z.record(z.unknown(), { message: `${field} debe ser un objeto` });

const common = {
  mode: z.enum(MODES, { message: `mode debe ser ${MODES.join(', ')}` }).optional(),
  max: z
    .number({ message: 'max debe ser un entero entre 1 y 50' })
    .int('max debe ser un entero entre 1 y 50')
    .min(1, 'max debe ser un entero entre 1 y 50')
    .max(50, 'max debe ser un entero entre 1 y 50')
    .optional(),
  variables: object('variables').optional(),
};

const CONFIG_SCHEMAS: Record<Tipo, z.ZodType<unknown, z.ZodTypeDef, unknown>> = {
  automatizacion: z.object({
    alias: text('alias', 1, 100),
    description: text('description', 0, 300).optional(),
    triggers: objectList('triggers', 1, 20),
    conditions: objectList('conditions', 0, 20).optional(),
    actions: objectList('actions', 1, 30),
    ...common,
  }),
  script: z.object({
    alias: text('alias', 1, 100),
    description: text('description', 0, 300).optional(),
    sequence: objectList('sequence', 1, 30),
    fields: object('fields').optional(),
    ...common,
  }),
  escena: z.object({
    name: text('name', 1, 100),
    entities: z
      .record(z.unknown(), { message: 'entities debe ser un objeto entity_id → estado' })
      .refine((e) => {
        const keys = Object.keys(e);
        return keys.length >= 1 && keys.length <= 30 && keys.every((k) => ENTITY_RE.test(k));
      }, 'entities necesita de 1 a 30 claves con la forma dominio.nombre'),
  }),
};

/** Claves de `config` admitidas por tipo (todas las demás se rechazan por su nombre). */
const ALLOWED_KEYS: Record<Tipo, string[]> = {
  automatizacion: [
    'alias',
    'description',
    'triggers',
    'conditions',
    'actions',
    'mode',
    'max',
    'variables',
  ],
  script: ['alias', 'description', 'sequence', 'mode', 'max', 'fields', 'variables'],
  escena: ['name', 'entities'],
};

const ArgsSchema = z.object({
  accion: z.enum(['crear', 'modificar'], { message: 'accion debe ser crear o modificar' }),
  tipo: z.enum(TIPOS, { message: 'tipo debe ser automatizacion, script o escena' }),
  id: z.string({ message: ID_MSG }).trim().regex(ID_RE, ID_MSG),
  config: z.record(z.unknown(), { message: 'config debe ser un objeto' }),
  habilitada: z.boolean({ message: 'habilitada debe ser verdadero o falso' }).optional(),
});

const DeleteSchema = z.object({
  tipo: ArgsSchema.shape.tipo,
  id: ArgsSchema.shape.id,
});

function validateConfig(tipo: Tipo, config: Record<string, unknown>): void {
  for (const key of Object.keys(config)) {
    if (key === 'id' || key === 'initial_state') {
      throw new ToolUserError(
        `Argumento inválido: config no admite ${key}: lo pone el conector (el id sale del argumento id y el estado inicial, de habilitada).`,
      );
    }
    if (!ALLOWED_KEYS[tipo].includes(key)) {
      throw new ToolUserError(
        `Argumento inválido: config.${safeField(key, 40)} no se admite en ${tipo === 'escena' ? 'una escena' : tipo === 'script' ? 'un script' : 'una automatización'} (se admiten: ${ALLOWED_KEYS[tipo].join(', ')}).`,
      );
    }
  }
  parseArgs(
    z.object({ config: CONFIG_SCHEMAS[tipo] }).transform((o) => o.config),
    { config },
  );
}

// --- Comprobaciones previas -------------------------------------------------------------

function supportedVersion(version: string | null): boolean {
  const m = version === null ? null : /^(\d{4})\.(\d{1,2})/.exec(version);
  if (!m) return false;
  const year = Number(m[1]);
  return year * 100 + Number(m[2]) >= MIN_VERSION && year <= MAX_YEAR;
}

async function assertKnownVersion(c: HaClient, signal: AbortSignal | undefined): Promise<void> {
  const v = (await c.getConfig(signal)).version;
  if (!supportedVersion(v)) {
    throw new ToolUserError(
      `No escribo en esta versión de Home Assistant (${v ? safeField(v, 20) : 'desconocida'}): solo en las que conozco (de 2024.10 a 2027.x). No se cambió nada.`,
    );
  }
}

/** La configuración guardada de lo que se toca; `null` si no existe (404). */
async function existing(
  c: HaClient,
  kind: HaConfigKind,
  id: string,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown> | null> {
  try {
    const data = await c.getJson(`/api/config/${kind}/config/${id}`, signal);
    return isRecord(data) ? data : {};
  } catch (err) {
    if (err instanceof HaHttpError && err.status === 404) return null;
    throw err;
  }
}

// --- Respuestas de escritura ------------------------------------------------------------

/** Lo único que se da por hecho: exactamente `{"result":"ok"}`. */
function isOk(reply: unknown): boolean {
  return isRecord(reply) && Object.keys(reply).length === 1 && reply.result === 'ok';
}

/** Qué tool de lectura enseña lo que hay de cada tipo. */
const checkWith = (kind: HaConfigKind): string =>
  kind === 'scene' ? 'ha_buscar con dominio scene' : 'ha_automatizaciones';

const unknownReply = (kind: HaConfigKind): ToolUserError =>
  new ToolUserError(
    `Home Assistant respondió algo que no reconozco: no sé si aplicó el cambio; compruébalo con ${checkWith(kind)}.`,
  );

/**
 * Una escritura (POST o DELETE) con todos sus finales: rechazo, «no sé si llegó»,
 * respuesta no reconocida. Nunca reintenta. `onBadRequest` deja que cada llamador
 * dé su texto a un 400.
 */
async function sendWrite(
  kind: HaConfigKind,
  run: () => Promise<unknown>,
  onBadRequest: (err: HaHttpError) => ToolUserError | null,
): Promise<void> {
  let reply: unknown;
  try {
    reply = await run();
  } catch (err) {
    if (err instanceof HaHttpError && err.status === 400) {
      const handled = onBadRequest(err);
      if (handled) throw handled;
    }
    // Un 5xx puede llegar con el cambio ya hecho: HA guarda el fichero y después
    // recarga, y lo que falla puede ser la recarga.
    if (err instanceof HaHttpError && err.status >= 500) {
      throw new ToolUserError(
        `${err.message} No sé si Home Assistant llegó a hacer el cambio: compruébalo con ${checkWith(kind)} antes de repetir (no lo reintento).`,
      );
    }
    if (err instanceof HaNetworkError && err.maybeSent) {
      throw new ToolUserError(
        `${err.message} No sé si Home Assistant llegó a hacer el cambio: compruébalo con ${checkWith(kind)} antes de repetir (no lo reintento).`,
        err.kind,
      );
    }
    throw err;
  }
  if (!isOk(reply)) throw unknownReply(kind);
}

const rejected = (err: HaHttpError): ToolUserError =>
  new ToolUserError(
    `Home Assistant rechazó la configuración: ${safeField(err.detail, 200) || 'sin detalle'}. No se cambió nada.`,
  );

// --- Ver lo escrito ---------------------------------------------------------------------------

/** La entidad de lo recién escrito (automatización y escena por `attributes.id`; script por su id). */
async function findEntity(
  ctx: HaToolContext,
  c: HaClient,
  kind: HaConfigKind,
  id: string,
  signal: AbortSignal | undefined,
): Promise<HaState | null> {
  for (let i = 0; i < LOOKUP_ATTEMPTS; i++) {
    await ctx.sleep(LOOKUP_WAIT_MS);
    try {
      const states = await c.getStates(signal);
      const found = states.find((s) =>
        kind === 'script'
          ? s.entity_id === `script.${id}`
          : s.entity_id.startsWith(`${kind}.`) && s.attributes.id === id,
      );
      if (found) return found;
    } catch (err) {
      // Ver lo escrito es auxiliar: un fallo aquí no deshace ni desmiente la escritura.
      if (!(err instanceof ToolUserError)) throw err;
    }
  }
  return null;
}

function nameOfConfig(tipo: Tipo, config: Record<string, unknown>): string {
  return safeField(tipo === 'escena' ? config.name : config.alias, 100);
}

// --- Tools -------------------------------------------------------------------------------------

export function createConfigWriteTools(ctx: HaToolContext): ConnectorTool[] {
  const haProponer: ConnectorTool = {
    name: 'ha_proponer_automatizacion',
    description:
      'Crea o modifica una automatización, un script o una escena PROPIA de Home Assistant (su id empieza por ' +
      'stratum_; nunca toca las demás). La persona aprueba la propuesta entera en Dot antes de que se escriba. ' +
      'Por defecto se crea desactivada (habilitada: true la crea activada). Para «créame una automatización ' +
      'que…». Comprueba antes los entity_id con ha_buscar y mantén la configuración breve.',
    inputSchema: {
      type: 'object',
      properties: {
        accion: { type: 'string', enum: ['crear', 'modificar'] },
        tipo: { type: 'string', enum: [...TIPOS] },
        id: {
          type: 'string',
          description:
            'Identificador propio: stratum_ y minúsculas, números o _ (p. ej. stratum_luz_pasillo).',
        },
        config: {
          type: 'object',
          description:
            'Automatización: alias, description, triggers, conditions, actions, mode, max, variables. ' +
            'Script: alias, description, sequence, mode, max, fields, variables. ' +
            'Escena: name y entities. Sin id ni initial_state: los pone el conector.',
        },
        habilitada: {
          type: 'boolean',
          description:
            'Solo al crear una automatización: true la crea activada. Por defecto false.',
        },
      },
      required: ['accion', 'tipo', 'id', 'config'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const c = ctx.need();
      const a = parseArgs(ArgsSchema, args);
      const kind = KIND[a.tipo];
      if (a.habilitada !== undefined && !(a.tipo === 'automatizacion' && a.accion === 'crear')) {
        throw new ToolUserError(
          'Argumento inválido: habilitada solo vale al crear una automatización (una que se modifica conserva su estado; scripts y escenas no actúan solos).',
        );
      }
      validateConfig(a.tipo, a.config);

      await assertKnownVersion(c, signal);

      const current = await existing(c, kind, a.id, signal);
      if (a.accion === 'crear' && current !== null) {
        throw new ToolUserError(
          `${a.id} ya existe: usa accion modificar para cambiarla. No se cambió nada.`,
        );
      }
      if (a.accion === 'modificar' && current === null) {
        throw new ToolUserError(
          `${a.id} no existe: usa accion crear para crearla. No se cambió nada.`,
        );
      }

      const write = (body: Record<string, unknown>): Promise<void> =>
        sendWrite(kind, () => c.writeConfig(kind, a.id, body, signal), rejected);

      // Una automatización nueva nace apagada con `initial_state: false`, sin ventana en
      // la que pueda saltar; la segunda escritura lo quita para que no la apague en cada
      // reinicio (HA restaura el último estado al recargarla).
      const bornOff = a.tipo === 'automatizacion' && a.accion === 'crear' && a.habilitada !== true;
      if (bornOff) {
        await write({ ...a.config, initial_state: false });
        try {
          await write(a.config);
        } catch (err) {
          const why = err instanceof ToolUserError ? ` (${err.message})` : '';
          throw new ToolUserError(
            `La automatización ${a.id} quedó creada y apagada, pero con initial_state: false guardado (se apagará en cada reinicio): vuelve a proponerla con accion modificar.${why}`,
          );
        }
      } else {
        await write(a.config);
      }

      const entity = await findEntity(ctx, c, kind, a.id, signal);
      const done = a.accion === 'crear' ? 'Creada' : 'Modificada';
      const lines = [
        `${done} ${TIPO_TEXT[a.tipo]} «${nameOfConfig(a.tipo, a.config)}» (${a.id}).`,
        `Tipo: ${a.tipo} · id: ${a.id} · entity_id: ${entity ? entity.entity_id : 'sin dato: aún no aparece'}`,
      ];
      if (a.tipo === 'automatizacion') {
        const label = entity ? stateLabel({ kind: 'automation', state: entity }) : NO_DATA;
        lines.push(`Estado: ${label}.`);
        if (a.accion === 'modificar') {
          lines.push(`Conserva su estado (${label}).`);
        } else if (bornOff) {
          lines.push(
            `Para activarla: ha_encender con ${entity ? entity.entity_id : 'su entity_id'} (pide aprobación).`,
          );
        }
      } else if (a.tipo === 'escena' && a.accion === 'crear') {
        lines.push('Crearla no la activa.');
      }
      return lines.join('\n');
    },
  };

  const haBorrar: ConnectorTool = {
    name: 'ha_borrar_automatizacion',
    description:
      'Borra una automatización, un script o una escena PROPIA de Home Assistant (su id empieza por stratum_; ' +
      'nunca borra las demás). La persona lo aprueba en Dot antes de que se borre.',
    inputSchema: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: [...TIPOS] },
        id: {
          type: 'string',
          description: 'Identificador propio: stratum_ y minúsculas, números o _.',
        },
      },
      required: ['tipo', 'id'],
      additionalProperties: false,
    },
    async handler(args, signal) {
      const c = ctx.need();
      const a = parseArgs(DeleteSchema, args);
      const kind = KIND[a.tipo];
      await assertKnownVersion(c, signal);

      const current = await existing(c, kind, a.id, signal);
      if (current === null) {
        return `${a.id} no existe (nada que borrar).`;
      }
      const name = safeField(a.tipo === 'escena' ? current.name : current.alias, 100);
      await sendWrite(
        kind,
        () => c.deleteConfig(kind, a.id, signal),
        (err) =>
          /not found/i.test(err.detail)
            ? new ToolUserError(`${a.id} ya no existe (nada que borrar).`)
            : null,
      );
      return `Borrada ${TIPO_TEXT[a.tipo]}${name ? ` «${name}»` : ''} (${a.id}).`;
    },
  };

  return [haProponer, haBorrar];
}
