const headers = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type'
};

const url = Deno.env.get('SUPABASE_URL');
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

async function query(table: string, params = '') {
  const response = await fetch(`${url}/rest/v1/${table}?${params}`, {
    headers: { apikey: serviceKey!, Authorization: `Bearer ${serviceKey}` }
  });
  if (!response.ok) throw new Error(`Supabase query failed: ${response.status}`);
  return response.json();
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers });
  if (!url || !serviceKey) return new Response(JSON.stringify({ error: 'Supabase environment is not configured' }), { status: 500, headers });
  try {
    const route = new URL(request.url).pathname.split('/').at(-1);
    if (route === 'blocks') return new Response(JSON.stringify(await query('network_blocks', 'select=*&order=height.desc&limit=50')), { headers });
    if (route === 'anchors') return new Response(JSON.stringify(await query('network_anchors', 'select=*&order=height.desc&limit=50')), { headers });
    if (route === 'accounts') return new Response(JSON.stringify(await query('network_accounts', 'select=*&order=updated_at.desc&limit=100')), { headers });
    const [blocks, anchors, validators] = await Promise.all([
      query('network_blocks', 'select=height,block_hash&order=height.desc&limit=1'),
      query('network_anchors', 'select=height,anchor_id&order=height.desc&limit=1'),
      query('network_validators', 'select=validator_id&active=eq.true')
    ]);
    return new Response(JSON.stringify({ chainId: 'iit-bdtc-testnet-1', height: blocks[0]?.height || 0, tipHash: blocks[0]?.block_hash || null, latestAnchor: anchors[0] || null, activeValidators: validators.length }), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
  }
});
