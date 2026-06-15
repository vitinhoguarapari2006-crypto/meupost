// =============================================================================
// Edge Function: scheduler
// Chamada pelo pg_cron a cada minuto (ver schema.sql). Busca posts SCHEDULED
// cujo horário já chegou e dispara a publicação de cada um.
//
// Como roda no servidor, publica mesmo com nenhum navegador aberto — é o
// "motor de agendamento" real do MeuPost.
//
// Deploy:  supabase functions deploy scheduler
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { json, handleCors } from "../_shared/graph.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const pre = handleCors(req);
  if (pre) return pre;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
  const now = new Date().toISOString();

  // Busca os posts vencidos (limita o lote para respeitar rate limits).
  const { data: due, error } = await admin
    .from("posts")
    .select("id")
    .eq("status", "SCHEDULED")
    .lte("scheduled_at", now)
    .limit(20);

  if (error) return json({ error: error.message }, 500);
  if (!due?.length) return json({ ok: true, published: 0 });

  // Dispara a função publish para cada post. Sequencial para não estourar
  // o limite da Graph API (~200 chamadas/hora por conta).
  let count = 0;
  for (const p of due) {
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/publish`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SERVICE_ROLE}`,
        },
        body: JSON.stringify({ postId: p.id }),
      });
      if (res.ok) count++;
    } catch (_) {
      // O publish já marca FAILED e loga; aqui só seguimos para o próximo.
    }
  }

  return json({ ok: true, processed: due.length, published: count });
});
