/**
 * M23 — la «comprobación de acceso» de un conector con cuenta: una tool sin
 * argumentos que dice si la credencial sigue valiendo. La llama el daemon (la
 * sonda de vigilantes, como cualquier `check`) para el diagnóstico.
 *
 * Nada se infiere del texto del error: el cliente del conector clasifica sus
 * fallos con `ToolUserError.kind` y aquí solo se traslada ese `kind` al estado.
 */
import { ToolUserError, type ConnectorTool, type ToolOutput } from './mcp-stdio.js';

/**
 * `verify` hace la llamada más barata que prueba la credencial y lanza si no
 * vale. Un `ToolUserError` no es un fallo de la tool: es el resultado (`estado`
 * = su `kind`, o `error` si no lo trae). Cualquier otro error se relanza y el
 * server lo convierte en `isError` (la sonda lo cuenta como fallo de lectura).
 */
export function accessCheckTool(
  name: string,
  description: string,
  verify: (signal?: AbortSignal) => Promise<void>,
): ConnectorTool<ToolOutput> {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        estado: { type: 'string' },
        valor: { type: ['number', 'null'] },
        detalle: { type: 'string' },
      },
      required: ['estado', 'valor', 'detalle'],
      additionalProperties: false,
    },
    // No lee argumentos: si llegan, se ignoran.
    async handler(_args, signal) {
      let estado: string;
      let detalle: string;
      try {
        await verify(signal);
        estado = 'ok';
        detalle = 'La credencial es válida y el servicio responde.';
      } catch (err) {
        if (!(err instanceof ToolUserError)) throw err;
        estado = err.kind ?? 'error';
        detalle = err.message;
      }
      return {
        text: [detalle, `Para vigilantes: estado «${estado}»`].join('\n'),
        structured: { estado, valor: null, detalle },
      };
    },
  };
}
