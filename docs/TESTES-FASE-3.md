# Testes da Fase 3 — Chess-Analysis

**Data:** 18/11/2026 (atualizado em 23/11/2026)  
**Escopo:** M1 (banco v2, fila e checkpoints), M3 (retomada no motor) e
M4 (executor com lease e BroadcastChannel)  
**Ambiente:** Windows, Node v26.13.1, Edge headless 157.0.4341.60 (CDP 9333),
servidor local `127.0.0.1:8765`

> Todos os números abaixo vieram de execução real nesta máquina. Nada foi
> estimado. O que não foi executado está marcado como **não executado**.

---

## 1. Verificações estáticas

```text
node tools/check-syntax.cjs
Tudo certo: sintaxe e JSON válidos.

npm test
tests 64
pass 64
fail 0
```

### 1.1. Distribuição dos testes

| Arquivo | Testes | Situação |
|---|---:|---|
| `tests/api.test.mjs` | 8 | aprovado |
| `tests/consent.test.mjs` | 5 | aprovado |
| `tests/engine.test.mjs` | 9 | aprovado (2 novos na M3) |
| `tests/static.test.mjs` | 10 | aprovado |
| `tests/wdl.test.mjs` | 8 | aprovado |
| `tests/storage.test.mjs` | 5 | aprovado (1 novo na M1) |
| `tests/queue.test.mjs` | 19 | **novo** (11 na M1 + 8 na M4) |
| **Total** | **64** | **64 aprovados** |

A suíte anterior tinha 42 testes; a M1 acrescentou 12 (11 da fila + 1 de
identidade) e a M3/M4 acrescentou 10 (8 de lease/checkpoint + 2 de validação de
retomada). Nenhum teste antigo foi alterado.

### 1.2. Cobertura unitária da fila (`tests/queue.test.mjs`)

O arquivo real `js/queue.js` é carregado em `vm`, sem navegador. Cobre:

1. `normalize` devolve o contrato completo com defaults seguros.
2. Prioridade preserva a ordem do lote (`Date.now() + índice`).
3. Entrada sem `key`, sem `gameId` ou com `depth` inválida é descartada.
4. `positionsTotal` ausente/inválido vira `null`, não `0`.
5. `plan` ignora quem já está ativo.
6. `plan` deduplica dentro do próprio lote.
7. `done`/`canceled` não ocupam vaga no teto.
8. Teto é respeitado e o excedente é reportado.
9. Teto padrão é 200 (205 candidatos → 200 aceitos, 5 recusados).
10. `plan` não altera os candidatos originais.
11. Estados ativos e terminais são exclusivos.

`tests/storage.test.mjs` ganhou o teste “fila usa exatamente a mesma chave da
análise”, que confere `DB.queueKey === DB.analysisKey` nas formas com e sem
build.

A M4 acrescentou oito testes em `tests/queue.test.mjs`:

12. Lease ativo com 19 s e expirado com 20/21 s.
13. `nextItem` escolhe o primeiro executável por prioridade.
14. `nextItem` respeita lease ativo e libera o expirado.
15. `validateCheckpoint` aceita checkpoint consistente.
16. Checkpoint ausente significa começar do zero (`empty: true`).
17. Cada campo divergente (chave, partida, profundidade, build, FEN inicial,
    tamanho, FEN de retomada) rejeita o checkpoint.
18. `resumeAt` fora da partida ou sem posições suficientes é rejeitado.
19. Checkpoint que já cobre a partida inteira é aceito.

`tests/engine.test.mjs` ganhou dois testes da M3: `startIndex` inválido e
`seedPositions` incompletas falham com `RangeError` **antes** de iniciar o
Worker.

---

## 2. Ensaio real com IndexedDB

Harness: `C:\Users\ademi\AppData\Local\Temp\opencode\cdp-m1-db.mjs`  
Execução: Edge headless com perfil limpo, CDP em `9333`.

O harness cria um banco `acervo64` **na versão 1** em uma página 404 do mesmo
origin, com uma partida, um PGN, uma análise SF10 (`key = g_v1@12`) e o marcador
de migração. Só então abre o app, que pede a versão 2.

### 2.1. Upgrade v1 → v2 sem perda

```json
"seeded": { "version": 1 },
"upgraded": {
  "version": 2,
  "stores": ["ai", "analysis", "checkpoints", "data", "games", "meta", "queue"],
  "queueIndexes": ["gameId", "priority", "state"],
  "checkpointIndexes": ["gameId"],
  "analysis": {
    "key": "g_v1@12",
    "version": 2,
    "engine": "Stockfish 10 (WASM)",
    "engineBuild": "stockfish-10-legacy",
    "createdAt": 111
  },
  "game": {
    "id": "g_v1",
    "analyzedDepth": 12,
    "analyzedBuild": "stockfish-10-legacy"
  },
  "data": { "ids": "g_v1", "moves": 2 },
  "analysisCount": 1
}
```

Confirma: upgrade **aditivo**, os cinco stores antigos intactos, análise legada
com chave, versão, build e `createdAt` originais, e os dois stores novos com
seus índices.

### 2.2. Teto de 200 e dedupe

```json
"cap": {
  "first":  { "added": 200, "skipped": 0,   "rejected": 5, "capReached": true },
  "second": { "added": 0,   "skipped": 200, "rejected": 5, "capReached": true },
  "stored": 200,
  "active": 200,
  "firstKeys": [
    "g_q1@12@stockfish-19-lite-single",
    "g_q2@12@stockfish-19-lite-single",
    "g_q3@12@stockfish-19-lite-single"
  ],
  "sortedByPriority": true
}
```

- Lote de 205: 200 aceitos, 5 recusados pelo teto.
- Reenvio do mesmo lote: 0 adicionados, 200 ignorados (dedupe) e 5 recusados
  pelo teto, sem duplicar registros.
- Ordem de leitura é `priority` crescente.

### 2.3. Vaga liberada por item terminal

```json
"freed": {
  "added": 10,
  "rejected": 0,
  "capReached": false,
  "total": 210,
  "active": 200,
  "done": 10
}
```

Dez itens marcados como `done` deixaram de ocupar vaga; dez novos entraram. O
store tem 210 registros, mas apenas 200 ativos — o teto conta estados ativos,
não o total histórico.

### 2.4. Build diferente = chave diferente

```json
"otherBuild": {
  "added": 1,
  "rejected": 0,
  "keys": [
    "g_q11@12@stockfish-10-legacy",
    "g_q11@12@stockfish-19-lite-single"
  ],
  "distinct": true
}
```

A mesma partida na mesma profundidade, com outro build, coexiste como registro
distinto. Nenhuma sobrescrita.

> Nota de transparência: a primeira execução deste cenário removeu o item antigo
> antes de comparar as chaves, então só uma chave existia. O defeito era do
> harness, não do código. O harness foi corrigido para liberar uma vaga sem
> remover o item e a execução seguinte passou.

### 2.5. Checkpoint: gravar, ler, atualizar, apagar

```json
"checkpoint": {
  "savedResumeAt": 1,
  "updatedResumeAt": 2,
  "rereadResumeAt": 2,
  "hasTimestamps": true
}
```

`afterDelete` retornou `undefined` (omitido no JSON), confirmando a remoção.

### 2.6. `deleteGame` em cascata

```json
"deleted": {
  "before": { "queue": 1, "checkpoint": 1, "otherCheckpoint": 1 },
  "after": {
    "queue": 0,
    "checkpoint": 0,
    "otherCheckpoint": 1,
    "otherQueue": 1,
    "legacyAnalysis": true
  }
}
```

A partida alvo perdeu fila e checkpoint; a partida vizinha manteve os seus e a
análise legada continuou intacta.

### 2.7. Rollback: banco em v3, app em v2

```json
"rolledBack": 3,
"readyAfterRollback": true,
"afterRollback": { "version": 3, "queue": 210, "analyses": 1 }
```

O banco foi elevado para a versão 3 e o app recarregado pedindo a versão 2. O
patch de compatibilidade abriu sem rebaixar, manteve fila e análise, e emitiu
apenas o aviso esperado:

```text
Banco local em versão mais nova; abrindo sem rebaixar.
```

### 2.8. `clearAll`

```json
"cleared": {
  "ai": 0, "analysis": 0, "checkpoints": 0, "data": 0,
  "games": 0, "meta": 0, "queue": 0
}
```

Os sete stores foram esvaziados.

### 2.9. Console

```json
"consoleErrors": []
```

Nenhum erro de console em toda a execução. Os dois avisos de fallback são o
texto esperado do patch de rollback ao abrir um banco que já estava em v3 — não
são erros.

---

## 3. M3 — retomada no motor

`Engine.analyzeGame` passou a aceitar `startIndex`, `seedPositions` e
`onPosition`:

- `startIndex` é validado **antes** de iniciar o Worker (`RangeError` se não for
  inteiro entre 0 e `moves.length + 1`).
- `seedPositions` precisa cobrir exatamente o prefixo `0..startIndex-1`.
- `onPosition` é aguardado pelo motor; é ele que grava o checkpoint antes de a
  próxima posição começar.
- `buildAnalysis` continua recebendo o array completo. **Nenhuma** mudança em
  WDL, `scoreSource`, `version` ou classificação.

### 3.1. Igualdade entre retomada e caminho contínuo

Para eliminar o efeito do hash do Stockfish entre execuções, o ensaio usa
profundidade 1 e reinicia o Worker (`Engine.stop()`) antes de cada caminho. O
prefixo de 4 posições foi produzido, o Worker foi reiniciado e a análise
retomou de `startIndex 4` com `seedPositions` de 4 itens.

```json
"equality": {
  "prefix": 4,
  "want": 4,
  "resumed": {
    "cp": [29, -7, 12, -16, 12, 2],
    "best": ["e2e4", "e7e5", "b1c3", "b8c6", "d2d4", "g8e7"],
    "win": [52.5, 50.5, 50.85, 51.2, 50.85, 49.85],
    "version": 3,
    "scoreSource": "wdl"
  },
  "continuous": {
    "cp": [29, -7, 12, -16, 12, 2],
    "best": ["e2e4", "e7e5", "b1c3", "b8c6", "d2d4", "g8e7"],
    "win": [52.5, 50.5, 50.85, 51.2, 50.85, 49.85],
    "version": 3,
    "scoreSource": "wdl"
  },
  "match": true
}
```

`cp`, `mate`, `best`, `winPctWhite`, `version` e `scoreSource` são idênticos.

---

## 4. M4 — executor, lease e queda de aba

Harness: `C:\Users\ademi\AppData\Local\Temp\opencode\cdp-m34.mjs`  
Perfil limpo, duas abas reais (`A` dona e `B` observadora), engine real.

### 4.1. Pausa com outra aba observando

A pausa foi disparada pelo `onPosition` no instante em que a quarta posição
terminou (gancho do harness, não do código de produção). A aba `B` já estava
**observando** a mesma fila — era o cenário em que a observadora poderia
desfazer a pausa assumindo o lease.

```json
"pause": {
  "started": { "role": "owner" },
  "observerStart": { "role": "observer" },
  "bObserver": true,
  "triggered": true,
  "pausedOk": true,
  "afterPause": {
    "state": "paused",
    "attempts": 1,
    "positionsDone": 4,
    "leaseOwner": null,
    "lastError": "pausada pelo usuário",
    "checkpoint": { "resumeAt": 4, "positions": 4 },
    "lease": null
  },
  "afterHold": {
    "state": "paused",
    "attempts": 1,
    "positionsDone": 4,
    "leaseOwner": null,
    "checkpoint": { "resumeAt": 4, "positions": 4 },
    "lease": null
  },
  "bStatusAfterPause": { "running": false, "role": "idle" },
  "bClaimsAfterPause": [{ "itemKey": null }],
  "resumed": { "started": true, "role": "owner" },
  "doneOk": true,
  "done": {
    "state": "done",
    "attempts": 2,
    "positionsDone": 21,
    "checkpoint": null,
    "analysis": { "positions": 21, "version": 3, "scoreSource": "wdl" },
    "game": { "analyzedDepth": 6, "summary": true }
  }
}
```

`bClaimsAfterPause` mostra que `B` **assumiu** o lease depois da pausa, mas
devolveu-o em seguida: o item permaneceu `paused` e `positionsDone` não mudou
durante 3,5 s (mais que o watchdog de 2 s). Só o `start()` explícito de `A`
limpou a pausa global e retomou de `resumeAt 4`.

Confirma: pausa grava checkpoint, libera o lease, não é desfeita pela
observadora, `attempts` só aumenta na retomada, e o `done` remove o checkpoint.

### 4.2. Queda real do renderer e retomada pela outra aba

`A` estava analisando com `positionsDone: 8` e checkpoint em `resumeAt: 8`.
`B` já estava conectada como **observadora** ao mesmo tempo.

```json
"beforeCrash": {
  "state": "running",
  "attempts": 1,
  "positionsDone": 8,
  "leaseOwner": "<aba A>",
  "checkpoint": { "resumeAt": 8, "positions": 8 },
  "lease": { "tabId": "<aba A>", "itemKey": "g_crash@8@..." }
},
"observerStart": { "started": true, "role": "observer" },
"bObserver": true,
"crashMethod": "Page.crash",
"bAlive": true,
"bClaimSeen": true,
"claimAfterCrash": { "at": "<crash + 19297 ms>" },
"takeoverMs": 19297
```

O renderer de `A` foi derrubado com `Page.crash` (sem `pagehide`). `B`
sobreviveu, o lease expirou em **19,297 s** e `B` assumiu — a assunção é medida
pelo `DB.claimLease` bem-sucedido, não por um poll de `role` (a análise em
depth 8 termina rápido). A retomada real foi medida dentro do
`Engine.analyzeGame`:

```json
"resumeCalls": [
  { "gameId": "g_crash", "startIndex": 8, "seeds": 8 }
],
"done": {
  "state": "done",
  "attempts": 2,
  "positionsDone": 21,
  "checkpoint": null,
  "analysis": {
    "positions": 21,
    "version": 3,
    "scoreSource": "wdl",
    "engineBuild": "stockfish-19-lite-single"
  },
  "game": { "analyzedDepth": 8, "summary": true }
}
```

Nenhuma posição foi reanalisada do zero: `B` recebeu as 8 posições já
verificadas e continuou da 9ª. `attempts` foi de 1 para 2 e o checkpoint foi
removido na conclusão.

### 4.3. BroadcastChannel

A aba `B` registrou no canal os eventos de `A` e os da própria `B` (o listener
do harness é um canal separado na mesma aba, então enxerga os dois lados):

```json
"eventsSeen": [
  "lease-taken", "lease-seen", "item-start",
  "item-progress", "item-progress", "item-progress", "item-progress",
  "queue-paused",
  "lease-taken", "item-start",
  "item-progress", "item-progress", "item-progress", "item-progress",
  "item-progress", "item-progress", "item-progress", "item-progress",
  "item-progress", "item-progress"
]
```

Isso comprova o canal real entre abas. O lease continua sendo a autoridade
final: o BroadcastChannel só acorda/avisa; a escrita exige `leaseOwner ===
tabId` dentro da transação.

### 4.4. Console

```json
"consoleErrors": { "B": [] }
```

Nenhum erro na aba que sobreviveu. `Page.crash` derruba o renderer de `A` por
definição, então o console dela não é coletável depois do crash.

---

## 5. O que a M1–M4 **não** testaram

| Item | Motivo |
|---|---|
| UI da Central de Análises | fora do escopo até a M5 |
| Retry manual pela interface | sem UI nesta etapa; a regra de estados já está fixada |
| Cancelamento pela interface | a transição `canceled` existe no storage, mas a UI é M5 |
| Simulação de quota cheia | `QuotaExceededError` está tratado no executor, mas não foi forçado no harness |
| Duas abas disputando o teto ao mesmo tempo | a decisão ocorre dentro de uma transação `readwrite`, mas a corrida de enfileiramento não foi executada |
| Retomada com worker de outra aba já aquecido | o ensaio usa Worker novo após o crash; o resultado é idêntico ao caminho contínuo em depth 1 |

Nenhuma dessas lacunas bloqueia a M3/M4: todas pertencem à M5 ou a um teste de
estresse separado.

---

## 6. Como reproduzir

```powershell
# servidor local e Edge headless (CDP 9333) já ativos
node tools/check-syntax.cjs
npm test
node "C:\Users\ademi\AppData\Local\Temp\opencode\cdp-m1-db.mjs"   # M1
node "C:\Users\ademi\AppData\Local\Temp\opencode\cdp-m34.mjs"    # M3/M4
```

Os dois harnesses são destrutivos para o perfil usado: eles apagam e recriam o
banco `acervo64`. Rodar sempre com perfil limpo. O `cdp-m34.mjs` derruba o
renderer da aba A de propósito (`Page.crash`); é esperado que ela não responda
mais.
