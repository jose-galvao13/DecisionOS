# Estado do roadmap (Fases 6-10)

## FASE 6 — Frontend / UX — CONCLUÍDA
`frontend/src/DecisionOS.jsx` (2571 linhas, um único ficheiro) foi separado na
estrutura de pastas proposta. Build verificado com `npm run build` (Vite/Rollup,
sem erros).

Estrutura final:
```
src/
  DecisionOS.jsx        entry point fino (LangProvider + AuthGate)
  api/                  client.js (fetch/auth), aiClient.js (advisor/chat)
  lib/                  theme, i18n, format, mapping, metrics, demoData, digest
  auth/                 AuthScreen, AuthGate
  app/                  DecisionOSApp.jsx (shell, nav, routing por view)
  components/           ui/ (Pill,Card,KPI,SectionTitle,SourceBadge,Modal),
                        Onboarding, FilterBar, ChatWidget, LangSwitch,
                        DecisionFeed (novo)
  pages/
    Dashboard/Overview.jsx
    Analytics/BusinessIntelligence.jsx, ProfitIntelligence.jsx,
              InvestmentIntelligence.jsx, ReportsPage.jsx
    Decisions/DecisionSimulator.jsx
    Advisor/AIAdvisor.jsx
    DataSources/DataPage.jsx
    DataQuality/DataQualityCenter.jsx   (novo — FASE 7)
    Customers/CustomerIntelligenceView.jsx  (novo — bug fix, ver abaixo)
    Products/ProductsPage.jsx           (novo)
    Settings/SettingsPage.jsx           (novo — bug fix, ver abaixo)
```

**Decision Feed**: `components/DecisionFeed.jsx` implementa o formato pedido
(🔴/🟡/🟢, título + descrição em lista vertical) e já substitui o antigo grid
de "alerts" em `pages/Dashboard/Overview.jsx`.

**Bugs corrigidos durante o split**: no ficheiro original, o `switch` de
navegação referenciava `CustomerIntelligenceView`, `ReportsPage` e
`SettingsPage` — três componentes que **nunca chegaram a ser definidos**.
Clicar em "Customers", "Reports" ou "Settings" no menu rebentava com
`ReferenceError: X is not defined`. Implementei os três a sério (não como
placeholders): Customers usa `analytics.customerIntelligence` já calculado,
Reports mostra um resumo executivo imprimível, Settings mostra idioma/fonte
ligada. Também adicionei `ProductsPage` (pedido na árvore de pastas da Fase 6
mas sem página nem entrada de nav) e uma entrada de nav "Data Quality".

## FASE 7 — Data Quality Center — CONCLUÍDA (versão inicial)
`pages/DataQuality/DataQualityCenter.jsx`: score, Completeness/Validity/
Consistency, contagem de anomalias/linhas não mapeadas, "last sync", fonte,
e tabs (Issues, Warnings, Mapping, Skipped rows, Sync history, Data lineage).
As tabs Issues/Warnings/Skipped já leem o objeto `quality` real
(`lib/mapping.js` no frontend ou `backend/src/services/dataQuality.js` no
servidor — a função `normalizeQuality()` aceita as duas formas). Sync history
e Data lineage estão como secções claramente identificadas como pendentes,
porque dependem da FASE 8 (jobs) e de rastreio de linhagem que ainda não
existe no backend — não fingi dados que não tenho.

## FASE 8 — Performance & scalability — CONCLUÍDA
`POST /api/datasources/*commit` e `POST /:id/refresh` deixaram de bloquear o
pedido: passam a inserir a `data_source`, chamar `enqueueJob()` e responder
`202 {jobId}` de imediato. `src/worker.js` faz o trabalho real (import →
validação → analytics → completed), correndo in-process por omissão
(`server.js`) ou como processo próprio via `npm run worker` — a fila é uma
tabela Postgres (`jobs`, com `FOR UPDATE SKIP LOCKED`), não Redis, para não
introduzir infraestrutura nova. `GET /api/datasources/jobs/:jobId` dá polling
de progresso; `GET /:id/jobs` alimenta a tab "Sync history" da FASE 7 (que
estava pendente exatamente por isto). `services/cache.js` (TTL em memória)
cacheia `computeAnalyticsForOrg`, invalidado a cada import/refresh
concluído. `config/limits.js` define `MAX_IMPORT_ROWS` (limite claro, 413,
não truncagem silenciosa) partilhado entre import e analytics. Índices novos
em `jobs`, `data_quality_reports(org_id)` e `transactions(org_id,date DESC)`.
Paginação (`?limit&offset`) em `GET /api/datasources`. Frontend: `Onboarding`,
`DataPage`/`DecisionOSApp` e a tab "Sync history" foram atualizados para o
fluxo assíncrono (barra de progresso real via `JobProgress`, não um spinner
opaco).

## FASE 9 — Testes — CONCLUÍDA (backend + componentes frontend; E2E scaffolded)
Backend: `vitest` + `supertest`, **197 testes** (número na altura desta
fase: 90 — subiu com as fases P2 seguintes) cobrindo auth/multi-tenant
(incl. verificação de que `orgId` nunca vem do corpo do pedido), import,
Data Quality, Analytics Engine, Decision Engine, Simulation Engine,
ferramentas de IA (conformidade de schema + dispatch), segurança do
conector (SSRF guard — localhost/RFC1918/metadata/IPv6-mapped/DNS
rebinding) e a job queue (mocks do pool `pg`, sem precisar de Postgres real
a correr). Dois bugs reais foram encontrados e corrigidos a escrever estes
testes: `assessQuality([])` rebentava com dataset vazio; `Onboarding.jsx`
usava `<Pill>` sem o importar (rebentava ao chegar ao passo de preview).
Frontend: `vitest` + `@testing-library/react`, **21 testes** (número na
altura desta fase: 16 — subiu com o dark mode) (Onboarding —
estados de escolha/erro/progresso assíncrono; `ui/` — EmptyState,
JobProgress, Tooltip, ToastProvider). E2E: `frontend/e2e/full-flow.spec.js`
(Playwright) cobre o fluxo completo do roadmap (Register→Org→Import→Data
quality→Analytics→Decision→Advisor→Simulation) contra um stack real — não
corre em CI normal por precisar de Postgres + backend + `ANTHROPIC_API_KEY`
reais (ver `frontend/e2e/README.md`).

## FASE 10 — Produto / apresentação — CONCLUÍDA
`components/ui/index.jsx` ganhou `ToastProvider`/`useToast` (sistema de
notificações que não existia — erros estavam todos em banners inline
dispersos), `Tooltip` e `EmptyState` (estado vazio/erro consistente,
substituindo layouts repetidos em `DecisionOSApp.jsx`). Toasts já ligados ao
fluxo de import/replace e a erros do AI Advisor. Novo `backend/src/db/
seedDemoOrg.js` (`npm run seed:demo`) cria uma organização de exemplo real
(login incluído) importando dados sintéticos através do pipeline de import
verdadeiro — não faz apenas inserts diretos. Onboarding e dataset de demo já
existiam desde as fases anteriores.

**Dark/light mode — feito.** `lib/theme.js` passou a `lib/theme.jsx` (agora
tem JSX) e os ~20 tokens de cor (`C.blue`, `C.charcoal`, etc.) deixaram de
ser hex fixos e passaram a `var(--x)` — CSS custom properties, definidas em
`:root` (claro) e sobrepostas em `[data-theme="dark"]` (escuro), injetadas
no mesmo `<style>{fontImport}</style>` que já existia nos 3 shells da app.
Isto significa que os ~500 usos existentes de `C.x` por todo o código —
incluindo os que estão capturados em objetos de módulo avaliados uma única
vez no import (`STATUS_META`, `TONE_META`, etc.) — continuam a funcionar
sem tocar em mais nada, porque `var(--x)` é só uma string até o browser
pintar; a cor real resolve-se no momento, conforme o `[data-theme]` atual.
Foi por isto que optei por CSS vars em vez de um `ThemeContext` em JS: a
alternativa exigiria reescrever cada um desses objetos de módulo para
serem funções chamadas dentro do componente, um refactor bem maior.

O que teve de mudar a sério:
- **Papel duplo do `white`**: `C.white` era usado tanto como fundo de
  cartão (que deve escurecer) como texto branco sobre fundo já escuro/azul
  (que tem de continuar branco). Separei em `C.surface` (fundo, muda com o
  tema) e `C.white` (permanece `#FFFFFF` sempre). Atualizados ~10 sítios
  (`Card`, `Modal`, `FilterBar`, `LangSwitch`, `ChatWidget`, `Onboarding`,
  `AuthScreen`, `Overview`, o header principal) que usavam `C.white` como
  fundo.
- **Padrão `${C.blue}22`** (alpha-blend via concatenação de hex) usado em
  4 sítios (`DecisionFeed.jsx`, 2x em `DecisionLogPage.jsx`) — rebentaria
  com `var()`. Substituído por um helper `tint(color, pct)` que gera
  `color-mix(in srgb, var(--x) 15%, transparent)`, suportado em todos os
  browsers evergreen atuais.
- `ThemeModeProvider`/`useThemeMode()` (novo, em `theme.jsx`), persistência
  em `localStorage` (produto real, não artifact — faz sentido usar), com
  fallback para `prefers-color-scheme` do SO na primeira visita, e um
  script inline em `index.html` que aplica o tema antes do primeiro paint
  (sem flash do tema errado).
- `ThemeSwitch.jsx` (pill sol/lua, no mesmo padrão do `LangSwitch`),
  colocado no header principal e no ecrã de login.
- **Dois bugs de produção apanhados de graça**: `AuthScreen.jsx` e
  `DecisionOSApp.jsx` usavam `fontImport` no JSX sem o importar —
  rebentaria com `ReferenceError` assim que essas telas renderizassem.
  Corrigido.

Deliberadamente fora de escopo, documentado e não escondido: sombras
(`box-shadow: rgba(10,21,38,x)`) continuam hardcoded — ainda leem como
sombra em fundo escuro, só menos visíveis; as paletas de cor dos gráficos
(recharts, em `BusinessIntelligence.jsx`/`Overview.jsx`) não estão ligadas
aos tokens — continuam legíveis, só não trocam de tom.

5 testes novos (`test/lib/theme.test.jsx`): modo por omissão, leitura de
preferência guardada, `toggle()` a atualizar `<html data-theme>` +
`localStorage`, e o `ThemeSwitch`. **21 testes de frontend, todos verdes.**
`npm run build` sem erros.

## Como validar (FASE 8–10)
```bash
cd backend
npm install
npm run migrate     # aplica schema.sql (inclui fx_rates, decision_actions)
npm test            # 197 testes, sem precisar de Postgres a correr (mocks)
npm run seed:demo   # opcional: cria uma org de exemplo com dados reais
npm run dev          # ou: npm start / npm run worker num processo à parte

cd ../frontend
npm install
npm run build   # compila sem erros
npm test         # 21 testes de componentes
npm run dev      # correr localmente
# npm run test:e2e   # requer backend+Postgres+ANTHROPIC_API_KEY reais a correr
```

## FASE 11 — Desktop App — ARQUITETURA IMPLEMENTADA E VERIFICADA; build Rust não compilado
Duas decisões de arquitetura resolvidas e **testadas de verdade** (não só
escritas): (1) **base de dados** — em vez de reescrever todo o SQL para
SQLite, `@electric-sql/pglite` (Postgres real, compilado para WASM) corre
atrás de `@electric-sql/pglite-socket`, expondo o protocolo Postgres real
num socket local; `pool.js`, `migrate.js` e até a query `FOR UPDATE SKIP
LOCKED` da FASE 8 correm sem alterações (ver `backend/scripts/
poc-embedded-pg.mjs`, que corre e passa). (2) **empacotamento do backend**
— a primeira tentativa (`pkg`) falhou com um erro real e reproduzível (o
`import()` dinâmico do WASM loader do pglite não é interceptável pelo
snapshot V8 do pkg); a solução foi trocar para o padrão "Tauri + sidecar
Node real" (binário Node real + ficheiros do backend copiados como
resources), validado end-to-end (registo real, JWT real, contra Postgres
embutido real) na exata estrutura de ficheiros que o Tauri vai empacotar.

`desktop/src-tauri/` contém o projeto Tauri v2 completo: `main.rs` (spawna
o sidecar, espera pelo sinal de prontidão, mostra a janela, encerra de
forma limpa via stdin — Windows não tem SIGTERM), `secrets.rs`
(`jwt_secret`/`config_encryption_key` gerados e guardados no keychain do
SO via `keyring`; `anthropic_api_key` fornecida pelo utilizador em
Settings, já que uma app desktop é single-user), `capabilities/
default.json` (a webview só pode executar o sidecar exato, nada mais) e
`tauri.conf.json` (CSP restrito a `127.0.0.1:58732`, instalador NSIS
per-user). `.github/workflows/desktop-build.yml` compila os instaladores
reais (.exe/.dmg/.AppImage/.deb) em runners nativos do GitHub.

**O que NÃO foi verificado**: o lado Rust não foi compilado — o `rustc` do
apt (1.75) é mais antigo que o mínimo do Tauri v2 (1.77.2+), e os
servidores do rustup não são alcançáveis a partir desta sandbox. Antes de
confiar cegamente no `main.rs`/`secrets.rs`, corre `cargo check` numa
máquina com Rust atual — ver `desktop/DESKTOP.md` para o que está provado
vs. o que está "devia compilar" mas não foi testado.

**Atualização — tentativa real de validação nesta sandbox**: instalei o
`rustc`/`cargo` 1.75.0 (candidato do apt) e corri `cargo check` a sério em
`desktop/src-tauri/`. Falha na resolução de dependências, antes sequer de
compilar código próprio:
```
error: failed to download replaced source registry `crates-io`
Caused by: failed to parse manifest at `.../serde_spanned-1.1.1/Cargo.toml`
Caused by: feature `edition2024` is required
The package requires the Cargo feature called `edition2024`, but that
feature is not stabilized in this version of Cargo (1.75.0).
```
Confirma exatamente a limitação já assumida: 1.75 é insuficiente. Também
confirmei que `sh.rustup.rs` e `static.rust-lang.org` respondem
`403 host_not_allowed` a partir desta rede — não há forma de instalar um
Rust mais recente aqui. **Continua por validar**: `cargo check`/`cargo
build` numa máquina com Rust 1.77.2+ (ou via o workflow do GitHub
Actions), como já recomendado.

## Como validar (FASE 11)
```bash
cd backend
npm install
npm run desktop:poc   # prova: embedded Postgres + migrate.js + pool.js reais, sem alterações

cd ../desktop
npm install
npm run prepare-backend   # stage de um backend só-produção em src-tauri/resources/

# build real (precisa de Rust 1.77.2+, não disponível nesta sandbox):
npm run build
# ou, sem instalar Rust localmente: dispara o workflow
# ".github/workflows/desktop-build.yml" no GitHub Actions
```
Ver `desktop/DESKTOP.md` para a arquitetura completa, o que está provado,
o que falta verificar, e o guião de teste de instalação/desinstalação
limpa.

## P0 — Credibilidade — CONCLUÍDA
O achado principal: `decisionEngine.js` (confidence/evidence/drivers, já
testado desde a FASE 9) nunca era chamado pelo produto — o Decision Feed
real (Overview) só mostrava `computeAlerts()` (thresholds simples, zero
confidence/evidência), e `GET /api/decisions` existia mas nada o chamava.
O Simulador tinha a sua própria reimplementação local com uma "faixa de
90%" fabricada (`dProfit * 0.55` a `dProfit * 1.4` — sem base nenhuma).

Corrigido: `simulateLevers()` novo (backend) substitui o cálculo local do
simulador, devolvendo uma "estimated range" derivada da volatilidade
histórica real (mesma lógica `buildScenario` das outras simulações) —
nunca chamada "90% CI", sempre acompanhada de `rangeMethodology` a dizer
explicitamente que não é um intervalo de confiança formal. Cada lever
(price/marketing/churn) declara a sua fonte (`estimated` vs `assumption`)
com uma frase em português simples do porquê. `GET /api/decisions` (já
existia, nunca era usado) está agora ligado ao Overview via
`DecisionFeed.jsx`, que ganhou um painel expansível por decisão ("Why",
"Recommendation", "Estimated impact") e mostra `dataCoverage`
(transações/meses) uma vez por feed. 100 testes backend, build + 16 testes
frontend, tudo verde.

## P1 — Core product — CONCLUÍDA
Nova tabela `decisions` (schema.sql) — o registo persistido de decisões
reais, distinto de `GET /api/decisions` (que recalcula o engine a cada
chamada; nada para "aprovar" ali). `services/decisionRecords.js` implementa
a máquina de estados completa (`proposed → pending_approval → approved →
in_progress → completed`, mais `rejected`/`archived`), com toda a transição
a passar por `audit_log`. `routes/decisionRecords.routes.js` expõe
`/api/decision-log` (criação, histórico paginado+filtrado, mudança de
owner, submit/approve/reject/start/archive, registo de outcome). Aprovar,
rejeitar e registar outcome exigem role `manager` ou superior — item 8
(approval workflow) é um gate real, não decorativo. ROI (`roi.netGain`,
`roi.roiPct`) e variância vs. impacto esperado (`variance.
withinExpectedRange`) só existem depois de um outcome real ser registado —
nunca uma projeção a fingir de resultado. 26 testes novos (16 do serviço +
10 das rotas, incluindo verificação explícita de que um viewer não
consegue aprovar/rejeitar/registar outcome).

Frontend: página nova `DecisionLogPage.jsx` (nav "Decision Log") com
filtro por status e ações inline (submit/approve/reject/start/archive/
record outcome) já ligadas aos endpoints reais. `DecisionFeed.jsx` ganhou
"Turn into a decision" (P2 parcial: Recommendation → Decision) e o
Simulador ganhou "Commit this scenario as a decision" (P2 parcial:
Simulation → Decision) — ambos escrevem para `/api/decision-log`
congelando a evidência/confiança do momento em que a decisão foi criada.

## P2 — AI — parcialmente coberto, resto por fazer
Já ligado (como consequência direta do P1): **Recommendation → Simulation**
já existia (Advisor usa as mesmas ferramentas de simulação); **Simulation →
Decision** e **Decision** propriamente dita (criação a partir de uma
decisão detetada ou de uma simulação) — feito acima. Falta:
**Decision → Action** (nenhum conceito de "ação" distinto do status
`in_progress` — não há subtarefas nem responsável por passo) e
**Action → Measurement** automatizada (hoje o outcome é sempre inserido
manualmente por um manager; não há nenhuma ligação de volta aos dados
reais — p.ex. comparar a receita observada 60 dias depois com o esperado
automaticamente).

## P2 — fechar o ciclo Decision → Action → Measurement — CONCLUÍDA
As duas peças que faltavam:

**Decision → Action**: nova tabela `decision_actions` (subtarefas com
título, `owner_id`, `status` `todo/in_progress/done/skipped`, `due_date`) e
`services/decisionActions.js` com CRUD completo. Não conduzem o estado da
própria decisão — um manager continua a mover a decisão explicitamente
através de `approved → in_progress → completed`; são só o checklist "quem
está a fazer o quê". Endpoints em `/api/decision-log/:id/actions`
(qualquer membro da org pode criar/editar, sem gate de `manager` — mesma
lógica de "criar uma decisão" já não ter esse gate). Frontend:
`DecisionLogPage.jsx` ganhou um painel de actions por decisão (lazy-loaded
só quando expandido), com toggle de estado e adicionar/remover inline.

**Action → Measurement automatizada**: `decisions` ganhou `started_at`,
`baseline_metric` e `measurement_window_days` (default 60, override por
decisão via `measurementWindowDays` na criação). Quando uma decisão passa
a `in_progress` (`decisionRecords.startDecision`), captura-se um
**baseline** — soma real de `revenue`/`gross_profit` nas transações da
janela imediatamente antes do início — porque comparar "antes/depois"
sem essa fotografia não seria honesto. Novo `services/measurementEngine.js`
varre periodicamente (loop de 6h, arrancado a partir de `server.js`) as
decisões cuja janela já passou e sem outcome registado, soma o mesmo
metric na janela observada, e regista `actual_outcome` sozinho
(`outcome_source: 'automatic'`), com uma nota explícita a dizer que é uma
correlação simples — não um teste causal, à semelhança do que
`simulateLevers()` já fazia ao recusar chamar-se "90% CI" à sua própria
estimativa. Só cobre os dois metrics que dá para somar honestamente a
partir de transações (`revenue`, `gross_profit`); `revenue_at_risk`,
`revenue_concentration_pct`, `annual_gross_profit` continuam manuais, tal
como antes. Nunca sobrescreve um outcome manual, e só mede uma vez.

Como ninguém vai esperar 60 dias reais para testar isto: `POST
/api/decision-log/measure-due` (role `manager`+, à semelhança de
approve/reject/outcome) dispara a varredura na hora, com âmbito à própria
org do chamador. O botão "Measure due decisions now" no Decision Log usa
este endpoint.

47 testes novos no backend (decisionRecords: baseline no start + source no
outcome; `decisionActions.test.js`; `measurementEngine.test.js`; rotas
novas em `decisionRecords.routes.test.js`). Frontend: `npm run build` sem
erros; painel de actions ligado.

**Pontas soltas fechadas numa ronda seguinte**: seletor de `owner_id` ao
adicionar uma action (busca `GET /api/org/users`; se o utilizador não tem
permissão para essa lista — é `admin+` only — o seletor fica escondido em
vez de rebentar, e a action fica por atribuir); `measurementWindowDays`
tornou-se editável no momento de "Turn into a decision" no `DecisionFeed`
(campo inline "Measure automatically after N days", default 60).

## P2 — conversão de câmbio real (não só rótulo) — CONCLUÍDA
`dataQuality.js` já assinalava `mixed_currencies` desde a FASE 7, mas
nunca havia forma de corrigir — os totais somavam valores em moedas
diferentes às cegas. Fechado com conversão real:

Nova tabela `fx_rates` (org_id, currency, rate_to_default, effective_date)
— um manager define "1 USD = 0.9 EUR a partir de 1 Jan 2024", e pode ter
várias datas por moeda (a taxa muda ao longo do tempo). `services/
fxRates.js` expõe `setRate`/`listRates`/`deleteRate` e a lógica de lookup
(`buildRateIndex`/`rateAsOf`): para uma transação numa dada data, usa-se a
taxa mais recente *até essa data* (não a mais recente em absoluto) — não é
uma série temporal de câmbio intradiário, mas já não é "1 taxa para
sempre" ingénuo. `loadOrgTransactions` (analyticsEngine.js) passou a
converter `revenue`/`cost`/`profit`/`unitPrice`/`discount` para a moeda
por omissão da org antes de devolver as transações — o que significa que
**todos os consumidores** (dashboards, `computeAnalytics`, o baseline do
P2 acima, o `measurementEngine.js`) recebem valores já convertidos, sem
precisar de saber que a conversão existe. Uma transação numa moeda sem
taxa configurada fica deliberadamente por converter, na sua moeda
original — `computeAnalytics`'s `currency.unconvertedCount`/
`unconvertedCurrencies` torna isso explícito em vez de somar às cegas
como antes. Rotas: `GET/POST /api/org/fx-rates`, `DELETE /api/org/
fx-rates/:id` (manager+, invalida a cache de analytics ao mudar). UI nova
em Settings (`FxRatesCard`) para gerir as taxas.

**Dois bugs de produção adicionais apanhados ao correr isto contra um
Postgres real** (não só testes com mocks — ver secção de verificação
abaixo): `fx_rates` estava declarada no schema *antes* de `users`, mas
`created_by REFERENCES users(id)` — a migração falhava com `relation
"users" does not exist`. Corrigido (tabela movida para depois de `users`).
E `frontend/src/pages/Settings/SettingsPage.jsx` chamava `apiFetch("/api/
organizations")`, mas o backend monta esse router em `/api/org` — a secção
de moeda em Definições estava **completamente partida** (404 sempre) antes
desta correção; ninguém a tinha notado porque não há teste E2E de UI a
correr contra o backend real (ver limitação de E2E mais abaixo).

Testes novos: `fxRates.test.js` (setRate/listRates/deleteRate + lookup de
taxa por data), `loadOrgTransactions.test.js` (conversão real, moeda sem
taxa fica por converter, fallback de moeda por omissão), mais os
assertions de `currency.unconvertedCount` em `analyticsEngine.test.js` e
as rotas novas em `organizations.routes.test.js`.

## Verificação real contra Postgres (não só testes com mocks)
Os 197 testes de backend usam `pool.query` mockado — dão confiança na
lógica, mas não apanham erros de SQL real (ordem de tabelas, constraints,
nomes de coluna). Para além dos testes, instalei Postgres 16 nesta
sandbox, corri `npm run migrate` a sério, arranquei o `server.js` real, e
exerci via `curl` o fluxo completo ponta a ponta: registo → criar taxa
USD→EUR → inserir uma transação real de 1000 USD → confirmar que
`/api/analytics/full` devolve **900 EUR já convertidos** (não 1000) →
criar/submeter/aprovar/arrancar uma decisão com janela de 7 dias →
confirmar que o baseline capturado é exatamente os 900 EUR convertidos →
recuar `started_at` 10 dias (simular os 7 dias terem passado) → inserir
uma 2ª transação de 500 EUR dentro da janela observada → disparar `POST
/measure-due` → confirmar que a decisão foi marcada `completed`,
`outcome_source: automatic`, com `actual_outcome.value = 500` (1400
observado − 900 baseline, exatamente o esperado) → testar o CRUD de
actions (criar, marcar como `done`, listar). Tudo correto ao primeiro
cálculo, exceto os dois bugs de schema/rota já descritos acima, que só
apareceram por correr isto a sério. Foi assim que apanhei ambos.

**Isto NÃO substitui a suite E2E (Playwright) real** — essa continua por
correr (ver `frontend/e2e/README.md` e a FASE 9 acima para como), porque precisa de um browser
de verdade e de `ANTHROPIC_API_KEY`, nenhum dos quais está disponível
nesta sandbox (tentei: `chromium-browser` no apt do Ubuntu 24.04 é só um
pacote de transição para a snap, que não instala nada utilizável sem
`snapd` — confirmado, não a assumir). O que fiz é uma verificação de API
ponta a ponta contra uma base de dados real, o que apanha uma classe
diferente (e real) de bugs que os testes unitários com mocks não apanham.

## Como validar (P0 + P1)
```bash
cd backend
npm install
npm test   # 197 testes

cd ../frontend
npm install
npm run build
npm test   # 21 testes
```

## Como validar (P2 — Decision → Action → Measurement)
```bash
cd backend
npm install
npm run migrate   # aplica os ALTER/CREATE novos (decision_actions, colunas de baseline)
npm test          # 173 testes (backend), inclui decisionActions.test.js e measurementEngine.test.js

cd ../frontend
npm install
npm run build   # compila sem erros
npm test         # 21 testes

# Para testar a medição automática sem esperar dias reais: cria uma
# decisão com expected_impact.metric = "revenue" ou "gross_profit",
# aprova-a e arranca-a (POST /:id/start captura o baseline), depois
# chama POST /api/decision-log/measure-due como manager+ (ou espera o
# loop de 6h em produção).
```
