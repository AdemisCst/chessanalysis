# Testes da Fase 3 — Chess-Analysis

**Data:** 18/11/2026  
**Escopo:** M1 — banco IndexedDB v2, fila de análise e checkpoints  
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
tests 54
pass 54
fail 0
```

### 1.1. Distribuição dos testes

| Arquivo | Testes | Situação |
|---|---:|---|
| `tests/api.test.mjs` | 8 | aprovado |
| `tests/consent.test.mjs` | 5 | aprovado |
| `tests/engine.test.mjs` | 7 | aprovado |
| `tests/static.test.mjs` | 10 | aprovado |
| `tests/wdl.test.mjs` | 8 | aprovado |
| `tests/storage.test.mjs` | 5 | aprovado (1 novo na M1) |
| `tests/queue.test.mjs` | 11 | **novo** |
| **Total** | **54** | **54 aprovados** |

A suíte anterior tinha 42 testes; a M1 acrescentou 12 (11 da fila + 1 de
identidade em `storage.test.mjs`). Nenhum teste antigo foi alterado.

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

## 3. O que a M1 **não** testou

| Item | Motivo |
|---|---|
| UI da Central de Análises | fora do escopo da M1 (M2+) |
| Integração com o motor / execução real da fila | fora do escopo da M1 (M3+) |
| Lease de aba e heartbeat | campos reservados; implementação na M4 |
| Retomada real a partir de checkpoint | regra de consistência e uso ficam na M4 |
| Duas abas disputando o teto ao mesmo tempo | a decisão ocorre dentro de uma transação `readwrite`, mas a corrida real entre abas não foi executada |
| Retry manual pela interface | sem UI nesta etapa; a regra de estados já está fixada |

Nenhuma dessas lacunas bloqueia a M1: todas pertencem a etapas posteriores do
plano.

---

## 4. Como reproduzir

```powershell
# servidor local e Edge headless (CDP 9333) já ativos
node tools/check-syntax.cjs
npm test
node "C:\Users\ademi\AppData\Local\Temp\opencode\cdp-m1-db.mjs"
```

O harness apaga e recria o banco `acervo64` no início, então ele é destrutivo
para o perfil usado. Rodar sempre com perfil limpo.
