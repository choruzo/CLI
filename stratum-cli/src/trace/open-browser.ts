import { execa } from 'execa';

/**
 * Abre una URL en el navegador por defecto. Best-effort: devuelve `false` si
 * no se pudo lanzar (sin escritorio, WSL sin integración…) y quien llama
 * muestra la URL para abrirla a mano.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  // Solo URLs http(s): el argumento acaba en un lanzador del sistema.
  if (!/^https?:\/\//.test(url)) return false;
  // Entornos sin escritorio y pruebas automatizadas: solo se imprime la URL.
  if (process.env.STRATUM_NO_BROWSER) return false;
  const [cmd, args] =
    process.platform === 'win32'
      ? // `start` pasa por cmd.exe y su parseo; el manejador de protocolo, no.
        (['rundll32', ['url.dll,FileProtocolHandler', url]] as const)
      : process.platform === 'darwin'
        ? (['open', [url]] as const)
        : (['xdg-open', [url]] as const);
  try {
    const child = execa(cmd, [...args], { stdio: 'ignore', detached: true, reject: false });
    child.unref();
    const result = await Promise.race([
      child,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500).unref()),
    ]);
    // Sigue vivo tras el margen (xdg-open esperando al navegador): se da por lanzado.
    return result === null || (!result.failed && result.exitCode === 0);
  } catch {
    return false;
  }
}
