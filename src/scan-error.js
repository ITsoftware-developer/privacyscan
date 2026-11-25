// Een fout bij het zoeken waar de bezoeker een nette melding over krijgt, zoals
// "Have I Been Pwned is nu niet bereikbaar". De code zegt wat er mis ging; de tekst
// voor de bezoeker staat in routes-scan.js.
export class ScanError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ScanError';
    this.code = code;
  }
}
