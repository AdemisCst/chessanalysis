/* Testes de posições terminais e da classificação do lance de mate.
   Executar com: npm test

   O harness carrega o vendor/chess.js e o js/engine.js reais em um contexto
   `vm` (como o navegador faz, sem módulos) e testa as funções puras expostas.
   O Worker do Stockfish não é iniciado: a terminalidade é decidida por
   `Engine.terminalResult`, que é quem alimenta `evaluate`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function loadEngine() {
    const context = vm.createContext({ window: {}, console, setTimeout, clearTimeout });
    const chess = await readFile(join(root, 'vendor/chess.js'), 'utf8');
    const engine = await readFile(join(root, 'js/engine.js'), 'utf8');
    vm.runInContext(chess, context, { filename: 'vendor/chess.js' });
    vm.runInContext(engine, context, { filename: 'js/engine.js' });
    return { Engine: context.window.Engine, Chess: context.Chess };
}

const { Engine, Chess } = await loadEngine();

const OPERA_GAME = [
    'e4', 'e5', 'Nf3', 'd6', 'd4', 'Bg4', 'dxe5', 'Bxf3', 'Qxf3', 'dxe5',
    'Bc4', 'Nf6', 'Qb3', 'Qe7', 'Nc3', 'c6', 'Bg5', 'b5', 'Nxb5', 'cxb5',
    'Bxb5+', 'Nbd7', 'O-O-O', 'Rd8', 'Rxd7', 'Rxd7', 'Rd1', 'Qe6',
    'Bxd7+', 'Nxd7', 'Qb8+', 'Nxb8', 'Rd8#',
];

/** Joga uma lista de SANs e devolve a FEN antes e depois do último lance. */
function play(sans) {
    const chess = new Chess();
    let beforeFen = null;
    let lastMove = null;
    sans.forEach((san, index) => {
        if (index === sans.length - 1) beforeFen = chess.fen();
        lastMove = chess.move(san);
    });
    return { beforeFen, afterFen: chess.fen(), lastMove };
}

const opera = play(OPERA_GAME);
const fool = play(['f4', 'e5', 'g4', 'Qh4#']);
const STALEMATE_FEN = '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1';

test('xeque-mate com as brancas vencedoras é reconhecido com mate: 0', () => {
    assert.equal(opera.lastMove.san, 'Rd8#');
    const terminal = Engine.terminalResult(opera.afterFen);
    assert.equal(terminal.cp, null);
    assert.equal(terminal.mate, 0);
    assert.equal(terminal.wdl, null);
    assert.equal(terminal.depth, 0);
    assert.equal(terminal.best, null);
    assert.equal(terminal.pv.length, 0);
    // Índice 33 (pretas a jogar, já em mate): as brancas venceram.
    assert.equal(Engine.whiteWinPct(terminal, 33), 100);
});

test('xeque-mate com as pretas vencedoras é reconhecido com mate: 0', () => {
    assert.equal(fool.lastMove.san, 'Qh4#');
    const terminal = Engine.terminalResult(fool.afterFen);
    assert.equal(terminal.mate, 0);
    assert.equal(terminal.cp, null);
    // Índice 4 (brancas a jogar, já em mate): as pretas venceram.
    assert.equal(Engine.whiteWinPct(terminal, 4), 0);
});

test('afogamento é empate técnico (cp: 0), não mate', () => {
    const terminal = Engine.terminalResult(STALEMATE_FEN);
    assert.equal(terminal.cp, 0);
    assert.equal(terminal.mate, null);
    assert.equal(terminal.wdl, null);
    assert.equal(Engine.whiteWinPct(terminal, 1), 50);
    assert.equal(Engine.cpOf(terminal), 0);
});

test('FEN inválida não vira posição terminal nem inventa avaliação', () => {
    assert.equal(Engine.terminalResult('posicao-invalida'), null);
    assert.equal(Engine.terminalResult('8/8/8/8/8/8/8/8 w - - 0 1'), null);
    assert.equal(Engine.terminalResult(''), null);
    assert.equal(Engine.terminalResult(null), null);
});

test('posição não terminal continua sendo avaliada pelo motor', () => {
    assert.equal(Engine.terminalResult(new Chess().fen()), null);
    // Posição antes de Rd8#: mate em 1, mas ainda não é terminal.
    assert.equal(Engine.terminalResult(opera.beforeFen), null);
});

test('depth 0 só é aceito quando a terminalidade foi confirmada', () => {
    const depth0 = { depth: 0, type: 'cp', value: 0 };
    const depth12 = { depth: 12, type: 'cp', value: 31 };
    assert.equal(Engine.usableInfo(depth0, false), false);
    assert.equal(Engine.usableInfo(depth0, undefined), false);
    assert.equal(Engine.usableInfo(depth0, true), true);
    assert.equal(Engine.usableInfo(depth12, false), true);
    assert.equal(Engine.usableInfo(null, true), false);
});

test('o lance de mate Rd8# não é penalizado e a análise fecha em 100%', () => {
    const before = {
        cp: null, mate: 1, wdl: null, depth: 12, best: 'd1d8', pv: ['d1d8'],
    };
    const after = Engine.terminalResult(opera.afterFen);
    const analysis = Engine.buildAnalysis(
        'teste-mate',
        { startFen: opera.beforeFen, moves: [{ san: 'Rd8#', fen: opera.afterFen }] },
        [before, after],
        12,
        1
    );

    const move = analysis.moves[0];
    assert.equal(move.loss, 0);
    assert.equal(move.cpLoss, 0);
    assert.equal(move.missed, false);
    assert.equal(move.isBest, true);
    assert.equal(move.annotation, 'best');
    assert.equal(move.symbol, '★');
    assert.equal(move.label, 'Melhor');
    assert.equal(analysis.winPctWhite.at(-1), 100);
    assert.equal(analysis.acpl.w, 0);
    assert.equal(analysis.accuracy.w, 100);
    assert.equal(analysis.summary.missedW, 0);
    assert.equal(analysis.summary.blundersW, 0);
    assert.equal(analysis.keyMoments.length, 0);
});

/* ---------- retomada (M3): validação antes de tocar no Worker ---------- */

test('analyzeGame recusa startIndex fora da partida antes de iniciar o motor', async () => {
    const data = { startFen: 'start', moves: [{ fen: 'f1' }, { fen: 'f2' }] };
    await assert.rejects(
        () => Engine.analyzeGame({ id: 'g' }, data, { depth: 12, startIndex: 5 }),
        error => error.name === 'RangeError'
    );
    await assert.rejects(
        () => Engine.analyzeGame({ id: 'g' }, data, { depth: 12, startIndex: -1 }),
        error => error.name === 'RangeError'
    );
    await assert.rejects(
        () => Engine.analyzeGame({ id: 'g' }, data, { depth: 12, startIndex: 1.5 }),
        error => error.name === 'RangeError'
    );
});

test('analyzeGame recusa seedPositions que não cobrem o startIndex', async () => {
    const data = { startFen: 'start', moves: [{ fen: 'f1' }, { fen: 'f2' }] };
    await assert.rejects(
        () => Engine.analyzeGame({ id: 'g' }, data, { depth: 12, startIndex: 2, seedPositions: [{}] }),
        error => error.name === 'RangeError'
    );
});
