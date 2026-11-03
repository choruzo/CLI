import { useEffect, useState } from 'react';
import {
  errorMessage,
  listWorkspaceFiles,
  openOutput,
  previewOutput,
  saveOutput,
  type ListedFile,
} from '../../../ipc/files';

const IMAGE_FILE = /^outputs\/[\w.-]+\.(png|jpe?g|webp|gif)$/i;

/**
 * Rutas que `generate_image` dejó en `outputs/`: la salida de la tool empieza
 * por ellas, una por línea (`stratum-cli/src/tools/images/generate.ts`). Solo
 * se aceptan nombres simples bajo `outputs/` con extensión de imagen; la ruta
 * la confina además Rust (`file_path`) al leerla.
 */
export function generatedImagePaths(output: string | undefined): string[] {
  if (!output) return [];
  const paths: string[] = [];
  for (const line of output.split('\n')) {
    const path = line.trim();
    if (!IMAGE_FILE.test(path)) break;
    paths.push(path);
  }
  return paths;
}

/**
 * Marca de una llamada en el nombre de sus imágenes. Misma regla que
 * `callImageTag` de `stratum-cli/src/tools/images/generate.ts`.
 */
export function callImageTag(callId: string): string {
  return callId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10);
}

/**
 * Imágenes de `outputs/` de una llamada, por su marca (`<slug>-<marca>.ext`,
 * `-<n>` con varias, `-v<n>` si el nombre ya existía): para los turnos
 * antiguos, cuya conversación no lleva la salida de la tool.
 */
export function imagesOfCall(files: readonly ListedFile[], callId: string): string[] {
  const tag = callImageTag(callId);
  if (!tag) return [];
  const re = new RegExp(`-${tag}(-\\d+)?(-v\\d+)?\\.(png|jpe?g|webp|gif)$`, 'i');
  return files
    .filter((f) => f.area === 'outputs' && IMAGE_FILE.test(f.path) && re.test(f.name))
    .map((f) => f.path)
    .sort();
}

function GeneratedImage({ cwd, path }: { cwd: string; path: string }) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const [src, setSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<{ tone: 'error' | 'muted'; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    previewOutput(cwd, path)
      .then((preview) => {
        if (!live) return;
        if (preview.kind === 'image') setSrc(preview.dataUrl);
        else setStatus({ tone: 'error', text: preview.kind === 'unsupported' ? preview.reason : 'Sin vista previa.' });
      })
      .catch((err) => live && setStatus({ tone: 'error', text: errorMessage(err) }));
    return () => {
      live = false;
    };
  }, [cwd, path]);

  const run = (action: () => Promise<unknown>, done?: string) => {
    setStatus(null);
    action()
      .then((result) => {
        if (done && result !== false) setStatus({ tone: 'muted', text: done });
      })
      .catch((err) => setStatus({ tone: 'error', text: errorMessage(err) }));
  };

  return (
    <figure className="generated-image">
      {src ? (
        <img className="generated-image__img" src={src} alt={`Imagen generada: ${name}`} />
      ) : (
        !status && <div className="generated-image__placeholder">Cargando imagen…</div>
      )}
      <figcaption className="generated-image__bar">
        <span className="generated-image__name">{name}</span>
        <span className="file-card__actions">
          <button type="button" className="button" onClick={() => run(() => openOutput(cwd, path))}>
            Abrir
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => run(() => saveOutput(cwd, path), 'Guardado.')}
          >
            Guardar como…
          </button>
        </span>
      </figcaption>
      {status && (
        <p className="notice" data-tone={status.tone} role={status.tone === 'error' ? 'alert' : undefined}>
          {status.text}
        </p>
      )}
    </figure>
  );
}

/**
 * Las imágenes de una llamada a `generate_image`, en el sitio de la respuesta
 * donde se hizo: las rutas de su salida o, sin ella, las de `outputs/` con su
 * marca.
 */
export function GeneratedImages({ cwd, callId, output }: { cwd: string; callId: string; output?: string }) {
  const fromOutput = generatedImagePaths(output);
  const [listed, setListed] = useState<string[] | null>(null);
  const needList = fromOutput.length === 0;
  useEffect(() => {
    if (!needList) return;
    let live = true;
    listWorkspaceFiles(cwd)
      .then((files) => live && setListed(imagesOfCall(files, callId)))
      .catch(() => live && setListed([]));
    return () => {
      live = false;
    };
  }, [cwd, callId, needList]);
  const paths = needList ? (listed ?? []) : fromOutput;
  if (paths.length === 0) return null;
  return (
    <div className="generated-images" aria-label="Imágenes generadas">
      {paths.map((p) => (
        <GeneratedImage key={p} cwd={cwd} path={p} />
      ))}
    </div>
  );
}
