// Tekst van buiten, zoals van Have I Been Pwned of een zoekdienst, maken we
// schoon voordat we hem opslaan of tonen. We tonen hem altijd als gewone tekst
// (EJS maakt er veilige HTML van), maar HTML-tags horen er niet in thuis.

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };

// Haalt tags weg, zet veelvoorkomende HTML-tekens terug en kapt af op `max` tekens.
export function plainText(value, max) {
  const text = String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|apos);/g, (entity) => ENTITIES[entity])
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
