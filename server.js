import http from 'node:http';
import { handleRequest } from './src/core.js';

const port = Number(process.env.PORT || 7001);

http.createServer(async (req, res) => {
  try {
    const result = await handleRequest({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(result.status, result.headers);
    res.end(result.body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
}).listen(port, '0.0.0.0', () => {
  console.log('BoomSubs Gemini listening on http://0.0.0.0:' + port);
});
