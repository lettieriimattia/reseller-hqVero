// Verifica se il file di un'immagine di catalogo è coerente col titolo/nome del prodotto.
// Il nome file di solito rispecchia il titolo (es. "...Velvet-Brown-Product.jpg" per il
// titolo "...Velvet Brown"): se la parola più specifica del titolo (l'ultima, di solito la
// colorway) non compare nel nome file, l'immagine appartiene quasi certamente a un'ALTRA
// colorway (fonte inconsistente, es. StockX che a volte ritorna title e media di prodotti
// diversi) → meglio nessuna foto che una foto sbagliata.
export function imageMatchesTitle(image: string | null | undefined, title: string): boolean {
  if (!image) return false;
  const toks = (title || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
  const lastTok = toks[toks.length - 1];
  if (!lastTok) return true;
  const filePart = (image.split('/').pop() || '').split('?')[0].replace(/\.(jpe?g|png|webp)$/i, '').toLowerCase();
  return filePart.includes(lastTok);
}
