// Issues short-lived upload tokens so the browser can send songs straight to Blob storage
// (songs are larger than a function request body may be).
import { handleUpload } from '@vercel/blob/client';
import { authed, json, unauthorized, FILE_PATH } from './_lib.js';

export async function POST(req) {
  if (!authed(req)) return unauthorized();
  const body = await req.json().catch(() => null);
  if (!body) return json({ error: 'bad request' }, 400);
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!FILE_PATH.test(pathname)) throw new Error('bad path');
        const art = pathname.startsWith('art/');
        return {
          allowedContentTypes: art ? ['image/*'] : ['audio/*', 'video/mp4', 'application/octet-stream'],
          maximumSizeInBytes: (art ? 10 : 300) * 1024 * 1024,
          addRandomSuffix: false,
          allowOverwrite: false,
        };
      },
    });
    return json(result);
  } catch (e) {
    return json({ error: e.message || 'upload refused' }, 400);
  }
}
