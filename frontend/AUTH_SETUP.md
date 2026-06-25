# ZEUS Command — Setup de autenticação (login MAZARI + indicação + aprovação)

O painel agora exige **login** (Supabase Auth). Cada conta nasce **pendente** e **só o admin aprova**.
Cadastro é por **link de indicação** (só o admin gera). **Membro aprovado = só vê**; **armar o bot = só admin**.

> Em DEV/local sem as envs do Supabase, o painel abre direto em modo demo (sem login) — o login só é
> exigido quando o Supabase está configurado (produção).

## 1. Rodar o schema atualizado
No Supabase → SQL Editor, rode `frontend/supabase/schema.sql` (idempotente). Ele cria `profiles` + `invites`,
a função `is_admin()`, as policies RLS, e **aperta a leitura** de `events`/`service_status` para
`authenticated` (o painel agora loga). `engine_control` segue legível por anon (o BOT lê com a anon key).

Se você tem a tabela `wallet_snapshots`, aperte a leitura dela também (snippet comentado no fim do schema).

## 2. Criar a conta-raiz (admin) — one-time
1. Supabase → **Authentication → Users → Add user**: `humbertodeassuncao@gmail.com` + senha. Marque
   **"Auto Confirm User"** (sem e-mail de verificação).
2. Copie o **UID** do usuário criado e rode no SQL Editor:
   ```sql
   insert into public.profiles (id, email, role, status, approved_at)
     values ('<ADMIN_UID>', 'humbertodeassuncao@gmail.com', 'admin', 'approved', now())
     on conflict (id) do update set role='admin', status='approved';
   ```

## 3. Config do Supabase Auth
- **Email confirmations: OFF** (as contas são criadas já confirmadas via `admin.createUser` + a aprovação do
  admin é o portão). Não precisa de SMTP.
- O **service role key** (`SUPABASE_SERVICE_ROLE_KEY`, já na Vercel) é o que cria usuários e valida convites
  server-side. Nunca exposto ao browser.

## 4. Envs (Vercel)
Nenhuma env NOVA obrigatória — usa as 4 do Supabase que já existem:
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ZEUS_WEBHOOK_SECRET`.
`ZEUS_CONTROL_SECRET` agora é **opcional** (override de máquina pra curl/automação no header `x-zeus-control`).

## 5. Fluxo de uso
1. **Login** (`/`): admin entra com e-mail/senha → vê o painel + nav **Admin** + o toggle de execução.
2. **Gerar indicação**: tela **Admin** → "Gerar link de indicação" → copia a URL `/signup?invite=<token>` (validade 7d).
3. **Novo membro**: abre o link → cria e-mail/senha → conta entra **pendente** ("aguardando aprovação").
4. **Aprovar**: tela **Admin** → "Aprovações pendentes" → Aprovar/Rejeitar.
5. **Membro aprovado**: loga e vê dashboards/PnL/inteligência — **mas NÃO o toggle de execução** (admin-only,
   reforçado no servidor por `requireAdmin` em `/api/control`).

## 6. Marca
A tela de login/cadastro mostra a logo de `frontend/public/brand/mazari-logo.svg` (hoje um **placeholder**) +
o rodapé **"Tecnologia exclusiva do Grupo MAZARI CORP"**. Para a logo final, substitua o arquivo no mesmo caminho.
