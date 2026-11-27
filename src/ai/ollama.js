// De koppeling met Ollama (ollama.com): een AI-model dat op je eigen computer draait. De site stuurt een
// vraag naar Ollama op OLLAMA_URL (standaard http://127.0.0.1:11434, deze computer) en krijgt een antwoord
// terug in een vast formaat (een JSON-schema). Er gaat niets naar een externe AI-dienst, zolang OLLAMA_URL
// naar deze computer wijst.
//
// Dit is alleen de verbinding. Wat de AI mag en wat we met het antwoord doen, staat in agent.js.
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen3:8b';
export const AI_TIMEOUT_MS = 180_000; // een model op een gewone computer kan traag zijn

// Fouten van de AI, zonder technische details. De code zegt wat er mis was.
export class AiError extends Error {
  constructor(code) {
    super(code);
    this.name = 'AiError';
    this.code = code;
  }
}

// AI_PROVIDER in .env: leeg of "none" = geen AI, "ollama" = Ollama. Iets anders stopt de server liever dan
// dat hij stilletjes zonder AI draait.
export function parseAiProvider(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '' || text === 'none') return null;
  if (text === 'ollama') return 'ollama';
  throw new Error(`AI_PROVIDER moet "ollama" zijn (of leeg voor geen AI), niet "${String(value).trim().slice(0, 30)}". Controleer je .env.`);
}

// OLLAMA_URL: een http(s)-adres zonder gebruikersnaam of wachtwoord. Leeg = deze computer.
export function parseOllamaUrl(value) {
  const text = String(value ?? '').trim();
  if (text === '') return DEFAULT_OLLAMA_URL;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`OLLAMA_URL is geen geldig adres: "${text.slice(0, 60)}". Bijvoorbeeld: ${DEFAULT_OLLAMA_URL}`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`OLLAMA_URL moet beginnen met http:// of https:// en mag geen gebruikersnaam of wachtwoord bevatten. Bijvoorbeeld: ${DEFAULT_OLLAMA_URL}`);
  }
  return url.href.replace(/\/+$/, '');
}

// Wijst dit adres naar deze computer? (Voor de privacyverklaring en de beheerpagina.)
export function isLocalUrl(value) {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
  } catch {
    return false;
  }
}

export function createOllama({
  url = DEFAULT_OLLAMA_URL,
  model = DEFAULT_OLLAMA_MODEL,
  fetchImpl = fetch,    // server.js geeft de getelde versie van de monitor mee (zie monitor.js)
  timeoutMs = AI_TIMEOUT_MS,
} = {}) {
  const base = String(url).replace(/\/+$/, '');

  async function call(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, { ...init, signal: controller.signal });
      const text = await response.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
      return { status: response.status, data };
    } catch (error) {
      throw new AiError(error?.name === 'AbortError' ? 'timeout' : 'unavailable');
    } finally {
      clearTimeout(timer);
    }
  }

  // Eén vraag, één antwoord in het formaat van `schema`. Geeft { content, tokens }. Temperatuur 0: zo min
  // mogelijk fantasie. "think: false" zet het lange nadenken van modellen als Qwen3 uit; kent het model die
  // instelling niet, dan vragen we het nog een keer zonder.
  async function chat({ system, prompt, schema, maxTokens = 700 }) {
    const body = {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      format: schema,
      stream: false,
      think: false,
      keep_alive: '10m',
      options: { temperature: 0, num_ctx: 8192, num_predict: maxTokens },
    };
    const send = () => call('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    let answer = await send();
    if (answer.status === 400 && /think/i.test(String(answer.data?.error ?? ''))) {
      delete body.think;
      answer = await send();
    }
    if (answer.status === 404) throw new AiError('model_missing');
    if (answer.status !== 200 || typeof answer.data?.message?.content !== 'string') throw new AiError('failed');
    let content;
    try {
      content = JSON.parse(answer.data.message.content);
    } catch {
      throw new AiError('bad_output');
    }
    return {
      content,
      tokens: { prompt: Number(answer.data.prompt_eval_count) || 0, output: Number(answer.data.eval_count) || 0 },
    };
  }

  // Welke modellen heeft Ollama? (Voor de testknop op de beheerpagina.)
  async function models() {
    const answer = await call('/api/tags', { method: 'GET' });
    if (answer.status !== 200 || !Array.isArray(answer.data?.models)) throw new AiError('failed');
    return answer.data.models.map((item) => String(item?.name ?? '')).filter(Boolean);
  }

  return {
    id: 'ollama', name: 'Ollama', url: base, model, local: isLocalUrl(base), chat, models,
  };
}
