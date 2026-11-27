// Een gevonden webpagina zelf lezen, om na te gaan of je gegevens er echt op staan. Een zoekmachine geeft
// alleen een titel en een kort fragment, en dat fragment kan oud zijn. De pagina zelf zegt meer.
//
// Dit is een bezoek van de server aan een site van iemand anders, dus voorzichtig:
//   - alleen gewone webpagina's (http of https, poort 80 of 443), en alleen adressen die een zoekopdracht
//     van jouw eigen account opleverde. Nooit een adres dat iemand intypt;
//   - nooit naar een intern adres: de server kijkt vóór de verbinding welk IP-adres de naam heeft, en weigert
//     alles wat niet openbaar is (127.0.0.1, 10.x, 192.168.x, 169.254.x, ::1, ...). Ook na een doorverwijzing.
//     Zo kan een pagina de server niet laten praten met je router, je eigen computer of de server zelf;
//   - robots.txt van de site geldt: vraagt die robots om weg te blijven, dan lezen we de pagina niet;
//   - geen databrokers, personenzoeksites en sociale media: hun voorwaarden verbieden geautomatiseerd lezen;
//   - hooguit 1,5 MB en 10 seconden per pagina, alleen tekst (html of platte tekst). Pdf lezen we nog niet.
// We bewaren niet de pagina, alleen wat we erop vonden en een kort stukje tekst eromheen, bij het
// webresultaat zelf (en dat verloopt met het resultaat).
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { brokerForUrl } from '../brokers/registry.js';
import { PEOPLE_SEARCH, SOCIAL } from '../extract.js';

export const USER_AGENT = 'PrivacyscanBot/0.9 (controleert de eigen gegevens van een gebruiker; respecteert robots.txt)';
export const ROBOT_TOKEN = 'privacyscanbot';
export const MAX_PAGE_BYTES = 1_500_000;
export const PAGE_TIMEOUT_MS = 10_000;
const MAX_ROBOTS_BYTES = 200_000;
const MAX_REDIRECTS = 3;

// Waarom een pagina niet gelezen is, en wat er op een gelezen pagina stond, in gewone woorden.
export const PAGE_REASONS = {
  overgeslagen: 'databroker of sociale media (lezen we bewust niet)',
  geweigerd: 'geen openbaar adres',
  robots: 'robots.txt van de site vraagt om weg te blijven',
  'geen-tekst': 'geen webpagina (bijvoorbeeld een pdf; die lezen we nog niet)',
  'te-groot': 'te groot',
  onbereikbaar: 'niet bereikbaar',
};

export const FOUND_LABELS = {
  naam: 'je naam', woonplaats: 'je woonplaats', email: 'je e-mailadres', telefoon: 'je telefoonnummer',
};

// "je naam en je woonplaats", alleen uit de vaste lijst hierboven.
export function foundText(found) {
  const labels = (Array.isArray(found) ? found : []).filter((key) => Object.hasOwn(FOUND_LABELS, key)).map((key) => FOUND_LABELS[key]);
  if (labels.length <= 1) return labels[0] ?? '';
  return `${labels.slice(0, -1).join(', ')} en ${labels.at(-1)}`;
}

// PAGE_CHECK in .env: leeg of "on" = aan, "off" = uit. Een typfout stopt de server liever dan dat hij
// stilletjes iets anders doet.
export function parsePageCheck(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === '' || text === 'on') return true;
  if (text === 'off') return false;
  throw new Error(`PAGE_CHECK moet "on" of "off" zijn (of leeg), niet "${String(value).trim().slice(0, 20)}". Controleer je .env.`);
}

// --- Welke adressen mogen ----------------------------------------------------------------------------

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 127], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(address, prefix, 'ipv6');

// Is dit een openbaar IP-adres? Een IPv4-adres in IPv6-jasje (::ffff:8.8.8.8) weigeren we altijd: een
// gewone site geeft zo'n adres niet op, en het is een bekende manier om een controle te omzeilen.
export function isPublicAddress(address) {
  const text = String(address ?? '');
  if (/^::ffff:/i.test(text)) return false;
  const family = net.isIP(text);
  if (family === 4) return !blocked.check(text, 'ipv4');
  if (family === 6) return !blocked.check(text, 'ipv6');
  return false;
}

const onDomain = (host, domains) => domains.some((domain) => host === domain || host.endsWith(`.${domain}`));

// Lezen we deze site bewust niet? Databrokers, personenzoeksites en sociale media.
export function offLimits(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  return Boolean(brokerForUrl(url)) || onDomain(host, PEOPLE_SEARCH) || onDomain(host, SOCIAL);
}

// Een adres dat we mogen proberen: http(s), poort 80/443 (of een toegestane testpoort), zonder
// inloggegevens. Een IP-adres in het adres zelf moet openbaar zijn. Geeft de URL of null.
function checkUrl(value, { ports, allowAddress }) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!ports.includes(port)) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !allowAddress(host)) return null;
  return url;
}

// De naam opzoeken, en alleen een openbaar adres teruggeven. Dit draait bij het maken van de verbinding
// zelf, dus de naam kan niet tussendoor naar een ander adres wijzen.
function safeLookup(resolve, allowAddress) {
  return (hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const wantsAll = typeof options === 'object' && options !== null && options.all === true;
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) return done(error);
      const list = Array.isArray(addresses) ? addresses : [];
      // Eén intern adres tussen de openbare is al genoeg om te weigeren.
      if (list.length === 0 || !list.every((entry) => allowAddress(entry.address))) {
        return done(Object.assign(new Error('Geen openbaar adres'), { code: 'EPRIVATE' }));
      }
      if (wantsAll) return done(null, list);
      return done(null, list[0].address, list[0].family);
    });
  };
}

// --- Ophalen -------------------------------------------------------------------------------------------

class FetchError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

// Haalt één adres op, met alle grenzen. Geeft { status, headers, body (Buffer), url } of gooit FetchError.
function getOnce(url, {
  lookup, timeoutMs, maxBytes, agentOptions = {},
}) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, {
      method: 'GET',
      lookup,
      // Elke aanvraag een eigen verbinding: een hergebruikte verbinding uit de gedeelde pool slaat de
      // adrescontrole in `lookup` over.
      agent: false,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9',
        'Accept-Language': 'nl,en;q=0.8',
      },
      timeout: timeoutMs,
      ...agentOptions,
    }, (response) => {
      // Zegt de site vooraf al dat het te groot is, dan halen we het niet op.
      if (Number(response.headers['content-length']) > maxBytes) {
        request.destroy(new FetchError('te-groot'));
        return;
      }
      const chunks = [];
      let size = 0;
      let tooBig = false;
      response.on('data', (chunk) => {
        if (tooBig) return;
        size += chunk.length;
        if (size > maxBytes) {
          tooBig = true;
          request.destroy(new FetchError('te-groot'));
          return;
        }
        chunks.push(chunk);
      });
      // Ook als het laatste stuk al binnen was: wat te groot is, telt niet als gelezen.
      response.on('end', () => (tooBig ? reject(new FetchError('te-groot')) : resolve({
        status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks), url,
      })));
      response.on('error', (error) => reject(error instanceof FetchError ? error : new FetchError('onbereikbaar')));
    });
    const timer = setTimeout(() => request.destroy(new FetchError('onbereikbaar')), timeoutMs);
    request.on('close', () => clearTimeout(timer));
    request.on('timeout', () => request.destroy(new FetchError('onbereikbaar')));
    request.on('error', (error) => {
      if (error instanceof FetchError) return reject(error);
      reject(new FetchError(error?.code === 'EPRIVATE' ? 'geweigerd' : 'onbereikbaar'));
    });
    request.end();
  });
}

// Haalt een adres op en volgt hooguit drie doorverwijzingen, elk weer met alle controles.
async function fetchFollowing(start, options) {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await getOnce(url, options);
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      const next = checkUrl(new URL(response.headers.location, url).href, options);
      if (!next) throw new FetchError('geweigerd');
      url = next;
      continue;
    }
    return response;
  }
  throw new FetchError('onbereikbaar');
}

// --- robots.txt ------------------------------------------------------------------------------------------

// Leest robots.txt (RFC 9309): de groep voor onze naam, anders die voor *. De langste regel die past,
// wint; bij gelijke lengte wint Allow. * en $ werken zoals in de RFC.
export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === 'user-agent') {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && current) {
      if (value !== '') current.rules.push({ allow: field === 'allow', path: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  const ours = groups.filter((group) => group.agents.some((agent) => agent !== '*' && ROBOT_TOKEN.includes(agent)));
  const chosen = ours.length > 0 ? ours : groups.filter((group) => group.agents.includes('*'));
  return chosen.flatMap((group) => group.rules);
}

function ruleMatches(rulePath, path) {
  const anchored = rulePath.endsWith('$');
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const pattern = body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${pattern}${anchored ? '$' : ''}`).test(path);
}

export function robotsAllow(rules, path) {
  let best = null;
  for (const rule of rules) {
    if (!ruleMatches(rule.path, path)) continue;
    const length = rule.path.replace(/\$$/, '').length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}

// --- Van html naar tekst ---------------------------------------------------------------------------------

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', euml: 'ë', egrave: 'è', iuml: 'ï',
  ouml: 'ö', uuml: 'ü', auml: 'ä', aacute: 'á', oacute: 'ó', ccedil: 'ç', szlig: 'ß', ndash: '–', mdash: '—',
  hellip: '…', copy: '©', reg: '®', euro: '€',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
    }
    return NAMED[name.toLowerCase()] ?? whole;
  });
}

// De zichtbare tekst van een html-pagina, en de titel. Scripts, stijlen en commentaar gaan eruit.
export function htmlToText(html) {
  const source = String(html ?? '');
  const title = decodeEntities((source.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim());
  const text = decodeEntities(source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head|title)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|section|article|td|th|dd|dt)>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  return { title: title.slice(0, 300), text };
}

function decodeBody(body, contentType) {
  const charset = String(contentType ?? '').match(/charset=["']?([\w-]+)/i)?.[1]?.toLowerCase() ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

// --- De lezer ----------------------------------------------------------------------------------------------

// Maakt een lezer. `read(url)` geeft:
//   { status: 'gelezen', url, title, text }
//   { status: 'overgeslagen' }     databroker, personenzoeksite of sociale media: bewust niet
//   { status: 'geweigerd' }        geen openbaar adres, of geen http(s) op poort 80/443
//   { status: 'robots' }           robots.txt van de site vraagt om weg te blijven
//   { status: 'geen-tekst' }       geen html of platte tekst (bijvoorbeeld een pdf)
//   { status: 'te-groot' }         meer dan 1,5 MB
//   { status: 'onbereikbaar' }     geen antwoord, een fout van de site, of te lang
// De opties zijn voor de tests: een eigen adresopzoeker, en welke adressen en poorten mogen.
export function createPageReader({
  resolve = dns.lookup,
  allowAddress = isPublicAddress,
  ports = [80, 443],
  timeoutMs = PAGE_TIMEOUT_MS,
  maxBytes = MAX_PAGE_BYTES,
  agentOptions = {},
} = {}) {
  const lookup = safeLookup(resolve, allowAddress);
  const base = {
    lookup, timeoutMs, maxBytes, ports, allowAddress, agentOptions,
  };
  const robotsCache = new Map(); // per herkomst (https://site.nl), zolang deze lezer bestaat

  async function robotsFor(url) {
    const origin = url.origin;
    if (robotsCache.has(origin)) {
      const known = robotsCache.get(origin);
      if (typeof known === 'string') throw new FetchError(known);
      return known;
    }
    let rules;
    try {
      const response = await fetchFollowing(new URL('/robots.txt', origin), { ...base, maxBytes: MAX_ROBOTS_BYTES });
      if (response.status >= 200 && response.status < 300) rules = parseRobots(response.body.toString('utf8'));
      else if (response.status >= 400 && response.status < 500) rules = []; // geen robots.txt: alles mag
      else rules = [{ allow: false, path: '/' }]; // storing bij de site: dan liever niet
    } catch (error) {
      // Mag de server er niet heen (geen openbaar adres), of is de site helemaal niet bereikbaar, dan zeggen
      // we dat, en niet "robots.txt". Lezen doen we dan ook niet (RFC 9309: bij twijfel niet).
      const failure = error instanceof FetchError && error.code === 'geweigerd' ? 'geweigerd' : 'onbereikbaar';
      robotsCache.set(origin, failure);
      throw new FetchError(failure);
    }
    robotsCache.set(origin, rules);
    return rules;
  }

  async function read(value) {
    if (!URL.canParse(String(value ?? ''))) return { status: 'geweigerd' };
    if (offLimits(value)) return { status: 'overgeslagen' };
    const url = checkUrl(value, base);
    if (!url) return { status: 'geweigerd' };
    try {
      const rules = await robotsFor(url);
      if (!robotsAllow(rules, `${url.pathname}${url.search}`)) return { status: 'robots' };
      const response = await fetchFollowing(url, base);
      if (response.status < 200 || response.status >= 300) return { status: 'onbereikbaar' };
      const type = String(response.headers['content-type'] ?? '').toLowerCase();
      const isHtml = type.includes('text/html') || type.includes('application/xhtml');
      if (!isHtml && !type.includes('text/plain')) return { status: 'geen-tekst' };
      const decoded = decodeBody(response.body, type);
      const page = isHtml ? htmlToText(decoded) : { title: '', text: decoded.replace(/\s+/g, ' ').trim() };
      return {
        status: 'gelezen', url: response.url.href, title: page.title, text: page.text,
      };
    } catch (error) {
      return { status: error instanceof FetchError ? error.code : 'onbereikbaar' };
    }
  }

  return { read };
}
