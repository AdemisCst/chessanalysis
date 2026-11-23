# Plano da Fase 3 — Central de Análises

**Data:** 17/11/2026 (atualizado em 23/11/2026)  
**Estado:** **M1, M3 e M4 concluídas** — DB v2 e regras da fila, retomada no
motor e executor com lease/heartbeat/BroadcastChannel implementados e
verificados; M5–M6 pendentes (UI e revisão final). Evidências em
[`TESTES-FASE-3.md`](TESTES-FASE-3.md).  
**Base:** Fase 2 aprovada (motor SF19, proveniência `gameId@depth@build`,
Expected Score v3 por WDL) e §9 de
[`ARQUITETURA-INTEGRACAO.md`](ARQUITETURA-INTEGRACAO.md)

> Este documento define o que será feito, como será verificado e o que fica
> fora. Nenhum item é declarado implementado antes de execução real com
> evidência em `docs/TESTES-FASE-3.md`.

---

## 1. Objetivo

Substituir o modal provisório de análise em lote por uma **central
persistente**: fila por partida, checkpoint durante a análise, retomada
confiável após recarregar/fechar a aba, pausa/cancelamento explícitos e
progresso honesto por partida e por posição.

A Fase 3 **não** muda o cálculo da análise. O registro produzido continua sendo
o da Fase 2: `version: 3`/`scoreSource: 'wdl'` quando o WDL é completo,
`engineBuild` na chave, `summary` consistente e nenhuma sobrescrita de análise
legada.

---

## 2. Estado atual e limites reais

| Peça | Hoje | Limite que motiva a Fase 3 |
|---|---|---|
| `js/settings.js` → `analyzeAll()` | laço `for` em memória, dentro de um modal | fechar a aba perde tudo; não há pausa nem retomada |
| `Engine.analyzeGame(game, data, {depth, signal, onProgress})` | analisa todas as posições e devolve o registro completo | não permite parar no meio e continuar de onde parou |
| `Engine.stop()` | derruba o Worker | reiniciar custa handshake e perde o contexto do motor |
| `DB` | versão `1`; stores `games`, `data`, `analysis`, `ai`, `meta` | não há onde persistir fila nem checkpoint |
| Erros | contador `errors++` e `console.warn` | uma partida com defeito não tem retry nem diagnóstico |
| Progresso | barra única do modal | sem lista, sem ETA, sem estado por partida |
| Abas | nenhuma coordenação | duas abas podem analisar a mesma partida ao mesmo tempo |

---

## 3. Escopo

### 3.1. Dentro

1. Fila persistente por partida, ordenada e idempotente.
2. Estados explícitos: `pending`, `running`, `paused`, `interrupted`, `done`,
   `error`, `canceled`.
3. Checkpoint a cada grupo verificável de posições.
4. Retomada após recarregar, navegar entre telas ou fechar/reabrir a aba.
5. Pausa e cancelamento com semântica distinta.
6. Retry individual e "reprocessar falhas".
7. Um Worker por aba; uma aba "dona" da fila por vez.
8. View dedicada "Análises" com progresso por partida e ETA.
9. Diagnóstico de erro por partida (motivo legível, tentativas).
10. Testes unitários puros + smoke CDP com IndexedDB real.

### 3.2. Fora (não implementar nesta fase)

- **MultiPV 2** e **integração com banco de aberturas (ECO)** — deferidos para
  a Fase 2.5/5 junto com as 3 categorias restantes.
- Análise com **todas as abas fechadas** ou fora do navegador: impossível sem
  backend/Service Worker com limitações; fora de escopo.
- Processamento no servidor (Vercel Function) — o motor é WASM local.
- Paralelismo com vários Workers: o padrão continua **um** Worker; avaliar
  depois, com medição.
- Sincronização entre dispositivos.
- Alterar limiares de classificação ou o cálculo de precisão/ACPL.

---

## 4. Modelo de dados (IndexedDB versão 2)

`DB.VERSION` passa de `1` para `2`. O `onupgradeneeded` já é aditivo (só cria o
que falta), então a migração é segura: **nenhum store existente é recriado ou
limpo**.

### 4.1. Novo store `queue`

Chave: `key = gameId`; índices `state`, `priority`. Um item por partida e por
alvo de análise — a `key` inclui o alvo para permitir reprofundidade futura:
`key = gameId@depth@build`.

| Campo | Tipo | Regra |
|---|---|---|
| `key` | string | `gameId@depth@build` |
| `gameId` | string | |
| `depth` | number | profundidade alvo |
| `engineBuild` | string | build que deve produzir a análise |
| `state` | string | um dos 7 estados da §5 |
| `priority` | number | menor primeiro; padrão `Date.now()` |
| `attempts` | number | incrementa a cada execução iniciada |
| `lastError` | string \| null | motivo legível, sem stack |
| `createdAt` / `updatedAt` | number | epoch ms |
| `startedAt` / `finishedAt` | number \| null | |
| `positionsDone` | number | espelho do checkpoint, para a UI |
| `positionsTotal` | number | `data.moves.length + 1` |
| `leaseOwner` | string \| null | `tabId` de quem está executando |
| `heartbeatAt` | number \| null | renovado a cada 5 s |

### 4.2. Novo store `checkpoints`

Chave: `key = gameId@depth@build` (mesma da fila). **Separado** do store
`analysis` de propósito: `analysis` só contém resultado completo.

| Campo | Tipo | Regra |
|---|---|---|
| `key` | string | idem |
| `gameId`, `depth`, `engineBuild` | | conferidos na retomada |
| `startFen` | string | valida que o PGN não mudou |
| `movesLength` | number | idem |
| `positions` | array | posições já avaliadas, no formato da Fase 2 (`{cp, mate, depth, best, pv, wdl?}`) |
| `resumeAt` | number | índice da próxima posição a avaliar |
| `fenAtResume` | string | FEN da posição `resumeAt` |
| `updatedAt` | number | |

### 4.3. Invariantes (contrato)

1. `analysis` **nunca** recebe registro parcial. Um registro só é gravado
   depois de `buildAnalysis` concluir todas as posições.
2. `getAnalysis` e as estatísticas continuam lendo apenas `analysis` — nenhuma
   mudança de contrato da Fase 2.
3. Checkpoint de outro `depth`/`build` é descartado, não reaproveitado.
4. `game.analyzedDepth`/`analyzedBuild` só são atualizados na conclusão.
5. Apagar a partida (`DB.deleteGame`) remove fila e checkpoint dela.
6. Reprocessar é idempotente: mesma `key` de análise é substituída apenas por
   resultado completo do **mesmo** build; legado SF10 nunca é tocado.

### 4.4. Transações

- Conclusão de uma partida grava, **na mesma transação** sobre
  `['analysis', 'games', 'queue', 'checkpoints']`: análise, metadados da
  partida, estado `done` e remoção do checkpoint.
- Atualização de progresso grava só `queue` + `checkpoints`.
- Nunca abrir transação atravessando `await` de rede/Worker.

---

## 5. Máquina de estados

```text
                    enqueue
                       │
                       ▼
                  ┌─────────┐  start   ┌─────────┐
                  │ pending │─────────▶│ running │
                  └─────────┘          └─────────┘
                       ▲                │   │   │
        retry          │       pause    │   │   │ erro
                       │                ▼   │   ▼
                  ┌────────┐      ┌────────┐ │ ┌───────┐
                  │ error  │      │ paused │ │ │ error │
                  └────────┘      └────────┘ │ └───────┘
                       ▲                │   │ │
                       │             resume │ │ aba fecha / lease expira
                       │                │   ▼ ▼
                       │                │ ┌────────────┐
                       │                │ │interrupted │
                       │                │ └────────────┘
                       │                │        │ resume
                       │                ▼        ▼
                       │             running ──▶ done
                       │
                  cancel (de pending/paused/error/interrupted) → canceled
```

| Transição | Gatilho | Efeito persistido |
|---|---|---|
| `pending → running` | "Iniciar" ou worker livre | `startedAt`, `leaseOwner`, `attempts++` |
| `running → paused` | botão Pausar | checkpoint da última posição concluída |
| `running → interrupted` | aba fecha, reload, lease expirada | checkpoint + `lastError: 'interrompida'` |
| `running → error` | exceção do motor/IndexedDB | `lastError`, checkpoint preservado |
| `running → done` | última posição + `saveAnalysis` | análise + `games` + remoção do checkpoint |
| `paused/interrupted/error → running` | "Retomar"/"Tentar novamente" | valida checkpoint e continua |
| `* → canceled` | "Cancelar" | remove checkpoint; análise existente **não** é apagada |

Regras:

- `done` é terminal; reenfileirar cria novo item (ou reabre o mesmo, se a
  profundidade/build mudou).
- `error` guarda a tentativa; retry automático **não** existe — o usuário
  decide.
- Cancelar não apaga análise antiga nem partial de outra `key`.

---

## 6. Retomada confiável

Algoritmo de inicialização (`resumeQueue`), executado depois de
`migrateAnalysisProvenance`:

1. Abrir `queue`; se `meta.analysisQueueLease` existe e o heartbeat tem menos de
   **20 s**, outra aba é dona → modo somente leitura.
2. Se o lease está expirado, qualquer item `running` daquele dono vira
   `interrupted` e o lease é reivindicado.
3. Ordenar por `priority` e escolher o primeiro `pending`/`interrupted`/`paused`.
4. Carregar o checkpoint da `key`. Validar **todos**: `gameId`, `depth`,
   `engineBuild`, `startFen`, `movesLength` e `fenAtResume` (reconstruída do
   PGN com a chess.js).
5. Checkpoint inválido → apagar e recomeçar a partida do zero (contabilizar
   `restarted` no diagnóstico). Nunca lançar erro fatal por checkpoint corrompido.
6. Chamar o motor a partir de `resumeAt`, reutilizando as posições já avaliadas.
   Posições terminais continuam resolvidas por `Engine.terminalResult`, sem
   consultar o Worker.
7. A cada **4 posições** (constante `CHECKPOINT_EVERY`) atualizar checkpoint +
   `queue.positionsDone`. O último checkpoint é sempre gravado antes de
   finalizar.
8. Ao terminar, `buildAnalysis` roda sobre o array completo; só então
   `DB.saveAnalysis` + metadados + `done`, na mesma transação.

Regras de confiabilidade:

- **Heartbeat** a cada 5 s no item em execução e no lease da aba.
- **Idempotência:** retomar duas vezes o mesmo item não duplica análise
  (mesma `key`).
- **Sem perda silenciosa:** qualquer falha de gravação de checkpoint pausa a
  fila com mensagem; nunca continua como se tivesse salvo.
- **Quota:** `QuotaExceededError` → `paused` com instrução de exportar backup e
  limpar espaço; checkpoints existentes ficam intactos.
- **Partida apagada** durante a fila → item vira `error` com motivo "partida
  removida", sem tentar recriar dados.

---

## 7. Mudança necessária no motor

`Engine.analyzeGame` precisa aceitar retomada, sem duplicar lógica:

```js
Engine.analyzeGame(game, data, {
    depth,
    signal,
    startIndex,              // novo: posição inicial (padrão 0)
    seedPositions,           // novo: posições já avaliadas (padrão [])
    onPosition,              // novo: callback por posição concluída
    onProgress,              // existente, mantido
});
```

- O resultado continua completo: `startIndex`/`seedPositions` são apenas
  pré-condição; `buildAnalysis` sempre recebe o array inteiro.
- `onPosition({ index, position })` permite checkpoint sem que o motor conheça
  IndexedDB.
- Pausa: `controller.abort()` mantém o Worker vivo; `Engine.stop()` só em
  "Liberar memória" ou troca de motor.
- Nenhuma alteração no cálculo de WDL/v3: o **fim** da análise continua sendo o
  único ponto que decide `scoreSource` e `wdlCoverage`.

---

## 8. Interface

### 8.1. Nova view "Análises"

Item no rail (`data-view="analyses"`), view própria em `index.html`, render em
`js/queue-ui.js` (novo módulo, sem framework).

| Elemento | Conteúdo |
|---|---|
| Cabeçalho | "Central de Análises", contadores por estado |
| Barra global | posições concluídas / total da fila + ETA (média móvel das últimas 5 partidas) |
| Lista | uma linha por item: partidas, profundidade, build, estado, progresso `x/y`, tentativas, erro |
| Ações | Iniciar, Pausar, Retomar, Cancelar, Tentar novamente, Remover concluídas |
| Filtros | Todos / Pendentes / Em andamento / Falhas / Concluídas |
| Vazio | explicação + botão para a Biblioteca |

### 8.2. Entradas

- Biblioteca → seleção múltipla → **"Adicionar à fila"** (hoje dispara análise
  imediata).
- Partida → "Analisar" continua imediato; "Adicionar à fila" passa a existir
  no menu da partida.
- Configurações → análise em lote passa a **enfileirar** em vez de executar no
  modal.
- Badge no rail com o número de itens ativos; atualizado por evento próprio.

### 8.3. Regras de UI

- Fechar a aba com fila ativa **não** mostra `confirm()`: o estado já está
  persistido; ao reabrir, a retomada é automática (com aviso discreto).
- Progresso nunca anda para trás na mesma sessão.
- Estado real, sem animação otimista: a barra só avança depois do checkpoint.
- Acessibilidade: `aria-live="polite"` no status, botões com rótulo textual e
  `aria-pressed` nos filtros.

---

## 9. Coordenação entre abas

- **Lease** em `meta.analysisQueueLease = { tabId, itemKey, heartbeatAt }`.
- `BroadcastChannel('acervo64-queue')` para eventos (`queue-changed`,
  `lease-taken`, `item-done`); fallback para evento `storage` quando
  indisponível.
- Aba observadora mostra a lista e o progresso, mas desabilita "Iniciar" com o
  texto "Em execução em outra aba".
- Ao fechar a aba dona (`beforeunload`/`pagehide`), grava checkpoint e libera o
  lease; se o fechamento for abrupto, o lease expira em 20 s.
- A pausa é **global** (`meta.analysisQueuePaused`): a aba observadora pode até
  assumir o lease depois da pausa, mas devolve sem retomar; só um `start()`
  explícito limpa a pausa.
- Duas abas nunca escrevem no mesmo item: a escrita exige `leaseOwner === tabId`
  na transação (releitura antes de gravar).

---

## 10. Erros e diagnóstico

| Situação | Estado | Mensagem exibida |
|---|---|---|
| Worker não inicia | `error` | "Não foi possível iniciar o Stockfish. Recarregue a página." |
| Falha de IndexedDB | `paused` | "Falha ao salvar o progresso. Libere espaço e retome." |
| Quota excedida | `paused` | "Armazenamento cheio. Exporte um backup e remova partidas." |
| Partida removida | `error` | "Partida removida da biblioteca." |
| FEN inválida no PGN | `error` | "Posição inválida no lance N." |
| Checkpoint inconsistente | `running` (recomeça) | aviso discreto "Retomada reiniciada para esta partida." |
| Lease de outra aba | observador | "Em execução em outra aba." |

Nenhuma mensagem inclui stack trace ou conteúdo do PGN.

---

## 11. Testes

### 11.1. Unitários (node, sem navegador)

Extrair a lógica pura para `js/queue.js` (reducer + validadores) e testar em
`vm`, como já é feito em `tests/wdl.test.mjs`:

1. Transições válidas e inválidas da §5.
2. Ordenação por `priority` e idempotência de `enqueue`.
3. `nextItem()` ignora `done`/`canceled` e respeita lease.
4. Expiração de lease (19 s ativo, 21 s expirado).
5. Validação de checkpoint: cada campo divergente rejeita.
6. `resumeAt` correto com posições terminais e `seedPositions` parciais.
7. Cálculo de ETA com amostra insuficiente não inventa número.
8. Diagnóstico de erro não vaza stack nem dados sensíveis.

### 11.2. Smoke CDP com IndexedDB real

1. Enfileirar 3 partidas (uma com mate no fim) e iniciar.
2. Recarregar a página no meio da 2ª → retomada continua de `resumeAt`, sem
   duplicar análise e sem marcar `done` prematuro.
3. Pausar e retomar → posições já feitas não são reavaliadas (contador não
   volta).
4. Cancelar → item `canceled`, checkpoint removido, análise anterior intacta.
5. Duas abas → somente a dona executa; a outra exibe "outra aba".
6. Corromper um checkpoint (`resumeAt` > `positions.length`) → partida
   reinicia e a fila segue.
7. Simular quota (`IDBObjectStore.prototype.put` lançando `QuotaExceededError`
   no harness) → fila pausa com mensagem, sem perder checkpoint.
8. Apagar uma partida enfileirada → item `error` com motivo, fila continua.
9. Confirmar que `analysis` só tem registros completos e que
   `stats.otherEngine` continua isolando builds.

### 11.3. Critérios de aceite

- [x] Nenhuma análise parcial em `analysis` ou nas estatísticas.
- [x] Kill da aba em qualquer ponto retoma sem perder mais que
      `CHECKPOINT_EVERY` posições (queda real em `TESTES-FASE-3.md` §4.2).
- [ ] Fila sobrevive a fechar e reabrir o navegador (retomada após crash de
      renderer comprovada; reload completo do navegador fica para a M6).
- [x] Duas abas nunca executam o mesmo item.
- [x] Nenhum caminho de erro apaga análise existente.
- [x] Suíte total verde e `check-syntax` limpo.
- [x] Evidências reais registradas em `docs/TESTES-FASE-3.md`, não simuladas.

---

## 12. Etapas de implementação

| Etapa | Entrega | Critério de saída |
|---|---|---|
| **M1** | `DB` v2 + stores `queue`/`checkpoints` + `js/queue.js` (regras puras) + testes | migração 1→2 sem perda, teto/dedupe e CRUD reais — **concluída** |
| ~~**M2**~~ | Absorvida pela M1: `js/queue.js` e testes unitários | — |
| **M3** | `Engine.analyzeGame` com `startIndex`/`seedPositions`/`onPosition` | retomada real no smoke, mesmo resultado do caminho sem retomada — **concluída** (evidência §3 de `TESTES-FASE-3.md`) |
| **M4** | Executor com lease/heartbeat + pausa/cancelar/retry | reload no meio retoma; duas abas coordenam — **concluída** (evidência §4) |
| **M5** | View "Análises" + entradas pela Biblioteca/Configurações | fluxo completo pela interface, sem modal |
| **M6** | Evidências, documentação e revisão | `TESTES-FASE-3.md` §1 completo |

Cada etapa tem commit próprio e não avança sem a anterior verificada.

---

## 13. Riscos e decisões abertas

| Risco | Mitigação |
|---|---|
| IndexedDB versão 2 quebrar dados existentes | upgrade aditivo + teste com banco v1 semeado |
| Checkpoint grande em partidas longas | gravar a cada 4 posições; medir espaço antes de M4 |
| Lease expirar com aba lenta (mobile) | heartbeat 5 s / validade 20 s, ajustável por constante |
| Duas abas com clocks diferentes | comparar com `Date.now()` da mesma máquina; tolerância documentada |
| Retomada gerar resultado diferente do caminho contínuo | comparar `winPctWhite`, `counts` e `acpl` nos testes de M3 |
| Usuário fechar a aba durante gravação | transação atômica; pior caso perde ≤ 4 posições |

Decisões aprovadas em 18/11/2026 (antes da M1):

1. A fila **substitui** o modal; a view dedicada entra na M5, dentro de
   `index.html` (`data-view="analyses"`), sem arquivo HTML separado.
2. Retry **manual**, com mensagem acionável; nunca automático.
3. Teto de **200 itens ativos** por vez (`Queue.MAX_ITEMS`). `done`/`canceled`
   não ocupam vaga. Um Worker simultâneo.

### 13.1. Decisão de rollback (implementada antes da M1)

O patch de compatibilidade foi entregue e publicado como passo isolado
(commit `b3ecc64`): se o banco local estiver em versão maior que a do bundle,
`DB.open()` reabre **sem versão declarada**, sem apagar nem rebaixar nada.
Evidência real em `docs/TESTES-FASE-3.md` §2.7.

---

## 14. Definição de pronto

A Fase 3 estará concluída quando: um usuário puder enfileirar 50 partidas,
fechar o navegador no meio, reabrir e ver a fila continuar do ponto correto;
pausar, cancelar e tentar novamente sem perder análise anterior; usar duas abas
sem conflito; e tudo isso estiver comprovado por testes reais, com a suíte
verde e a documentação atualizada.
