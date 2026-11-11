# OperaMeds

Aplicação web para organizar cirurgias, agenda e acompanhamento financeiro, com dados armazenados no MongoDB.

## Requisitos e execução local

- Node.js 20.6 ou superior
- MongoDB Atlas ou outra instância MongoDB

Copie `.env.example` para `.env` e informe `MONGODB_URI`. `MONGODB_DB` é opcional (padrão: `operamed`) e `PORT` define a porta HTTP (padrão: `3000`). Não compartilhe nem versione `.env`.

```sh
npm install
npm run start:local
```

Abra `http://localhost:3000`. O login usa nome de usuário e PIN numérico de quatro dígitos; PINs são armazenados com hash. Não há usuários de demonstração. O endpoint local `/api/access/bootstrap` só configura a primeira conta quando a coleção `users` está vazia.

## Deploy somente do front-end no Vercel

O build publica apenas `index.html`, `app.js`, `styles.css`, a configuração pública do endpoint e os dois arquivos de identidade visual em `dist/`. A API e o MongoDB permanecem no servidor externo. Importe este repositório no Vercel, mantenha a raiz na pasta principal e configure `OPERAMEDS_API_BASE_URL` como uma origem HTTPS, por exemplo `https://api.exemplo.com`. O build falha se essa variável estiver ausente ou inválida. Não configure `MONGODB_URI` no Vercel de front-end.

No servidor da API, configure `OPERAMEDS_ALLOWED_ORIGINS` com a origem exata do front-end Vercel (ou do domínio personalizado), separando várias origens por vírgulas. Use domínio próprio para o front e para a API no mesmo domínio registrável quando possível. Para origens realmente cross-site, `OPERAMEDS_COOKIE_SAMESITE=None` habilita cookies `Secure; SameSite=None`, mas alguns navegadores podem bloquear cookies de terceiros. A conexão `MONGODB_URI` e a permissão de rede do MongoDB continuam configuradas exclusivamente onde a API estiver hospedada.

## Deploy do backend no Render

Crie manualmente um **Web Service** ligado a este repositório e selecione o plano Free. Use `npm ci` como Build Command, `npm start` como Start Command e `/healthz` como Health Check Path. O script `start` inicia somente `server.js`; localmente, `npm run start:local` carrega as variáveis de `.env`.

Cadastre no ambiente do serviço `MONGODB_URI`, `OPERAMEDS_ALLOWED_ORIGINS` (a origem pública exata do front Vercel, sem caminho final, por exemplo `https://operameds.vercel.app`) e `OPERAMEDS_COOKIE_SAMESITE=None` para permitir cookies entre os dois domínios. `MONGODB_DB` usa `operamed` por padrão, e o Render fornece `PORT`. O script de build do Vercel é independente: `npm run build` gera apenas o front estático em `dist/`; o Start Command do Render não executa no Vercel.

Depois que o Render fornecer a URL HTTPS do serviço, atualize `OPERAMEDS_API_BASE_URL` nos ambientes Production e Preview do Vercel para essa origem e publique uma nova versão do front. Não coloque `MONGODB_URI` no Vercel. Com `OPERAMEDS_COOKIE_SAMESITE=None`, o servidor envia cookies de sessão entre Vercel e Render; navegadores podem restringir cookies de terceiros, então domínios próprios no mesmo domínio registrável são mais confiáveis.

## Funcionalidades

- **Painel Inicial:** resumo das cirurgias cadastradas e próximas datas.
- **Agenda Simplificada:** calendário mensal, filtros por médica, cidade e status, reservas de horário, prévia de compartilhamento e impressão/PDF.
- **Gestão Completa:** cartões de cirurgia, filtros por mês, médica, cidade, status e paciente; indicadores financeiros e acesso ao formulário de edição.
- **Configurações:** abas Médicas / Cirurgiões, Orçamentistas, Funcionários (contas de acesso), Status e Comissões. Cidades e procedimentos arquivados ficam em seções recolhíveis junto às médicas. As alterações administrativas são protegidas por permissões no servidor.
- **Cirurgias:** cadastro e edição compartilham o mesmo formulário. Hospital é informado em texto livre. Reservas aparecem na Agenda Simplificada e não entram na Gestão Completa nem nas comissões.
- **Comissões:** visualização mensal das cirurgias elegíveis, calculadas a 2% somente quando o status é realizado e há orçamentista vinculado.

Os dados usam o banco existente, nas coleções MongoDB de configurações, orçamentistas, usuários, sessões e cirurgias. Desativar cadastros não remove vínculos históricos.
