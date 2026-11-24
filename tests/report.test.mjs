/* Regressões do relatório em PDF (lista completa de lances e Momentos Críticos).
   Executar com: npm test

   O relatório é um documento HTML autônomo montado por `js/report.js`. Estes
   testes carregam o módulo real em `vm` e inspecionam o HTML gerado; não abrem
   navegador nem tocam no IndexedDB. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'js/report.js'), 'utf8');

const ANNOTATIONS = {
    brilliant: { symbol: '!!', label: 'Brilhante' },
    great: { symbol: '!', label: 'Grande Lance' },
    excellent: { symbol: '!', label: 'Excelente' },
    best: { symbol: '★', label: 'Melhor' },
    good: { symbol: '✓', label: 'Bom' },
    book: { symbol: '📖', label: 'Livro' },
    inaccuracy: { symbol: '?!', label: 'Imprecisão' },
    mistake: { symbol: '?', label: 'Erro' },
    missed: { symbol: '×', label: 'Chance Perdida' },
    blunder: { symbol: '??', label: 'Erro Grosseiro' },
};

function loadReport(overrides = {}) {
    const Engine = {
        ANNOTATION_ORDER: ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'missed', 'blunder'],
        annotationInfo: key => ANNOTATIONS[key] || { symbol: '?', label: key || '—' },
        isLegacyAnalysis: () => false,
        ...overrides,
    };
    const context = vm.createContext({
        window: { Engine, print() {} },
        Engine,
        document: {},
        console,
        setTimeout,
    });
    vm.runInContext(source, context, { filename: 'js/report.js' });
    return context.window.Report;
}

const Report = loadReport();

const GAME = {
    white: 'Morphy, Paul',
    black: 'Duke Karl',
    result: '1-0',
    dateISO: '1858-10-21',
    opening: 'Philidor Defense',
    eco: 'C41',
};

const DATA = {
    startFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moves: [
        { san: 'e4' }, { san: 'e5' },
        { san: 'Nf3' }, { san: 'd6' },
        { san: 'd4' },
    ],
};

const ANALYSIS = {
    depth: 10,
    engine: 'Stockfish 19 Lite WASM',
    moves: [
        { annotation: 'brilliant', symbol: '!!' },
        { annotation: 'best', symbol: '★' },
        { annotation: 'excellent', symbol: '!' },
        { annotation: 'mistake', symbol: '?' },
        { annotation: 'good', symbol: '✓' },
    ],
    keyMoments: [
        {
            ply: 4,
            san: 'd6',
            color: 'b',
            annotation: 'mistake',
            loss: 12.4,
            before: 55,
            after: 43,
            bestSan: 'Nf6',
        },
    ],
    positions: [null, null, null, null],
    counts: { w: { brilliant: 1 }, b: { mistake: 1 } },
};

function section(html, startMarker, endMarker) {
    const start = html.indexOf(startMarker);
    assert.ok(start >= 0, 'seção ausente: ' + startMarker);
    const end = endMarker ? html.indexOf(endMarker, start) : html.length;
    return html.slice(start, end < 0 ? html.length : end);
}

/** Só a tabela de lances: evita contar o `<tr>` do cabeçalho e outras tabelas. */
function movesTable(html) {
    const table = section(html, '<table class="move-list">', '</table>');
    const body = table.slice(table.indexOf('<tbody>'), table.indexOf('</tbody>'));
    return {
        table,
        body,
        rows: (body.match(/<tr>/g) || []).length,
    };
}

test('lista completa de lances usa duas colunas e numera a jogada', () => {
    const html = Report.buildHtml(GAME, DATA, ANALYSIS, null);
    const moves = movesTable(html);
    assert.ok(moves.table.includes('<th>Brancas</th><th>Pretas</th>'));
    assert.equal(moves.rows, 3);
    assert.ok(moves.body.includes('1. e4'));
    assert.ok(moves.body.includes('2. Nf3'));
    assert.ok(moves.body.includes('3. d4'));
    // A última linha tem só as brancas; a célula das pretas fica vazia.
    assert.ok(/<td>3\. d4[\s\S]*?<\/td>\s*<td><\/td>/.test(moves.body));
});

test('símbolos de classificação acompanham o lance, na coluna certa', () => {
    const html = Report.buildHtml(GAME, DATA, ANALYSIS, null);
    const moves = movesTable(html).body;
    assert.ok(moves.includes('<td>1. e4 <span class="sym">!!</span></td>'));
    assert.ok(moves.includes('<td>e5 <span class="sym">★</span></td>'));
    assert.ok(moves.includes('<td>d6 <span class="sym">?</span></td>'));
});

test('tabela PDF lista as novas classificações e rótulos', () => {
    const html = Report.buildHtml(GAME, DATA, ANALYSIS, null);
    assert.ok(html.includes('! Grande Lance'));
    assert.ok(html.includes('✓ Bom'));
    assert.ok(html.includes('📖 Livro'));
    assert.ok(html.includes('?! Imprecisão'));
    assert.ok(html.includes('?? Erro Grosseiro'));
});

test('partida sem análise mostra a lista, mas não inventa classificação', () => {
    const html = Report.buildHtml(GAME, DATA, null, null);
    const moves = movesTable(html);
    assert.equal(moves.rows, 3);
    assert.ok(moves.body.includes('1. e4'));
    assert.equal(moves.table.includes('class="sym"'), false);
});

test('partida sem lances exibe o aviso em vez de uma tabela vazia', () => {
    const html = Report.buildHtml(GAME, { moves: [] }, null, null);
    assert.ok(html.includes('Esta partida não tem lances válidos'));
    assert.equal(html.includes('<table class="move-list">'), false);
});

test('Momentos Críticos mantém sete colunas e a classe na classificação', () => {
    const html = Report.buildHtml(GAME, DATA, ANALYSIS, null);
    const moments = section(html, '<h2>Momentos críticos</h2>', 'Resumo do Treinador IA');
    const row = moments.match(/<tbody><tr>([\s\S]*?)<\/tr><\/tbody>/);
    assert.ok(row, 'linha de momento crítico ausente');
    assert.equal((row[1].match(/<td/g) || []).length, 7);
    assert.ok(row[1].includes('<td class="sym">? Erro</td>'));
    assert.ok(row[1].includes('12,4%'));
    assert.ok(row[1].includes('Nf6'));
});

test('conteúdo é escapado antes de entrar no documento', () => {
    const html = Report.buildHtml(
        { ...GAME, white: 'A & B', black: '<script>alert(1)</script>' },
        { moves: [{ san: '<img onerror=x>' }] },
        null,
        null
    );
    assert.ok(html.includes('A &amp; B'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('&lt;img onerror=x&gt;'));
    assert.equal(html.includes('<script>alert(1)</script>'), false);
});

test('CSS de impressão repete o cabeçalho e não força página em branco', () => {
    const html = Report.buildHtml(GAME, DATA, ANALYSIS, null);
    assert.ok(html.includes('thead { display: table-header-group; }'));
    assert.equal(html.includes('display: table-row-group'), false);
    assert.equal(html.includes('page-break-before: always'), false);
    assert.equal(html.includes('break-before: page'), false);
    assert.ok(html.includes('page-break-inside: avoid'));
});

test('análise de motor anterior é identificada sem sobrescrever o resultado', () => {
    const legacy = loadReport({ isLegacyAnalysis: () => true });
    const html = legacy.buildHtml(GAME, DATA, ANALYSIS, null);
    assert.ok(html.includes('O resultado original foi preservado e não foi sobrescrito.'));
});
