// =============================================================================
// Edge Function: instagram-oauth
// Callback do "Facebook Login for Business". O frontend manda o usuário para o
// dialog de OAuth da Meta com redirect_uri = esta função. Aqui trocamos o
// `code` por tokens (server-side, onde o App Secret fica seguro), descobrimos
// a conta Instagram Business e salvamos tudo em social_accounts.
//
// Variáveis de ambiente (Project Settings → Edge Functions → Secrets):
//   META_APP_ID, META_APP_SECRET, META_REDIRECT_URI, META_GRAPH_VERSION
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   APP_USER_ID  (uuid do seu usuário Admin no Supabase Auth — dono das contas)
//   FRONTEND_URL (para redirecionar de volta após conectar)
//
// Deploy:  supabase functions deploy instagram-oauth --no-verify-jwt
// (sem verify-jwt porque a Meta chama via GET sem o header do Supabase)
// =============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { graphFetch } from "../_shared/graph.ts";

const APP_ID = Deno.env.get("META_APP_ID")!;
const APP_SECRET = Deno.env.get("META_APP_SECRET")!;
const REDIRECT_URI = Deno.env.get("META_REDIRECT_URI")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_USER_ID = Deno.env.get("APP_USER_ID")!;
const FRONTEND_URL = Deno.env.get("FRONTEND_URL") || "/";

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error_description");

  if (error) return redirect(`${FRONTEND_URL}?ig=error&msg=${encodeURIComponent(error)}`);
  if (!code) return new Response("Faltou o parâmetro 'code'.", { status: 400 });

  try {
    // 1) code -> token short-lived (~1h)
    const short = await graphFetch("oauth/access_token", {
      client_id: APP_ID,
      client_secret: APP_SECRET,
      redirect_uri: REDIRECT_URI,
      code,
    });

    // 2) short-lived -> long-lived (~60 dias)
    const long = await graphFetch("oauth/access_token", {
      grant_type: "fb_exchange_token",
      client_id: APP_ID,
      client_secret: APP_SECRET,
      fb_exchange_token: short.access_token,
    });
    const userToken: string = long.access_token;

    // 3) descobre as Páginas do usuário (e o Page Access Token de cada uma)
    const pages = await graphFetch("me/accounts", {
      fields: "id,name,access_token,instagram_business_account{id,username}",
      access_token: userToken,
    });

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);
    let connected = 0;

    // 4) para cada Página com IG Business vinculado, salva a conta.
    for (const page of pages.data || []) {
      const ig = page.instagram_business_account;
      if (!ig) continue;

      await admin.from("social_accounts").upsert({
        user_id: APP_USER_ID,
        platform: "INSTAGRAM",
        account_name: ig.username ? `@${ig.username}` : page.name,
        external_id: ig.id,
        ig_business_id: ig.id,
        page_id: page.id,
        access_token: page.access_token, // Page token (usado para publicar)
        token_expires_at: new Date(Date.now() + 55 * 24 * 3600 * 1000).toISOString(),
        status: "ACTIVE",
        updated_at: new Date().toISOString(),
      }, { onConflict: "external_id,platform" });
      connected++;
    }

    return redirect(`${FRONTEND_URL}?ig=ok&contas=${connected}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return redirect(`${FRONTEND_URL}?ig=error&msg=${encodeURIComponent(msg)}`);
  }
});

function redirect(to: string): Response {
  return new Response(null, { status: 302, headers: { Location: to } });
}
