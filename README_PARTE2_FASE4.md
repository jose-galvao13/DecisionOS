# Parte 2 — Carteira de ações — FASE 4 ("Ligação ao resto")

Este zip contém **apenas os ficheiros novos/alterados** desta fase, já nas
pastas corretas para serem copiados/mesclados por cima do repositório
`DecisionOS-main` (assume as FASES 1–3 aplicadas). Sem migrações de schema.

Testes: backend 407 (eram 354), frontend 178 (eram 161) — todos a passar;
`vite build` compila.

## 1. Alerta de concentração

- `backend/src/services/notifications.js` — nova fonte `portfolioConcentration`:
  dispara quando **uma posição > 25 %** ou **HHI > 0,20** (≈ menos de 5
  posições efetivas). Uma notificação no máximo, `target: { view: "portfolio" }`,
  severidade amarela (vermelha se a maior posição ≥ 50 %). Só conta posições
  com preço e taxa de câmbio (as outras estão fora dos pesos, como na FASE 2).
  A `key` inclui o ticker e o peso em degraus de 5 pontos: variações de
  mercado pequenas não voltam a notificar quem já leu; outra posição no topo,
  ou um degrau completo a mais, é notificação nova.
- `backend/src/config/limits.js` — `PORTFOLIO_ALERT_MAX_POSITION_PCT` (25) e
  `PORTFOLIO_ALERT_HHI` (0,20), ambos com override por variável de ambiente.
  Nota: HHI ≤ peso da maior posição, por isso um limiar de HHI ≥ ao da
  posição seria redundante; com 0,20 vs 25 % o HHI apanha também carteiras
  como 4 × 24 %.
- `frontend/src/lib/alertCopy.js` — `portfolioConcentrationCopy()` (os textos,
  pt/en, três variantes: posição / HHI / ambos). Só descrevem a concentração e
  remetem para a Carteira; não dizem o que fazer.
- `frontend/src/lib/notifications.js` — `describeNotification` delega nele
  (é aqui que o sino monta o texto de cada `kind`).
- `frontend/src/components/NotificationBell.jsx` — ícone do novo `kind`.
- `frontend/src/lib/i18n.jsx` — chaves `alerts.portfolioConcentration*`.

## 2. Decision Simulator

- `backend/src/services/simulationEngine.js` — `simulateSellPosition()`:
  pesos, HHI (+ nº efetivo, top 3, maior posição) e VaR 95 % **antes e depois**,
  mais os deltas, avisos, pressupostos e aviso legal.
  Assinatura: `simulateSellPosition({ ticker, percent, portfolio, seriesByTicker })`
  — é pura (como o resto do motor): recebe a análise da carteira e as séries de
  preços em vez de ir à BD. Devolve `{ error }` (nunca lança) para ticker
  desconhecido, percentagem fora de (0, 100], posição sem preço ou sem taxa.
- `backend/src/services/riskAnalytics.js` — **novo** `computePortfolioVaR95()`.
  Não existia VaR ao nível da carteira (só por ticker), por isso o "VaR antes e
  depois" precisou dele: VaR histórico dos retornos diários ponderados, pesos
  constantes, só datas comuns a todas as posições cobertas; posições com menos
  de 60 retornos ficam de fora e `coveredWeightPct` diz quanto da carteira o
  número descreve. Antes e depois usam **exatamente a mesma janela**, para a
  diferença vir só dos pesos.
- `backend/src/routes/simulation.routes.js` — `sell_position` registado em
  `HANDLERS` (`{ type: "sell_position", ticker, percent }`). Não usa a análise
  de vendas, por isso funciona numa organização só com carteira (não exige
  transações).
- `backend/src/services/portfolioData.js` — **novo**: o carregamento
  (posições agregadas, análise em cache 60 s, séries de `price_history`) foi
  extraído de `portfolio.routes.js`, porque há agora quatro leitores dos mesmos
  números (rota, alerta, simulador, advisor). `portfolio.routes.js` só perdeu
  código; o comportamento de `GET /holdings` e `GET /analytics` não mudou.
- `frontend/src/pages/Decisions/DecisionSimulator.jsx` — passou a ter dois
  separadores: **Negócio** (o simulador de sempre, intacto) e **Carteira de
  ações**.
- `frontend/src/pages/Decisions/PortfolioSellTab.jsx` — **novo**: escolha da
  posição + parte vendida (5–100 %), antes/depois de HHI, nº efetivo, maior
  posição, valor e VaR, tabela de pesos, avisos, pressupostos e o aviso de que
  não é aconselhamento financeiro. As variações não são pintadas de verde/
  vermelho (menos HHI não é "melhor"): aparecem como deltas neutros.
- `frontend/src/app/DecisionOSApp.jsx` — 5 linhas: sem dados de vendas
  (nenhuns/erro), o Simulador abre no separador da carteira em vez do estado
  vazio, tal como a página Carteira já fazia.

## 3. AI Advisor

- `backend/src/analytics-tools.js` — ferramentas `get_portfolio_summary`
  (valor, P&L, HHI, top posições, exposições, VaR e avisos) e
  `simulate_sell_position({ ticker, percent })`; `runTool(name, input, { analytics, portfolio })`.
  Sem carteira devolve erro claro; sem análise de vendas as ferramentas de
  vendas dizem-no em vez de "tool execution failed".
- `PORTFOLIO_ADVISOR_GUARDRAILS` (exportado do mesmo ficheiro) é **acrescentado
  ao prompt no servidor** (`server.js`), por isso um cliente não o pode omitir:
  descrever risco e cenários, nunca recomendar comprar/vender/reduzir/
  reequilibrar, tratar a simulação como hipótese, citar só números das
  ferramentas, e terminar com aviso de que não é aconselhamento financeiro.
  Cada resultado das ferramentas também traz o `disclaimer`.
- `backend/src/server.js` — carrega a carteira só quando o Claude chama uma
  ferramenta de carteira; `/api/advisor` só devolve 404 se não houver
  transações **nem** carteira.
- `frontend/src/api/aiClient.js` — `ADVISOR_SYSTEM` (pt/en) ganhou a instrução
  equivalente (o aviso vai em `limitations`, que o AIAdvisor já mostra).

## Testes novos

- `backend/test/services/simulateSellPosition.test.js` (26) — números à mão:
  60/30/10 → vender 50 % de A dá 42,86/42,86/14,29 e HHI 0,46 → 0,3878; 100 %
  dá 75/25 e 0,625; VaR 6,00 % → 4,29 %; janela comum; cobertura parcial;
  dados insuficientes; validação.
- `backend/test/routes/simulateSellPosition.routes.test.js` (6),
  `backend/test/services/analyticsToolsPortfolio.test.js` (10),
  `backend/test/services/portfolioConcentrationAlert.test.js` (11).
- `frontend/test/lib/portfolioAlert.test.js` (6),
  `frontend/test/pages/DecisionSimulatorPortfolio.test.jsx` (11).

## A rever / limitações conhecidas

1. **"Depois" = o dinheiro sai da carteira** (não fica em caixa nem é
   reinvestido). É o que a página Carteira mostraria se a posição fosse
   reduzida no ficheiro; está dito nos pressupostos, no resultado e na UI.
2. O VaR usa o retorno de cada ticker na sua moeda (câmbio não modelado) —
   avisado quando há posições noutra moeda.
3. Não há (ainda) um ecrã do Advisor para perguntas sobre a carteira: as
   ferramentas e as regras estão prontas no `/api/advisor`, mas o botão atual do
   AIAdvisor continua a pedir a recomendação de negócio.
4. Cache em memória (como o resto do backend): a invalidação só vale na
   instância que recebeu a escrita.
