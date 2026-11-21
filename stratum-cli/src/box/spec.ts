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
import { CONNECTOR_ID_RE } from '../connectors/manifest.js';

/**
 * Versión de la imagen de Stratum. Subirla recrea las cajas en su siguiente
 * `start`. La 2 (M20) añade Node y los conectores (`/opt/stratum/connectors`):
 * cambiar el código de un conector también exige subirla (lo fija
 * `box-image.version.test.ts`).
 */
export const BOX_IMAGE_VERSION = 13;
export const DEFAULT_BOX_IMAGE = `stratum-box:${BOX_IMAGE_VERSION}`;

export const BOX_USER = 'stratum';
export const BOX_HOME = '/home/stratum';
export const BOX_EXCHANGE = '/exchange';

/** Etiqueta que marca un contenedor como caja de Stratum (su valor es el nombre). */
export const BOX_LABEL = 'io.stratum.box';
/** Huella de los argumentos de creación: si cambia, la caja está desfasada. */
export const BOX_SPEC_LABEL = 'io.stratum.box.spec';
/**
 * M20 — papel del contenedor: solo lo lleva la caja de conectores
 * (`connectors`). Esa caja **no** lleva `io.stratum.box`, así que `exec`
 * (`container:<n>`) nunca la alcanza.
 */
export const BOX_ROLE_LABEL = 'io.stratum.box.role';
/** M20 — en la caja de conectores, el nombre de la caja a la que acompaña. */
export const BOX_CONNECTORS_LABEL = 'io.stratum.box.connectors';
/** M20 — dónde está el código de los conectores dentro de la imagen (de `root`). */
export const CONNECTORS_IMAGE_DIR = '/opt/stratum/connectors';

export type RuntimeKind = 'podman' | 'docker';

/** Prefijo fijo: `container:<n>` solo alcanza contenedores que creó Stratum. */
export function boxContainerName(name: string): string {
  return `stratum-box-${name}`;
}

export function boxVolumeName(name: string): string {
  return `stratum-box-${name}-home`;
}

/** M20 — la caja de conectores de la caja `<n>`: `stratum-box-<n>-connectors`. */
export function connectorsContainerName(name: string): string {
  return `${boxContainerName(name)}-connectors`;
}

export function connectorsVolumeName(name: string): string {
  return `${boxContainerName(name)}-connectors-data`;
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
// M20 — la caja de conectores
// ---------------------------------------------------------------------------

/**
 * Lo que define la caja de conectores. Siempre la imagen de Stratum (el
 * código de los conectores va dentro), aunque la caja del agente use otra.
 */
export interface ConnectorsBoxSpec {
  name: string;
  image: string;
  network: boolean;
  runtime: RuntimeKind;
  platform: NodeJS.Platform;
}

/**
 * Argumentos de `<runtime> create` para la caja de conectores. Monta **solo**
 * su volumen (cachés de los conectores): ni `/exchange`, ni nada del
 * anfitrión. Sin escritorio (`STRATUM_BOX_ROLE=connectors`).
 */
export function connectorsCreateArgs(spec: ConnectorsBoxSpec): string[] {
  return [
    'create',
    '--name',
    connectorsContainerName(spec.name),
    '--label',
    `${BOX_ROLE_LABEL}=connectors`,
    '--label',
    `${BOX_CONNECTORS_LABEL}=${spec.name}`,
    '--label',
    `${BOX_SPEC_LABEL}=${connectorsSpecHash(spec)}`,
    ...connectorsBody(spec),
  ];
}

function connectorsBody(spec: ConnectorsBoxSpec): string[] {
  const args = [
    '--hostname',
    `${spec.name}-connectors`,
    '--init',
    '--mount',
    `type=volume,source=${connectorsVolumeName(spec.name)},target=${BOX_HOME}`,
    '--env',
    'STRATUM_BOX_ROLE=connectors',
    '--pids-limit',
    '1024',
  ];
  if (!spec.network) args.push('--network', 'none');
  if (spec.runtime === 'podman' && spec.platform === 'linux') {
    args.push('--userns', 'keep-id:uid=1000,gid=1000');
  }
  args.push(spec.image);
  return args;
}

export function connectorsSpecHash(spec: ConnectorsBoxSpec): string {
  return createHash('sha256')
    .update(JSON.stringify(['connectors', ...connectorsBody(spec)]))
    .digest('hex')
    .slice(0, 16);
}

/** Nombre de una variable de entorno que lleva un secreto (fase 4). */
const SECRET_ENV_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * La orden que lanza el server de un conector: `<runtime> exec -i [-e NOMBRE…]
 * stratum-box-<n>-connectors node /opt/stratum/connectors/<id>/server.mjs`.
 * Argumentos fijos; el `id` y los nombres de secreto se validan aquí aunque ya
 * vengan del catálogo. `-e NOMBRE` va **sin valor**: el runtime lo toma del
 * entorno del cliente, y el secreto nunca aparece en la línea de órdenes.
 */
export function connectorExecArgs(
  boxName: string,
  id: string,
  secretNames: readonly string[] = [],
): string[] {
  if (!CONNECTOR_ID_RE.test(id)) throw new Error(`Invalid connector id "${id}".`);
  const env: string[] = [];
  for (const name of secretNames) {
    if (!SECRET_ENV_RE.test(name)) throw new Error(`Invalid secret name "${name}".`);
    env.push('-e', name);
  }
  return [
    'exec',
    '-i',
    ...env,
    connectorsContainerName(boxName),
    'node',
    `${CONNECTORS_IMAGE_DIR}/${id}/server.mjs`,
  ];
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
  /** M20 — `io.stratum.box.role` (`connectors` en la caja de conectores). */
  role?: string;
  /** M20 — `io.stratum.box.connectors`: la caja a la que acompaña. */
  connectorsOf?: string;
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
    ...(labels[BOX_ROLE_LABEL] !== undefined ? { role: labels[BOX_ROLE_LABEL] } : {}),
    ...(labels[BOX_CONNECTORS_LABEL] !== undefined
      ? { connectorsOf: labels[BOX_CONNECTORS_LABEL] }
      : {}),
  };
}

/** El runtime dice que el contenedor o el volumen no existe (Docker y Podman). */
export function isNoSuchObject(stderr: string): boolean {
  return /no such (container|object|volume)|no container with name/i.test(stderr);
}
