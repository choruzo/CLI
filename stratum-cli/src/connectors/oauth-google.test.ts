import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_AUTH_URL,
  GOOGLE_TOKEN_URL,
  OAuthError,
  authorizeGoogle,
  parseGoogleClientJson,
  pkcePair,
} from './oauth-google.js';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/tasks',
];
const CLIENT = {
  clientId: '123-abc.apps.googleusercontent.com',
  clientSecret: 'GOCSPX-super-secreto',
};

/** El «navegador»: abre la URL de Google y vuelve al loopback como lo haría Google. */
function browser(
  reply: (auth: URL) => Record<string, string> | null,
  before?: (auth: URL) => Promise<void>,
) {
  const seen: URL[] = [];
  const open = vi.fn(async (url: string) => {
    const auth = new URL(url);
    seen.push(auth);
    // Google responde después de que la persona autorice: fuera de esta llamada.
    setTimeout(() => {
      void (async () => {
        if (before) await before(auth);
        const q = reply(auth);
        if (!q) return;
        const back = new URL(auth.searchParams.get('redirect_uri')!);
        for (const [k, v] of Object.entries(q)) back.searchParams.set(k, v);
        await fetch(back);
      })();
    }, 5);
    return true;
  });
  return { open, seen };
}

function tokenFetch(body: Record<string, unknown>, status = 200) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

describe('parseGoogleClientJson (M21)', () => {
  it('lee el cliente de escritorio del JSON de Google Cloud', () => {
    const text = JSON.stringify({
      installed: {
        client_id: CLIENT.clientId,
        client_secret: CLIENT.clientSecret,
        redirect_uris: ['http://localhost'],
      },
    });
    expect(parseGoogleClientJson(text)).toEqual(CLIENT);
  });

  it('rechaza un cliente web, un JSON roto y uno sin secreto, sin repetir el contenido', () => {
    expect(() => parseGoogleClientJson(JSON.stringify({ web: { client_id: 'x' } }))).toThrow(
      /App de escritorio/,
    );
    expect(() => parseGoogleClientJson('{ no es json')).toThrow(OAuthError);
    try {
      parseGoogleClientJson(
        JSON.stringify({ installed: { client_id: 'raro', client_secret: 'SECRETO-X' } }),
      );
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('SECRETO-X');
    }
  });
});

describe('pkcePair', () => {
  it('el challenge es el SHA-256 en base64url del verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });
});

describe('authorizeGoogle (M21)', () => {
  it('pide offline + consent + PKCE, recoge el código con su state y canjea', async () => {
    const b = browser((auth) => ({ code: 'CODIGO-1', state: auth.searchParams.get('state')! }));
    const f = tokenFetch({ refresh_token: 'RT-1', access_token: 'AT', scope: SCOPES.join(' ') });
    const out: string[] = [];
    const r = await authorizeGoogle({
      ...CLIENT,
      scopes: SCOPES,
      openBrowser: b.open,
      out: (t) => out.push(t),
      fetch: f,
    });
    expect(r.refreshToken).toBe('RT-1');

    const auth = b.seen[0]!;
    expect(`${auth.origin}${auth.pathname}`).toBe(GOOGLE_AUTH_URL);
    const p = auth.searchParams;
    expect(p.get('client_id')).toBe(CLIENT.clientId);
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('scope')).toBe(SCOPES.join(' '));
    expect(p.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    // El secreto nunca va en la URL que se abre ni en lo que se enseña.
    expect(auth.toString()).not.toContain(CLIENT.clientSecret);
    expect(out.join('')).not.toContain(CLIENT.clientSecret);

    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(GOOGLE_TOKEN_URL);
    const form = new URLSearchParams(String(init!.body));
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('CODIGO-1');
    expect(form.get('redirect_uri')).toBe(p.get('redirect_uri'));
    const verifier = form.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(p.get('code_challenge'));
  });

  it('una vuelta con otro state no cuenta: sigue esperando la buena', async () => {
    const b = browser(
      (auth) => ({ code: 'BUENO', state: auth.searchParams.get('state')! }),
      async (auth) => {
        const back = new URL(auth.searchParams.get('redirect_uri')!);
        back.searchParams.set('code', 'AJENO');
        back.searchParams.set('state', 'otro');
        const res = await fetch(back);
        expect(res.status).toBe(404);
        // Ni otra ruta.
        expect((await fetch(new URL('/favicon.ico', back))).status).toBe(404);
      },
    );
    const f = tokenFetch({ refresh_token: 'RT', scope: SCOPES.join(' ') });
    await authorizeGoogle({
      ...CLIENT,
      scopes: SCOPES,
      openBrowser: b.open,
      out: () => {},
      fetch: f,
    });
    expect(new URLSearchParams(String(f.mock.calls[0]![1]!.body)).get('code')).toBe('BUENO');
  });

  it('denegado en el navegador: error y sin canje', async () => {
    const b = browser((auth) => ({
      error: 'access_denied',
      state: auth.searchParams.get('state')!,
    }));
    const f = tokenFetch({});
    await expect(
      authorizeGoogle({ ...CLIENT, scopes: SCOPES, openBrowser: b.open, out: () => {}, fetch: f }),
    ).rejects.toThrow(/No se concedió/);
    expect(f).not.toHaveBeenCalled();
  });

  it('si falta un ámbito concedido, falla y lo nombra', async () => {
    const b = browser((auth) => ({ code: 'C', state: auth.searchParams.get('state')! }));
    const f = tokenFetch({ refresh_token: 'RT', scope: SCOPES[0] });
    await expect(
      authorizeGoogle({ ...CLIENT, scopes: SCOPES, openBrowser: b.open, out: () => {}, fetch: f }),
    ).rejects.toThrow(/Faltan permisos \(tasks\)/);
  });

  it('un canje rechazado no enseña el secreto ni el código', async () => {
    const b = browser((auth) => ({
      code: 'CODIGO-SECRETO',
      state: auth.searchParams.get('state')!,
    }));
    const f = tokenFetch({ error: `invalid_client ${CLIENT.clientSecret} CODIGO-SECRETO` }, 401);
    try {
      await authorizeGoogle({
        ...CLIENT,
        scopes: SCOPES,
        openBrowser: b.open,
        out: () => {},
        fetch: f,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      const msg = (err as Error).message;
      expect(msg).toContain('HTTP 401');
      expect(msg).not.toContain(CLIENT.clientSecret);
      expect(msg).not.toContain('CODIGO-SECRETO');
    }
  });

  it('sin refresh token, error', async () => {
    const b = browser((auth) => ({ code: 'C', state: auth.searchParams.get('state')! }));
    const f = tokenFetch({ access_token: 'AT', scope: SCOPES.join(' ') });
    await expect(
      authorizeGoogle({ ...CLIENT, scopes: SCOPES, openBrowser: b.open, out: () => {}, fetch: f }),
    ).rejects.toThrow(/refresh token/);
  });

  it('si no llega nada, caduca', async () => {
    const b = browser(() => null);
    await expect(
      authorizeGoogle({
        ...CLIENT,
        scopes: SCOPES,
        openBrowser: b.open,
        out: () => {},
        fetch: tokenFetch({}),
        waitMs: 50,
      }),
    ).rejects.toThrow(OAuthError);
  });

  it('sin navegador, enseña la URL para abrirla a mano', async () => {
    const out: string[] = [];
    await expect(
      authorizeGoogle({
        ...CLIENT,
        scopes: SCOPES,
        openBrowser: async () => false,
        out: (t) => out.push(t),
        fetch: tokenFetch({}),
        waitMs: 30,
      }),
    ).rejects.toThrow(OAuthError);
    expect(out.join('')).toContain(GOOGLE_AUTH_URL);
  });
});
