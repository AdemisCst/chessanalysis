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
    return { Engine: context.window.Engine, Chess: context.Chess, context };
}

const { Engine, Chess, context } = await loadEngine();

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

test('classificação normal respeita todos os limites percentuais', () => {
    const cases = [
        [0, 'best'],
        [0.01, 'excellent'],
        [2, 'excellent'],
        [2.01, 'good'],
        [5, 'good'],
        [5.01, 'inaccuracy'],
        [10, 'inaccuracy'],
        [10.01, 'mistake'],
        [20, 'mistake'],
        [20.01, 'blunder'],
    ];
    cases.forEach(([loss, expected]) => {
        assert.equal(Engine.decideAnnotation({ loss }), expected, `${loss}pp`);
    });
});

test('precedência das regras especiais é chance perdida, erro grosseiro, livro e lances raros', () => {
    assert.equal(Engine.decideAnnotation({ missed: true, loss: 25, book: true }), 'missed');
    assert.equal(Engine.decideAnnotation({ book: true, loss: 20 }), 'book');
    assert.equal(Engine.decideAnnotation({ book: true, loss: 20.01 }), 'blunder');
    assert.equal(Engine.decideAnnotation({ great: true, isBest: true, loss: 1 }), 'great');
    assert.equal(Engine.decideAnnotation({ brilliant: true, loss: 1 }), 'brilliant');
});

test('Chance Perdida aplica os limites inclusivos/exclusivos e aceita mate forçado', () => {
    assert.equal(Engine.isMissedChance({ before: 80, after: 69.9, loss: 10 }), true);
    assert.equal(Engine.isMissedChance({ before: 79.9, after: 60, loss: 20 }), false);
    assert.equal(Engine.isMissedChance({ before: 80, after: 70, loss: 10 }), false);
    assert.equal(Engine.isMissedChance({ before: 80, after: 69, loss: 9.9 }), false);
    assert.equal(Engine.isMissedChance({ before: 50, after: 40, loss: 10, mateBefore: 1 }), true);
});

test('classificações e símbolos têm o catálogo de dez categorias', () => {
    assert.deepEqual(Array.from(Engine.ANNOTATION_ORDER), [
        'brilliant', 'great', 'best', 'excellent', 'good',
        'book', 'inaccuracy', 'mistake', 'missed', 'blunder',
    ]);
    assert.deepEqual(
        Array.from(Engine.ANNOTATION_ORDER, key => [Engine.annotationInfo(key).symbol, Engine.annotationInfo(key).label]),
        [
            ['!!', 'Brilhante'], ['!', 'Grande Lance'], ['★', 'Melhor'],
            ['!', 'Excelente'], ['✓', 'Bom'], ['📖', 'Livro'],
            ['?!', 'Imprecisão'], ['?', 'Erro'], ['×', 'Chance Perdida'],
            ['??', 'Erro Grosseiro'],
        ]
    );
});

test('Grande Lance usa a segunda avaliação e precede Melhor quando só ela mantém o resultado', () => {
    const chess = new Chess();
    const startFen = chess.fen();
    const played = chess.move('e4');
    const analysis = Engine.buildAnalysis(
        'g_great',
        { startFen, moves: [{ san: played.san, fen: chess.fen() }] },
        [
            {
                cp: 0, mate: null, wdl: { w: 700, d: 200, l: 100 },
                best: 'e2e4', pv: ['e2e4', 'e7e5'],
                secondCp: 0, secondMate: null, secondWdl: { w: 500, d: 200, l: 300 },
                secondBest: 'd2d4', secondPv: ['d2d4', 'd7d5'],
            },
            { cp: 0, mate: null, wdl: { w: 100, d: 200, l: 700 }, best: null, pv: [] },
        ],
        12,
        1
    );
    assert.equal(analysis.moves[0].loss, 0);
    assert.equal(analysis.moves[0].secondLoss, 20);
    assert.equal(analysis.moves[0].great, true);
    assert.equal(analysis.moves[0].annotation, 'great');
});

test('Brilhante exige sacrifício aceito, alternativa segura e mais de um lance legal', () => {
    function analyzeSacrifice(fen, san, uci, replyUci, secondCp = 400) {
        const chess = new Chess(fen);
        const move = chess.move(san);
        assert.ok(move, `${san} deve ser legal`);
        const afterFen = chess.fen();
        const prefix = Array.from({ length: 5 }, () => ({ san: 'a3', fen }));
        const data = {
            startFen: fen,
            moves: prefix.concat([{ san, fen: afterFen }]),
        };
        const positions = Array.from({ length: 5 }, () => ({
            cp: 0, mate: null, best: null, pv: [],
        }));
        positions.push({
            cp: 500, mate: null, best: uci, pv: [uci, replyUci],
            secondCp, secondMate: null, secondBest: 'e4d6', secondPv: ['e4d6', replyUci],
        });
        positions.push({ cp: -500, mate: null, best: null, pv: [] });
        return Engine.buildAnalysis('g_brilliant', data, positions, 12, 1).moves[5];
    }

    const optionalSacrifice = analyzeSacrifice(
        '7k/8/6Q1/8/4n3/8/8/K7 b - - 0 1',
        'Nf6',
        'e4f6',
        'g6f6'
    );
    assert.equal(optionalSacrifice.sacrifice, 3);
    assert.equal(optionalSacrifice.brilliant, true);
    assert.equal(optionalSacrifice.annotation, 'brilliant');

    const forcedSacrifice = analyzeSacrifice(
        '7k/8/6Q1/6n1/8/8/8/K6R b - - 0 1',
        'Nh7',
        'g5h7',
        'g6h7',
        0
    );
    assert.equal(forcedSacrifice.sacrifice, 3);
    assert.equal(forcedSacrifice.brilliant, false);
    assert.notEqual(forcedSacrifice.annotation, 'brilliant');

    const candidate = {
        ply: 6, loss: 0, sacrifice: 3, after: 80, follow: 80, secondLoss: 0,
    };
    const onlyMoveFen = '4k1r1/8/P2P2p1/4b3/4p1P1/6p1/2qNQ3/1RK1B2R w - - 9 62';
    assert.equal(new Chess(onlyMoveFen).moves().length, 1);
    assert.equal(Engine.isBrilliantCandidate(candidate, onlyMoveFen), false);
    assert.equal(Engine.isBrilliantCandidate(candidate, new Chess().fen()), true);
});

test('Livro só usa o catálogo configurado e é bloqueado por erro grosseiro', () => {
    const chess = new Chess();
    const startFen = chess.fen();
    const played = chess.move('e4');
    const data = { startFen, moves: [{ san: played.san, fen: chess.fen() }] };
    const savedOpenings = context.window.Openings;
    context.window.Openings = { isBookSequence: sequence => sequence.length === 1 };
    const safe = Engine.buildAnalysis('g_book', data, [
        { cp: 0, mate: null, wdl: { w: 700, d: 100, l: 200 }, best: 'e2e4', pv: ['e2e4', 'e7e5'] },
        { cp: 0, mate: null, wdl: { w: 200, d: 200, l: 600 }, best: null, pv: [] },
    ], 12, 1);
    assert.equal(safe.moves[0].annotation, 'book');

    const blunder = Engine.buildAnalysis('g_book_blunder', data, [
        { cp: 0, mate: null, wdl: { w: 650, d: 100, l: 250 }, best: 'd2d4', pv: ['d2d4', 'd7d5'] },
        { cp: 0, mate: null, wdl: { w: 550, d: 100, l: 350 }, best: null, pv: [] },
    ], 12, 1);
    assert.equal(blunder.moves[0].loss, 30);
    assert.equal(blunder.moves[0].annotation, 'blunder');
    context.window.Openings = savedOpenings;
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
