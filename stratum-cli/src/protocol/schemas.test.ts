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

  it('approvals.resolve admite grant con 10, 30 o 60 minutos; grants.revoke es estricto (M17)', () => {
    const base = { approvalId: 'a', decision: 'approve' };
    for (const minutes of [10, 30, 60]) {
      expect(PARAMS['approvals.resolve'].safeParse({ ...base, grant: { minutes } }).success).toBe(
        true,
      );
      expect(
        PARAMS['host.resolveApproval'].safeParse({
          sessionId: 's',
          ...base,
          grant: { minutes },
          by: { kind: 'remote', client: 'cli', at: 1 },
        }).success,
      ).toBe(true);
    }
    for (const minutes of [15, 0, -10, '30']) {
      expect(PARAMS['approvals.resolve'].safeParse({ ...base, grant: { minutes } }).success).toBe(
        false,
      );
    }
    expect(
      PARAMS['approvals.resolve'].safeParse({ ...base, grant: { minutes: 10, extra: 1 } }).success,
    ).toBe(false);
    expect(PARAMS['grants.revoke'].safeParse({ sessionId: 's', grantId: 'g' }).success).toBe(true);
    expect(PARAMS['grants.revoke'].safeParse({ sessionId: 's' }).success).toBe(false);
    expect(PARAMS['grants.revoke'].safeParse({ sessionId: 's', grantId: 'g', x: 1 }).success).toBe(
      false,
    );
    expect(PARAMS['host.revokeGrant'].safeParse({ sessionId: 's', grantId: 'g' }).success).toBe(
      true,
    );
    expect(METHODS['grants.revoke'].capability).toBe('control');
  });

  it('runs.start, runs.steer y host.steer: images son de 1 a 5 rutas', () => {
    const paths = (k: number) => Array.from({ length: k }, (_, i) => `/p/${i}.png`);
    const base = {
      'runs.start': { sessionId: 's', input: 'hola' },
      'runs.steer': { sessionId: 's', text: 'ojo' },
      'host.steer': { sessionId: 's', text: 'ojo' },
    } as const;
    for (const method of ['runs.start', 'runs.steer', 'host.steer'] as const) {
      const ok = (images: unknown) => PARAMS[method].safeParse({ ...base[method], images }).success;
      expect(PARAMS[method].safeParse(base[method]).success, `${method} sin images`).toBe(true);
      expect(ok(paths(1)), `${method} 1`).toBe(true);
      expect(ok(paths(5)), `${method} 5`).toBe(true);
      expect(ok([]), `${method} vacío`).toBe(false);
      expect(ok(paths(6)), `${method} 6`).toBe(false);
      expect(ok(['']), `${method} ruta vacía`).toBe(false);
      expect(ok([7]), `${method} no cadena`).toBe(false);
    }
  });

  it('las peticiones mutantes admiten operationId; las de lectura no lo necesitan', () => {
    const mutating = (Object.keys(METHODS) as MethodName[]).filter(
      (m) => METHODS[m].mutating && METHODS[m].direction === 'client-to-server',
    );
    // `host.publish` es un flujo, no una operación con identidad propia; los
    // pasos de un traspaso tras `host.handoffBegin` se identifican por su `handoffId`.
    const flows: MethodName[] = [
      'host.publish',
      'host.handoffChunk',
      'host.handoffCommit',
      'host.handoffAbort',
    ];
    for (const m of mutating.filter((m) => !flows.includes(m))) {
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
    expect(Object.keys(STATE_EVENT_DATA).length + Object.keys(VOLATILE_EVENT_DATA).length).toBe(36);
  });

  it('valida los de estado y los volátiles', () => {
    expect(eventSchema.parse(state)).toEqual(state);
    expect(eventSchema.parse(volatile)).toEqual(volatile);
  });

  it('los eventos grant.* validan y no admiten razones inventadas (M17)', () => {
    const grant = {
      id: 'g1',
      sessionId: 's1',
      tool: 'exec',
      target: 'local',
      minutes: 10,
      grantedAt: 1,
      expiresAt: 600_001,
      grantedBy: { kind: 'remote', client: 'cli', at: 1 },
    };
    const created = { type: 'grant.created', sessionId: 's1', at: 10, seq: 5, data: { grant } };
    expect(eventSchema.parse(created)).toEqual(created);
    for (const reason of ['expired', 'revoked', 'host-changed']) {
      const ended = {
        type: 'grant.ended',
        sessionId: 's1',
        at: 10,
        seq: 6,
        data: { grantId: 'g1', reason },
      };
      expect(eventSchema.parse(ended)).toEqual(ended);
    }
    expect(
      eventSchema.safeParse({ ...created, data: { grant: { ...grant, minutes: 15 } } }).success,
    ).toBe(false);
    expect(
      eventSchema.safeParse({
        type: 'grant.ended',
        sessionId: 's1',
        at: 10,
        seq: 6,
        data: { grantId: 'g1', reason: 'because' },
      }).success,
    ).toBe(false);
  });

  it('la foto lleva grants opcionales y la aprobación, grantable', () => {
    expect(sessionSnapshotSchema.parse(sampleSnapshot()).grants).toBeUndefined();
    const withGrants = {
      ...sampleSnapshot(),
      grants: [
        {
          id: 'g1',
          sessionId: 's1',
          tool: 'exec',
          minutes: 60,
          grantedAt: 1,
          expiresAt: 2,
          grantedBy: { kind: 'remote', client: 'dot', at: 1 },
        },
      ],
    };
    expect(sessionSnapshotSchema.parse(withGrants).grants).toHaveLength(1);
    expect(schemas.approvalSchema.parse({ ...sampleApproval(), grantable: true }).grantable).toBe(
      true,
    );
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

describe('la clave de aprobador es de solo entrada', () => {
  const isKey = (path: string): boolean => /approver|credential|passphrase|secret/i.test(path);

  it('solo existe en core.hello, y en ningún resultado, notificación ni evento', () => {
    expect(objectKeys(PARAMS['core.hello']).filter(isKey)).toEqual(['approverKey']);
    const offenders: string[] = [];
    const check = (label: string, schema: unknown): void => {
      if (!(schema instanceof z.ZodType)) return;
      for (const path of objectKeys(schema).filter(isKey)) offenders.push(`${label}: ${path}`);
    };
    for (const [name, value] of Object.entries(schemas)) check(name, value);
    for (const [m, s] of Object.entries(RESULTS)) check(`result ${m}`, s);
    for (const [n, s] of Object.entries(NOTIFICATION_PARAMS)) check(`notification ${n}`, s);
    for (const [t, s] of Object.entries(STATE_EVENT_DATA)) check(`event ${t}`, s);
    for (const [t, s] of Object.entries(VOLATILE_EVENT_DATA)) check(`event ${t}`, s);
    for (const [m, s] of Object.entries(PARAMS)) {
      if (m !== 'core.hello') check(`params ${m}`, s);
    }
    expect(offenders).toEqual([]);
  });

  it('una clave colada en el resultado del handshake no sobrevive a la validación', () => {
    const hello = RESULTS['core.hello'].parse({
      protocol: STRATUM_PROTOCOL_VERSION,
      server: { version: '1', platform: 'linux' },
      connectionId: 3,
      capabilities: ['observe', 'approve'],
      features: [],
      approverKey: 'no debería volver',
    });
    expect(JSON.stringify(hello)).not.toContain('no debería volver');
  });

  it('quién resolvió: una vía y, como mucho, lo que el cliente declaró ser', () => {
    const resolved = STATE_EVENT_DATA['approval.resolved'];
    const ok = resolved.parse({
      approvalId: 'apr_1',
      status: 'approved',
      decision: 'approve',
      resolvedBy: { kind: 'remote', client: 'cli', connectionId: 4, at: 10, token: 't', pid: 9 },
    });
    expect(ok.resolvedBy).toEqual({ kind: 'remote', client: 'cli', connectionId: 4, at: 10 });
    for (const kind of ['local', 'timeout', 'policy'] as const) {
      expect(
        resolved.safeParse({ approvalId: 'a', status: 'denied', resolvedBy: { kind, at: 1 } })
          .success,
      ).toBe(true);
    }
    expect(
      resolved.safeParse({ approvalId: 'a', status: 'denied', resolvedBy: { kind: 'host', at: 1 } })
        .success,
    ).toBe(false);
  });
});

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
      PARAMS['host.publish'].parse({ sessionId: 's1', epoch: 1, events: [event] }),
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

describe('routines.* (M16)', () => {
  const add = PARAMS['routines.add'];
  const base = { name: 'n', schedule: '1h', prompt: 'p' };

  it('add acepta lo mínimo y los límites completos, y rechaza claves ajenas', () => {
    expect(add.safeParse(base).success).toBe(true);
    expect(
      add.safeParse({
        ...base,
        model: 'm',
        enabled: false,
        limits: { maxIterations: 200, timeoutMinutes: 1440 },
        operationId: 'op1',
      }).success,
    ).toBe(true);
    expect(add.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(add.safeParse({ ...base, limits: { maxIterations: 5, extra: 1 } }).success).toBe(false);
  });

  it('add respeta los topes del almacén', () => {
    expect(add.safeParse({ ...base, name: '' }).success).toBe(false);
    expect(add.safeParse({ ...base, name: 'x'.repeat(81) }).success).toBe(false);
    expect(add.safeParse({ ...base, name: 'x'.repeat(80) }).success).toBe(true);
    expect(add.safeParse({ ...base, prompt: '' }).success).toBe(false);
    expect(add.safeParse({ ...base, prompt: 'x'.repeat(8001) }).success).toBe(false);
    expect(add.safeParse({ ...base, schedule: 'x'.repeat(201) }).success).toBe(false);
    expect(add.safeParse({ ...base, limits: { maxIterations: 0 } }).success).toBe(false);
    expect(add.safeParse({ ...base, limits: { maxIterations: 201 } }).success).toBe(false);
    expect(add.safeParse({ ...base, limits: { timeoutMinutes: 1441 } }).success).toBe(false);
    expect(add.safeParse({ ...base, limits: { timeoutMinutes: 1.5 } }).success).toBe(false);
  });

  it('update admite null para quitar model y limits, y no admite otras claves en el parche', () => {
    const update = PARAMS['routines.update'];
    expect(
      update.safeParse({ routineId: 'r', patch: { model: null, limits: null, enabled: true } })
        .success,
    ).toBe(true);
    expect(update.safeParse({ routineId: 'r', patch: { name: null } }).success).toBe(false);
    expect(update.safeParse({ routineId: 'r', patch: { id: 'otro' } }).success).toBe(false);
    expect(update.safeParse({ patch: {} }).success).toBe(false);
  });

  it('list/remove/run: formas estrictas', () => {
    expect(PARAMS['routines.list'].safeParse({}).success).toBe(true);
    expect(PARAMS['routines.list'].safeParse({ x: 1 }).success).toBe(false);
    expect(PARAMS['routines.remove'].safeParse({ routineId: 'r' }).success).toBe(true);
    expect(PARAMS['routines.run'].safeParse({}).success).toBe(false);
    expect(PARAMS['routines.run'].safeParse({ routineId: 'r', x: 1 }).success).toBe(false);
  });

  it('capacidades: observe lee, control muta', () => {
    expect(METHODS['routines.list']).toMatchObject({ capability: 'observe', mutating: false });
    for (const m of ['add', 'update', 'remove', 'run'] as const) {
      expect(METHODS[`routines.${m}`]).toMatchObject({ capability: 'control', mutating: true });
    }
  });

  it('ProtocolSession.routineId es opcional y de solo procedencia', () => {
    const session = sampleSession();
    expect(sessionSchema.safeParse(session).success).toBe(true);
    expect(sessionSchema.safeParse({ ...session, routineId: 'rt_abc' }).success).toBe(true);
  });
});
