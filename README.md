# DecisionOS

Plataforma web de apoio à decisão para empresas. Importas os teus dados (Excel, CSV ou uma base PostgreSQL), o sistema analisa-os e transforma-os em **decisões concretas**: o que está a correr mal, porquê, o que fazer e qual o impacto esperado.

## Funcionalidades

- **Importação de dados** — Excel/CSV (com assistente de mapeamento de colunas) e conector PostgreSQL. Deteta automaticamente onde a tabela começa, o tipo e o significado de cada coluna.
- **Qualidade de dados** — score de 0 a 100, com problemas classificados por gravidade (datas inválidas, receita em falta, clientes sem ID, moedas misturadas, duplicados).
- **Analítica** — receita, margem, lucro, produtos, clientes, regiões, canais, crescimento, previsão e deteção de anomalias.
- **Motor de decisões** — deteta problemas (queda de receita, degradação de margem, risco de clientes, fuga de custos, oportunidades de preço…), cada um com evidência e nível de confiança.
- **Simulador** — testa o impacto de uma decisão antes de a tomar.
- **Registo de decisões** — ciclo completo: criação, responsável, aprovação e medição do resultado real.
- **Carteira de ações** — importação de posições, concentração, risco com histórico de preços e simulação de venda.
- **Assistente com IA** — responde a perguntas sobre os teus dados usando ferramentas executadas no servidor. O modelo só vê números calculados pelo backend, nunca dados enviados pelo cliente.
- **Multi-utilizador** — organizações isoladas entre si, com papéis: `viewer < manager < finance < admin < owner`.
- **Interface** em vários idiomas, com tema claro/escuro.

## Stack

| Camada | Tecnologia |
| --- | --- |
| Frontend | React 18, Vite, Tailwind CSS, Recharts |
| Backend | Node.js (≥ 18), Express |
| Base de dados | PostgreSQL |
| IA | Qualquer API compatível com OpenAI (por defeito Groq) |
| Testes | Vitest, Supertest, Playwright (E2E) |

## Estrutura

```
DecisionOS/
├── backend/     API Express, motor de análise, decisões, simulação, worker
│   ├── src/
│   │   ├── routes/            endpoints da API
│   │   ├── services/          analítica, decisões, simulação, importação…
│   │   ├── data-understanding/ deteção de estrutura e significado das colunas
│   │   ├── auth/              JWT, papéis, sessões
│   │   └── db/                schema SQL, migrações, seed de demonstração
│   └── test/
└── frontend/    aplicação React
    ├── src/
    └── e2e/     testes end-to-end (Playwright)
```

Documentação técnica mais detalhada do backend em [`backend/README.md`](backend/README.md).

## Requisitos

- Node.js 18 ou superior
- PostgreSQL 14 ou superior (local ou alojado)
- Uma chave de API de um fornecedor de LLM (opcional, só é necessária para o assistente de IA). O [Groq](https://console.groq.com/keys) tem plano gratuito.

## Como correr localmente

### 1. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Edita o `.env` e preenche pelo menos:

| Variável | Descrição |
| --- | --- |
| `DATABASE_URL` | Ligação ao PostgreSQL, por ex. `postgres://user:pass@localhost:5432/decisionos` |
| `JWT_SECRET` | Texto aleatório longo (mín. 16 caracteres) |
| `CONFIG_ENCRYPTION_KEY` | Chave de 32 bytes em hexadecimal (64 caracteres) |
| `LLM_API_KEY` | Chave do fornecedor de IA (opcional) |

Para gerar uma chave segura:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Depois cria as tabelas e arranca:

```bash
npm run migrate
npm run seed:demo   # opcional: cria uma organização de demonstração
npm run dev
```

A API fica em `http://localhost:8787`. Verifica com `http://localhost:8787/health`.

A organização de demonstração usa `demo@decisionos.app` / `demo12345` (ou os valores de `SEED_DEMO_EMAIL` e `SEED_DEMO_PASSWORD`). **Não uses estas credenciais em produção.**

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

A aplicação fica em `http://localhost:5173`. Por defeito liga-se ao backend em `http://localhost:8787`; para outro endereço define `VITE_DECISIONOS_API_BASE` antes do build.

> **Nota:** a biblioteca `xlsx` é instalada a partir do CDN oficial da SheetJS (a versão do npm está desatualizada e tem vulnerabilidades conhecidas). O `npm install` precisa de acesso a `cdn.sheetjs.com`.

## Configuração do backend

Todas as variáveis estão em `backend/.env`. As principais opcionais:

| Variável | Por defeito | Descrição |
| --- | --- | --- |
| `PORT` | `8787` | Porta da API |
| `ALLOWED_ORIGINS` | `http://localhost:5173,http://localhost:3000` | Origens autorizadas (CORS), separadas por vírgula |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` | Endpoint do fornecedor de IA |
| `LLM_MODEL` | `openai/gpt-oss-120b` | Modelo a usar |
| `JWT_EXPIRES_IN` | `7d` | Validade das sessões |
| `API_RATE_LIMIT_PER_MIN` | `300` | Limite geral de pedidos por IP |
| `AI_RATE_LIMIT_PER_MIN` | `10` | Limite de pedidos de IA por utilizador |
| `WORKER_ENABLED` | `true` | Processa importações em segundo plano |
| `PG_CONNECTOR_ALLOW_PRIVATE_HOSTS` | `false` | Só para desenvolvimento: permite ligar a bases em IPs privados |

## Testes

```bash
# Backend (não precisa de PostgreSQL: usa uma base em memória)
cd backend
npm test

# Frontend
cd frontend
npm test

# End-to-end (precisa do backend, PostgreSQL e frontend a correr)
cd frontend
npx playwright install --with-deps chromium
npm run test:e2e
```

Mais detalhes sobre os testes E2E em [`frontend/e2e/README.md`](frontend/e2e/README.md).

## Deploy

1. **Backend** — num serviço Node (Render, Railway, Fly.io…) com PostgreSQL. Define as variáveis do `.env`, com `ALLOWED_ORIGINS` igual ao URL do frontend. O servidor executa as migrações ao arrancar.
2. **Frontend** — `npm run build` gera a pasta `dist/`, que podes servir em qualquer alojamento estático (Vercel, Netlify…). Define `VITE_DECISIONOS_API_BASE` com o URL do backend antes do build.

Recomendações para produção:
- Usa um `JWT_SECRET` e uma `CONFIG_ENCRYPTION_KEY` únicos e guarda-os em segurança. Se perderes a `CONFIG_ENCRYPTION_KEY`, as ligações a bases de dados guardadas deixam de poder ser lidas.
- Serve tudo por HTTPS.
- Nunca atives `PG_CONNECTOR_ALLOW_PRIVATE_HOSTS`.
- O estado de sessões e de uploads em curso vive na memória do processo, por isso corre **uma única instância** do backend (ou move esse estado para Redis antes de escalar).

## Segurança

- Todas as rotas (exceto registo e login) exigem um token JWT; a organização vem sempre do token, nunca do pedido.
- Credenciais de conectores são cifradas com AES-256-GCM.
- Proteção contra SSRF nos conectores de base de dados (bloqueia IPs privados, loopback e metadados cloud, e liga-se ao IP já validado).
- Rate limiting geral e mais restrito nas rotas de IA.
- Sessões podem ser revogadas (desativação de utilizador, mudança de password ou de papel).

## Estado do projeto

Em desenvolvimento ativo. O que ainda não existe: conectores MySQL/SQL Server, correção automática de problemas de qualidade de dados, faturação e interface completa de auditoria.

## Licença

Defina aqui a licença do projeto (por ex. MIT) ou indique que é de uso privado.

