import { MarkdownRenderer } from './markdown/MarkdownRenderer';

/** Texto de la respuesta con cursor mientras sigue llegando. */
export function StreamingText({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="streaming-text" data-streaming={streaming}>
      <MarkdownRenderer text={text} streaming={streaming} />
      {streaming && <span className="streaming-text__cursor" aria-hidden="true" />}
    </div>
  );
}
