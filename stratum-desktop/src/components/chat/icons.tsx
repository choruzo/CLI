/**
 * Iconos de trazo del chat, en la misma rejilla 24×24 y con los mismos trazos
 * redondeados que los del sidebar. SVG en línea: sin fuentes de iconos.
 */
export function StrokeIcon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export const ICON = {
  copy: 'M9 9h10v10H9zM5 15V5h10',
  check: 'M5 12l5 5 9-10',
  retry: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4',
  markdown: 'M3 6h18v12H3zM6 15V9l3 3 3-3v6M16 9v6M14 13l2 2 2-2',
  arrowDown: 'M12 5v14M6 13l6 6 6-6',
  // Tipos de tool.
  file: 'M6 3h8l4 4v14H6zM14 3v4h4',
  filePen: 'M6 21V3h8l4 4v5M14 3v4h4M13 21l1-3 5-5 2 2-5 5z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l4 4',
  folder: 'M3 6h6l2 2h10v11H3z',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  brain: 'M12 4a4 4 0 0 0-4 4v1a3 3 0 0 0-2 5 3 3 0 0 0 3 4h6a3 3 0 0 0 3-4 3 3 0 0 0-2-5V8a4 4 0 0 0-4-4zM12 4v14',
  list: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  question: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  terminal: 'M4 5h16v14H4zM7 9l3 3-3 3M12 15h5',
  plug: 'M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4',
  tool: 'M14 6a4 4 0 0 0 5 5l-8 8a2 2 0 0 1-3-3l8-8a4 4 0 0 1-2-2z',
} as const;
