---
name: new-tool
description: Scaffold de una nueva Stratum Tool (ToolDefinition + Zod schema + test Vitest) siguiendo las convenciones del proyecto.
disable-model-invocation: true
---

Genera el scaffold completo de una nueva tool para Stratum CLI. Antes de crear archivos, pregunta al usuario:

1. **Nombre** de la tool (snake_case, ej: `read_file`)
2. **Descripción** breve para el LLM
3. **¿Es destructiva?** (pide confirmación al usuario antes de ejecutar)
4. **¿Es serializada?** (no se ejecuta en paralelo con otras tools)
5. **Parámetros**: nombre, tipo Zod, descripción y si son requeridos

Con esa información, crea:

**`stratum-cli/src/tools/<nombre>.ts`**
```typescript
import { z } from 'zod';
import type { ToolDefinition } from '../types.js';

const schema = z.object({
  // parámetros del usuario
});

export const <nombre>Tool: ToolDefinition<typeof schema> = {
  name: '<nombre>',
  description: '<descripción>',
  schema,
  destructive: <true|false>,
  serialized: <true|false>,
  async execute(params) {
    // TODO: implementar
    throw new Error('Not implemented');
  },
};
```

**`stratum-cli/src/tools/<nombre>.test.ts`**
```typescript
import { describe, it, expect } from 'vitest';
import { <nombre>Tool } from './<nombre>.js';

describe('<nombre>Tool', () => {
  it('valida el schema con parámetros correctos', () => {
    const result = <nombre>Tool.schema.safeParse({ /* parámetros válidos */ });
    expect(result.success).toBe(true);
  });

  it('rechaza parámetros inválidos', () => {
    const result = <nombre>Tool.schema.safeParse({});
    expect(result.success).toBe(false);
  });
});
```

Finalmente, indica al usuario que registre la tool en `ToolRegistry` cuando esté lista.
