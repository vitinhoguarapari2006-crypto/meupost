// =============================================================================
// Edge Function: publish
// Publica UM post na plataforma certa (Instagram imagem/reels/carrossel ou
// Facebook feed). Chamada pelo frontend (publicar agora) e pelo scheduler.
//
// Recebe: { post, account }  — onde account.access_token está descriptografado
// no banco (a função usa service role para ler o token, nunca o frontend).
//
// Deploy:  supabase functions deploy publish --no-verify-jwt=false
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { graphFetch, waitContainerFinished, json, handleCors } from "../_shared/graph.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  const pre = handleCors(req);
  if (pre) return pre;

  // Cliente com service role (lê tokens, escreve logs/status sem RLS).
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Lê o corpo UMA vez (não dá para reler um Request body).
  const input = await req.json().catch(() => ({}));
  const postId: string | undefined = input.postId || input.post?.id;

  try {
    let { post, account } = input;

    // Permite chamar tanto com o post inteiro quanto só com postId (scheduler).
    if (input.postId && !post) {
      const { data } = await admin.from("posts").select("*").eq("id", postId).single();
      post = data;
    }
    if (!post) return json({ error: "post ausente" }, 400);

    if (!account && post.social_account_id) {
      const { data } = await admin.from("social_accounts").select("*").eq("id", post.social_account_id).single();
      account = data;
    }
    if (!account) return json({ error: "conta social ausente" }, 400);

    await log(admin, post.id, "INFO", "Publicação iniciada.");
    await admin.from("posts").update({ status: "PROCESSING" }).eq("id", post.id);

    const result = await publish(post, account);

    await admin.from("posts").update({
      status: "PUBLISHED",
      published_at: new Date().toISOString(),
      external_post_id: result.id,
      error_message: null,
    }).eq("id", post.id);
    await log(admin, post.id, "INFO", `Publicado. ID externo: ${result.id}`);

    return json({ ok: true, id: result.id });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Marca como FAILED se temos o id do post.
    if (postId) {
      await admin.from("posts").update({ status: "FAILED", error_message: message }).eq("id", postId);
      await log(admin, postId, "ERROR", `Falha: ${message}`);
    }
    return json({ error: message }, 500);
  }
});

// Grava um log no banco (espelha o PostLog do app).
async function log(admin: any, postId: string, level: string, message: string, payload?: unknown) {
  await admin.from("post_logs").insert({ post_id: postId, level, message, payload: payload ?? null });
}

// Decide o fluxo conforme o tipo do post.
async function publish(post: any, account: any): Promise<{ id: string }> {
  const token = account.access_token;
  if (!token) throw new Error("Conta sem access_token. Reconecte a conta.");

  switch (post.type) {
    case "IMAGE":    return publishImage(account.ig_business_id, post, token);
    case "REELS":    return publishReels(account.ig_business_id, post, token);
    case "CAROUSEL": return publishCarousel(account.ig_business_id, post, token);
    case "FB_FEED":  return publishFacebook(account.page_id, post, token);
    case "TIKTOK_VIDEO": throw new Error("TikTok entra na Fase 6 (Content Posting API + auditoria).");
    default: throw new Error(`Tipo não suportado: ${post.type}`);
  }
}

// ---- Instagram: imagem única ------------------------------------------------
async function publishImage(igId: string, post: any, token: string) {
  const container = await graphFetch(`${igId}/media`, {
    image_url: post.media_urls[0],
    caption: post.caption || "",
    access_token: token,
  }, "POST");
  return mediaPublish(igId, container.id, token);
}

// ---- Instagram: Reels (vídeo) -----------------------------------------------
async function publishReels(igId: string, post: any, token: string) {
  const container = await graphFetch(`${igId}/media`, {
    media_type: "REELS",
    video_url: post.media_urls[0],
    caption: post.caption || "",
    access_token: token,
  }, "POST");
  // Reels precisa de processamento — espera ficar FINISHED.
  await waitContainerFinished(igId, container.id, token);
  return mediaPublish(igId, container.id, token);
}

// ---- Instagram: Carrossel (até 10 itens) ------------------------------------
async function publishCarousel(igId: string, post: any, token: string) {
  const urls: string[] = (post.media_urls || []).slice(0, 10);
  if (urls.length < 2) throw new Error("Carrossel precisa de 2 a 10 mídias.");

  // 1) cria containers filhos (is_carousel_item=true)
  const childIds: string[] = [];
  for (const url of urls) {
    const isVideo = /\.mp4|\.mov|video/i.test(url);
    const child = await graphFetch(`${igId}/media`, {
      ...(isVideo ? { media_type: "VIDEO", video_url: url } : { image_url: url }),
      is_carousel_item: "true",
      access_token: token,
    }, "POST");
    childIds.push(child.id);
  }
  // 2) espera todos ficarem prontos (vídeos demoram)
  for (const id of childIds) await waitContainerFinished(igId, id, token);

  // 3) cria o container pai
  const parent = await graphFetch(`${igId}/media`, {
    media_type: "CAROUSEL",
    children: childIds.join(","),
    caption: post.caption || "",
    access_token: token,
  }, "POST");
  await waitContainerFinished(igId, parent.id, token);

  // 4) publica
  return mediaPublish(igId, parent.id, token);
}

// ---- Passo final comum: media_publish ---------------------------------------
async function mediaPublish(igId: string, creationId: string, token: string) {
  const res = await graphFetch(`${igId}/media_publish`, {
    creation_id: creationId,
    access_token: token,
  }, "POST");
  return { id: res.id };
}

// ---- Facebook: feed (publica imediatamente; agendamento via scheduled_publish_time) ----
async function publishFacebook(pageId: string, post: any, token: string) {
  const res = await graphFetch(`${pageId}/photos`, {
    url: post.media_urls[0],
    caption: post.caption || "",
    access_token: token,
  }, "POST");
  return { id: res.post_id || res.id };
}
