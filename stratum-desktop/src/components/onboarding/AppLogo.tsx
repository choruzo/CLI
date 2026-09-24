/** Logo de la app (el mismo dibujo que `assets/icon.svg`), en línea y sin fondo. */
export function AppLogo({ className }: { className?: string }) {
  const layer = 'M512 648 L808 520 L512 392 L216 520 Z';
  return (
    <svg className={className} viewBox="200 220 624 600" aria-hidden="true" focusable="false">
      <g strokeLinejoin="round" strokeWidth={36}>
        <path d={layer} fill="#92400E" stroke="#92400E" transform="translate(0 150)" />
        <path d={layer} fill="#F59E0B" stroke="#F59E0B" />
        <path d={layer} fill="#FBBF24" stroke="#FBBF24" transform="translate(0 -150)" />
      </g>
    </svg>
  );
}
