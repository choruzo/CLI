import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { METHODS, NOTIFICATIONS, STRATUM_PROTOCOL_VERSION, type MethodName } from './index.js';
import * as schemas from './schemas.js';
import {
  NOTIFICATION_PARAMS,
  PARAMS,
  RESULTS,
  STATE_EVENT_DATA,
  VOLATILE_EVENT_DATA,
  errorResponseSchema,
  eventSchema,
  notificationMessageSchema,
  requestMessageSchema,
  sessionSchema,
  sessionSnapshotSchema,
  successResponseSchema,
} from './schemas.js';
import {
  sampleApproval,
  sampleRun,
  sampleSession,
  sampleSnapshot,
  sampleToolCall,
} from './protocol.fixtures.js';

const hello = {
  protocol: STRATUM_PROTOCOL_VERSION,
  token: 't'.repeat(64),
  client: { kind: 'cli', name: 'stratum-cli', version: '0.9.0' },
  roles: ['observer'],
};

describe('cobertura', () => {
  it('hay schema de parámetros y de resultado para cada método, y solo para ellos', () => {
    const methods = Object.keys(METHODS).sort();
    expect(Object.keys(PARAMS).sort()).toEqual(methods);
    expect(Object.keys(RESULTS).sort()).toEqual(methods);
  });

  it('hay schema para cada notificación', () => {
    expect(Object.keys(NOTIFICATION_PARAMS).sort()).toEqual([...NOTIFICATIONS].sort());
  });
});

describe('sobre de los mensajes', () => {
  it('acepta las tres formas', () => {
    expect(requestMessageSchema.safeParse({ id: 1, method: 'core.status' }).success).toBe(true);
    expect(notificationMessageSchema.safeParse({ method: 'events', params: {} }).success).toBe(
      true,
    );
    expect(successResponseSchema.safeParse({ id: 'a', result: null }).success).toBe(true);
    expect(
      errorResponseSchema.safeParse({ id: null, error: { code: 'INVALID_REQUEST', message: 'x' } })
        .success,
    ).toBe(true);
  });

  it('rechaza campos de más, ids imposibles y códigos de error inventados', () => {
    expect(requestMessageSchema.safeParse({ id: 1, method: 'x', extra: 1 }).success).toBe(false);
    expect(requestMessageSchema.safeParse({ id: {}, method: 'x' }).success).toBe(false);
    expect(requestMessageSchema.safeParse({ id: 1, method: '' }).success).toBe(false);
    expect(successResponseSchema.safeParse({ id: 1 }).success).toBe(false);
    expect(
      errorResponseSchema.safeParse({ id: 1, error: { code: 'BOOM', message: 'x' } }).success,
    ).toBe(false);
  });
});

describe('parámetros: estrictos', () => {
  it('core.hello exige versión, token, cliente y al menos un rol', () => {
    expect(PARAMS['core.hello'].safeParse(hello).success).toBe(true);
    for (const missing of ['protocol', 'token', 'client', 'roles'] as const) {
      const partial: Record<string, unknown> = { ...hello };
      delete partial[missing];
      expect(PARAMS['core.hello'].safeParse(partial).success, missing).toBe(false);
    }
    expect(PARAMS['core.hello'].safeParse({ ...hello, roles: [] }).success).toBe(false);
    expect(PARAMS['core.hello'].safeParse({ ...hello, roles: ['root'] }).success).toBe(false);
    expect(
      PARAMS['core.hello'].safeParse({ ...hello, client: { ...hello.client, kind: 'browser' } })
        .success,
    ).toBe(false);
  });

  it('un campo desconocido invalida la petición', () => {
    expect(PARAMS['runs.start'].safeParse({ sessionId: 's', input: 'hola' }).success).toBe(true);
    expect(
      PARAMS['runs.start'].safeParse({ sessionId: 's', input: 'hola', sudo: true }).success,
    ).toBe(false);
    expect(PARAMS['core.status'].safeParse({ x: 1 }).success).toBe(false);
  });

  it('aplica tipos y límites', () => {
    expect(PARAMS['runs.start'].safeParse({ sessionId: 's', input: '' }).success).toBe(false);
    expect(PARAMS['runs.start'].safeParse({ sessionId: 's', input: 7 }).success).toBe(false);
    expect(
      PARAMS['approvals.resolve'].safeParse({ approvalId: 'a', decision: 'maybe' }).success,
    ).toBe(false);
    expect(
      PARAMS['events.subscribe'].safeParse({ scope: { kind: 'session', sessionId: 's' } }).success,
    ).toBe(true);
    expect(PARAMS['events.subscribe'].safeParse({ scope: { kind: 'all' } }).success).toBe(false);
    expect(PARAMS['sessions.list'].safeParse({ limit: 100_000 }).success).toBe(false);
  });

  it('las peticiones mutantes admiten operationId; las de lectura no lo necesitan', () => {
    const mutating = (Object.keys(METHODS) as MethodName[]).filter(
      (m) => METHODS[m].mutating && METHODS[m].direction === 'client-to-server',
    );
    // `host.publish` es un flujo, no una operación con identidad propia.
    for (const m of mutating.filter((m) => m !== 'host.publish')) {
      expect(hasKey(PARAMS[m], 'operationId'), m).toBe(true);
    }
  });
});

describe('DTOs y resultados: tolerantes', () => {
  it('validan los valores de ejemplo', () => {
    expect(sessionSchema.parse(sampleSession())).toEqual(sampleSession());
    expect(sessionSnapshotSchema.parse(sampleSnapshot())).toEqual(sampleSnapshot());
    expect(RESULTS['runs.get'].parse({ run: sampleRun() })).toEqual({ run: sampleRun() });
  });

  it('descartan los campos que no son del contrato en vez de fallar', () => {
    const parsed = sessionSchema.parse({ ...sampleSession(), internalHandle: 42, config: {} });
    expect(parsed).toEqual(sampleSession());
    expect(RESULTS['core.shutdown'].parse({ later: true })).toEqual({});
  });

  it('rechazan un valor que no cumple el contrato', () => {
    expect(sessionSchema.safeParse({ ...sampleSession(), state: 'zombie' }).success).toBe(false);
    expect(sessionSchema.safeParse({ ...sampleSession(), seq: -1 }).success).toBe(false);
  });
});

describe('eventos', () => {
  const state = {
    type: 'tool.completed',
    sessionId: 's1',
    runId: 'run_1',
    at: 10,
    seq: 4,
    data: { call: sampleToolCall() },
  };
  const volatile = {
    type: 'message.delta',
    sessionId: 's1',
    at: 11,
    after: 4,
    data: { text: 'ho' },
  };

  it('hay schema de datos para cada tipo de evento', () => {
    expect(Object.keys(STATE_EVENT_DATA).length + Object.keys(VOLATILE_EVENT_DATA).length).toBe(35);
  });

  it('valida los de estado y los volátiles', () => {
    expect(eventSchema.parse(state)).toEqual(state);
    expect(eventSchema.parse(volatile)).toEqual(volatile);
  });

  it('un evento de estado necesita seq ≥ 1 y no admite after', () => {
    expect(eventSchema.safeParse({ ...state, seq: undefined }).success).toBe(false);
    expect(eventSchema.safeParse({ ...state, seq: 0 }).success).toBe(false);
    expect(eventSchema.safeParse({ ...state, after: 3 }).success).toBe(false);
  });

  it('un evento volátil lleva after y nunca seq', () => {
    expect(eventSchema.safeParse({ ...volatile, seq: 5 }).success).toBe(false);
    expect(eventSchema.safeParse({ ...volatile, after: undefined }).success).toBe(false);
    expect(eventSchema.parse({ ...volatile, after: 0 }).type).toBe('message.delta');
  });

  it('rechaza tipos desconocidos y datos que no son los de su tipo', () => {
    expect(eventSchema.safeParse({ ...state, type: 'run.exploded' }).success).toBe(false);
    expect(eventSchema.safeParse({ ...state, type: 'toString' }).success).toBe(false);
    expect(eventSchema.safeParse({ ...state, data: { text: 'x' } }).success).toBe(false);
    expect(eventSchema.safeParse(null).success).toBe(false);
  });

  it('se reconstruye solo con los campos del contrato', () => {
    const parsed = eventSchema.parse({
      ...state,
      debug: { stack: 'at foo (/home/u/x.ts:1)' },
      data: { call: { ...sampleToolCall(), rawParams: { token: 'sk-secret' } } },
    });
    expect(parsed).toEqual(state);
  });
});

// ---------------------------------------------------------------------------
// `sessions.open.env` es de solo entrada: no existe en nada que se devuelva.
// ---------------------------------------------------------------------------

/** Recorre un schema de Zod y devuelve las rutas de todas las claves de objeto. */
function objectKeys(schema: z.ZodTypeAny, path = '', seen = new Set<z.ZodTypeAny>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = schema._def as Record<string, unknown> & { typeName?: string };
  const next = (inner: unknown, p = path): string[] =>
    inner ? objectKeys(inner as z.ZodTypeAny, p, seen) : [];
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
      return Object.entries(shape).flatMap(([key, value]) => {
        const here = path ? `${path}.${key}` : key;
        return [here, ...next(value, here)];
      });
    }
    case 'ZodArray':
      return next(def.type, `${path}[]`);
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
    case 'ZodReadonly':
      return next(def.innerType);
    case 'ZodEffects':
      return next(def.schema);
    case 'ZodRecord':
      return next(def.valueType, `${path}{}`);
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion': {
      const options = def.options as z.ZodTypeAny[] | Map<unknown, z.ZodTypeAny>;
      return [...(options instanceof Map ? options.values() : options)].flatMap((o) => next(o));
    }
    default:
      return [];
  }
}

function hasKey(schema: z.ZodTypeAny, key: string): boolean {
  return objectKeys(schema).some((p) => p === key);
}

const isEnvKey = (path: string): boolean => /(^|\.|\[\]|\{\})env$/i.test(path);

describe('env es de solo entrada', () => {
  it('el recorrido de schemas ve las claves anidadas (control)', () => {
    const keys = objectKeys(sessionSnapshotSchema);
    expect(keys).toContain('session.host.client');
    expect(keys).toContain('toolCalls[].description');
    expect(objectKeys(PARAMS['sessions.open']).filter(isEnvKey)).toEqual(['env']);
  });

  it('ningún DTO, resultado, notificación, evento ni error declara un campo env', () => {
    const offenders: string[] = [];
    const check = (label: string, schema: unknown): void => {
      if (!(schema instanceof z.ZodType)) return;
      for (const path of objectKeys(schema).filter(isEnvKey)) offenders.push(`${label}: ${path}`);
    };

    // Todo lo exportado que sea un schema (DTOs, sobre, snapshots, error)…
    for (const [name, value] of Object.entries(schemas)) check(name, value);
    // …y las tablas, entrada a entrada.
    for (const [m, s] of Object.entries(RESULTS)) check(`result ${m}`, s);
    for (const [n, s] of Object.entries(NOTIFICATION_PARAMS)) check(`notification ${n}`, s);
    for (const [t, s] of Object.entries(STATE_EVENT_DATA)) check(`event ${t}`, s);
    for (const [t, s] of Object.entries(VOLATILE_EVENT_DATA)) check(`event ${t}`, s);
    // De los parámetros, solo `sessions.open` puede traerlo.
    for (const [m, s] of Object.entries(PARAMS)) {
      if (m !== 'sessions.open') check(`params ${m}`, s);
    }

    expect(offenders).toEqual([]);
  });

  it('un env colado en una sesión, un snapshot o un evento no sobrevive a la validación', () => {
    const secret = 'sk-live-0123456789abcdef';
    const env = { API_KEY: secret };
    const session = { ...sampleSession(), env };
    const snapshot = {
      ...sampleSnapshot(),
      env,
      session,
      run: { ...sampleRun(), env },
      approvals: [{ ...sampleApproval(), env }],
    };
    const event = {
      type: 'session.updated',
      sessionId: 's1',
      at: 1,
      seq: 1,
      env,
      data: { session, env },
    };

    const outputs = [
      sessionSchema.parse(session),
      sessionSnapshotSchema.parse(snapshot),
      eventSchema.parse(event),
      RESULTS['sessions.open'].parse({ session, env }),
      RESULTS['sessions.get'].parse({ snapshot }),
      NOTIFICATION_PARAMS.snapshot.parse({ subscriptionId: 'sub1', snapshot }),
      PARAMS['host.register'].parse({ snapshot }),
      PARAMS['host.publish'].parse({ sessionId: 's1', events: [event] }),
    ];
    for (const output of outputs) expect(JSON.stringify(output)).not.toContain(secret);
  });

  it('sessions.open lo acepta como entrada, con límites', () => {
    const open = PARAMS['sessions.open'];
    expect(open.safeParse({ cwd: '/w', env: { PATH: '/bin' } }).success).toBe(true);
    expect(open.safeParse({ cwd: '/w', env: { PATH: 7 } }).success).toBe(false);
    expect(open.safeParse({ cwd: '/w', env: 'PATH=/bin' }).success).toBe(false);
  });
});
