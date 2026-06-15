# =============================================================================
# MeuPost — setup automatizado do backend Supabase (Windows / PowerShell)
#
# O que ESTE script faz por você (a parte automatizável):
#   - instala o CLI do Supabase (via npm) se faltar
#   - faz login (abre seu navegador uma vez)
#   - linka o projeto que você criou
#   - aplica o schema (tabelas + RLS + storage + pg_cron) via migration
#   - configura os secrets das Edge Functions
#   - faz deploy das 3 Edge Functions (publish, scheduler, instagram-oauth)
#   - injeta o agendador (pg_cron) apontando pra sua função scheduler
#
# O que VOCÊ faz (só isto, porque exige o seu login — eu não tenho como):
#   1) Criar um projeto grátis em https://supabase.com  (3 cliques)
#   2) Criar um App "Business" em https://developers.facebook.com  (login Facebook)
#   3) Submeter o App Review da Meta (revisão da Meta, leva dias)
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File .\setup-supabase.ps1
# =============================================================================

$ErrorActionPreference = "Stop"
function Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Magenta }
function Ask($t)     { Read-Host ">> $t" }

Section "1/7  CLI do Supabase"
if (-not (Get-Command supabase -ErrorAction SilentlyContinue)) {
  Write-Host "Supabase CLI nao encontrado. Instalando via npm..." -ForegroundColor Yellow
  npm install -g supabase
}
supabase --version

Section "2/7  Login (vai abrir o navegador)"
supabase login

Section "3/7  Dados do projeto"
Write-Host "Crie o projeto em https://supabase.com (se ainda nao criou)." -ForegroundColor Yellow
Write-Host "Pegue o Project Ref em: Project Settings -> General -> Reference ID" -ForegroundColor Yellow
$ref       = Ask "Project Ref (ex: abcd1234efgh5678)"
$adminUuid = Ask "UUID do seu usuario Admin (Authentication -> Users -> seu user)"
$frontUrl  = Ask "URL do app no GitHub Pages (ex: https://SEU_USUARIO.github.io/meupost/)"

Section "4/7  Dados do App da Meta"
Write-Host "Em https://developers.facebook.com -> seu App -> Configuracoes -> Basico" -ForegroundColor Yellow
$metaAppId     = Ask "Meta App ID"
$metaAppSecret = Ask "Meta App Secret"
$redirectUri   = "https://$ref.functions.supabase.co/instagram-oauth"
Write-Host "IMPORTANTE: cadastre este Redirect URI no Facebook Login do seu App:" -ForegroundColor Cyan
Write-Host "  $redirectUri" -ForegroundColor Cyan

Section "5/7  Linkando o projeto e aplicando o schema"
supabase link --project-ref $ref
# Coloca o schema como migration para o `db push` aplicar.
New-Item -ItemType Directory -Force -Path "supabase/migrations" | Out-Null
Copy-Item "supabase/schema.sql" "supabase/migrations/0001_meupost_init.sql" -Force
supabase db push

Section "6/7  Secrets + deploy das Edge Functions"
supabase secrets set `
  META_APP_ID=$metaAppId `
  META_APP_SECRET=$metaAppSecret `
  META_REDIRECT_URI=$redirectUri `
  META_GRAPH_VERSION=v25.0 `
  APP_USER_ID=$adminUuid `
  FRONTEND_URL=$frontUrl

supabase functions deploy publish
supabase functions deploy scheduler
supabase functions deploy instagram-oauth --no-verify-jwt

Section "7/7  Agendador (pg_cron -> scheduler)"
Write-Host "Service Role Key: Project Settings -> API -> service_role (secret)" -ForegroundColor Yellow
$serviceKey = Ask "Service Role Key (NAO compartilhe com ninguem)"
$cronSql = @"
select cron.unschedule('meupost-scheduler') where exists (select 1 from cron.job where jobname='meupost-scheduler');
select cron.schedule('meupost-scheduler', '* * * * *', \$\$
  select net.http_post(
    url := 'https://$ref.functions.supabase.co/scheduler',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer $serviceKey'),
    body := '{}'::jsonb
  );
\$\$);
"@
$cronSql | Out-File -Encoding utf8 "supabase/_cron.generated.sql"
Write-Host "`nGerado supabase/_cron.generated.sql." -ForegroundColor Green
Write-Host "Cole o conteudo dele no SQL Editor do Supabase e rode (uma vez)." -ForegroundColor Green

Section "PRONTO (parte automatizada)"
Write-Host "Agora no app (Configuracoes): cole a Project URL + anon key, App ID e o Redirect URI." -ForegroundColor Green
Write-Host "Conecte o Instagram em Contas. Lembre: publicar em contas reais exige Meta App Review." -ForegroundColor Yellow
