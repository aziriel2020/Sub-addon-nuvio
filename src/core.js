import crypto from 'node:crypto';
import { gunzipSync, inflateSync } from 'node:zlib';

const UPSTREAMS = [
  { name: 'OpenSubtitles v3', base: 'https://opensubtitles-v3.strem.io' },
  { name: 'OpenSubtitles legacy', base: 'https://opensubtitles.strem.io/stremio/v1' }
];
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const MAX_TRACKS = Math.max(1, Math.min(12, Number(process.env.MAX_TRACKS || 6)));
const BATCH_CUES = Math.max(120, Math.min(500, Number(process.env.BATCH_CUES || 320)));
const GEMINI_CONCURRENCY = 1;

const LANGS = {
  fr: { name: 'Français', iso3: 'fra' },
  en: { name: 'English', iso3: 'eng' },
  es: { name: 'Español', iso3: 'spa' },
  de: { name: 'Deutsch', iso3: 'deu' },
  it: { name: 'Italiano', iso3: 'ita' },
  pt: { name: 'Português', iso3: 'por' },
  nl: { name: 'Nederlands', iso3: 'nld' },
  ar: { name: 'العربية', iso3: 'ara' },
  tr: { name: 'Türkçe', iso3: 'tur' },
  pl: { name: 'Polski', iso3: 'pol' },
  ro: { name: 'Română', iso3: 'ron' },
  ru: { name: 'Русский', iso3: 'rus' },
  uk: { name: 'Українська', iso3: 'ukr' },
  ja: { name: '日本語', iso3: 'jpn' },
  ko: { name: '한국어', iso3: 'kor' },
  zh: { name: '中文', iso3: 'zho' },
  sv: { name: 'Svenska', iso3: 'swe' },
  no: { name: 'Norsk', iso3: 'nor' },
  da: { name: 'Dansk', iso3: 'dan' },
  fi: { name: 'Suomi', iso3: 'fin' }
};

const ENGLISH = new Set(['en', 'eng', 'english', 'en-us', 'en-gb', 'en_us', 'en_gb']);
const FRENCH = new Set(['fr', 'fra', 'fre', 'french', 'fr-fr', 'fr_fr']);
const cache = new Map();

function json(status, value, extraHeaders) {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      ...(extraHeaders || {})
    },
    body: JSON.stringify(value)
  };
}

function text(status, value, contentType, extraHeaders) {
  return {
    status,
    headers: {
      'content-type': contentType || 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
      ...(extraHeaders || {})
    },
    body: value
  };
}

function normalizeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value[0] : value
    ])
  );
}

function requestOrigin(headers) {
  const host = headers['x-forwarded-host'] || headers.host || '127.0.0.1:7001';
  const proto = headers['x-forwarded-proto'] ||
    (String(host).startsWith('127.0.0.1') || String(host).startsWith('localhost') ? 'http' : 'https');
  return proto + '://' + host;
}

function normalizeUrl(urlString, headers) {
  const u = new URL(urlString, requestOrigin(headers));

  if ((u.pathname === '/api/index' || u.pathname === '/api/index.js') && u.searchParams.get('__path')) {
    u.pathname = '/' + u.searchParams.get('__path').replace(/^\/+/, '');
    u.searchParams.delete('__path');
  }

  return u;
}

function manifest(langCode) {
  const lang = LANGS[langCode];
  return {
    id: 'com.boomsubs.gemini.' + langCode,
    version: '1.5.0',
    name: 'BoomSubs Gemini v1.5 → ' + lang.name,
    description: 'OpenSubtitles v3 officiel Stremio → Gemini. Aucune clé API OpenSubtitles personnelle.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    catalogs: [],
    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  };
}

function normalizedLanguage(value) {
  return String(value || '').trim().toLowerCase();
}

function isEnglish(value) {
  const lang = normalizedLanguage(value);
  return ENGLISH.has(lang) || lang.startsWith('en-') || lang.startsWith('eng');
}

function isFrench(value) {
  const lang = normalizedLanguage(value);
  return FRENCH.has(lang) || lang.startsWith('fr-') || lang.startsWith('fra');
}

function subtitlePriority(subtitle) {
  if (isEnglish(subtitle?.lang)) return 0;
  if (isFrench(subtitle?.lang)) return 1;
  return 2;
}

function signingKey(apiKey) {
  return process.env.ADDON_SECRET || apiKey || 'boomsubs-local-development';
}

function signUrl(url, langCode, apiKey) {
  return crypto
    .createHmac('sha256', signingKey(apiKey))
    .update(langCode + '\n' + url)
    .digest('base64url')
    .slice(0, 32);
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function encodeUrl(url) {
  return Buffer.from(url, 'utf8').toString('base64url');
}

function decodeUrl(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function decodeConfigToken(token) {
  const decoded = Buffer.from(token, 'base64url').toString('utf8');
  const parsed = JSON.parse(decoded);
  const apiKey = String(parsed?.k || '').trim();

  if (apiKey.length < 20) {
    throw new Error('Invalid Gemini API key');
  }

  return apiKey;
}

function stableId(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function diagnosticSubtitle(origin, token, langCode, message) {
  return {
    id: 'boom-diagnostic-' + stableId(message),
    url:
      origin +
      '/c/' +
      token +
      '/' +
      langCode +
      '/diagnostic.vtt?m=' +
      encodeURIComponent(message),
    lang: LANGS[langCode]?.iso3 || 'fra'
  };
}

function assTimeToVtt(value) {
  const match = String(value || '').trim().match(/^(\d+):(\d{2}):(\d{2})[.](\d{1,2})$/);
  if (!match) return null;

  const hours = match[1].padStart(2, '0');
  const minutes = match[2];
  const seconds = match[3];
  const millis = String(Number(match[4].padEnd(2, '0')) * 10).padStart(3, '0');

  return hours + ':' + minutes + ':' + seconds + '.' + millis;
}

function parseAssSubtitles(source) {
  const cues = [];

  for (const line of source.split('\n')) {
    if (!/^Dialogue\s*:/i.test(line)) continue;

    const body = line.replace(/^Dialogue\s*:\s*/i, '');
    const parts = body.split(',');
    if (parts.length < 10) continue;

    const start = assTimeToVtt(parts[1]);
    const end = assTimeToVtt(parts[2]);
    if (!start || !end) continue;

    const cueText = parts
      .slice(9)
      .join(',')
      .replace(/\\N/gi, '\n')
      .replace(/\{\\[^}]+\}/g, '')
      .trim();

    if (!cueText) continue;
    cues.push({ timing: start + ' --> ' + end, text: cueText });
  }

  return cues;
}

export function parseSubtitle(input) {
  const source = String(input || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');

  const cues = [];

  for (const block of source.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) =>
      /\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}/.test(line)
    );

    if (timingIndex < 0) continue;

    const timing = lines[timingIndex]
      .trim()
      .replace(/(\d{1,2}:\d{2}:\d{2}),([0-9]{3})/g, '$1.$2');

    const cueText = lines.slice(timingIndex + 1).join('\n').trim();
    if (!cueText) continue;

    cues.push({ timing, text: cueText });
  }

  if (cues.length) return cues;
  return parseAssSubtitles(source);
}

export function renderVtt(cues) {
  const output = ['WEBVTT', ''];
  for (const cue of cues) {
    output.push(cue.timing, cue.text, '');
  }
  return output.join('\n');
}

function errorVtt(message) {
  const safe = String(message || 'BoomSubs error')
    .replace(/\r?\n/g, ' ')
    .slice(0, 900);

  return [
    'WEBVTT',
    '',
    '00:00:00.000 --> 10:00:00.000',
    'BoomSubs: ' + safe,
    ''
  ].join('\n');
}

function extractGeminiText(data) {
  return (data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part?.text || '')
    .join('')
    .trim();
}

function parseJsonArrayLoose(value) {
  const raw = String(value || '').trim();

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start >= 0 && end > start) {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (Array.isArray(parsed)) return parsed;
  }

  throw new Error('Gemini did not return a JSON array');
}

async function translateBatch(items, targetName, apiKey) {
  const endpoint =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    encodeURIComponent(MODEL) +
    ':generateContent';

  const payload = items.map((item) => ({ i: item.i, t: item.text }));

  const prompt = [
    'Translate the following subtitle dialogue into ' + targetName + '.',
    'Return ONLY a valid JSON array.',
    'Every output object must have exactly this shape: {"i":0,"t":"translated text"}.',
    'Keep the exact integer i values and exact item order.',
    'Do not merge, split, remove or add subtitle items.',
    'Preserve line breaks, speaker dashes, names, numbers, punctuation, music symbols and tags such as <i>, <b> and <font>.',
    '',
    JSON.stringify(payload)
  ].join('\n');

  let lastError;

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            thinkingConfig: {
              thinkingLevel: 'minimal'
            }
          }
        })
      });

      if (response.status === 429) {
        const retryAfterHeader = Number(response.headers.get('retry-after') || 0);
        const waitMs = retryAfterHeader > 0
          ? retryAfterHeader * 1000
          : Math.min(15000, 2500 * (attempt + 1));

        const details = (await response.text()).slice(0, 500);
        lastError = new Error('Gemini quota/rate limit: ' + details);

        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        throw lastError;
      }

      if (!response.ok) {
        throw new Error(
          'Gemini ' +
          response.status +
          ': ' +
          (await response.text()).slice(0, 500)
        );
      }

      const result = parseJsonArrayLoose(
        extractGeminiText(await response.json())
      );

      const translated = new Map(
        result
          .filter((item) => Number.isInteger(item?.i) && typeof item?.t === 'string')
          .map((item) => [item.i, item.t])
      );

      if (translated.size < Math.max(1, Math.floor(items.length * 0.9))) {
        throw new Error('Gemini returned too few subtitle items');
      }

      return items.map((item) => translated.get(item.i) ?? item.text);
    } catch (error) {
      lastError = error;

      if (attempt < 3 && !String(error?.message || error).includes('quota/rate limit')) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }

  throw lastError;
}

function decodeSubtitleBytes(arrayBuffer, contentType = '', sourceUrl = '') {
  let bytes = Buffer.from(arrayBuffer);
  const loweredType = String(contentType || '').toLowerCase();
  const loweredUrl = String(sourceUrl || '').toLowerCase();

  const looksGzip =
    (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) ||
    loweredType.includes('gzip') ||
    loweredUrl.endsWith('.gz');

  if (looksGzip) {
    try {
      bytes = gunzipSync(bytes);
    } catch {}
  } else if (loweredType.includes('deflate')) {
    try {
      bytes = inflateSync(bytes);
    } catch {}
  }

  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }

  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }

  return new TextDecoder('utf-8').decode(bytes);
}

async function translateSubtitle(sourceText, targetName, apiKey) {
  const cues = parseSubtitle(sourceText);

  if (!cues.length) {
    throw new Error('No supported timed subtitle cues found');
  }

  const translated = new Array(cues.length);

  for (let start = 0; start < cues.length; start += BATCH_CUES) {
    const items = cues
      .slice(start, start + BATCH_CUES)
      .map((cue, offset) => ({
        i: start + offset,
        text: cue.text
      }));

    const batch = await translateBatch(items, targetName, apiKey);

    batch.forEach((value, offset) => {
      translated[start + offset] = value;
    });
  }

  return renderVtt(
    cues.map((cue, index) => ({
      timing: cue.timing,
      text: translated[index] || cue.text
    }))
  );
}

function upstreamCandidatePaths(pathAndQuery) {
  const qIndex = pathAndQuery.indexOf('?');
  const path = qIndex >= 0 ? pathAndQuery.slice(0, qIndex) : pathAndQuery;
  const query = qIndex >= 0 ? pathAndQuery.slice(qIndex) : '';
  const candidates = [path + query];

  const match = path.match(/^\/subtitles\/(movie|series)\/([^/]+)(?:\/(.+))?\.json$/);
  if (match) {
    const type = match[1];
    const id = match[2];
    const extra = match[3];

    if (!extra) {
      candidates.push('/subtitles/' + type + '/' + id + '/*.json' + query);
    } else {
      candidates.push('/subtitles/' + type + '/' + id + '.json' + query);
    }
  }

  return [...new Set(candidates)];
}

async function fetchJsonWithTimeout(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'BoomSubs-Gemini/1.5 (Stremio/Nuvio addon)',
        'accept': 'application/json'
      }
    });

    if (!response.ok) {
      return { ok: false, status: response.status, subtitles: [] };
    }

    const data = await response.json();
    return {
      ok: true,
      status: response.status,
      subtitles: Array.isArray(data?.subtitles) ? data.subtitles : []
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: String(error?.message || error),
      subtitles: []
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstreamSubtitles(pathAndQuery) {
  const paths = upstreamCandidatePaths(pathAndQuery);
  const requests = [];

  for (const upstream of UPSTREAMS) {
    for (const candidatePath of paths) {
      requests.push({
        upstream: upstream.name,
        url: upstream.base + candidatePath
      });
    }
  }

  const results = await Promise.all(
    requests.map(async (request) => ({
      ...request,
      ...(await fetchJsonWithTimeout(request.url))
    }))
  );

  const unique = new Map();

  for (const result of results) {
    for (const subtitle of result.subtitles || []) {
      if (!subtitle?.url) continue;
      const key = subtitle.url;
      if (!unique.has(key)) {
        unique.set(key, {
          ...subtitle,
          _boomSource: result.upstream
        });
      }
    }
  }

  const subtitles = [...unique.values()].sort((a, b) => {
    const pa = subtitlePriority(a);
    const pb = subtitlePriority(b);
    return pa - pb;
  });

  return {
    subtitles,
    diagnostics: results.map((result) => ({
      upstream: result.upstream,
      status: result.status,
      count: result.subtitles?.length || 0,
      url: result.url,
      error: result.error || null
    }))
  };
}

function configurePage(origin) {
  const options = Object.entries(LANGS)
    .map(([code, lang]) =>
      '<option value="' + code + '"' +
      (code === 'fr' ? ' selected' : '') +
      '>' + lang.name + '</option>'
    )
    .join('');

  return '<!doctype html>' +
    '<html lang="fr"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>BoomSubs Gemini</title>' +
    '<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 18px;background:#111;color:#eee}.card{background:#1b1b1b;border:1px solid #333;border-radius:14px;padding:22px;margin:18px 0}select,input,button{font:inherit;padding:11px;border-radius:9px;border:1px solid #555;background:#151515;color:#fff}input{width:100%;box-sizing:border-box;margin:10px 0}button{cursor:pointer;font-weight:700;margin-right:8px}.ok{color:#9be28f}.warn{color:#ffd27d}code{color:#b8e0ff;word-break:break-all}</style>' +
    '</head><body><h1>💥 BoomSubs Gemini</h1>' +
    '<p>OpenSubtitles v3 officiel Stremio → Gemini → Nuvio. <b>Aucune API OpenSubtitles personnelle.</b></p>' +
    '<div class="card">' +
    '<label>Clé Gemini</label>' +
    '<input id="key" type="password" autocomplete="off" placeholder="Colle ta clé Gemini">' +
    '<label>Langue cible</label><br><select id="lang">' + options + '</select><br><br>' +
    '<button id="make">Créer le manifest</button><button id="copy" type="button">Copier</button>' +
    '<input id="url" readonly placeholder="Le lien manifest apparaîtra ici">' +
    '<p class="warn">La clé n’est pas enregistrée dans GitHub ni dans une variable Vercel. Elle est encodée dans ton URL d’addon, donc garde ce lien privé.</p>' +
    '<p>Colle ensuite le lien dans Nuvio → Addons.</p></div>' +
    '<script>' +
    'const k=document.getElementById("key"),l=document.getElementById("lang"),u=document.getElementById("url");' +
    'function token(v){const b=btoa(JSON.stringify({k:v}));return b.replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}' +
    'document.getElementById("make").onclick=()=>{const v=k.value.trim();if(!v){alert("Clé Gemini manquante");return}u.value=location.origin+"/c/"+token(v)+"/"+l.value+"/manifest.json";u.select()};' +
    'document.getElementById("copy").onclick=()=>{if(u.value)navigator.clipboard?.writeText(u.value)};' +
    '</script></body></html>';
}

export async function handleRequest(request) {
  const method = request.method || 'GET';
  const headers = normalizeHeaders(request.headers);
  const u = normalizeUrl(request.url || '/', headers);
  const origin = requestOrigin(headers);

  if (method === 'OPTIONS') {
    return text(204, '', 'text/plain', {
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': '*'
    });
  }

  if (method !== 'GET') {
    return json(405, { error: 'Method not allowed' });
  }

  if (u.pathname === '/' || u.pathname === '/configure') {
    return text(200, configurePage(origin), 'text/html; charset=utf-8');
  }

  if (u.pathname === '/health') {
    return json(200, {
      ok: true,
      configurationMode: 'manifest-url',
      upstreams: UPSTREAMS.map((item) => item.base),
      model: MODEL
    });
  }

  const debugMatch = u.pathname.match(/^\/debug\/(movie|series)\/([^/]+)\.json$/);

  if (debugMatch) {
    const type = debugMatch[1];
    const id = decodeURIComponent(debugMatch[2]);
    const result = await fetchUpstreamSubtitles('/subtitles/' + type + '/' + id + '.json');
    return json(200, {
      id,
      type,
      total: result.subtitles.length,
      languages: [...new Set(result.subtitles.map((subtitle) => subtitle?.lang).filter(Boolean))],
      sample: result.subtitles.slice(0, 8).map((subtitle) => ({
        lang: subtitle.lang,
        id: subtitle.id || null,
        source: subtitle._boomSource || null,
        url: subtitle.url
      })),
      diagnostics: result.diagnostics
    }, {
      'cache-control': 'no-store'
    });
  }

  const manifestMatch = u.pathname.match(/^\/c\/([^/]+)\/([a-z]{2})\/manifest\.json$/);

  if (manifestMatch) {
    const token = manifestMatch[1];
    const langCode = manifestMatch[2];

    if (!LANGS[langCode]) {
      return json(404, { error: 'Unsupported target language' });
    }

    try {
      decodeConfigToken(token);
    } catch {
      return json(400, { error: 'Invalid Gemini configuration' });
    }

    return json(200, manifest(langCode), {
      'cache-control': 'private, max-age=300'
    });
  }

  const subtitleMatch = u.pathname.match(
    /^\/c\/([^/]+)\/([a-z]{2})(\/subtitles\/(movie|series)\/.+\.json)$/
  );

  if (subtitleMatch) {
    const token = subtitleMatch[1];
    const langCode = subtitleMatch[2];
    const lang = LANGS[langCode];

    if (!lang) return json(404, { subtitles: [] });

    let apiKey;
    try {
      apiKey = decodeConfigToken(token);
    } catch {
      return json(400, { subtitles: [], error: 'Invalid Gemini configuration' });
    }

    try {
      const upstreamPath = subtitleMatch[3] + u.search;
      const requestedIdMatch = subtitleMatch[3].match(/^\/subtitles\/(?:movie|series)\/([^/.]+(?:[:][^/.]+)*)\.json$/);
      const requestedId = requestedIdMatch ? decodeURIComponent(requestedIdMatch[1]) : '';

      if (requestedId && !requestedId.startsWith('tt')) {
        return json(200, {
          subtitles: [
            diagnosticSubtitle(
              origin,
              token,
              langCode,
              'BoomSubs appelé, mais ID non-IMDb reçu: ' + requestedId
            )
          ]
        }, {
          'cache-control': 'no-store'
        });
      }

      const upstreamResult = await fetchUpstreamSubtitles(upstreamPath);

      const candidates = upstreamResult.subtitles
        .filter((subtitle) => subtitle?.url)
        .slice(0, MAX_TRACKS);

      if (!candidates.length) {
        const statuses = upstreamResult.diagnostics
          .map((item) => item.upstream + '=' + item.status + '/' + item.count)
          .join(', ');

        return json(200, {
          subtitles: [
            diagnosticSubtitle(
              origin,
              token,
              langCode,
              'BoomSubs: aucune piste OpenSubtitles pour ' + (requestedId || 'ID inconnu') + ' (' + statuses + ')'
            )
          ]
        }, {
          'cache-control': 'no-store'
        });
      }

      const best =
        candidates.find((subtitle) => isEnglish(subtitle.lang)) ||
        candidates[0];

      const encoded = encodeUrl(best.url);
      const signature = signUrl(best.url, langCode, apiKey);

      const subtitles = [
        {
          id: 'boom-gemini-best-' + stableId(best.url + '|' + langCode),
          url:
            origin +
            '/c/' +
            token +
            '/' +
            langCode +
            '/translate.vtt?u=' +
            encodeURIComponent(encoded) +
            '&sig=' +
            encodeURIComponent(signature),
          lang: lang.iso3
        },
        {
          id: 'boom-original-best-' + stableId(best.url),
          url:
            origin +
            '/c/' +
            token +
            '/' +
            langCode +
            '/source.vtt?u=' +
            encodeURIComponent(encoded) +
            '&sig=' +
            encodeURIComponent(signature),
          lang: isEnglish(best.lang) ? 'eng' : (best.lang || 'und')
        }
      ];

      return json(200, { subtitles }, {
        'cache-control': 'private, max-age=300'
      });
    } catch (error) {
      return json(502, {
        subtitles: [],
        error: String(error?.message || error)
      });
    }
  }

  const sourceMatch = u.pathname.match(
    /^\/c\/([^/]+)\/([a-z]{2})\/source\.vtt$/
  );

  if (sourceMatch) {
    const token = sourceMatch[1];
    const langCode = sourceMatch[2];

    let apiKey;
    try {
      apiKey = decodeConfigToken(token);
    } catch {
      return text(200, errorVtt('Invalid Gemini configuration'), 'text/vtt; charset=utf-8');
    }

    const encoded = u.searchParams.get('u');
    const signature = u.searchParams.get('sig');
    if (!encoded || !signature) {
      return text(200, errorVtt('Missing source subtitle token'), 'text/vtt; charset=utf-8');
    }

    let sourceUrl;
    try {
      sourceUrl = decodeUrl(encoded);
    } catch {
      return text(200, errorVtt('Invalid source subtitle token'), 'text/vtt; charset=utf-8');
    }

    if (
      !/^https?:\/\//i.test(sourceUrl) ||
      !safeEqual(signUrl(sourceUrl, langCode, apiKey), signature)
    ) {
      return text(200, errorVtt('Invalid source subtitle signature'), 'text/vtt; charset=utf-8');
    }

    try {
      const sourceResponse = await fetch(sourceUrl, {
        headers: { 'user-agent': 'BoomSubs-Gemini/1.5' }
      });

      if (!sourceResponse.ok) {
        throw new Error('Original subtitle download returned ' + sourceResponse.status);
      }

      const sourceText = decodeSubtitleBytes(
        await sourceResponse.arrayBuffer(),
        sourceResponse.headers.get('content-type') || '',
        sourceUrl
      );

      const cues = parseSubtitle(sourceText);
      if (!cues.length) throw new Error('Original subtitle parser found 0 cues');

      return text(
        200,
        renderVtt(cues),
        'text/vtt; charset=utf-8',
        { 'cache-control': 'private, max-age=3600' }
      );
    } catch (error) {
      return text(
        200,
        errorVtt(String(error?.message || error)),
        'text/vtt; charset=utf-8',
        { 'cache-control': 'no-store' }
      );
    }
  }

  const testMatch = u.pathname.match(
    /^\/c\/([^/]+)\/([a-z]{2})\/test\.vtt$/
  );

  if (testMatch) {
    return text(
      200,
      [
        'WEBVTT',
        '',
        '00:00:00.000 --> 10:00:00.000',
        'BoomSubs TEST OK - le lecteur Nuvio charge bien cette piste',
        ''
      ].join('\n'),
      'text/vtt; charset=utf-8',
      { 'cache-control': 'no-store' }
    );
  }

  const diagnosticMatch = u.pathname.match(
    /^\/c\/([^/]+)\/([a-z]{2})\/diagnostic\.vtt$/
  );

  if (diagnosticMatch) {
    const message = u.searchParams.get('m') || 'BoomSubs diagnostic';
    const body = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 10:00:00.000',
      message,
      ''
    ].join('\n');

    return text(200, body, 'text/vtt; charset=utf-8', {
      'cache-control': 'no-store'
    });
  }

  const translateMatch = u.pathname.match(
    /^\/c\/([^/]+)\/([a-z]{2})\/translate\.vtt$/
  );

  if (translateMatch) {
    const token = translateMatch[1];
    const langCode = translateMatch[2];
    const lang = LANGS[langCode];

    if (!lang) return text(404, 'Unsupported target language');

    let apiKey;
    try {
      apiKey = decodeConfigToken(token);
    } catch {
      return text(400, 'Invalid Gemini configuration');
    }

    const encoded = u.searchParams.get('u');
    const signature = u.searchParams.get('sig');

    if (!encoded || !signature) {
      return text(400, 'Missing subtitle token');
    }

    let sourceUrl;
    try {
      sourceUrl = decodeUrl(encoded);
    } catch {
      return text(400, 'Invalid subtitle token');
    }

    if (
      !/^https?:\/\//i.test(sourceUrl) ||
      !safeEqual(signUrl(sourceUrl, langCode, apiKey), signature)
    ) {
      return text(403, 'Invalid subtitle signature');
    }

    const cacheKey = langCode + '|' + sourceUrl + '|' + stableId(apiKey);

    if (cache.has(cacheKey)) {
      return text(
        200,
        cache.get(cacheKey),
        'text/vtt; charset=utf-8',
        { 'cache-control': 'private, max-age=604800' }
      );
    }

    try {
      const sourceResponse = await fetch(sourceUrl, {
        headers: { 'user-agent': 'BoomSubs-Gemini/1.5' }
      });

      if (!sourceResponse.ok) {
        throw new Error('Subtitle download returned ' + sourceResponse.status);
      }

      const sourceText = decodeSubtitleBytes(
        await sourceResponse.arrayBuffer(),
        sourceResponse.headers.get('content-type') || '',
        sourceUrl
      );

      const translatedVtt = await translateSubtitle(
        sourceText,
        lang.name,
        apiKey
      );

      cache.set(cacheKey, translatedVtt);
      if (cache.size > 80) cache.delete(cache.keys().next().value);

      return text(
        200,
        translatedVtt,
        'text/vtt; charset=utf-8',
        { 'cache-control': 'private, max-age=604800' }
      );
    } catch (error) {
      return text(
        200,
        errorVtt(String(error?.message || error)),
        'text/vtt; charset=utf-8',
        { 'cache-control': 'no-store' }
      );
    }
  }

  return json(404, { error: 'Not found' });
}

