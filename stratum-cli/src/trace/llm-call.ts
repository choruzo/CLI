import type { CompletionRequest, IProvider, OpenAIStreamChunk } from '../providers/base.js';
import type { TraceScope } from './recorder.js';
import type { AuxiliaryLlmOrigin } from './records.js';

/**
 * Una llamada al LLM que no hace el loop del agente: extracción de memoria,
 * compresión de contexto, resumen de la sesión.
 */
export interface AuxiliaryCall {
  origin: AuxiliaryLlmOrigin;
  provider: IProvider;
  /** Nombre del provider en la config, si quien llama lo conoce. */
  providerName?: string;
  request: CompletionRequest;
  /** Sin scope la llamada se hace igual, solo que no deja rastro. */
  trace?: TraceScope;
  /**
   * Cancelación de quien pidió el trabajo. `request.signal` suele llevar además
   * un timeout: sin esta señal no se podría distinguir «cancelada» (el usuario,
   * el cierre de la sesión) de «falló por timeout», que es un error.
   */
  cancelSignal?: AbortSignal;
}

/**
 * Punto único por el que pasan las llamadas auxiliares al LLM: hace la petición
 * tal cual —el mismo `provider.complete(request)` que hacía cada una por su
 * cuenta— y la anota en la traza con el `ModelSpan` del loop (inicio, primer
 * token, `usage`, fin y estado), con su origen.
 *
 * El paso se cierra siempre: si el stream falla (el error se relanza), si se
 * cancela, si no produce texto, si no trae `usage` y si quien lo consume lo
 * abandona a medias.
 */
export async function* tracedCompletion(call: AuxiliaryCall): AsyncGenerator<OpenAIStreamChunk> {
  const { request } = call;
  const span = call.trace?.modelStart({
    origin: call.origin,
    provider: call.providerName,
    model: request.model,
    messages: request.messages,
    tools: request.tools?.length ?? 0,
    toolSchemas: request.tools,
  });
  let text = '';
  let reasoning = '';
  let error: string | undefined;
  try {
    for await (const chunk of call.provider.complete(request)) {
      span?.firstChunk();
      if (chunk.usage || chunk.timings) span?.usage(chunk.usage, chunk.timings);
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) text += delta.content;
      const thought = delta?.reasoning_content ?? delta?.reasoning;
      if (thought) reasoning += thought;
      yield chunk;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    const cancelled = call.cancelSignal?.aborted === true;
    span?.end({
      text,
      reasoning,
      toolCalls: [],
      cancelled,
      error: cancelled ? undefined : error,
    });
  }
}
