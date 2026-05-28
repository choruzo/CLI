---
name: spec-read
description: Lee la sección 12 de STRATUM_PROJECT_DEFINITION.md relevante al módulo que se va a implementar y carga las invariantes vinculantes en contexto antes de escribir código.
user-invocable: false
---

Lee `STRATUM_PROJECT_DEFINITION.md` completo y extrae las subsecciones de la sección 12 relevantes al módulo que se solicita implementar.

Mapeo de módulos a subsecciones:
- `types.ts` / `AgentEvent` → 12.1
- `StreamBuffer` / parsing SSE → 12.2
- manejo de errores en el loop / formato XML → 12.3
- `ContextManager` / compresión de contexto → 12.4
- MCP bridge / lifecycle de servers → 12.8
- ONNX / embeddings lazy load → 12.10
- señales del proceso / cleanup → 12.12

Para cada subsección relevante, resume en bullets concisos:
1. Las invariantes que el código DEBE cumplir
2. Los algoritmos o secuencias de pasos exactos descritos
3. Los casos de error y cómo deben manejarse

Termina con: "Spec cargada. Puedes proceder con la implementación de [módulo]."
