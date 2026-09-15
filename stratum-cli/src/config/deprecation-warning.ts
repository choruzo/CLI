import { getLogger } from '../logging/index.js';
import { takeConfigDeprecations } from './loader.js';

/**
 * Emite una vez los avisos de claves obsoletas que el loader detectó al cargar.
 * Se llama tras `configureLogging`: al cargar la config el logger aún no existe.
 */
export function warnConfigDeprecations(): void {
  const log = getLogger('config');
  for (const message of takeConfigDeprecations()) log.warn(message);
}
