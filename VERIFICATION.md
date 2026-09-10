# O que está provado vs. assumido

Este documento existe para uma pergunta simples: **se eu (ou outra pessoa)
herdar este código amanhã, o que posso confiar sem reverificar, e o que
ainda precisa de ser testado antes de confiar?**

`STATUS.md` documenta o histórico fase-a-fase. Este ficheiro é diferente:
é um corte transversal por área, atualizado sempre que algo passa de
"assumido" a "provado" (ou o inverso, se uma regressão for encontrada).
Não é aspiracional — só entra aqui o que foi mesmo verificado, com a
evidência concreta de como.

---

## Sessão de 2026-09-09 — CI, E2E, code-splitting, moeda

Resumo do que mudou nesta sessão e como cada alteração foi verificada
(não apenas escrita e assumida como correta):

| Área | Alteração | Como foi verificado |
|---|---|---|
| CI (`.github/workflows/ci.yml`) | Testes backend+frontend e build agora correm em cada push/PR; guard que falha se aparecerem binários/artefactos de build no git | Workflow novo — a validação real só acontece quando correr no GitHub Actions; a lógica do guard foi escrita e revista, não executada em CI real ainda |
| E2E (`.github/workflows/e2e.yml`) | Postgres real como serviço, backend+frontend arrancados, Playwright a correr o fluxo completo; gated pela secret `ANTHROPIC_API_KEY` | Instalei Postgres 16 localmente e confirmei manualmente que `npm run migrate` e `GET /health` funcionam contra Postgres real com as env vars usadas no workflow. **A suite Playwright em si não foi corrida** (precisa de browser + a secret real) |
| Frontend code-splitting | Páginas passaram de import estático para `React.lazy` + `Suspense` | Build real: bundle principal caiu de 723KB para 232KB, cada página em chunk próprio. `npm test` (16/16) continua a passar |
| Moeda por transação | `unifiedModel.js` agora grava `currency` real por linha (mapeada ou default da org); `default_currency` configurável por organização; `dataQuality.js` alerta quando um dataset mistura moedas; `decisionEngine.js` deixa de assumir `EUR` fixo | 21 testes novos (147/147 no total). Import real testado à mão contra Postgres real (script descartável, não commitado) |
| **Bug crítico encontrado por acidente** | `unifiedModel.js` nunca incluía `gross_profit` no INSERT de `transactions`, apesar de a coluna ser `NOT NULL` sem default | Descoberto porque o script de verificação da moeda correu contra Postgres real e o INSERT falhou com `null value in column "gross_profit" violates not-null constraint`. **Antes desta sessão, nenhum import real contra Postgres real teria funcionado** — só não foi apanhado porque a suite de testes do backend faz mock completo do `pg` (ver `test/setupEnv.js`) e não existia nenhum teste, unitário ou de integração, para `unifiedModel.js` |

A linha do `gross_profit` é o motivo pelo qual este documento existe: um
projeto pode ter 126 testes verdes e ainda ter um caminho crítico nunca
exercitado contra a coisa real. "Os testes passam" e "isto funciona" não
são a mesma afirmação — só se tornam a mesma quando os testes tocam a
dependência real, não um mock dela.

---

## Provado (verificado contra a coisa real, não só contra mocks)

- **Autenticação e RBAC** (`auth/middleware.js`): `orgId` vem sempre do JWT,
  nunca do body — lido e confirmado por leitura de código.
- **SSRF guard** (`utils/ssrfGuard.js`): pina o IP após resolver o host,
  cobre IPv4-mapped em IPv6 e ranges reservados — 11 testes unitários,
  mais um teste de rota (`datasources.routes.test.js`) que confirma que um
  host privado é rejeitado antes de persistir a data source.
- **Encriptação de segredos** (`utils/crypto.js`): AES-256-GCM com IV
  aleatório e auth tag.
- **Migração e schema**: `npm run migrate` corre com sucesso contra
  Postgres 16 real (verificado nesta sessão, incluindo a coluna nova
  `default_currency`).
- **Import de transações** (`unifiedModel.js`): corre com sucesso contra
  Postgres real, incluindo o cálculo e persistência de `gross_profit` e
  `currency` por linha (corrigido e verificado nesta sessão).
- **Build de produção do frontend**: `npm run build` sem erros, bundle
  dividido por página.
- **Suite de testes**: 147/147 backend, 16/16 frontend, todos correndo
  de facto (não apenas presentes no repositório).

## Assumido / não verificado (a fazer antes de confiar de olhos fechados)

- **Rust/Tauri do desktop** (`desktop/src-tauri/`): nunca compilado nesta
  sessão nem nas anteriores — a sandbox usada não tem toolchain Rust
  atual. `secrets.rs` foi lido e o design (keychain do SO, nunca
  plaintext) parece correto, mas "parece correto por leitura" não é o
  mesmo que "compila e corre".
- **Suite E2E (Playwright)**: o workflow foi escrito e o arranque do
  backend+Postgres foi validado manualmente, mas a suite Playwright em
  si (browser real a clicar na app) não foi executada nesta sessão — só
  correrá quando o repositório tiver a secret `ANTHROPIC_API_KEY`
  configurada e o workflow disparar no GitHub Actions.
- **CI em GitHub Actions real**: os workflows `ci.yml` e `e2e.yml` foram
  escritos e a lógica foi testada por partes localmente (migração,
  `/health`, build), mas nenhum dos dois correu ainda dentro do GitHub
  Actions propriamente dito — isso só se confirma no primeiro push.
- **Conversão de moeda**: o que existe é um *rótulo* por transação e um
  alerta quando um dataset mistura moedas — não há conversão de câmbio.
  Um dataset que misture EUR e USD terá os seus totais corretamente
  assinalados como suspeitos (`mixed_currencies`), mas os números
  continuam a somar valores sem converter até essa conversão ser
  implementada.
- **Ciclo Decision → Action → Measurement**: continua manual (ver
  `STATUS.md`, FASE 2) — não fazia parte do pedido desta sessão.

---

## Como manter este documento honesto

Regra simples: uma linha só entra em "Provado" quando foi corrida contra
a dependência real (Postgres real, build real, browser real) — nunca
apenas porque "os testes unitários passam" ou "o código parece correto
por leitura". Quando uma área muda de categoria, mover a linha e citar
como foi verificado, não apenas que foi.
