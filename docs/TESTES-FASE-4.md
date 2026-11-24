# Testes da Fase 4 — Chess-Analysis (Integrações)

**Data:** 24/11/2026
**Escopo desta rodada:** M4.1 — regras puras de integração (`js/sources.js`)
**Ambiente:** Windows, Node v26.13.1
**Branch:** `fase-4-integracoes`

> Todos os números abaixo vieram de execução real nesta máquina. Nada foi
> estimado. O que não foi executado está marcado como **não executado**.

---

## 1. Verificações estáticas

```text
node tools/check-syntax.cjs
Tudo certo: sintaxe e JSON válidos.

npm test
tests 101
pass 101
fail 0
```

### 1.1. Distribuição dos testes

| Arquivo | Testes | Situação |
|---|---:|---|
| `tests/api.test.mjs` | 8 | aprovado |
| `tests/consent.test.mjs` | 5 | aprovado |
| `tests/engine.test.mjs` | 9 | aprovado |
| `tests/static.test.mjs` | 13 | aprovado |
| `tests/wdl.test.mjs` | 8 | aprovado |
| `tests/storage.test.mjs` | 5 | aprovado |
| `tests/queue.test.mjs` | 19 | aprovado |
| `tests/queue-ui.test.mjs` | 6 | aprovado |
| `tests/report.test.mjs` | 8 | aprovado (revisão do PDF) |
| `tests/sources.test.mjs` | 20 | **novo na M4.1** |
| **Total** | **101** | **101 aprovados** |

Os 101 testes rodam em Node, sem navegador e sem rede. `js/sources.js` é
carregado em `vm` do mesmo jeito que `js/queue.js`.

---

## 2. O que a M4.1 cobre

`js/sources.js` é um módulo browser-global puro: não faz `fetch`, não toca no
DOM e não grava nada. Ele concentra as decisões que a sincronização (M4.3) e
os proxies (M4.2) vão usar.

| Bloco | Regras verificadas |
|---|---|
| Usuário | `normalizeUsername` aceita `@Nome`, URL do perfil e maiúsculas; `validateUsername` separa vazio, inválido por fonte e válido (Chess.com 3–25, Lichess 2–30) |
| Período | `monthKey` (Date, timestamp, `YYYY-MM`, `YYYY-MM-DD`), `parseMonth`, `monthsBack` (3 meses por padrão, virada de ano, trava em 24), `monthsBetween` (ordem, inclusivo, `period_too_long`) |
| URLs oficiais | perfil, arquivos mensais e PGN do Chess.com em `YYYY/MM`; perfil e exportação PGN do Lichess |
| Sanitização do Lichess | só parâmetros da whitelist entram (`max`, `since`, `until`, `rated`, `perfType`, `color`, `clocks`, `evals`, `opening`, `moves`); `max` limitado a 100; `perfType` normalizado e sem duplicatas; `rated`/`color` validados |
| URLs do proxy | `/api/chesscom` e `/api/lichess`, query determinística, parâmetros vazios descartados |
| Identidade externa | `Link` do Chess.com (`daily` e `live`), `GameId`/`Site` do Lichess, dica de fonte, e `null` quando o PGN não traz identidade |
| Origem exibida | `detectSource` e `gameSource` (campo explícito vence; partida antiga cai em `manual`) |
| Erros | `retryAfterMs` em segundos e data HTTP (nunca negativo), `classifyResponse` para 200 JSON/PGN, 200 com HTML, 304, 401, 403, 404, 418, 429, 500/503 e status 0, `backoffMs` com teto |

Teste destacado: **um 200 com `text/html` no lugar do PGN não é sucesso**. É
exatamente o que o Lichess devolve quando a requisição não traz User-Agent
descritivo, e o erro precisa aparecer como `invalid_response`, não como uma
importação vazia.

### 2.1. Verificação com PGN real

Além dos testes sintéticos, `js/sources.js` foi carregado em `vm` e alimentado
com amostras reais das duas APIs.

Lichess (`https://lichess.org/api/games/user/thibault?max=1`):

```text
PGN real do Lichess: https://lichess.org/game/rBRo2im9
externalId: {"source":"lichess","externalId":"rBRo2im9","sourceUrl":"https://lichess.org/rBRo2im9"}
gameSource: lichess
validateUsername(White): {"ok":true,"username":"thibault"}
proxy: /api/lichess?username=thibault&max=100
```

Chess.com (arquivo mensal de 10/2026, 1.174 partidas):

```text
Link real: https://www.chess.com/game/live/186299800014
externalId: {"source":"chesscom","externalId":"186299800014","sourceUrl":"https://www.chess.com/game/live/186299800014"}
gameSource: chesscom
classifyResponse(200 html): {"status":200,"ok":false,"error":"invalid_response",...}
```

---

## 3. Contrato real das APIs (verificado em 24/11/2026)

| Verificação | Chess.com | Lichess |
|---|---|---|
| CORS | `Access-Control-Allow-Origin: *` | `access-control-allow-origin: *` |
| Cache | `ETag`, `Last-Modified`, `max-age=5` | `ETag` por recurso |
| Usuário inexistente | HTTP 404, corpo vazio | HTTP 404, `{"error":"Not found"}` |
| Sem User-Agent descritivo | **200 com HTML de desafio Cloudflare** (curl padrão) | **404 com HTML** |
| Com `User-Agent: Acervo64/1.0` | 200 + PGN | 200 + PGN |
| Identidade no PGN | `[Link "https://www.chess.com/game/daily/82586502"]` | `[GameId "rBRo2im9"]` + `[Site ".../game/rBRo2im9"]` |

Consequência de arquitetura: o navegador não pode definir `User-Agent`, e as
**duas** APIs recusam cliente genérico — o Chess.com chega a devolver **200 com
HTML** de desafio do Cloudflare, o que passaria por sucesso se ninguém olhasse o
`Content-Type`. Por isso:

- as chamadas de produção passam pelos proxies `api/chesscom.js` e
  `api/lichess.js` (M4.2), que assinam a requisição;
- um 200 com `text/html` é classificado como `invalid_response`, nunca como
  PGN válido;
- o `servidor.ps1` vai espelhar as duas rotas para que o desenvolvimento local
  use o mesmo caminho da produção.

---

## 4. O que ainda não foi executado

| Item | Situação |
|---|---|
| `api/chesscom.js` / `api/lichess.js` | **não implementados** (M4.2) |
| Espelho das rotas no `servidor.ps1` | **não implementado** (M4.2) |
| Modal de sincronização e faixa de fontes | **não implementados** (M4.3) |
| Sincronização real com conta de usuário | **não executada** (M4.4) |
| 429 real forçado | **não executado** (M4.4, simulação planejada) |
| 200 com HTML de desafio (Cloudflare) | **reproduzido de verdade** via curl sem UA em 24/11/2026; a suíte cobre a classificação |
| `js/sources.js` carregado no `index.html` | **não** — entra na M4.3, quando a UI existir |

Nenhum teste desta rodada faz requisição de rede, abre navegador ou grava no
IndexedDB.
