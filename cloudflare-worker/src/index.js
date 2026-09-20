const corsHeaders = {
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders,
  },
});

function constantTimeEqual(left, right) {
  const a = new TextEncoder().encode(left || '');
  const b = new TextEncoder().encode(right || '');
  let difference = a.length ^ b.length;

  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    difference |= (a[index] || 0) ^ (b[index] || 0);
  }

  return difference === 0;
}

function adminAuthorized(request, env) {
  const key = typeof env.ROOMCAST_ACCESS_KEY === 'string'
    ? env.ROOMCAST_ACCESS_KEY
    : '';

  return key.length >= 16
    && constantTimeEqual(
      request.headers.get('Authorization') || '',
      `Bearer ${key}`,
    );
}

async function turn(request, env) {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  if (!adminAuthorized(request, env)) {
    return json({ error: 'Unauthorized' }, 401);
  }

  if (!env.CF_TURN_KEY_ID || !env.CF_TURN_API_TOKEN) {
    return json({ error: 'Worker secrets are incomplete' }, 500);
  }

  let ttl = 3600;

  try {
    ttl = Math.min(
      7200,
      Math.max(
        900,
        Number((await request.json()).ttl) || 3600,
      ),
    );
  } catch { }

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl }),
    },
  );

  if (!response.ok) {
    return json(
      {
        error: 'Cloudflare TURN credential request failed',
        status: response.status,
      },
      502,
    );
  }

  const data = await response.json();

  return json({
    iceServers: data.iceServers || data,
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    const url = new URL(request.url);

    if (url.pathname === '/') {
      return turn(request, env);
    }

    return json({ error: 'Not found' }, 404);
  },
};
