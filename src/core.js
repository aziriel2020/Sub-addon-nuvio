import crypto from 'node:crypto';

const UPSTREAM = 'https://opensubtitles-v3.strem.io';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const MAX_TRACKS = Math.max(1, Math.min(12, Number(process.env.MAX_TRACKS || 6)));
const BATCH_CUES = Math.max(20, Math.min(500, Number(process.env.BATCH_CUES || 220)));

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

const ENGLISH = new Set(['en', 'eng', 'english', 'en-us', 'en-gb']);
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
    version: '1.0.0',
    name: 'BoomSubs Gemini → ' + lang.name,
    description: 'OpenSubtitles v3 officiel Stremio → Gemini. Aucune clé API OpenSubtitles personnelle.',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  };
}

function isEnglish(value) {
  return ENGLISH.has(String(value || '').trim().toLowerCase());
}

function signingKey() {
  return process.env.ADDON_SECRET || process.env.GEMINI_API_KEY || 'boomsubs-local-development';
}

function signUrl(url, langCode) {
  return crypto
    .createHmac('sha256', signingKey())
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

function stableId(value) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
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

  return cues;
}

export function renderVtt(cues) {
  const output = ['WEBVTT', ''];
  for (const cue of cues) {
    output.push(cue.timing, cue.text, '');
  }
  return output.join('\n');
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

  for (let attempt = 0; attempt < 2; attempt++) {
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
            temperature: 0,
            responseMimeType: 'application/json'
          }
        })
      });

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
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
    }
  }

  throw lastError;
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

async function fetchUpstreamSubtitles(pathAndQuery) {
  const response = await fetch(UPSTREAM + pathAndQuery, {
    headers: {
      'user-agent': 'BoomSubs-Gemini/1.0 (Stremio/Nuvio addon)'
    }
  });

  if (!response.ok) {
    throw new Error('OpenSubtitles v3 upstream returned ' + response.status);
  }

  const data = await response.json();
  return Array.isArray(data?.subtitles) ? data.subtitles : [];
}

function configurePage(origin, ready) {
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
    '<style>body{font-family:system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 18px;background:#111;color:#eee}.card{background:#1b1b1b;border:1px solid #333;border-radius:14px;padding:22px;margin:18px 0}select,input,button{font:inherit;padding:11px;border-radius:9px;border:1px solid #555;background:#151515;color:#fff}input{width:100%;box-sizing:border-box;margin:10px 0}button{cursor:pointer;font-weight:700}.ok{color:#9be28f}.bad{color:#ff9e9e}code{color:#b8e0ff}</style>' +
    '</head><body><h1>💥 BoomSubs Gemini</h1>' +
    '<p>OpenSubtitles v3 officiel Stremio → Gemini → Nuvio. <b>Aucune API OpenSubtitles personnelle.</b></p>' +
    '<div class="card"><p>Gemini : <b class="' + (ready ? 'ok' : 'bad') + '">' +
    (ready ? 'clé configurée ✓' : 'GEMINI_API_KEY manquante') +
    '</b></p><label>Langue cible</label><br><select id="lang">' +
    options +
    '</select><button id="make">Créer le lien</button>' +
    '<input id="url" readonly value="' + origin + '/fr/manifest.json">' +
    '<p>Colle ce manifest dans Nuvio → Addons.</p></div>' +
    '<script>const l=document.getElementById("lang"),u=document.getElementById("url");document.getElementById("make").onclick=()=>{u.value=location.origin+"/"+l.value+"/manifest.json";u.select();navigator.clipboard?.writeText(u.value)};</script>' +
    '</body></html>';
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
    return text(
      200,
      configurePage(origin, Boolean(process.env.GEMINI_API_KEY)),
      'text/html; charset=utf-8'
    );
  }

  if (u.pathname === '/health') {
    return json(200, {
      ok: true,
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
      upstream: UPSTREAM,
      model: MODEL
    });
  }

  const manifestMatch = u.pathname.match(/^\/([a-z]{2})\/manifest\.json$/);

  if (manifestMatch) {
    const langCode = manifestMatch[1];

    if (!LANGS[langCode]) {
      return json(404, { error: 'Unsupported target language' });
    }

    return json(200, manifest(langCode), {
      'cache-control': 'public, max-age=3600'
    });
  }

  const subtitleMatch = u.pathname.match(
    /^\/([a-z]{2})(\/subtitles\/(movie|series)\/.+\.json)$/
  );

  if (subtitleMatch) {
    const langCode = subtitleMatch[1];
    const lang = LANGS[langCode];

    if (!lang) return json(404, { subtitles: [] });

    try {
      const upstreamPath = subtitleMatch[2] + u.search;
      const upstream = await fetchUpstreamSubtitles(upstreamPath);

      const english = upstream
        .filter((subtitle) => subtitle?.url && isEnglish(subtitle?.lang))
        .slice(0, MAX_TRACKS);

      const subtitles = english.map((subtitle, index) => {
        const encoded = encodeUrl(subtitle.url);
        const signature = signUrl(subtitle.url, langCode);

        return {
          id: 'boom-gemini-' + stableId(
            String(subtitle.id || index) + '|' + subtitle.url + '|' + langCode
          ),
          url:
            origin +
            '/' +
            langCode +
            '/translate.vtt?u=' +
            encodeURIComponent(encoded) +
            '&sig=' +
            encodeURIComponent(signature),
          lang: lang.iso3
        };
      });

      return json(200, { subtitles }, {
        'cache-control': 'public, max-age=300'
      });
    } catch (error) {
      return json(502, {
        subtitles: [],
        error: String(error?.message || error)
      });
    }
  }

  const translateMatch = u.pathname.match(
    /^\/([a-z]{2})\/translate\.vtt$/
  );

  if (translateMatch) {
    const langCode = translateMatch[1];
    const lang = LANGS[langCode];

    if (!lang) return text(404, 'Unsupported target language');

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
      !safeEqual(signUrl(sourceUrl, langCode), signature)
    ) {
      return text(403, 'Invalid subtitle signature');
    }

    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return text(503, 'GEMINI_API_KEY is not configured');
    }

    const cacheKey = langCode + '|' + sourceUrl;

    if (cache.has(cacheKey)) {
      return text(
        200,
        cache.get(cacheKey),
        'text/vtt; charset=utf-8',
        { 'cache-control': 'public, max-age=604800' }
      );
    }

    try {
      const sourceResponse = await fetch(sourceUrl, {
        headers: {
          'user-agent': 'BoomSubs-Gemini/1.0'
        }
      });

      if (!sourceResponse.ok) {
        throw new Error('Subtitle download returned ' + sourceResponse.status);
      }

      const translatedVtt = await translateSubtitle(
        await sourceResponse.text(),
        lang.name,
        apiKey
      );

      cache.set(cacheKey, translatedVtt);

      if (cache.size > 80) {
        cache.delete(cache.keys().next().value);
      }

      return text(
        200,
        translatedVtt,
        'text/vtt; charset=utf-8',
        { 'cache-control': 'public, max-age=604800' }
      );
    } catch (error) {
      return text(
        502,
        'Subtitle translation failed: ' + String(error?.message || error)
      );
    }
  }

  return json(404, { error: 'Not found' });
}
