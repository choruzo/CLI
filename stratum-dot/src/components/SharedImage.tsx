import { useEffect, useState } from 'react';
import { loadSharedImage } from '../app/sharedImages';
import { useNative } from '../bridge/context';
import { toCommandError } from '../bridge/native';
import type { ProtocolSharedImage } from '../protocol';

type Loaded = { state: 'loading' } | { state: 'ready'; url: string } | { state: 'failed'; text: string };

/** Qué decir cuando no se pudo traer: `NOT_FOUND` es que ya caducó; lo demás, algo corto. */
function failureText(err: unknown): string {
  return toCommandError(err).code === 'NOT_FOUND' ? 'This image has expired.' : 'This image could not be loaded.';
}

/**
 * Una imagen que envió el asistente. Se pide al montar (por trozos, cacheada
 * por id) y su URL se libera al desmontar. Si falla, lo dice: no inventa una
 * imagen. El pie es texto, nunca HTML.
 */
export function SharedImage({ image }: { image: ProtocolSharedImage }) {
  const native = useNative();
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });

  useEffect(() => {
    let url: string | null = null;
    let stopped = false;
    setLoaded({ state: 'loading' });
    loadSharedImage(native, image).then(
      (blob) => {
        if (stopped) return;
        url = URL.createObjectURL(blob);
        setLoaded({ state: 'ready', url });
      },
      (err) => {
        if (!stopped) setLoaded({ state: 'failed', text: failureText(err) });
      },
    );
    return () => {
      stopped = true;
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [native, image.id, image.mime, image.bytes]);

  return (
    <figure className="shared-image" data-state={loaded.state}>
      {loaded.state === 'ready' ? (
        <img src={loaded.url} alt={image.caption || 'Image from the assistant'} />
      ) : loaded.state === 'loading' ? (
        <p className="muted small" role="status">
          Loading the image…
        </p>
      ) : (
        <p className="note small" role="alert">
          {loaded.text}
        </p>
      )}
      {image.caption ? <figcaption className="small">{image.caption}</figcaption> : null}
    </figure>
  );
}
