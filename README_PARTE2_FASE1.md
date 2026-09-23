# Parte 2 — Carteira de ações — FASE 1 ("Carteira por upload")

Este zip contém **apenas os ficheiros novos/alterados** desta fase, já nas
pastas corretas para serem copiados/mesclados por cima do repositório
`DecisionOS-main` original.

## Ficheiros novos

- `backend/src/services/portfolioImport.js` — validação de linhas
  (quantidade > 0, ticker não vazio, moeda com 3 letras) + importação
  (delete-then-insert por `import_id`, tal como `unifiedModel.js` faz para
  `data_source_id`).
- `backend/src/routes/portfolio.routes.js` — `POST /preview`,
  `POST /commit`, `GET /imports`, `GET /holdings`, `PUT /prices`,
  `DELETE /:id`. Escrita protegida com `requireMinRole("manager")` e
  registo em `auditLog`.
- `frontend/src/pages/Portfolio/PortfolioPage.jsx` — upload → preview com
  mapeamento de colunas → commit → polling do job → tabela de posições
  (agregadas por ticker) com KPIs e atualização manual de preço.

## Ficheiros alterados

- `backend/src/db/schema.sql` — tabelas `portfolio_imports`, `holdings`,
  `security_prices` (+ índices).
- `backend/src/data-understanding/semanticTypes.js` — novos tipos
  `TICKER`, `AVG_PRICE`, `CURRENCY` (reutiliza `QUANTITY`/`DATE` já
  existentes).
- `backend/src/worker.js` — novo tipo de job `import_portfolio`.
- `backend/src/server.js` — montagem de `app.use("/api/portfolio", ...)`.
- `frontend/src/api/client.js` — `pollJob()` aceita agora um `path`
  opcional (default mantém compatibilidade) para poder ser reutilizado
  pela página de Carteira.
- `frontend/src/app/DecisionOSApp.jsx` — lazy import da `PortfolioPage`,
  entrada `portfolio` em `NAV_MAIN` e `case` em `renderView()`.
- `frontend/src/components/GlobalSearch.jsx` — `portfolio` em
  `PAGE_KEYWORDS` ("acoes", "carteira", "risco", ...).
- `frontend/src/lib/i18n.jsx` — chaves `nav.portfolio` e `portfolio.*`
  (pt + en).

## Decisões de design (a documentar/rever)

1. **Reimportar substitui posições**: no `POST /commit`, se for enviado um
   `importId` existente, as posições desse import são substituídas
   (delete + insert), tal como o `unifiedModel.js` faz para uma fonte de
   dados. Sem `importId`, cria-se um novo `portfolio_imports`.
2. **Soma por ticker entre ficheiros** (ponto 6): feita em `GET /holdings`
   com `GROUP BY ticker` sobre todos os imports do `org_id` — não existe
   noção de "ativo" persistida, só o agregado calculado em tempo de
   leitura.
3. **`nome`/`sector`/`pais`/`tipo_ativo`** não têm deteção semântica
   automática (só ticker/quantidade/preço médio/moeda foram pedidos no
   ponto 2) — ficam disponíveis no `<select>` de mapeamento manual no
   preview.
4. **Preço atual** vem de `security_prices` (origem `manual` nesta fase,
   `upload`/`api` já suportadas no schema para fases futuras).

## Por aplicar / seguir

- Correr `db/schema.sql` novamente no ambiente (idempotente, usa
  `CREATE TABLE IF NOT EXISTS`).
- Nenhuma migração adicional necessária — `db/migrate.js` já executa o
  `schema.sql` completo no arranque.
