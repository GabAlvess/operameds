Warning: fs was declared with const; use let for reassignable variables.
# OperaMeds

Aplicação web para organizar cirurgias, agendas e cadastros de apoio no MongoDB.

## Requisitos e inicialização

- Node.js 20.6 ou superior
- Cluster MongoDB Atlas configurado no `.env`

O arquivo `.env` deve conter `MONGODB_URI`. O nome do banco é `operamed` por padrão; para usar outro, defina `MONGODB_DB`. A variável opcional `PORT` define a porta HTTP (padrão `3000`). Não compartilhe nem versione o `.env`.

```sh
npm install
npm start
```

Abra `http://localhost:3000`. A tela de login usa contas de acesso armazenadas separadamente dos funcionários internos. Para configurar a primeira conta autorizada, envie localmente `POST /api/access/bootstrap` com `username` e `pin` (exatamente 4 dígitos); essa rota só aceita conexões deste computador e só funciona enquanto a coleção `users` estiver vazia. Depois, usuários autenticados podem cadastrar novas contas por `POST /api/users`. Não há usuários de demonstração. A rota `GET /api/health` informa se o banco está conectado.

## Configurações e cirurgias

**Configurações** contém somente as abas Médicas / Cirurgiões, Status das Cirurgias, Cidades e Funcionários. Médicas, status e cidades podem ser adicionados, editados e ativados ou desativados; os nomes são únicos por categoria, sem distinção entre maiúsculas e minúsculas. Status também possuem cor. Funcionários são cadastros internos e não são contas de acesso. Contas autorizadas ficam na coleção separada `users`; seus PINs são armazenados com hash.

Em **Gestão Completa** ou **Agenda Simplificada**, use **+ Nova Cirurgia** para abrir o mesmo formulário. Informe data, horário, paciente, procedimento, hospital, médica, cidade opcional, funcionário responsável e status. Um horário pode ser reservado sem paciente, funcionário ou status operacional. A agenda permite filtrar por mês, médica, hospital, status e paciente; clicar em um registro abre o formulário existente para edição. A prévia de compartilhamento omite nome do paciente, anestesista e dados administrativos e pode ser impressa ou salva como PDF pelo navegador.

Os dados ficam no mesmo banco MongoDB, nas coleções `settings_options`, `employees`, `users`, `sessions` e `surgeries`. Não são inseridos cadastros de exemplo automaticamente. Hospitais são informados diretamente no formulário; não há aba de hospitais. Desativar itens não remove nem altera os registros de cirurgia existentes.
