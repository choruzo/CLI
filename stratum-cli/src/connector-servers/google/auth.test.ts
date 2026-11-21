import { describe, expect, it } from 'vitest';
import { ToolUserError } from '../lib/mcp-stdio.js';
import { GoogleNotFoundError, createGoogleAuth, SETUP_COMMAND, type GoogleAuth } from './auth.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const LIST_URL = 'https://tasks.googleapis.com/tasks/v1/users/@me/lists';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';

const CLIENT_ID = 'cid-123';
const CLIENT_SECRET = 'sec-SECRETO-123';
const REFRESH = 'ref-SECRETO-456';

interface Call {
  method: string;
  url: string;
  body: string;
  auth: string;
}

/** `fetch` falso que enruta por URL; `tokens` son las respuestas del endpoint OAuth. */
function setup(
  opts: {
    tokenResponses?: Array<{ status?: number; body: unknown }>;
    apiResponses?: Array<{ status: number; body: unknown }>;
    /** Respuesta cruda de la API (cuerpos enormes o en streaming). */
    rawResponse?: () => Response | Promise<Response>;
    now?: () => number;
  } = {},
) {
  const calls: Call[] = [];
  const tokens = [
    ...(opts.tokenResponses ?? [{ body: { access_token: 'at-1', expires_in: 3600 } }]),
  ];
  const apis = [...(opts.apiResponses ?? [{ status: 200, body: { items: [] } }])];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      method: init?.method ?? 'GET',
      url,
      body: String(init?.body ?? ''),
      auth: String((init?.headers as Record<string, string> | undefined)?.Authorization ?? ''),
    });
    if (url === TOKEN_URL) {
      const next = tokens.shift() ?? { body: { access_token: 'at-x' } };
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
    }
    if (opts.rawResponse) return opts.rawResponse();
    const next = apis.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { fetch: f, calls, tokenCalls: () => calls.filter((c) => c.url === TOKEN_URL) };
}

function make(
  opts: Parameters<typeof setup>[0] & { now?: () => number } = {},
  creds: { clientId?: string; clientSecret?: string; refreshToken?: string } = {},
) {
  const fake = setup(opts);
  const auth = createGoogleAuth({
    fetch: fake.fetch,
    clientId: creds.clientId ?? CLIENT_ID,
    clientSecret: creds.clientSecret ?? CLIENT_SECRET,
    refreshToken: creds.refreshToken ?? REFRESH,
    now: opts.now,
  }) as GoogleAuth;
  return { auth, ...fake };
}

describe('createGoogleAuth: credenciales', () => {
  it('sin credenciales devuelve null', () => {
    const { fetch } = setup();
    expect(createGoogleAuth({ fetch })).toBeNull();
    expect(
      createGoogleAuth({ fetch, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
    ).toBeNull();
    expect(createGoogleAuth({ fetch, clientId: CLIENT_ID, refreshToken: REFRESH })).toBeNull();
    expect(
      createGoogleAuth({ fetch, clientSecret: CLIENT_SECRET, refreshToken: REFRESH }),
    ).toBeNull();
  });

  it('las credenciales en blanco tampoco valen', () => {
    const { fetch } = setup();
    expect(
      createGoogleAuth({ fetch, clientId: ' ', clientSecret: ' ', refreshToken: ' ' }),
    ).toBeNull();
  });
});

describe('createGoogleAuth: renovación del token', () => {
  it('cambia el refresh token por un access token con el formulario correcto', async () => {
    const { auth, tokenCalls } = make();
    expect(await auth.accessToken()).toBe('at-1');
    const [call] = tokenCalls();
    expect(call.method).toBe('POST');
    expect(call.body).toContain('grant_type=refresh_token');
    expect(call.body).toContain(`client_id=${CLIENT_ID}`);
    expect(call.body).toContain(`client_secret=${encodeURIComponent(CLIENT_SECRET)}`);
    expect(call.body).toContain(`refresh_token=${encodeURIComponent(REFRESH)}`);
  });

  it('cachea el token hasta expires_in - 60 s', async () => {
    let clock = 1_000_000;
    const { auth, tokenCalls } = make({
      now: () => clock,
      tokenResponses: [
        { body: { access_token: 'at-1', expires_in: 3600 } },
        { body: { access_token: 'at-2', expires_in: 3600 } },
      ],
    });
    expect(await auth.accessToken()).toBe('at-1');
    // 3530 s: todavía dentro de la validez (3600 - 60).
    clock += 3530 * 1000;
    expect(await auth.accessToken()).toBe('at-1');
    expect(tokenCalls()).toHaveLength(1);
    // 3550 s: ya caducado para nosotros, renueva.
    clock += 20 * 1000;
    expect(await auth.accessToken()).toBe('at-2');
    expect(tokenCalls()).toHaveLength(2);
  });

  it('dos peticiones a la vez comparten una sola renovación', async () => {
    const { auth, tokenCalls } = make();
    const [a, b] = await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect([a, b]).toEqual(['at-1', 'at-1']);
    expect(tokenCalls()).toHaveLength(1);
  });

  it('un 400 invalid_grant pide repetir el setup', async () => {
    const { auth } = make({
      tokenResponses: [{ status: 400, body: { error: 'invalid_grant' } }],
    });
    const err = await auth.accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolUserError);
    expect((err as Error).message).toMatch(/revocada o caducada/);
    expect((err as Error).message).toContain(SETUP_COMMAND);
  });

  it('otros errores dicen el HTTP y el error del JSON', async () => {
    const { auth } = make({ tokenResponses: [{ status: 500, body: { error: 'backend_error' } }] });
    await expect(auth.accessToken()).rejects.toThrow(/HTTP 500.*backend_error/);
  });

  it('si no viene access_token lo dice', async () => {
    const { auth } = make({ tokenResponses: [{ body: {} }] });
    await expect(auth.accessToken()).rejects.toThrow(/no devolvió un token/);
  });
});

describe('createGoogleAuth: llamadas a la API', () => {
  it('usa el access token en la cabecera', async () => {
    const { auth, calls } = make();
    await auth.api('GET', LIST_URL);
    const api = calls.find((c) => c.url === LIST_URL)!;
    expect(api.auth).toBe('Bearer at-1');
  });

  it('rechaza cualquier URL fuera de Gmail y Tasks', async () => {
    const { auth, calls } = make();
    await expect(auth.api('GET', 'https://evil.example.com/gmail/v1/x')).rejects.toThrow(
      /no permitida/,
    );
    // Un `..` que al normalizar saldría del prefijo tampoco pasa.
    await expect(auth.api('GET', `${GMAIL}../../../other/messages`)).rejects.toThrow(
      /no permitida/,
    );
    expect(calls).toHaveLength(0);
  });

  it('veta los envíos aunque caigan dentro de los prefijos permitidos', async () => {
    const { auth, calls } = make();
    const tentativas = [
      `${GMAIL}messages/send`,
      `${GMAIL}drafts/send`,
      `${GMAIL}drafts/send?alt=json`,
      `${GMAIL}messages/send?uploadType=multipart`,
    ];
    for (const url of tentativas) {
      const err = await auth.api('POST', url, { raw: 'x' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ToolUserError);
      expect((err as Error).message).toMatch(/no envía correo/);
    }
    // Ni una petición: el veto es antes de tocar la red.
    expect(calls).toHaveLength(0);
  });

  it('no veta una URL que solo se parezca', async () => {
    const { auth } = make({ apiResponses: [{ status: 200, body: { items: [] } }] });
    expect(await auth.api('GET', `${GMAIL}messages/sendero`)).toEqual({ items: [] });
  });

  it('un cuerpo de más de 5 MB se corta sin acumularlo', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(97);
    let sent = 0;
    const { auth } = make({
      apiResponses: [],
      rawResponse: () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              if (sent > 6 * 1024 * 1024) {
                controller.close();
                return;
              }
              sent += chunk.byteLength;
              controller.enqueue(chunk);
            },
          }),
        ),
    });
    await expect(auth.api('GET', LIST_URL)).rejects.toThrow(
      'La respuesta de Google es demasiado grande',
    );
    // No se ha leído el cuerpo entero.
    expect(sent).toBeLessThan(6 * 1024 * 1024);
  });

  it('si Content-Length ya dice que es enorme, ni se lee', async () => {
    const { auth } = make({
      apiResponses: [],
      rawResponse: () =>
        new Response('{}', { status: 200, headers: { 'content-length': '6291456' } }),
    });
    await expect(auth.api('GET', LIST_URL)).rejects.toThrow(
      'La respuesta de Google es demasiado grande',
    );
  });

  it('un 401 invalida el token, renueva y reintenta una sola vez', async () => {
    const { auth, calls, tokenCalls } = make({
      tokenResponses: [
        { body: { access_token: 'at-1', expires_in: 3600 } },
        { body: { access_token: 'at-2', expires_in: 3600 } },
      ],
      apiResponses: [
        { status: 401, body: { error: { message: 'Invalid Credentials' } } },
        { status: 200, body: { items: [] } },
      ],
    });
    expect(await auth.api('GET', LIST_URL)).toEqual({ items: [] });
    expect(tokenCalls()).toHaveLength(2);
    const auths = calls.filter((c) => c.url === LIST_URL).map((c) => c.auth);
    expect(auths).toEqual(['Bearer at-1', 'Bearer at-2']);
  });

  it('si tras renovar sigue el 401, no reintenta más', async () => {
    const { auth, calls } = make({
      tokenResponses: [
        { body: { access_token: 'at-1', expires_in: 3600 } },
        { body: { access_token: 'at-2', expires_in: 3600 } },
      ],
      apiResponses: [
        { status: 401, body: {} },
        { status: 401, body: {} },
      ],
    });
    await expect(auth.api('GET', LIST_URL)).rejects.toThrow(/HTTP 401/);
    expect(calls.filter((c) => c.url === LIST_URL)).toHaveLength(2);
  });

  it('un 401 con un token ya caducado por otra petición no tira el token nuevo', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let tokenCalls = 0;
    let staleCalls = 0;
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        tokenCalls += 1;
        // Al renovar por segunda vez se libera el 401 que llegaba tarde.
        if (tokenCalls === 2) release();
        return new Response(JSON.stringify({ access_token: `at-${tokenCalls}`, expires_in: 3600 }));
      }
      const auth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
      if (auth === 'Bearer at-1') {
        // La segunda petición que usa el token viejo falla, pero tarde.
        staleCalls += 1;
        if (staleCalls === 2) await gate;
        return new Response('{}', { status: 401 });
      }
      return new Response('{}');
    }) as typeof fetch;
    const auth = createGoogleAuth({
      fetch: f,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH,
    }) as GoogleAuth;
    const results = await Promise.all([auth.api('GET', LIST_URL), auth.api('GET', LIST_URL)]);
    expect(results).toEqual([{}, {}]);
    // Si el segundo 401 hubiera tirado la caché, habría una tercera renovación.
    expect(tokenCalls).toBe(2);
  });

  it('un 404 se distingue del resto', async () => {
    const { auth } = make({
      apiResponses: [{ status: 404, body: { error: { message: 'Not Found' } } }],
    });
    const err = await auth.api('GET', LIST_URL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoogleNotFoundError);
    expect((err as Error).message).toMatch(/no encontró el recurso/);
  });
});

describe('createGoogleAuth: scrub', () => {
  it('tacha el client secret, el refresh token y el access token', async () => {
    const { auth } = make();
    await auth.accessToken();
    const text = `${CLIENT_SECRET} ${REFRESH} at-1`;
    const clean = auth.scrub(text);
    expect(clean).toBe('*** *** ***');
    expect(clean).not.toContain('SECRETO');
    expect(clean).not.toContain('at-1');
  });

  it('un mensaje de error con un secreto no lo filtra', async () => {
    const { auth } = make({
      apiResponses: [
        {
          status: 500,
          body: { error: { message: `boom con ${CLIENT_SECRET} y ${REFRESH}` } },
        },
      ],
    });
    const err = await auth.api('GET', LIST_URL).catch((e: unknown) => e);
    const message = (err as Error).message;
    expect(message).toContain('HTTP 500');
    expect(message).toContain('***');
    expect(message).not.toContain('SECRETO');
    expect(message).not.toContain(REFRESH);
  });

  it('un error de renovación con un secreto tampoco lo filtra', async () => {
    const { auth } = make({ tokenResponses: [{ status: 503, body: { error: CLIENT_SECRET } }] });
    const err = await auth.accessToken().catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('SECRETO');
    expect((err as Error).message).toContain('***');
  });
});

describe('verifyAccess (M23)', () => {
  it('fuerza la renovación aunque haya un token en caché', async () => {
    const { auth, tokenCalls } = make({
      tokenResponses: [
        { body: { access_token: 'at-1', expires_in: 3600 } },
        { body: { access_token: 'at-2', expires_in: 3600 } },
      ],
    });
    await auth.accessToken();
    expect(tokenCalls()).toHaveLength(1);
    await auth.verifyAccess();
    expect(tokenCalls()).toHaveLength(2);
  });

  it('invalid_grant → auth', async () => {
    const { auth } = make({
      tokenResponses: [{ status: 400, body: { error: 'invalid_grant' } }],
    });
    await expect(auth.verifyAccess()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('sin access_token en la respuesta → auth', async () => {
    const { auth } = make({ tokenResponses: [{ body: {} }] });
    await expect(auth.verifyAccess()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('otro HTTP al renovar no tiene kind', async () => {
    const { auth } = make({ tokenResponses: [{ status: 500, body: { error: 'x' } }] });
    const err = await auth.verifyAccess().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolUserError);
    expect((err as ToolUserError).kind).toBeUndefined();
  });

  function withFetchError(err: Error): GoogleAuth {
    return createGoogleAuth({
      fetch: (async () => {
        throw err;
      }) as typeof fetch,
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH,
    }) as GoogleAuth;
  }

  it('red (no resuelve, no llega, plazo) → unreachable', async () => {
    const dns = new TypeError('fetch failed');
    (dns as { cause?: unknown }).cause = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    const refused = new TypeError('fetch failed');
    (refused as { cause?: unknown }).cause = Object.assign(new Error('x'), {
      code: 'ECONNREFUSED',
    });
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    for (const e of [dns, refused, timeout]) {
      await expect(withFetchError(e).verifyAccess()).rejects.toMatchObject({
        kind: 'unreachable',
      });
    }
  });

  it('una cancelación del llamante no tiene kind', async () => {
    const abort = Object.assign(new Error('a'), { name: 'AbortError' });
    const err = await withFetchError(abort)
      .verifyAccess()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolUserError);
    expect((err as ToolUserError).kind).toBeUndefined();
  });

  it('un 401 o 403 de la API es auth', async () => {
    for (const status of [401, 403]) {
      const { auth } = make({
        tokenResponses: [{ body: { access_token: 'at-1' } }, { body: { access_token: 'at-2' } }],
        apiResponses: [
          { status, body: {} },
          { status, body: {} },
        ],
      });
      await expect(auth.api('GET', LIST_URL)).rejects.toMatchObject({ kind: 'auth' });
    }
  });
});
