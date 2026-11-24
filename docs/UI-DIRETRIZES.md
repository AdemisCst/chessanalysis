# Diretrizes de interface — Chess-Analysis

**Versão:** 1.0 — Fase 1  
**Atualizado em:** 16/11/2026  
**Aplica-se a:** `index.html`, `style.css` e futuras páginas em `pages/`.

Este documento centraliza a identidade visual e as regras de movimento. O
Prompt Mestre define objetivos; aqui ficam os detalhes operacionais.

---

## 1. Identidade

- Nome exibido: **Chess-Analysis**.
- Não existe subtítulo. Remover “Organizador de partidas PGN”.
- Título do navegador: `Chess-Analysis`.
- A peça `♞` é o símbolo da marca.
- Tema padrão: escuro.

## 2. Paleta

Tema escuro (padrão):

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#0b1220` | fundo da página (grafite/azul-marinho) |
| `--bg-card` | `#111b2e` | painéis e cartões |
| `--bg-soft` | `#17233a` | superfícies secundárias |
| `--bg-soft-2` | `#20304d` | trilhas, bordas internas |
| `--text` | `#e6edf7` | texto principal |
| `--text-muted` | `#93a3ba` | texto secundário |
| `--border` | `#22314a` | bordas discretas |
| `--accent` | `#22c55e` | verde de destaque |
| `--accent-hover` | `#4ade80` | destaque em hover |
| `--accent-soft` | `#123524` | fundo de destaque suave |
| `--success` | `#22c55e` | sucesso |
| `--danger` | `#f87171` | erro |
| `--warning` | `#fbbf24` | atenção |

O tema claro é uma alternativa opcional, acionada pelo botão de tema. Ele
mantém a mesma hierarquia e não altera dados.

Regras:

- Verde indica ação principal, confirmação e destaque — não decoração.
- Vermelho e amarelo são reservados a erro e atenção.
- Nunca usar apenas cor para comunicar um estado; sempre acompanhar de texto
  ou símbolo.
- Bordas discretas: `1px solid var(--border)`.

## 3. Tipografia

- Família: `Segoe UI`, `system-ui`, `-apple-system`, `Roboto`, `Arial`.
- Texto base: 15 px, altura de linha 1.45.
- Títulos: `h2` 1.35 rem, `h3` 1.02 rem, `h4` 0.85 rem em caixa alta.
- Números tabulares em tabelas (`font-variant-numeric: tabular-nums`).
- Não usar fontes externas nem requisições de rede para tipografia.

## 4. Espaçamento e componentes

- Escala base: 4, 6, 8, 12, 14, 18, 22 px.
- Raio padrão: 14 px; componentes pequenos: 9 px.
- Painéis têm `background: var(--bg-card)` e `box-shadow: var(--shadow-sm)`.
- Botões: primário (verde), secundário (superfície), fantasma (sem fundo).
- Todo botão precisa de rótulo textual ou `aria-label`.
- Ícones são moderados; não substituem texto em ações destrutivas.

## 5. Navegação

Cinco áreas principais:

1. Biblioteca
2. Análise
3. Desempenho
4. Treinador IA
5. Configurações

Aberturas é uma página auxiliar, acessível a partir de Desempenho. Ela pode ter
um botão de retorno, mas não ocupa o menu principal.

Regras:

- O item ativo recebe `aria-current="page"` e a classe `.active`.
- Avançar ou retroceder lances **não altera** a aba Lances/Análise/IA.
- A navegação entre áreas não deve reordenar a lista de lances nem perder a
  partida aberta.

## 6. Movimento

- Transições curtas: 120–200 ms.
- Movimento comunica mudança de estado, não enfeita.
- Animações não podem atrasar o tabuleiro, a análise ou a navegação rápida.
- Não depender apenas de `transitionend`: transições podem ser canceladas.
- Respeitar `prefers-reduced-motion`: reduzir ou remover animações.
- Não usar View Transitions API para navegação entre páginas HTML separadas
  nesta versão.

Ferramentas autorizadas apenas para avaliação pontual: Transitions.dev,
Animista e tokens de movimento do Open Props. Nenhuma foi instalada.

## 7. Acessibilidade

- Foco visível em todos os controles (`:focus-visible`).
- Modal com foco preso, `Esc` para fechar quando permitido.
- Abas seguem o padrão ARIA (`role="tablist"`, `aria-selected`, setas).
- Contraste mínimo 4.5:1 para texto normal.
- O tabuleiro mantém rótulos acessíveis; peças não são o único indicador.
- Mensagens de erro são anunciadas com `role="status"` ou `aria-live`.

## 8. Responsividade

- Até 1120 px: grades de duas colunas viram uma coluna.
- Até 760 px: navegação vira barra horizontal; tabuleiro ocupa a largura.
- Leitura do acervo e Repertório sugerido ficam **lado a lado** no desktop e
  **empilhados** no mobile.
- Tabelas largas têm rolagem horizontal, nunca corte de conteúdo.

## 9. Estados vazios e mensagens

- Estado vazio explica o próximo passo e oferece a ação.
- Nenhuma métrica é exibida como zero quando o dado não existe: usar `—`.
- Mensagens da IA diferenciam:
  - desabilitada por privacidade;
  - sem chave configurada no servidor;
  - credencial rejeitada;
  - limite atingido;
  - tempo esgotado;
  - falha de rede.
- Nunca mencionar `localhost` para quem está no site publicado.

## 10. Impressão e PDF

- A folha de estilo de impressão usa A4, margens de 14 mm e cores exatas.
- Tabelas e blocos não são cortados no meio (`break-inside: avoid`).
- O PDF é gerado pelo diálogo de impressão do navegador a partir de uma página
  própria, sem biblioteca externa.
- Nenhum dado é inventado: se a análise não existe, o relatório diz isso.

## 11. Testes visuais

- Comparar desktop (1280 px) e mobile (420 px).
- Verificar que a ordem das anotações é:
  Brilhante, Grande Lance, Melhor, Excelente, Bom, Livro, Imprecisão, Erro,
  Chance Perdida, Erro Grosseiro.
- Verificar que não existe dropzone, código de acesso, “Detalhes da conexão”
  nem a frase sobre licenças em `vendor/`.
- Testar com movimento reduzido ativado.
- Evidências registradas em `docs/TESTES-FASE-1.md`.
