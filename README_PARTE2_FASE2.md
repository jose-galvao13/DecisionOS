# Parte 2 — Carteira de ações — FASE 2 ("Análise sem preços ao vivo")

Este zip contém **apenas os ficheiros novos/alterados** desta fase, já nas
pastas corretas para serem copiados/mesclados por cima do repositório
`DecisionOS-main` (assume que a FASE 1 já está aplicada — reutiliza as
tabelas `holdings`/`security_prices`/`portfolio_imports` e o
`fx_rates`/`cache.js` que já existiam).

## Ficheiros novos

- `backend/src/services/portfolioAnalytics.js` — funções puras e
  testáveis (sem acesso à BD):
  - `computeUnrealizedPnL(position)` — P&L não realizado =
    quantidade × (preço atual − preço médio); `null` (não `0`) quando
    não há preço.
  - `convertToDefaultCurrency(positions, defaultCurrency, rateIndex)` —
    reutiliza `buildRateIndex`/`rateAsOf` de `fxRates.js` (o mesmo
    mecanismo do `analyticsEngine.js` para transações); uma posição cuja
    moeda não tem taxa fica marcada `semTaxaCambio: true`, nunca
    convertida a "palpite".
  - `computeWeights(positions)` — peso por posição (`pesoPct`), só sobre
    posições com valor convertido; sem preço/sem taxa ficam `pesoPct:
    null` e **fora** do denominador.
  - `computeConcentration(weightedPositions)` — HHI = Σ(peso²) (peso
    como fração, 0–1), nº efetivo de posições = 1/HHI, e top 3.
  - `computeExposureByDimension` / `computeExposures` — exposição por
    moeda, sector e país; sector/país em falta caem no bucket literal
    `"N/D"` (nunca são descartados da soma).
  - `buildPortfolioAnalytics(rawPositions, { defaultCurrency, rateIndex
    })` — pipeline completo: posições anotadas, totais (valor, custo
    com/sem preço, P&L convertido), concentração, exposições e uma
    lista de **avisos visíveis** (`sem_preco`, `sem_taxa_cambio`,
    `sector_nd`, `pais_nd`).
  - `invalidatePortfolioAnalyticsCache(orgId)` — vive aqui (não na
    rota) para que `worker.js` a possa chamar sem depender de um router
    Express.

- `backend/test/services/portfolioAnalytics.test.js` — 24 testes com
  carteiras pequenas (2 a 5 posições) e valores calculados à mão:
  P&L (ganho e perda), pesos, HHI/nº efetivo em casos conhecidos (1
  posição → HHI 1; 4 posições iguais → HHI 0.25, N efetivo 4),
  exposição por sector/país/moeda, conversão USD→EUR com taxa
  conhecida, posição sem preço, posição sem taxa de câmbio, sector/país
  em falta → "N/D".

- `frontend/test/pages/PortfolioAnalytics.test.jsx` — testa a secção
  nova da UI (KPIs de concentração, banner de avisos, pill "sem
  preço"/"sem taxa de câmbio" na tabela) e confirma que a página
  continua a funcionar mesmo que `GET /analytics` falhe.

## Ficheiros alterados

- `backend/src/routes/portfolio.routes.js`:
  - `GET /api/portfolio/analytics` (novo) — cache de 60s via
    `services/cache.js` (chave `portfolio-analytics:{orgId}`), carrega
    posições agregadas + `default_currency` da organização + `fx_rates`
    e chama `buildPortfolioAnalytics`.
  - `GET /holdings` foi refatorado para partilhar o carregamento das
    posições (`loadAggregatedHoldings`) com a rota nova, em vez de
    duplicar a query — o comportamento de `GET /holdings` não mudou.
  - `PUT /prices` e `DELETE /:id` agora chamam
    `invalidatePortfolioAnalyticsCache(orgId)` depois de escrever, para
    que `GET /analytics` nunca sirva números anteriores à escrita.

- `backend/src/worker.js` — depois de um `import_portfolio` terminar
  com sucesso, chama `invalidatePortfolioAnalyticsCache(orgId)` (o
  mesmo padrão que já existia para `invalidateOrgAnalyticsCache` nos
  imports de transações).

- `frontend/src/pages/Portfolio/PortfolioPage.jsx`:
  - Carrega `GET /api/portfolio/analytics` em paralelo com
    `GET /api/portfolio/holdings` (e volta a carregar ambos depois de
    importar um ficheiro ou atualizar um preço manual).
  - Tabela de posições ganhou uma coluna de **peso (%)** e pills
    "Sem cotação" / "Sem taxa de câmbio" nas linhas afetadas.
  - Nova secção **"Análise da carteira"**: KPIs de valor atual, P&L não
    realizado, HHI e nº efetivo de posições; lista do top 3; três
    gráficos de barras horizontais (moeda / sector / país), com o
    mesmo estilo visual (`recharts` + `chartTooltip`/`barCursor`) já
    usado em `BusinessIntelligence.jsx`.
  - Banner de **avisos visíveis** (ícone de alerta, fundo amarelo) por
    cima da tabela sempre que há posições sem preço, sem taxa de
    câmbio, ou sector/país em falta — a falha desta chamada
    (`analyticsError`) nunca impede o resto da página de funcionar.

- `frontend/src/lib/i18n.jsx` — novas chaves `portfolio.analytics.*`,
  `portfolio.kpi.unrealizedPnl/hhi/effectiveN/top3`,
  `portfolio.exposure.*`, `portfolio.warning.*`,
  `portfolio.field.noFxRate/weight`, `portfolio.error.analytics` — em
  pt e en (o teste `i18n.test.js` já existente confirma paridade entre
  as duas línguas).

## Decisões de design (a documentar/rever)

1. **"Sem preço" nunca vira 0 ou custo**: ao contrário de
   `GET /holdings` (que, para o KPI simples de "valor atual", usa o
   custo como melhor estimativa quando não há cotação — decisão da
   FASE 1, mantida), `GET /analytics` exclui essas posições de
   **todos** os cálculos de peso/concentração/exposição. É a leitura
   mais literal do ponto 3 do enunciado ("fora dos pesos").
2. **HHI em fração (0–1), não em "pontos" (0–10000)**: documentado no
   próprio `computeConcentration` — fácil de escalar na UI se algum
   dia for preciso comparar com um limiar regulatório que use a outra
   convenção.
3. **P&L total em moeda por defeito**: `totals.pnlNaoRealizado` soma o
   P&L de cada posição já convertido (mesma taxa usada para o valor),
   não a soma bruta das moedas originais — só entra no total quem
   também entrou nos pesos (com preço e com taxa de câmbio).
4. **Cache de 60s, invalidação explícita**: mesmo padrão do
   `analyticsEngine.js` (FASE 8) — TTL curto como rede de segurança,
   invalidação imediata a seguir a um import, uma atualização de preço
   ou a remoção de um import.

## Por aplicar / seguir

- Nenhuma migração de schema — esta fase não introduz tabelas novas,
  só uma rota e um serviço de cálculo sobre o schema já existente da
  FASE 1.
- `npm test` corre localmente sem `DATABASE_URL` configurado (os testes
  novos não tocam na BD — mockam `pool`/`cache`/usam funções puras);
  suite completa do backend (327 testes) e do frontend (156 testes)
  passa com estas alterações aplicadas.
