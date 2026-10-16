/**
 * Qué verifica **el sistema operativo** de quien se conecta al daemon (Q2, M9).
 *
 * Es una abstracción a propósito: hoy Node no expone las credenciales del par
 * de un socket (`SO_PEERCRED` en Linux, `GetNamedPipeClientProcessId` en
 * Windows), así que el daemon **no** sabe qué proceso hay al otro lado. Lo que
 * sí sabe es qué barrera puso el sistema antes de que la conexión llegase:
 *
 *  - `socket-permissions` (POSIX): el socket está en `0600` dentro de una
 *    carpeta `0700` (`private-dir.ts`). El núcleo solo deja conectar a quien
 *    puede escribir en él: **este usuario o root**. No dice qué proceso es.
 *  - `none` (Windows): el named pipe tiene la DACL por defecto. La única
 *    barrera es el token de `endpoint.json`, que está en el perfil del usuario.
 *
 * Lo que **ninguna** de las dos da: distinguir entre procesos del mismo
 * usuario. `client.kind` es lo que el cliente **declaró**; no es identidad y
 * no da ni quita capacidades (`authorize.ts`). Si un día se puede leer el pid o
 * el uid del par, entra aquí como otra variante, sin tocar la autorización.
 */
export type PeerVerification =
  | { check: 'socket-permissions'; boundary: 'same-user-or-root' }
  | { check: 'none'; boundary: 'token-only' };

export function peerVerification(platform: NodeJS.Platform = process.platform): PeerVerification {
  return platform === 'win32'
    ? { check: 'none', boundary: 'token-only' }
    : { check: 'socket-permissions', boundary: 'same-user-or-root' };
}
