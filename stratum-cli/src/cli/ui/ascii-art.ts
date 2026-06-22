export const ASCII_ART_FULL = `   ███████╗████████╗██████╗  █████╗ ████████╗██╗   ██╗███╗   ███╗
   ██╔════╝╚══██╔══╝██╔══██╗██╔══██╗╚══██╔══╝██║   ██║████╗ ████║
   ╚█████╗    ██║   ██████╔╝███████║   ██║   ██║   ██║██╔████╔██║
    ╚═══██╗   ██║   ██╔══██╗██╔══██║   ██║   ██║   ██║██║╚██╔╝██║
   ██████╔╝   ██║   ██║  ██║██║  ██║   ██║   ╚██████╔╝██║ ╚═╝ ██║
   ╚═════╝    ╚═╝   ╚═╝  ╚═╝╚═╝  ╚═╝  ╚═╝    ╚═════╝ ╚═╝     ╚═╝`;

export const ASCII_ART_SMALL = `  ╔═╗╔╦╗╦═╗╔═╗╔╦╗╦ ╦╔╦╗
  ╚═╗ ║ ╠╦╝╠═╣ ║ ║ ║║║║
  ╚═╝ ╩ ╩╚═╩ ╩ ╩ ╚═╝╩ ╩`;

export const ASCII_TEXT_ONLY = 'Stratum CLI';

export function getAsciiArtWidth(art: string): number {
  return Math.max(0, ...art.split('\n').map((row) => row.length));
}

export function getAsciiArt(columns: number): string {
  if (columns < 60) return ASCII_TEXT_ONLY;
  if (columns < 72) return ASCII_ART_SMALL;
  return ASCII_ART_FULL;
}
