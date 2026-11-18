# Modelo de dados — Chess-Analysis

**Versão:** 1.3 — Fase 3/M1 (fila e checkpoints)  
**Atualizado em:** 18/11/2026  
**Estado:** contratos documentados; persistência de `PlayerIdentity` fica para a
Fase 5. O `wdl`, a `version: 3`, a chave `gameId@depth@build` e a migração de
proveniência estão **implementados** (Tarefa 2). As **7 categorias atuais estão
aprovadas**; as 3 categorias restantes (Grande Lance, Livro, Bom) estão
**deferidas** para a Fase 2.5/5 — ver §3.2. O banco está na **versão 2** desde a
M1 da Fase 3, com os stores `queue` e `checkpoints` — ver §5.

Este documento descreve as estruturas **realmente usadas** hoje e os contratos
previstos. Onde a estrutura ainda não existe no código, o texto indica isso.

---

## 1. Convenções

- Identificadores internos são strings estáveis e não dependem do nome exibido.
- Datas de calendário usam `YYYY-MM-DD` (`dateISO`).
- Datas de operação usam epoch em milissegundos (`createdAt`, `importedAt`).
- Campos ausentes são omitidos ou `null`; nunca preenchidos com dados inventados.
- O banco IndexedDB mantém o nome legado `acervo64` para não apagar a
  biblioteca existente. O nome é um identificador de compatibilidade. A versão
  é `2` desde a M1 da Fase 3; bancos em versão mais nova são abertos **sem
  rebaixar** (ver §5.5).

---

## 2. Entidades atuais

### 2.1. Partida (`games`)

Chave: `id`.

| Campo | Tipo | Observação |
|---|---|---|
| `id` | string | determinístico a partir de jogadores, resultado e lances; cópias recebem `_c2`, `_c3` |
| `white`, `black` | string | nomes originais do PGN, preservados |
| `whiteElo`, `blackElo` | number \| null | somente quando o PGN informa |
| `result` | `1-0` \| `0-1` \| `1/2-1/2` \| `*` | |
| `dateISO`, `year` | string \| number | |
| `event`, `site`, `round` | string | |
| `eco`, `opening` | string | abertura reconhecida pela base local |
| `timeControl` | string | |
| `plyCount` | number | meia-jogadas |
| `headers` | object | cabeçalhos PGN preservados |
| `sourceFile` | string | arquivo de origem |
| `importedAt` | number | epoch ms |
| `favorite` | boolean | |
| `tags` | string[] | tags livres do usuário |
| `aiTags` | string[] | tags sugeridas pela IA |
| `sideTags` | object | tags calculadas por lado |
| `analysisSummary` | object \| null | resumo numérico da análise salva; inclui `engineBuild` e `scoreSource` |
| `analyzedDepth` | number | maior profundidade concluída |
| `analyzedBuild` | string \| null | build da última análise; diferente de `Engine.BUILD_ID` marca necessidade de reanálise |
| `copyOf` | string | presente apenas em cópias |

### 2.2. Dados da partida (`data`)

Chave: `id` (mesmo da partida).

| Campo | Tipo | Observação |
|---|---|---|
| `id` | string | |
| `startFen` | string | posição inicial (FEN) |
| `moves` | array | `{san, from, to, promotion, fen}` por meia-jogada |
| `pgn` | string | PGN **normalizado** gerado pelo aplicativo |

**Limitação conhecida:** o parser atual ignora comentários `{ }`, `;`, NAGs e
variações `( )`. O campo `pgn` não é o texto original bruto. Por isso o
relatório e a IA não podem exibir variantes do PGN nesta versão.

### 2.3. Análise (`analysis`)

Chave: `key = gameId@depth@engineBuild` nas análises novas; `key = gameId@depth`
nas análises anteriores à Tarefa 2 (preservadas como estão). Índice `gameId`.

O build **entra na chave** de propósito: duas análises da mesma partida na mesma
profundidade, uma do SF10 e outra do SF19, são registros distintos e coexistem.
Uma reanálise nunca sobrescreve o resultado anterior. A função canônica é
`DB.analysisKey(gameId, depth, build)`; quando `build` é omitido, ela devolve a
forma legada `gameId@depth`.

| Campo | Tipo | Observação |
|---|---|---|
| `gameId` | string | |
| `depth` | number | profundidade solicitada |
| `version` | number | `2` = win% pela curva sobre `cp`; `3` = win% derivado do WDL (§2.3.1) |
| `engine` | string | rótulo de exibição; o motor atual grava “Stockfish 19 Lite WASM” |
| `engineId` | string \| null | opcional; linha `id name` devolvida pelo UCI. Ausente nas análises antigas |
| `engineBuild` | string | identidade estável do build: `stockfish-19-lite-single` ou `stockfish-10-legacy`/`legacy-unknown`. Entra na `key` e no `summary` |
| `scoreSource` | `wdl` \| `cp` | fonte usada no **array inteiro** de `winPctWhite`. Nunca misturada por posição |
| `wdlCoverage` | object | `{complete, evaluated, present, missing, invalid}` — diagnóstico da escolha da fonte |
| `positions` | array | `{cp, mate, depth, best, pv, wdl?}` por posição |
| `moves` | array | classificação por meia-jogada |
| `winPctWhite` | number[] | 0–100 |
| `accuracy` | `{w,b}` | 0–100 |
| `acpl` | `{w,b}` | centipeões |
| `counts` | `{w,b}` | contagem por categoria |
| `phaseAccuracy` | object | abertura/meio-jogo/final |
| `phaseBlunders`, `phaseBrilliants` | object | |
| `keyMoments` | array | até 8 momentos críticos |
| `summary` | object | cópia compacta para a biblioteca; inclui `engineBuild` e `scoreSource` |
| `createdAt` | number | |

Cada item de `moves` contém: `loss` (pontos percentuais), `cpLoss`,
`annotation`, `symbol`, `label`, `bestSan`, `before`, `after`, `phase`,
`sacrifice`, `isBest`, `missed`, `brilliant`.

#### 2.3.1. Item de `positions` e o campo aditivo `wdl` (versão 3)

| Campo | Tipo | Obrigatório | Regra |
|---|---|---|---|
| `cp` | number \| null | sim | centipeões do ponto de vista de quem joga; `null` quando a linha é de mate |
| `mate` | number \| null | sim | em lances para mate; positivo = quem joga dá mate |
| `depth` | number | sim | profundidade da última linha aceita |
| `best` | string \| null | sim | lance UCI (`e2e4`, `e7e8q`) ou `null` |
| `pv` | string[] | sim | linha principal em UCI; pode ser vazia |
| `wdl` | `{w,d,l}` \| ausente | **não** | probabilidades em **por-mil** (0–1000), do ponto de vista de quem joga naquela posição |

Regras do `wdl`:

1. Só existe quando o motor responde com `UCI_ShowWDL` ativo e a linha `info`
   trouxer o trio `wdl <w> <d> <l>`. Desde a Tarefa 1 da Fase 2 o campo é
   gravado nas análises **v2** como dado bruto, sem entrar no cálculo.
2. São inteiros; a soma é 1000 (`l = 1000 − w − d`).
3. A perspectiva é a **de quem joga** — a mesma de `cp` e `mate`. Não inverter
   duas vezes ao converter para brancas.
4. Nunca é inventado: análise antiga ou linha sem WDL fica **sem** o campo.
   `0 0 0` não é valor válido.
5. É aditivo: `cp`, `mate`, `best` e `pv` continuam obrigatórios e com o mesmo
   significado. Nada é removido nem renomeado.
6. Em posição terminal, a análise é gravada **sem consultar o motor**:
   xeque-mate → `{ cp: null, mate: 0, depth: 0, wdl: null }`; afogamento ou
   material insuficiente → `{ cp: 0, mate: null, depth: 0, wdl: null }`.
   `mate: 0` significa que o lado a jogar está em mate — não é ausência de
   avaliação. `depth 0` sozinho não identifica terminalidade.

Conversão canônica para a matriz já existente:

```text
esMover     = (w + d / 2) / 10           // 0–100, em %
whiteWinPct = índice par  ? esMover : 100 − esMover
```

`winPctWhite` continua sendo o array canônico consumido pelo gráfico e pelo
relatório. A `version: 3` indica que ele foi derivado do WDL; a `version: 2`
indica que veio da curva logística sobre `cp`.

#### 2.3.2. Compatibilidade entre versões de análise

| `version` | Conteúdo | Leitura |
|---|---|---|
| `1` | `positions` + `winPctWhite`, sem `moves` anotados | Reconstruída por `Engine.enrichAnalysis` |
| `2` | Acrescenta `moves`, `accuracy`, `acpl`, `counts`, fases e momentos; win% pela curva logística. Pode carregar `positions[i].wdl` bruto | Fonte `cp`. Análises antigas **permanecem** v2 |
| `3` | `version: 2` + `scoreSource: 'wdl'` + `wdlCoverage`; win% derivado do WDL | Implementada na Tarefa 2 para análises novas com WDL completo |

Regras de migração e leitura:

- A ausência de `wdl` **não** é erro: significa “usar a curva logística”.
- A fonte é decidida **por análise**: se qualquer posição não terminal não tiver
  WDL válido, a análise inteira fica em v2 com a curva sobre `cp`
  (`scoreSource: 'cp'`). Não se mistura WDL e cp posição a posição.
- Posições terminais ficam fora da exigência de WDL (`depth 0`, sem `best`/`pv`,
  com `mate`/`cp`), porque o SF19 não envia WDL nelas. O mate continua
  prioritário no Expected Score.
- Não se regrava análise antiga apenas para preencher `wdl`.
- `enrichAnalysis` não inventa `wdl`, não eleva `version` e preserva `engine`,
  `engineId`, `engineBuild`, `scoreSource` e `key` originais. Se reconstruir uma
  análise v2, recalcula com a curva de `cp` mesmo que exista `wdl` gravado.
- Uma análise v3 pode ser lida por código que ignore `wdl` sem perder dados.

#### 2.3.3. Proveniência e migração (resolvido na Tarefa 2)

Antes da Tarefa 2 a chave `gameId@depth` não identificava o motor: `getAnalysis`
devolvia a análise de maior profundidade de qualquer build, `buildAnalysis`
carimbava o `engineId` atual ao reconstruir v1 e `analysisSummary` misturava
motores nas médias. A solução implementada cobre os seis pontos exigidos:

1. **Identidade estável** — `Engine.BUILD_ID = 'stockfish-19-lite-single'`.
   O `id name` do UCI não é usado como chave (muda entre releases).
2. **Chave com build** — `gameId@depth@build`. A forma legada continua válida.
3. **Recuperação de análises antigas** — `Engine.buildOf(record)` usa
   `engineBuild`, depois `build`, depois infere por `engineId`/`engine`
   (SF19 → build atual; SF10 → `stockfish-10-legacy`; desconhecido →
   `legacy-unknown`). `isLegacyAnalysis` alimenta o aviso na interface.
4. **Leitura sem mistura** — `DB.getAnalysis(gameId, build)` prefere o build
   atual e só cai para o legado se não houver registro do build pedido.
   `DB.getAnalyses(gameId)` devolve todos, para diagnóstico e limpeza.
5. **Migração segura** — `migrateAnalysisProvenance` grava `engineBuild` no
   **mesmo registro e mesma chave**, sem tocar em posições, resumos, `createdAt`
   ou `version`. Marcador `analysisProvenanceMigration = 1`. Ela roda antes de
   `migrateAnalysisData`, que só reconstrói registros v1 sem anotações.
6. **Consistência dos resumos** — `summary.engineBuild` é gravado junto da
   análise; `game.analyzedBuild` acompanha. As médias de Desempenho ignoram
   partidas de outro build e exibem a contagem (`stats.otherEngine`).

Garantia central: uma análise do SF10 com chave `gameId@depth` **nunca** é
sobrescrita por `saveAnalysis`, porque esta preserva a `key` existente e a
análise nova nasce em `gameId@depth@build`.


### 2.4. Conteúdo de IA (`ai`)

Chave: `key = gameId:kind`; índice `gameId`.

| Campo | Tipo |
|---|---|
| `gameId` | string |
| `kind` | `summary` \| `tags` |
| `text` | string |
| `tags` | string[] |
| `model` | string |
| `depth` | number \| null |
| `createdAt` | number |

### 2.5. Chaves auxiliares (`meta`)

Chave: `key`.

Exemplos: `analysisMigration` (reconstrução de anotações v1),
`analysisProvenanceMigration` (carimbo de `engineBuild`/`analyzedBuild`, valor
`1`), `insights`, `repertoire`. O valor é gravado em
`{ key, value, createdAt }`.

### 2.6. Preferências (`localStorage`)

Chave legada: `acervo64_settings_v1`.

| Campo | Tipo | Padrão |
|---|---|---|
| `theme` | `dark` \| `light` | `dark` |
| `playerNames` | string | vazio |
| `depth` | number | 12 |
| `pageSize` | number | 50 |
| `ai.mode` | `auto` \| `proxy` | `auto` |
| `ai.proxyUrl` | string | vazio |
| `ai.model` | string | vazio (vem do servidor) |
| `ai.temperature` | number | 0.3 |
| `ai.numCtx` | number | 4096 |
| `ai.privacy.blocked` | boolean | `false` |
| `ai.privacy.consentVersion` | string | vazio |
| `ai.privacy.consentAt` | number | 0 |
| `ai.privacy.provider` | string | vazio |

---

## 3. Classificações de movimento

Ordem visual oficial da Fase 1 (7 categorias):

1. Brilhante (`!!`)
2. Excelente (`!`)
3. Melhor (`★`)
4. Ótimo (`👍`)
5. Erro (`?`)
6. Chance Perdida (`×`)
7. Capivarada (`??`)

A ordem **não** é uma escala linear. O destino da Fase 2 tem 10 categorias
(Brilhante, Grande Lance, Melhor, Excelente, Bom, Livro, Imprecisão, Erro,
Chance Perdida, Erro Grosseiro), com critérios versionados, WDL e Expected
Score.

**Estado na Tarefa 2:** o Expected Score já é derivado do WDL (§3.1) e as
**7 categorias atuais estão aprovadas**. A implementação das 10 categorias foi
**deferida para uma fase posterior** (§3.2): além dos limiares, "Grande Lance"
exige MultiPV 2 e "Livro" exige integração com banco de aberturas (ECO) — ambos
fora do escopo estrito da Fase 2 (motor e precisão). Nenhum limiar foi
inventado.

Critérios atuais (em pontos percentuais de vitória — agora calculados sobre a
fonte escolhida para a análise inteira, `wdl` ou `cp`):

| Categoria | Critério resumido |
|---|---|
| Brilhante | sacrifício ≥ 2 peões ou virada, mantendo ≥ 60% e ≥ 55% dois lances depois |
| Melhor | igual ao melhor lance do Stockfish |
| Chance Perdida | antes ≥ 80% (ou mate), depois entre 45% e 70% |
| Capivarada | perda ≥ 30 pp |
| Erro | perda entre 10 e 29,9 pp |
| Excelente | perda ≤ 2 pp |
| Ótimo | perda entre 2 e 9,9 pp |

`Loss = ExpectedScoreBefore − ExpectedScoreAfter`, sempre pela perspectiva de
quem jogou. O ACPL usa centipeões e é apenas comparativo.

### 3.1. Fonte do Expected Score (contrato da versão 3)

**Estado:** implementado na Tarefa 2. Análises novas com WDL completo gravam
`version: 3` e `scoreSource: 'wdl'`; as demais permanecem em v2/`cp`.

| Fonte | Cálculo | Quando usar |
|---|---|---|
| `wdl` (v3) | `(w + d/2) / 10` → 0–100 | quando todas as posições avaliadas têm `wdl` válido |
| curva sobre `cp` (v2) | `50 + 50*(2/(1+exp(-0.00368208*cp))-1)` | quando falta `wdl` em qualquer posição avaliada |

Regras:

1. A fonte é escolhida **por análise**, não por posição: a `version: 3` usa WDL
   em todas as posições avaliadas; se alguma linha não trouxer WDL, a análise
   permanece na versão 2 e usa a curva (`scoreSource: 'cp'`).
2. `mate` continua tendo prioridade: 100% para quem dá mate, 0% para quem
   apanha, independentemente do `wdl`.
3. A perda continua em pontos percentuais e o ACPL continua em centipeões.
4. Se o `wdl` for inconsistente (fora de 0–1000 ou soma diferente de 1000),
   descartar o campo e usar a curva — registrando isso no item, sem inventar
   números. `wdlCoverage` publica `evaluated`, `present`, `missing` e `invalid`.
5. Posições **terminais** são isentas da exigência de WDL: o SF19 não envia o
   trio nelas. Elas não contam em `evaluated` e continuam decididas por
   `mate`/`cp`.
6. `DB.getAnalysis` prefere o build atual; uma análise v2 do SF10 continua
   legível e nunca é promovida a v3 pelo enriquecimento.

### 3.2. Categorias deferidas: MultiPV 2 e Livro

**Decisão de 17/11/2026:** a classificação permanece com **7 categorias**. As
3 restantes do destino de 10 categorias ficam para uma fase futura (Fase 2.5 ou
Fase 5), porque dependem de insumos que não pertencem ao escopo da Fase 2.

| Categoria | O que falta | Onde entra |
|---|---|---|
| **Grande Lance** | `MultiPV 2` no worker (hoje `MultiPV=1`) + critério versionado para o segundo melhor lance | Fase 2.5/5 |
| **Livro** | Fonte de abertura (usar `vendor/eco/openings.json` como reconhecimento de lances, não apenas nome da abertura) | Fase 2.5/5 |
| **Bom** | Faixa intermediária entre "Excelente" e "Imprecisão" | Fase 2.5/5, junto da revisão de limiares |
| Seção 10.11 do Prompt Mestre | Texto com critérios versionados das 10 categorias | Insumo obrigatório antes da implementação |

Regras:

- Nenhum limiar novo é inventado antes da §10.11.
- `Engine.ANNOTATION_ORDER`, `THRESHOLDS` e os símbolos das 7 categorias atuais
  não mudam por causa do deferimento.
- O Expected Score da v3 (WDL) já está pronto para alimentar os critérios
  futuros; não haverá nova migração de dados de análise.
- "MultiPV 2" e "Livro" **não** são requisitos de deploy da Fase 2 e não
  bloqueiam a publicação atual.


---

## 4. `PlayerIdentity` — contrato para a Fase 5

**Estado:** documentado. Ainda não persistido. A identificação atual em
`js/stats.js` é provisória e pode deduzir um jogador pela frequência de nomes;
isso não é `PlayerIdentity`.

```json
{
  "id": "player-001",
  "displayName": "Jogador principal",
  "aliases": [
    { "source": "manual", "username": "JohnDoe" },
    { "source": "chesscom", "username": "johndoe_chess" },
    { "source": "lichess", "username": "john_doe" }
  ],
  "createdAt": 1730000000000,
  "updatedAt": 1730000000000
}
```

### 4.1. Campos

| Campo | Tipo | Regra |
|---|---|---|
| `id` | string | estável; não deriva do nome exibido |
| `displayName` | string | apenas apresentação |
| `aliases` | array | cada item tem `source` e `username` |
| `createdAt`, `updatedAt` | number | epoch ms |

`source` aceita `manual`, `chesscom`, `lichess` e futuras origens
documentadas.

### 4.2. Regras obrigatórias

1. Toda associação é configurada ou confirmada pelo usuário.
2. Nunca inferir que usernames parecidos são a mesma pessoa.
3. Considerar a origem ao comparar aliases.
4. Normalizar usernames conforme a origem (por exemplo, caixa e espaços).
5. Detectar conflitos: o mesmo alias em origens diferentes ou o mesmo usuário
   em duas identidades.
6. Permitir editar e remover aliases.
7. Preservar os nomes originais nos PGNs; a identidade é uma camada separada.
8. Alterar a identidade não altera avaliações objetivas do Stockfish.
9. Recalcular estatísticas dependentes da identidade quando ela mudar.
10. Sem correspondência confiável, a partida continua na biblioteca, mas não
    entra em estatísticas pessoais.

### 4.3. Associação partida ↔ jogador

Para cada partida, a futura camada deve registrar:

| Campo | Tipo | Observação |
|---|---|---|
| `gameId` | string | |
| `playerId` | string \| null | `null` quando não atribuído |
| `color` | `w` \| `b` \| null | cor do jogador naquela partida |
| `matchedBy` | `alias` \| `manual` \| `none` | como a associação foi feita |
| `confirmedAt` | number \| null | |

A cor, o resultado pessoal, o rating, os erros atribuídos e as aberturas
dependem dessa associação. Sem ela, esses campos permanecem indefinidos.

### 4.4. Migração prevista

- Criar store `players` e store `playerGames` em uma nova versão do banco.
- Não renomear nem recriar `games`, `data`, `analysis`, `ai` ou `meta`.
- Executar em transação com verificação de contagem.
- Exportar backup antes da migração.
- Nunca apagar partidas sem correspondência.

---

## 5. Fila e checkpoints (Fase 3)

**Estado: implementado na M1.** O banco está na versão `2`, com os stores
`queue` e `checkpoints`. As regras puras ficam em `js/queue.js`; a persistência,
em `js/storage.js`. Não há interface nem integração com o motor nesta etapa
(M2–M6).

### 5.1. Separação de stores

`queue` e `checkpoints` são stores **separados** de `analysis` de propósito:

- uma análise parcial **nunca** entra em estatísticas, relatório ou gráfico;
- apagar uma partida remove fila e checkpoint dela sem tocar nas análises de
  outras partidas;
- o backup JSON (`exportJson`) **não** exporta fila nem checkpoint: são estado
  efêmero, reconstruível e específico da máquina.

A identidade é a mesma da análise: `DB.queueKey(gameId, depth, build)` delega
para `DB.analysisKey`, produzindo `gameId@depth@build` (ou `gameId@depth` quando
o build é omitido). Fila, checkpoint e resultado falam exatamente do mesmo alvo;
não existe uma segunda regra de identidade.

### 5.2. Item da fila (`queue`)

Chave: `key`. Índices: `state`, `priority`, `gameId`.

| Campo | Tipo | Regra |
|---|---|---|
| `key` | string | `gameId@depth@build` |
| `gameId` | string | partida alvo |
| `depth` | number | profundidade solicitada, inteiro ≥ 1 |
| `engineBuild` | string \| null | build estável (`stockfish-19-lite-single`) |
| `state` | enum | ver §5.3 |
| `priority` | number | menor primeiro; `Date.now() + índice do lote` |
| `attempts` | number | começa em `0`; incrementado só por retry manual |
| `lastError` | string \| null | motivo da última falha |
| `createdAt`, `updatedAt` | number | epoch ms |
| `startedAt`, `finishedAt` | number \| null | preenchidos ao executar/concluir |
| `positionsDone` | number | progresso verificado; começa em `0` |
| `positionsTotal` | number \| null | `null` quando desconhecido — **nunca** `0` por omissão |
| `leaseOwner` | string \| null | reservado ao lease de aba (M4); nasce `null` |
| `heartbeatAt` | number \| null | reservado ao lease de aba (M4); nasce `null` |

Item terminal (`done`/`canceled`) permanece no store para histórico e diagnóstico,
mas **não ocupa vaga** no teto. A remoção física é feita por `removeQueueItem`,
`clearQueue` ou `deleteGame`.

### 5.3. Estados e regras da fila

| Estado | Significado | Ocupa vaga? |
|---|---|---|
| `pending` | aguardando a vez | sim |
| `running` | em execução | sim |
| `paused` | pausada pelo usuário | sim |
| `interrupted` | aba fechou/recarregou ou lease expirou | sim |
| `error` | falhou; exige retry **manual** | sim |
| `done` | concluída | não |
| `canceled` | cancelada pelo usuário | não |

Regras implementadas em `js/queue.js`:

1. `Queue.normalize` devolve o contrato completo com defaults seguros e
   **descarta** entrada sem `key`, sem `gameId` ou com `depth` inválida.
   `positionsTotal` ausente/inválido vira `null`, não `0`.
2. `Queue.plan(active, candidates, max)` deduplica contra os itens ativos **e
   dentro do próprio lote**, respeita o teto de **200 itens ativos** e devolve
   `accepted`, `skipped`, `invalid`, `rejected`, `capReached`.
3. O plano não altera os objetos recebidos; a gravação é responsabilidade da
   persistência.
4. `DB.enqueueAnalyses` lê a fila e decide dedupe/teto **dentro de uma única
   transação `readwrite`**. Duas abas não conseguem furar o teto.
5. A ordem de execução é `priority` crescente (empate por `createdAt`).
6. Não existe retry automático: um item em `error` só volta a `pending` por ação
   explícita do usuário (M3/M4), o que também incrementa `attempts` e preserva
   `lastError`.

### 5.4. Checkpoint (`checkpoints`)

Chave: `key` (a mesma da fila). Índice: `gameId`.

| Campo | Tipo | Regra |
|---|---|---|
| `key` | string | `gameId@depth@build`; obrigatória |
| `gameId` | string | partida alvo |
| `depth` | number | profundidade da execução |
| `engineBuild` | string \| null | build que produziu o checkpoint |
| `positions` | array | avaliações já verificadas, no formato de `analysis.positions` |
| `resumeAt` | number | índice da próxima meia-jogada a analisar |
| `fenAtResume` | string \| null | FEN exata do ponto de retomada |
| `movesLength` | number | total de meias-jogadas do PGN no momento |
| `startFen` | string | posição inicial usada na execução |
| `updatedAt` | number | carimbado por `DB.saveCheckpoint` |

Regras:

- Checkpoint é **progresso parcial**, não resultado: nunca é lido por
  estatísticas, relatório ou gráfico.
- Só se retoma quando `key`, `depth`, `engineBuild`, `movesLength` e
  `fenAtResume` continuam consistentes com a partida e o build atuais (M4).
- Ao concluir a análise, o checkpoint correspondente é apagado (M4).
- `DB.deleteGame` remove os checkpoints da partida pelo índice `gameId`;
  `DB.clearCheckpointsForGame` faz o mesmo sem apagar a partida.

### 5.5. Compatibilidade, rollback e limpeza

- **Upgrade aditivo:** `VERSION = 2` cria apenas `queue` e `checkpoints` se
  faltarem. Nenhum store existente é recriado, limpo ou renomeado.
- **Rollback seguro:** se o navegador já tem o banco em versão maior que a do
  bundle, `DB.open()` recebe `VersionError`, reabre **sem versão declarada** e
  usa os stores conhecidos. Nada é apagado nem rebaixado; um aviso é emitido no
  console. Isso mantém o site utilizável após um rollback na Vercel.
- **Exclusão em cascata:** `deleteGame` apaga `games`, `data`, `analysis`, `ai`,
  `queue` e `checkpoints` da partida alvo; `clearAll` esvazia os sete stores.
- **Backup:** `exportJson` continua exportando apenas `games`, `data`,
  `analysis`, `ai` e `meta`. Fila e checkpoints não são restaurados por
  `importJson`.

---

## 6. Backup JSON

Formato atual:

```json
{
  "app": "chess-analysis",
  "version": 1,
  "exportedAt": "2026-11-16T00:00:00.000Z",
  "stores": { "games": [], "data": [], "analysis": [], "ai": [], "meta": [] }
}
```

A restauração aceita `app` antigo (`acervo64`) para compatibilidade. Antes de
mesclar, o aplicativo valida a estrutura e gera um backup do estado atual.
Autorizações de IA não são restauradas como consentimento válido.
