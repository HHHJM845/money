import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function localApi(): Plugin {
  return {
    name: 'local-finance-api',
    configureServer(server) {
      server.middlewares.use('/api', async (req, res) => {
        try {
          const { handle } = await server.ssrLoadModule('/server/http.ts');
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 16384) { res.statusCode = 413; res.end(); return; }
            chunks.push(Buffer.from(chunk));
          }
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(key, value);
          const response: Response = await handle(new Request(`http://${req.headers.host}/api${req.url}`, {
            method: req.method, headers,
            ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
          }), { sourceIp: req.socket.remoteAddress });
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(await response.text());
        } catch { res.statusCode = 503; res.end(JSON.stringify({ success: false, errorMessage: '本地接口载入失败' })); }
      });
    },
  };
}
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  for (const name of ['DATABASE_URL', 'OWNER_USERNAME', 'OWNER_PASSWORD_HASH', 'SESSION_SECRET']) {
    if (!process.env[name] && env[name]) process.env[name] = env[name];
  }
  return { plugins: [react(), localApi()], server: { host: '127.0.0.1' } };
});
