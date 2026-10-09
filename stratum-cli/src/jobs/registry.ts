/**
 * Los `JobManager` vivos del proceso. Existe para que el cierre no dependa de
 * que cada ruta de salida se acuerde de los jobs: `closeExecRuntime()` — que
 * ya llaman todos los teardown de `chat`, `run` e `init` — los apaga aquí, y un
 * gancho en el `exit` del proceso mata de forma síncrona lo que aún quede (un
 * `process.exit` directo, una excepción sin capturar).
 *
 * Sin imports de `tools/exec/runtime.ts`: ese módulo importa este.
 */

export interface ManagedJobs {
  shutdown(): Promise<void>;
  killAllSync(): void;
}

const managers = new Set<ManagedJobs>();
let exitHookInstalled = false;

function onProcessExit(): void {
  for (const manager of managers) {
    try {
      manager.killAllSync();
    } catch {
      /* en el `exit` no hay a quién contárselo */
    }
  }
}

export function registerJobManager(manager: ManagedJobs): void {
  managers.add(manager);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', onProcessExit);
  }
}

export function unregisterJobManager(manager: ManagedJobs): void {
  managers.delete(manager);
}

/**
 * Cancela y espera todos los jobs vivos del proceso. Nunca lanza. El cierre de
 * cada manager es terminal: no vuelve a lanzar jobs ni a registrarse aquí.
 */
export async function shutdownAllJobs(): Promise<void> {
  await Promise.allSettled([...managers].map((m) => m.shutdown()));
}

/** Solo para tests. */
export function liveJobManagers(): number {
  return managers.size;
}
