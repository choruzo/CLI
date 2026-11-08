import type { Proposal } from './proposals.js';

const day = (iso: string): string => iso.slice(0, 10);

/** Una propuesta para leerla en una terminal: qué cambia, por qué y de dónde sale. */
export function formatProposal(p: Proposal): string {
  const head = `${p.id}  [${p.kind}]  ${day(p.createdAt)} (caduca ${day(p.expiresAt)})`;
  let change: string;
  switch (p.kind) {
    case 'create':
      change = `crear [${p.memory.type}/${p.memory.importance}] «${p.memory.title}»\n    ${p.memory.summary ?? p.memory.content}`;
      break;
    case 'correct':
      change =
        `corregir ${p.targetId}` +
        (p.title ? `\n    título: ${p.title}` : '') +
        (p.content ? `\n    contenido: ${p.content}` : '') +
        (p.summary ? `\n    resumen: ${p.summary}` : '');
      break;
    case 'merge':
      change = `fusionar ${p.targetIds.join(', ')} en ${p.targetIds[0]} → «${p.into.title}»\n    ${p.into.summary ?? p.into.content}`;
      break;
    case 'prune':
      change = `olvidar ${p.targetId}`;
      break;
    case 'reclassify':
      change = `mover ${p.targetId} a ${p.type}`;
      break;
    case 'promote':
      change = `subir ${p.targetId} a importancia alta (encabeza el índice)`;
      break;
  }
  const evidence =
    p.evidence.length > 0
      ? `\n    origen: ${p.evidence.map((e) => `${e.sessionId} ${e.messageId}`).join('; ')}`
      : '';
  return `${head}\n  ${change}\n  porque: ${p.rationale}${evidence}`;
}
