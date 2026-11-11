# OperaMeds

Aplicação web para organizar cirurgias, agenda e acompanhamento financeiro, com dados armazenados no MongoDB.

## Requisitos e execução local

- Node.js 20.6 ou superior
- MongoDB Atlas ou outra instância MongoDB

Copie `.env.example` para `.env` e informe `MONGODB_URI`. `MONGODB_DB` é opcional (padrão: `operamed`) e `PORT` define a porta HTTP (padrão: `3000`). Não compartilhe nem versione `.env`.

```sh
npm install
npm start
```

Abra `http://localhost:3000`. O login usa nome de usuário e PIN numérico de quatro dígitos; PINs são armazenados com hash. Não há usuários de demonstração. O endpoint local `/api/access/bootstrap` só configura a primeira conta quando a coleção `users` está vazia.

## Deploy no Vercel

O repositório está configurado para servir os arquivos estáticos e executar a API como uma Vercel Function Node.js. Importe o repositório no Vercel com a raiz do projeto na pasta principal; não é necessário comando de build. Configure `MONGODB_URI` como variável secreta nos ambientes Preview e Production. `MONGODB_DB` é opcional e, se omitido, usa `operamed`. Não cadastre `PORT` no Vercel.

A implantação deve apontar para o MongoDB que contém os usuários e dados existentes. O banco também precisa aceitar conexões originadas da infraestrutura Vercel conforme a política de acesso de rede do Atlas. O endpoint de configuração inicial de usuário é restrito a conexões locais e não deve ser usado no deploy.

## Funcionalidades

- **Painel Inicial:** resumo das cirurgias cadastradas e próximas datas.
- **Agenda Simplificada:** calendário mensal, filtros por médica, cidade e status, reservas de horário, prévia de compartilhamento e impressão/PDF.
- **Gestão Completa:** cartões de cirurgia, filtros por mês, médica, cidade, status e paciente; indicadores financeiros e acesso ao formulário de edição.
- **Configurações:** abas Médicas / Cirurgiões, Orçamentistas, Funcionários (contas de acesso), Status e Comissões. Cidades e procedimentos arquivados ficam em seções recolhíveis junto às médicas. As alterações administrativas são protegidas por permissões no servidor.
- **Cirurgias:** cadastro e edição compartilham o mesmo formulário. Hospital é informado em texto livre. Reservas aparecem na Agenda Simplificada e não entram na Gestão Completa nem nas comissões.
- **Comissões:** visualização mensal das cirurgias elegíveis, calculadas a 2% somente quando o status é realizado e há orçamentista vinculado.

Os dados usam o banco existente, nas coleções MongoDB de configurações, orçamentistas, usuários, sessões e cirurgias. Desativar cadastros não remove vínculos históricos.
