import { handleRequest } from '../src/core.js';

export default async function handler(req, res) {
  try {
    const result = await handleRequest({ method: req.method, url: req.url, headers: req.headers });
    for (const [key, value] of Object.entries(result.headers || {})) res.setHeader(key, value);
    res.status(result.status).send(result.body);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
}
