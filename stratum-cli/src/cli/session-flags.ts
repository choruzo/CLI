/**
 * Hito 17 — flags de perfil de sesión compartidos por `chat` y `run`:
 * `--profile <nombre>` y sus atajos `--infra` / `--code`.
 */
export function sessionProfileFlag(opts: {
  profile?: string;
  infra?: boolean;
  code?: boolean;
}): { ok: true; profile: string | undefined } | { ok: false; error: string } {
  const picked = [
    opts.profile !== undefined ? `--profile ${opts.profile}` : null,
    opts.infra ? '--infra' : null,
    opts.code ? '--code' : null,
  ].filter((f): f is string => f !== null);
  if (picked.length > 1) {
    return { ok: false, error: `Elige un solo perfil de sesión: ${picked.join(', ')}.` };
  }
  if (opts.infra) return { ok: true, profile: 'infra' };
  if (opts.code) return { ok: true, profile: 'code' };
  return { ok: true, profile: opts.profile?.trim() || undefined };
}
