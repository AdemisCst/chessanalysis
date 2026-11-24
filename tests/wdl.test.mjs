/* Expected Score por WDL (versão 3) e proveniência do motor.
   Executar com: npm test

   Carrega vendor/chess.js + js/engine.js reais em `vm`, como no navegador.
   Não inicia Worker: as funções testadas são puras. */
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

const chess = new Chess();
const startFen = chess.fen();
const move = chess.move('e4');
const data = { startFen, moves: [{ san: 'e4', fen: chess.fen(), from: move.from, to: move.to }] };

const WHITE_75 = { cp: 0, mate: null, wdl: { w: 600, d: 300, l: 100 }, depth: 12, best: 'd2d4', pv: ['d2d4'] };
const BLACK_35 = { cp: 0, mate: null, wdl: { w: 200, d: 300, l: 500 }, depth: 12, best: 'e7e5', pv: ['e7e5'] };

test('WDL converte para Expected Score do lado a jogar', () => {
    assert.equal(Engine.wdlWinPct(WHITE_75), 75);
    assert.equal(Engine.wdlWinPct(BLACK_35), 35);
    assert.equal(Engine.whiteWinPct(WHITE_75, 0, 'wdl'), 75);
    assert.equal(Engine.whiteWinPct(BLACK_35, 1, 'wdl'), 65);
});

test('WDL inválido é descartado sem correção', () => {
    assert.equal(Engine.validWdl({ wdl: { w: 600, d: 300, l: 50 } }), null, 'soma 950');
    assert.equal(Engine.validWdl({ wdl: { w: 1000, d: 0, l: 1 } }), null, 'soma 1001');
    assert.equal(Engine.validWdl({ wdl: { w: -1, d: 500, l: 501 } }), null, 'negativo');
    assert.equal(Engine.validWdl({ wdl: { w: 500.5, d: 499.5, l: 0 } }), null, 'não inteiro');
    const valid = Engine.validWdl({ wdl: { w: 500, d: 300, l: 200 } });
    assert.equal(valid.w, 500);
    assert.equal(valid.d, 300);
    assert.equal(valid.l, 200);

    const bad = { ...WHITE_75, wdl: { w: 600, d: 300, l: 50 } };
    const coverage = Engine.wdlCoverage([bad]);
    assert.equal(coverage.complete, false);
    assert.equal(coverage.invalid, 1);
});

test('posição terminal é isenta de WDL e o mate continua prioritário', () => {
    const mate = new Chess();
    ['f4', 'e5', 'g4', 'Qh4#'].forEach(san => mate.move(san));
    const terminal = Engine.terminalResult(mate.fen());
    assert.equal(Engine.isTerminalPosition(terminal), true);

    const coverage = Engine.wdlCoverage([WHITE_75, terminal]);
    assert.equal(coverage.evaluated, 1);
    assert.equal(coverage.present, 1);
    assert.equal(coverage.complete, true);
    assert.equal(Engine.whiteWinPct(terminal, 4, 'wdl'), 0, 'brancas apanhando mate');
});

test('buildAnalysis usa WDL e grava version 3 com proveniência', () => {
    const analysis = Engine.buildAnalysis('g_wdl', data, [WHITE_75, BLACK_35], 12, 1);
    assert.equal(analysis.version, 3);
    assert.equal(analysis.classificationVersion, Engine.CLASSIFICATION_VERSION);
    assert.equal(analysis.scoreSource, 'wdl');
    assert.equal(analysis.engineBuild, Engine.BUILD_ID);
    assert.equal(analysis.summary.engineBuild, Engine.BUILD_ID);
    assert.equal(analysis.wdlCoverage.complete, true);
    assert.equal(analysis.winPctWhite[0], 75);
    assert.equal(analysis.winPctWhite[1], 65);
    assert.equal(analysis.moves[0].before, 75);
    assert.equal(analysis.moves[0].after, 65);
    assert.equal(analysis.moves[0].loss, 10);
    assert.equal(analysis.moves[0].annotation, 'inaccuracy');
});

test('sem WDL completo a análise inteira cai para a curva de cp (v2)', () => {
    const without = { ...BLACK_35, wdl: null };
    const analysis = Engine.buildAnalysis('g_cp', data, [WHITE_75, without], 12, 1);
    assert.equal(analysis.version, 2);
    assert.equal(analysis.scoreSource, 'cp');
    assert.equal(analysis.wdlCoverage.complete, false);
    assert.equal(analysis.wdlCoverage.missing, 1);
    // cp 0 nas duas posições: a curva devolve 50/50, não 75/65.
    assert.equal(analysis.winPctWhite[0], 50);
    assert.equal(analysis.winPctWhite[1], 50);
});

test('buildOf reconhece SF19, SF10 e desconhecido', () => {
    assert.equal(Engine.buildOf({ engineId: 'Stockfish 19 Lite WASM' }), Engine.BUILD_ID);
    assert.equal(Engine.buildOf({ engine: 'Stockfish 19 Lite WASM' }), Engine.BUILD_ID);
    assert.equal(Engine.buildOf({ engine: 'Stockfish 10 (WASM)' }), Engine.LEGACY_BUILD_ID);
    assert.equal(Engine.buildOf({ engine: 'Stockfish 19 Lite WASM', engineBuild: 'stockfish-x' }), 'stockfish-x');
    assert.equal(Engine.buildOf({}), 'legacy-unknown');
    assert.equal(Engine.buildOf(null), 'legacy-unknown');
});

test('isLegacyAnalysis distingue o build atual', () => {
    assert.equal(Engine.isLegacyAnalysis(null), false);
    assert.equal(Engine.isLegacyAnalysis({ engineBuild: Engine.BUILD_ID }), false);
    assert.equal(Engine.isLegacyAnalysis({ engine: 'Stockfish 10 (WASM)' }), true);
    assert.equal(Engine.isLegacyAnalysis({ engine: 'Stockfish 19 Lite WASM' }), false, 'inferido, mas do build atual');
});

test('enriquecimento preserva versão, fonte, motor e chave antigos', () => {
    const legacy = {
        key: 'g_old@12',
        gameId: 'g_old',
        depth: 12,
        version: 2,
        engine: 'Stockfish 10 (WASM)',
        engineId: null,
        createdAt: 1,
        positions: [WHITE_75, BLACK_35],
        moves: [], // incompleto de propósito: força a reconstrução
        winPctWhite: [50, 50],
    };
    const rebuilt = Engine.enrichAnalysis(legacy, data);
    assert.equal(rebuilt.key, 'g_old@12');
    assert.equal(rebuilt.version, 2, 'não promove histórico para v3');
    assert.equal(rebuilt.scoreSource, 'cp', 'não troca a fonte do histórico');
    assert.equal(rebuilt.engine, 'Stockfish 10 (WASM)');
    assert.equal(rebuilt.engineBuild, Engine.LEGACY_BUILD_ID);
    assert.equal(rebuilt.classificationVersion, Engine.CLASSIFICATION_VERSION);
    assert.equal(rebuilt.winPctWhite[0], 50, 'usa a curva, não o WDL armazenado');
    assert.equal(rebuilt.engineId, null);
});
