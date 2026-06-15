// =============================================================================
// Helpers compartilhados para falar com a Graph API da Meta (Instagram/Facebook).
// Importado pelas Edge Functions publish, scheduler e instagram-oauth.
// =============================================================================

export const GRAPH_VERSION = Deno.env.get("META_GRAPH_VERSION") || "v25.0";
export const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

// Faz uma chamada à Graph API e já trata erro com mensagem amigável.
export async function graphFetch(
  path: string,
  params: Record<string, string>,
  method: "GET" | "POST" = "GET",
): Promise<any> {
  const url = new URL(`${GRAPH}/${path}`);
  let body: URLSearchParams | undefined;

  if (method === "GET") {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  } else {
    body = new URLSearchParams(params);
  }

  const res = await fetch(url.toString(), { method, body });
  const data = await res.json();
  if (!res.ok || data.error) {
    const msg = data?.error?.message || `Graph API HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Aguarda um container de mídia (Reels/Carrossel) ficar FINISHED.
// A Meta recomenda consultar ~1x/min por no máx 5 min. Usamos backoff curto.
export async function waitContainerFinished(
  igUserId: string,
  containerId: string,
  accessToken: string,
  { maxMs = 5 * 60 * 1000, intervalMs = 5000 } = {},
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < maxMs) {
    const data = await graphFetch(containerId, {
      fields: "status_code,status",
      access_token: accessToken,
    });
    if (data.status_code === "FINISHED") return;
    if (data.status_code === "ERROR" || data.status_code === "EXPIRED") {
      throw new Error(`Container ${data.status_code}: ${data.status || ""}`);
    }
    // IN_PROGRESS / PUBLISHED -> espera e tenta de novo.
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timeout esperando o container ficar FINISHED (5 min).");
}

// Resposta JSON padronizada das Edge Functions (com CORS liberado).
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    },
  });
}

// Trata o preflight OPTIONS do CORS.
export function handleCors(req: Request): Response | null {
  if (req.method === "OPTIONS") return json({}, 204);
  return null;
}
