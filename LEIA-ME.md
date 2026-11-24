# Chess-Analysis

Aplicativo local para importar, organizar, analisar e estudar partidas de xadrez
em **PGN**. A análise objetiva roda no seu navegador com **Stockfish**. As
estatísticas também são calculadas localmente. O **Treinador IA** é opcional,
usa um provedor externo configurado no servidor e só recebe dados depois da sua
autorização explícita.

O projeto é **HTML5 + CSS3 + JavaScript puro (ES Modules)**. Não usa React,
Vue, Angular, TypeScript, Python nem PHP.

---

## 1. Como abrir

1. Dê duplo clique em **`iniciar.bat`**.
2. O navegador abre em `http://localhost:8765/`.
3. Para encerrar, feche a janela do servidor.

O servidor local é necessário para o **Stockfish** (Web Worker + WebAssembly).
Se você abrir `index.html` diretamente (`file://`), a biblioteca e o backup
funcionam, mas a análise com Stockfish e o Treinador IA ficam indisponíveis.

Requisitos: Windows, PowerShell e um navegador atualizado.

---

## 2. Interface

A navegação principal tem cinco áreas:

1. **Biblioteca** — importação, busca, filtros, tabela, exportação e seleção em
   lote.
2. **Análise** — tabuleiro, lances, avaliação do Stockfish, classificação e IA
   da partida.
3. **Desempenho** — resultados, precisão, rating e evolução. **Aberturas** é uma
   página auxiliar, aberta por botão e sem ocupar o menu principal.
4. **Treinador IA** — leitura do acervo, repertório sugerido e privacidade.
5. **Configurações** — perfil, profundidade do motor, IA, backup e limpeza.

Avançar ou retroceder lances **não troca** a aba Lances/Análise/IA.

---

## 3. Importar partidas

Use **＋ Importar PGN**. O seletor aceita um ou vários arquivos `.pgn` (ou
`.txt`), com várias partidas por arquivo. Não existe mais área de arrastar e
soltar.

A leitura roda em um **Web Worker** (`js/pgn-worker.js`). Se o navegador não
permitir worker, a importação continua na thread principal.

**Carregar exemplos** importa três partidas clássicas para experimentar.

### 3.1 Duplicatas

O aplicativo compara jogadores, data, resultado e sequência de lances. Quando
encontra partidas repetidas, oferece:

- **Importar só as novas** (padrão);
- **Importar todas, criando cópias** (`_c2`, `_c3`…);
- **Cancelar**.

---

## 4. Dizer quem é você

Em **Configurações → Perfil e tabuleiro**, informe como você aparece nos PGN.
Separe apelidos com ponto e vírgula:

```
Silva, Carlos; SilvaCarlos; carlos_silva
```

A vírgula é preservada porque nomes de PGN costumam vir como “Sobrenome, Nome”.
Sem esse campo, o aplicativo tenta deduzir o jogador mais frequente e avisa
quando a dedução é incerta.

Essa identificação é **provisória**. A identidade definitiva (`PlayerIdentity`)
está documentada para a Fase 5.

---

## 5. Analisar

Abra uma partida e clique em **⚡ Analisar**. O Stockfish avalia todas as
posições na profundidade escolhida (padrão 12) e o resultado fica salvo no
IndexedDB: reabrir a partida não refaz a análise.

Para o acervo inteiro, use **Configurações → Analisar partidas pendentes**.
Também é possível analisar apenas as partidas marcadas na biblioteca.

A análise é sempre local. Nada da posição ou dos lances sai do navegador.

### 5.1 Classificações

A interface usa estas classificações:

| Símbolo | Classificação | Critério resumido |
|---|---|---|
| `!!` | Brilhante | sacrifício de material, perda até 2 pp e alternativa segura, sem ser lance forçado |
| `!` | Grande Lance | sem sacrifício, perda até 2 pp e segunda opção perde mais de 10 pp |
| `★` | Melhor | perda zero ou lance da PV principal do Stockfish |
| `!` | Excelente | perda maior que 0 e até 2 pp |
| `✓` | Bom | perda maior que 2 e até 5 pp |
| `📖` | Livro | prefixo ECO reconhecido, exceto erro grosseiro |
| `?!` | Imprecisão | perda maior que 5 e até 10 pp |
| `?` | Erro | perda maior que 10 e até 20 pp |
| `×` | Chance Perdida | antes ≥ 80% (ou mate), depois < 70% e perda ≥ 10 pp |
| `??` | Erro Grosseiro | perda maior que 20 pp |

A ordem não é uma escala linear. O símbolo e o texto são a informação
principal; a cor apenas reforça.

A precisão e o ACPL são calculados a partir da perda de probabilidade de vitória
e de centipeões. O ACPL serve para comparação com outras ferramentas; não é uma
nota absoluta.

---

## 6. Relatório PDF

Na partida, clique em **Relatório PDF**. O aplicativo monta uma página própria,
sem biblioteca externa, e abre o diálogo de impressão do navegador para
“Salvar como PDF”.

O relatório inclui, quando os dados existem:

- ficha da partida;
- precisão e ACPL dos dois lados;
- gráfico da probabilidade de vitória;
- classificação dos lances na ordem oficial;
- precisão por fase;
- momentos críticos, com perda em pontos percentuais e melhor lance;
- variante do Stockfish (PV convertida para SAN), quando registrada;
- resumo do Treinador IA, se houver um salvo;
- recomendações de estudo derivadas dos números.

Se a partida não foi analisada, o relatório diz isso. Nenhuma avaliação, lance
ou variante é inventada.

---

## 7. Desempenho e Aberturas

**Desempenho** mostra resultados por cor, precisão, rating, evolução e fases.
**Aberturas** cruza a base ECO local com os seus resultados e permite filtrar
por cor. A detecção usa o maior prefixo conhecido de lances e não envia nada
para a internet.

---

## 8. Treinador IA

O Treinador IA é opcional. Ele **interpreta** números já calculados pelo
Stockfish; não substitui a análise do motor.

### 8.1 Provedor

O provedor atual é a **Groq**, atrás do proxy da Vercel:

- `AI_PROVIDER=openai`
- `AI_BASE_URL=https://api.groq.com/openai/v1`
- `AI_MODEL=openai/gpt-oss-120b`
- `AI_MAX_TOKENS=4096` (opcional; faixa 256–32768)
- `AI_API_KEY=<chave real, somente no servidor>`

A chave **nunca** chega ao navegador. O cliente fala apenas com `/api/chat` e
`/api/tags` do próprio site. Não existe código de acesso nem chamada a
`localhost` no site publicado. O teto de tokens é definido só no servidor:
valores enviados pelo navegador são ignorados.

### 8.2 Privacidade e consentimento

Antes do primeiro envio externo, o aplicativo mostra:

- provedor e modelo reais, lidos de `/api/tags`;
- finalidade;
- quais dados serão enviados;
- link para a política do provedor identificado (Groq:
  `https://groq.com/privacy-policy`). A política cobre o tratamento feito pelo
  provedor e não descreve o armazenamento local do aplicativo.

A autorização vale para a versão atual do aviso. Quando o texto muda de forma
relevante — como na troca de provedor para a Groq —, a versão anterior deixa de
valer e o aviso é mostrado outra vez antes de qualquer novo envio.

O texto enviado é minimizado: lances em SAN, avaliações do Stockfish, abertura e
resultado. **Não** são enviados nomes, usernames, URLs, evento, local ou tags do
usuário.

Em **Configurações → Treinador IA** há a opção **“Não enviar dados à IA”**, que
bloqueia qualquer chamada externa. Você também pode revogar a autorização. Com o
envio bloqueado:

- Biblioteca, Stockfish, estatísticas e PDF continuam funcionando;
- a Leitura do Acervo e o Repertório usam uma leitura local determinística;
- nenhum dado é transmitido.

### 8.3 Quando a IA está indisponível

A interface diferencia:

- envio desativado por privacidade;
- servidor sem chave ou com chave de exemplo;
- credencial rejeitada (401/403);
- modelo inexistente (404);
- limite de uso (429);
- tempo esgotado;
- falha de rede.

Sem chave real, o assistente fica desabilitado com mensagem clara. O aplicativo
não simula uma resposta.

### 8.4 Testar

Em **Configurações → Treinador IA**, o botão **Testar assistente** consulta
`/api/tags`. Essa rota valida a credencial no provedor antes de dizer que está
tudo certo. O teste não envia dados de partidas.

---

## 9. Backup e restauração

Em **Configurações → Dados e backup**:

- **Exportar todo o acervo em PGN** — arquivo `chess-analysis-AAAAMMDD.pgn`.
- **Backup completo (JSON)** — partidas, lances, análises, textos da IA, tags e
  metadados.
- **Restaurar backup (JSON)** — valida a estrutura e, antes de mesclar, baixa
  automaticamente um backup do estado atual.

O formato novo usa `"app": "chess-analysis"`. A restauração aceita backups
antigos com `"app": "acervo64"` para não quebrar quem já usava o aplicativo.

O banco IndexedDB mantém o nome legado **`acervo64`** e a chave de preferências
**`acervo64_settings_v1`** de propósito: renomear apagaria os dados existentes.
Esses nomes são internos e não aparecem na interface.

Antes de qualquer migração futura, exporte um backup JSON e confirme que o
arquivo abre.

---

## 10. Dados e privacidade

- Partidas, análises e preferências ficam no **IndexedDB/localStorage deste
  navegador**.
- O Stockfish roda localmente em Web Worker + WASM.
- A base de aberturas é local.
- O único tráfego externo opcional é o Treinador IA, sempre pelo proxy do site e
  somente após consentimento.
- O proxy não registra prompts, respostas ou chaves.

---

## 11. Estrutura do projeto

| Caminho | Função |
|---|---|
| `index.html` | shell da aplicação |
| `style.css` | tema escuro padrão, tema claro opcional e responsividade |
| `js/app.js` | estado, navegação, tema, modais e inicialização |
| `js/storage.js` | IndexedDB e preferências |
| `js/pgn.js`, `js/pgn-worker.js` | leitura e serialização de PGN |
| `js/engine.js` | Stockfish, precisão, ACPL e classificações |
| `js/board.js` | tabuleiro |
| `js/library.js` | importação, filtros, tabela e exportação |
| `js/game.js` | partida, abas, análise e tags |
| `js/report.js` | relatório detalhado e PDF |
| `js/analytics.js` | desempenho, aberturas, leitura e repertório |
| `js/settings.js` | configurações, backup e análise em lote |
| `js/stats.js` | cálculos locais |
| `js/ai.js` | cliente de IA, consentimento e minimização |
| `api/chat.js`, `api/tags.js` | proxy da Vercel |
| `api/_lib.js` | utilidades, cotas e tradução de erros |
| `docs/` | auditoria, arquitetura, UI, modelo de dados e testes |

---

## 12. Testes

```powershell
node tools/check-syntax.cjs
npm test
```

Os resultados reais da Fase 1 estão em `docs/TESTES-FASE-1.md`, incluindo o
teste de fumaça no navegador, a análise com Stockfish e a geração de um PDF de
três páginas.

---

## 13. Publicar na Vercel

1. Configure as variáveis de `.env.example` em **Settings → Environment
   Variables** da Vercel.
2. Use uma chave real da Groq; valores de exemplo são recusados.
3. Faça o deploy do projeto estático com as funções em `api/`.
4. Abra o site publicado e use **Testar assistente**.
5. Se `/api/tags` retornar 401/403, corrija `AI_API_KEY`; se retornar 404,
   corrija `AI_MODEL`.

As cotas `AI_DAILY_PER_USER` e `AI_DAILY_GLOBAL` são aplicadas por IP. Sem Redis,
os contadores ficam na memória de cada instância e podem reiniciar em um novo
deploy; isso está documentado como limitação.

---

## 14. Limites desta fase

- A interface ainda é um shell de uma página; a separação multipágina virá em
  etapa controlada.
- O parser atual não preserva comentários, NAGs nem variantes do PGN. Por isso o
  relatório não promete variantes do arquivo original; mostra apenas a linha
  calculada pelo Stockfish quando ela existe.
- A identificação de jogador é provisória.
- A Central de Análises com fila e checkpoints e as bibliotecas
  Chess.com/Lichess pertencem às fases seguintes. A classificação usa dez
  categorias, MultiPV 2 e o catálogo ECO local.
- O motor em `vendor/` é o Stockfish 19 Lite WASM (release v19.0.1), com
  identidade `stockfish-19-lite-single`. Análises antigas do Stockfish 10 são
  preservadas e sinalizadas na interface.
