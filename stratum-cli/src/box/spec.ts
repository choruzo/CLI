/**
 * M13 — la caja: qué contenedor es y con qué se crea (`docs/PRD_STRATUM_DOT.md`
 * §23.3). Sin I/O: nombres, argumentos y lectura del `inspect`.
 *
 * Las órdenes al runtime son **fijas**: salen de aquí y de `manager.ts`, nunca
 * de un comando que componga el agente. Lo que monta la caja es cerrado: su
 * volumen (`/home/stratum`) y la carpeta de intercambio (`/exchange`). Ni el
 * home del usuario, ni `~/.stratum`, ni el socket del runtime, ni `--privileged`.
 */
import { createHash } from 'crypto';
import { z } from 'zod';

/** Versión de la imagen de Stratum. Subirla recrea las cajas en su siguiente `start`. */
export const BOX_IMAGE_VERSION = 1;
export const DEFAULT_BOX_IMAGE = `stratum-box:${BOX_IMAGE_VERSION}`;

export const BOX_USER = 'stratum';
export const BOX_HOME = '/home/stratum';
export const BOX_EXCHANGE = '/exchange';

/** Etiqueta que marca un contenedor como caja de Stratum (su valor es el nombre). */
export const BOX_LABEL = 'io.stratum.box';
/** Huella de los argumentos de creación: si cambia, la caja está desfasada. */
export const BOX_SPEC_LABEL = 'io.stratum.box.spec';

export type RuntimeKind = 'podman' | 'docker';

/** Prefijo fijo: `container:<n>` solo alcanza contenedores que creó Stratum. */
export function boxContainerName(name: string): string {
  return `stratum-box-${name}`;
}

export function boxVolumeName(name: string): string {
  return `stratum-box-${name}-home`;
}

export interface BoxSpec {
  name: string;
  image: string;
  network: boolean;
  /** Carpeta del anfitrión que se monta en `/exchange`. */
  exchangeDir: string;
  runtime: RuntimeKind;
  /** `process.platform` del anfitrión. */
  platform: NodeJS.Platform;
}

/**
 * Argumentos de `<runtime> create` para la caja. Lanza si la carpeta de
 * intercambio no se puede expresar en un `--mount` (una coma la partiría).
 */
export function boxCreateArgs(spec: BoxSpec): string[] {
  const body = createBody(spec);
  return [
    'create',
    '--name',
    boxContainerName(spec.name),
    '--label',
    `${BOX_LABEL}=${spec.name}`,
    '--label',
    `${BOX_SPEC_LABEL}=${boxSpecHash(spec)}`,
    ...body,
  ];
}

/** Lo que define la caja, sin las etiquetas: de aquí sale la huella. */
function createBody(spec: BoxSpec): string[] {
  if (/[,\n\r]/.test(spec.exchangeDir)) {
    throw new Error(
      `The exchange folder "${spec.exchangeDir}" cannot be mounted: its path contains a comma.`,
    );
  }
  const args = [
    '--hostname',
    spec.name,
    // PID 1 que recoge procesos huérfanos: sin él, lo que mata una cancelación
    // queda como zombi.
    '--init',
    '--mount',
    `type=volume,source=${boxVolumeName(spec.name)},target=${BOX_HOME}`,
    '--mount',
    `type=bind,source=${spec.exchangeDir},target=${BOX_EXCHANGE}`,
    // Chromium necesita más que los 64 MB por defecto.
    '--shm-size',
    '1g',
    '--pids-limit',
    '4096',
  ];
  if (!spec.network) args.push('--network', 'none');
  // Podman sin root en Linux: el usuario de la caja es el del anfitrión, para
  // que pueda escribir en la carpeta de intercambio.
  if (spec.runtime === 'podman' && spec.platform === 'linux') {
    args.push('--userns', 'keep-id:uid=1000,gid=1000');
  }
  args.push(spec.image);
  return args;
}

export function boxSpecHash(spec: BoxSpec): string {
  return createHash('sha256')
    .update(JSON.stringify(createBody(spec)))
    .digest('hex')
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// `<runtime> container inspect`
// ---------------------------------------------------------------------------

/** Tolerante: Docker y Podman devuelven mucho más; solo se lee esto. */
const inspectSchema = z
  .array(
    z.object({
      State: z.object({ Running: z.boolean() }).passthrough(),
      Config: z
        .object({ Labels: z.record(z.string()).nullable().optional() })
        .passthrough()
        .optional(),
    }),
  )
  .min(1);

export interface InspectedBox {
  running: boolean;
  /** Etiqueta `io.stratum.box`: debe ser el nombre de la caja. */
  label?: string;
  spec?: string;
}

/** Lee la salida de `container inspect`. Lanza si no tiene la forma esperada. */
export function parseInspect(stdout: string): InspectedBox {
  const parsed = inspectSchema.parse(JSON.parse(stdout));
  const first = parsed[0]!;
  const labels = first.Config?.Labels ?? {};
  return {
    running: first.State.Running,
    ...(labels[BOX_LABEL] !== undefined ? { label: labels[BOX_LABEL] } : {}),
    ...(labels[BOX_SPEC_LABEL] !== undefined ? { spec: labels[BOX_SPEC_LABEL] } : {}),
  };
}

/** El runtime dice que el contenedor o el volumen no existe (Docker y Podman). */
export function isNoSuchObject(stderr: string): boolean {
  return /no such (container|object|volume)|no container with name/i.test(stderr);
}
