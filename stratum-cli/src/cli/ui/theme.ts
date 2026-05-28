export const theme = {
  accent:       '#F59E0B',
  accentBright:  '#FBBF24',
  success:      '#22C55E',
  error:        '#EF4444',
  errorMuted:   '#FCA5A5',
  warning:      '#F97316',
  code:         '#6EE7B7',

  textPrimary:  '#F3F4F6',
  textResponse: '#D1D5DB',
  textMuted:    '#9CA3AF',
  textFaint:    '#6B7280',
  textDisabled: '#4B5563',
  textInvisible:'#374151',

  bgStatusbar:  '#1A1A1A',
  bgDropdown:   '#1C1C1C',

  borderSubtle: '#2A2A2A',
  borderMedium: '#374151',
  borderAccent: '#92400E',
} as const;

export type Theme = typeof theme;
