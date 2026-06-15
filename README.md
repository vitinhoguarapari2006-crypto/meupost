# MeuPost — versão single-file (GitHub Pages + Supabase)

Plataforma de agendamento e publicação automática em redes sociais, em **um único `index.html`** para o frontend + **Supabase** como backend serverless (auth, banco, storage, publicação e agendador). Tema escuro com roxo `#6D28D9`.

> Esta é a versão "leve" para subir no **GitHub Pages**. Existe também a versão completa self-hosted (React + Node/Express + Prisma + Docker) na raiz do projeto, nas pastas `backend/` e `frontend/` — use aquela se quiser rodar tudo num servidor seu.

---

## Por que não dá pra publicar no Instagram só com o `index.html`

GitHub Pages é **estático**. Sozinho ele não consegue:

1. **Guardar o App Secret da Meta** — qualquer um veria no código-fonte. A troca do `code` por token *tem* que ser server-side.
2. **Publicar no horário com a aba fechada** — não há processo rodando no servidor.
3. **Hospedar a mídia** — o Instagram exige uma **URL pública** do arquivo.

Por isso o `index.html` é só a **interface**, e o **Supabase** faz o trabalho server-side:

| Necessidade | Quem resolve no Supabase |
|---|---|
| Login real | **Auth** |
| Dados (contas, posts, logs) | **Postgres** + RLS |
| URL pública da mídia | **Storage** (bucket `media`) |
| Guardar secret + chamar a Graph API | **Edge Functions** (`publish`, `instagram-oauth`) |
| Disparar no horário (aba fechada) | **pg_cron** → função `scheduler` |

O app funciona em **dois modos**:

- **Demo (padrão):** sem configurar nada. Tudo fica no `localStorage`, a publicação é *simulada*. Ótimo pra ver a interface e organizar o calendário.
- **Cloud:** você cola a URL + anon key do Supabase nas Configurações → login real, mídia no Storage e publicação de verdade pelas Edge Functions.

---

## 1) Subir o frontend no GitHub Pages

```bash
# na pasta do projeto
git init
git add .
git commit -m "MeuPost"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/SEU_REPO.git
git push -u origin main
```

No GitHub: **Settings → Pages → Source: Deploy from a branch → Branch: `main` / root**.

A página fica em:
`https://SEU_USUARIO.github.io/SEU_REPO/meupost/`

> O app está em `meupost/index.html` para **não conflitar** com o `index.html` que já existe na raiz (sua landing do "Café da Manhã do Diabético"). Se quiser o MeuPost na raiz, mova `meupost/index.html` para a raiz **ou** use um repositório separado só pra ele.

Pronto — já dá pra usar em **modo demo**.

---

## 2) Ligar o modo Cloud (Supabase)

### a) Criar projeto e tabelas
1. Crie um projeto grátis em https://supabase.com.
2. Em **SQL Editor**, cole e rode o `supabase/schema.sql` (cria tabelas, RLS, bucket e o cron). Antes de rodar, troque `<PROJECT_REF>` e `<SERVICE_ROLE_KEY>` no bloco do `cron.schedule`.
3. Em **Authentication → Users**, crie seu usuário Admin (email/senha). Copie o **UUID** dele.

### b) Conectar o frontend
Em **Project Settings → API**, copie a **Project URL** e a **anon public key**. No app, vá em **Configurações → Supabase**, cole as duas e salve. O badge muda para **● Cloud**.

### c) Deploy das Edge Functions
Instale a [CLI do Supabase](https://supabase.com/docs/guides/cli) e rode:

```bash
supabase login
supabase link --project-ref <PROJECT_REF>

# segredos das funções (Settings → Edge Functions → Secrets, ou via CLI):
supabase secrets set META_APP_ID=xxxx META_APP_SECRET=xxxx \
  META_REDIRECT_URI=https://<PROJECT_REF>.functions.supabase.co/instagram-oauth \
  META_GRAPH_VERSION=v25.0 \
  APP_USER_ID=<uuid-do-admin> \
  FRONTEND_URL=https://SEU_USUARIO.github.io/SEU_REPO/meupost/

supabase functions deploy publish
supabase functions deploy scheduler
supabase functions deploy instagram-oauth --no-verify-jwt
```

> `SUPABASE_URL` e `SUPABASE_SERVICE_ROLE_KEY` já são injetados automaticamente nas Edge Functions — não precisa setar.

### d) Criar o App na Meta (começe cedo — App Review é o gargalo)
1. https://developers.facebook.com → App **Business**.
2. Produtos: **Facebook Login for Business** + **Instagram Graph API**.
3. **Valid OAuth Redirect URI** = `https://<PROJECT_REF>.functions.supabase.co/instagram-oauth`.
4. Scopes: `instagram_basic`, `instagram_content_publish`, `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management`.
5. A conta IG precisa ser **Business/Creator** e estar ligada a uma **Página do Facebook**.
6. **Enquanto o app estiver em desenvolvimento, só publica em contas de teste / com papel no app.** Para produção, passe pelo **App Review**.

No app, em **Configurações → Meta**, preencha o **App ID** e o **Redirect URI**. Depois, em **Contas → Conectar Instagram**, faça o login da Meta — a função `instagram-oauth` salva a conta automaticamente.

---

## 3) Como o agendamento funciona

- Você agenda um post (data/hora) → fica `SCHEDULED` no banco.
- O **pg_cron** chama a função `scheduler` **a cada minuto**.
- O `scheduler` pega os posts vencidos e chama `publish` para cada um.
- `publish` executa o fluxo da Graph API (container → polling p/ Reels/Carrossel → `media_publish`) e atualiza status + logs.
- Enquanto a aba do app estiver aberta, há também um empurrãozinho client-side a cada 30s (redundância — o cron é a fonte real da verdade).

---

## Limites a respeitar (já considerados no código)
- Instagram: **100 posts/24h** por conta (carrossel = 1) e **~200 chamadas/hora**. O `scheduler` processa em lotes de 20 e sequencial.
- Reels/Carrossel: a Meta recomenda consultar o status do container ~1x/min por no máx 5 min — o `waitContainerFinished` faz polling com timeout.
- As APIs mudam de versão (~2 anos de suporte cada). Hoje: **v25.0**.

---

## Estrutura

```
meupost/
├─ index.html                       # app completo (frontend)
├─ README.md                        # este arquivo
└─ supabase/
   ├─ schema.sql                    # tabelas + RLS + storage + pg_cron
   └─ functions/
      ├─ _shared/graph.ts           # helpers da Graph API
      ├─ publish/index.ts           # publica imagem/reels/carrossel/FB
      ├─ scheduler/index.ts         # chamado pelo cron, publica vencidos
      └─ instagram-oauth/index.ts   # callback OAuth da Meta
```

## Fases (roadmap)
1. ✅ App + auth/demo + dashboard + calendário + editor + contas + logs + config
2. ✅ OAuth Instagram (Edge Function) + publicação imagem
3. ✅ Storage + agendamento (pg_cron) + logs
4. ✅ Reels + Carrossel (polling de container)
5. ✅ Legendas IA (mock/OpenAI/n8n) + agendamento em massa
6. ⏳ Facebook (parcial: foto/feed pronto) + TikTok (Content Posting API + auditoria)
7. ⏳ n8n: webhooks de "publicou/falhou/token expirando" + workflows de exemplo
