/* Filtros e agregações do Dashboard de Desempenho. Executar com: npm test */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'js/stats.js'), 'utf8');
const html = await readFile(join(root, 'index.html'), 'utf8');
const BUILD_ID = 'stockfish-19-lite-single';
const context = vm.createContext({
    window: {
        Engine: {
            BUILD_ID,
            buildOf: summary => summary.engineBuild || 'legacy-unknown',
        },
    },
});
vm.runInContext(source, context, { filename: 'js/stats.js' });
const Stats = context.window.Stats;

function game(id, overrides) {
    return Object.assign({
        id,
        white: 'Alex',
        black: `Opponent ${id}`,
        result: '1-0',
        dateISO: '2026-11-24',
        timeControl: '180+0',
        source: 'chesscom',
        eco: 'E00',
        opening: 'Catalan',
    }, overrides || {});
}

function summary(overrides) {
    return Object.assign({
        version: 3,
        engineBuild: BUILD_ID,
        scoreSource: 'wdl',
        accuracyW: 91,
        accuracyB: 80,
        acplW: 20,
        acplB: 50,
        phaseBlunders: { opening: 1, middlegame: 0, endgame: 0 },
        phaseAccuracy: {
            opening: { w: 90, b: 80 },
            middlegame: { w: 91, b: 81 },
            endgame: { w: 92, b: 82 },
        },
        phaseBrilliants: { opening: 0, middlegame: 1, endgame: 0 },
        phaseBrilliantsByColor: { w: { opening: 0, middlegame: 1, endgame: 0 }, b: {} },
        counts: { w: {}, b: {} },
    }, overrides || {});
}

test('combina origem, controle e período sem alterar a lista original', () => {
    const games = [
        game('chesscom'),
        game('lichess', { source: 'lichess', dateISO: '2026-10-26' }),
        game('manual', { source: '', dateISO: '2026-11-01', timeControl: '900+0' }),
        game('old', { source: 'lichess', dateISO: '2026-10-25' }),
    ];

    const selected = Stats.filterGames(games, {
        source: 'lichess',
        timeControl: 'Blitz',
        period: '30d',
    }, '2026-11-24T12:00:00');

    assert.deepEqual(Array.from(selected, item => item.id), ['lichess']);
    assert.equal(games[0].source, 'chesscom');
    assert.equal(Stats.compute(selected, ['Alex'], { includeRating: false }).total, 1);
});

test('origem manual inclui partidas antigas sem source e data customizada é inclusiva', () => {
    const games = [
        game('before', { source: undefined, dateISO: '2026-01-09' }),
        game('start', { source: 'manual', dateISO: '2026-01-10' }),
        game('end', { source: 'manual', dateISO: '2026-01-20' }),
        game('after', { source: 'manual', dateISO: '2026-01-21' }),
    ];

    const selected = Stats.filterGames(games, {
        source: 'manual',
        period: 'custom',
        dateFrom: '2026-01-10',
        dateTo: '2026-01-20',
    });

    assert.deepEqual(Array.from(selected, item => item.id), ['start', 'end']);
    assert.equal(Stats.filterGames(games, {
        period: 'custom',
        dateFrom: '2026-01-20',
        dateTo: '2026-01-10',
    }).length, 0);
});

test('só agrega precisão e ACPL de análises SF19 v3/WDL', () => {
    const games = [
        game('valid-white', { analysisSummary: summary() }),
        game('valid-black', {
            white: 'Opponent',
            black: 'Alex',
            result: '0-1',
            eco: 'E00',
            opening: 'Catalan',
            analysisSummary: summary({ accuracyW: 80, accuracyB: 90, acplW: 35, acplB: 15 }),
        }),
        game('sf19-v2', {
            analysisSummary: summary({ version: 2, scoreSource: 'cp', accuracyW: 1, acplW: 999 }),
        }),
        game('sf10-v3', {
            analysisSummary: summary({ engineBuild: 'stockfish-10-legacy', accuracyW: 1, acplW: 999 }),
        }),
    ];

    const stats = Stats.compute(games, ['Alex'], { includeRating: false });

    assert.equal(stats.analyzed, 2);
    assert.equal(stats.excludedAnalyses, 2);
    assert.equal(stats.precision.user.accuracy, 90.5);
    assert.equal(stats.precision.user.acpl, 18);
    assert.equal(stats.precision.user.games, 2);
    assert.equal(stats.precision.user.acplGames, 2);
    assert.equal(stats.phases.opening, 2);
    assert.equal('eloSeries' in stats, false);
    assert.equal('opponentRating' in stats, false);
});

test('agrega aberturas por ECO/nome e limita a lista às cinco mais jogadas', () => {
    const games = [
        game('a1'),
        game('a2', { result: '1/2-1/2' }),
        game('b1', { eco: 'B20', opening: 'Siciliana' }),
        game('c1', { eco: 'C20', opening: 'Aberta' }),
        game('d1', { eco: 'D10', opening: 'Eslava' }),
        game('e1', { eco: 'A00', opening: 'Irregular' }),
        game('f1', { eco: 'A45', opening: 'Outras' }),
    ];

    const stats = Stats.compute(games, ['Alex'], { includeRating: false });

    assert.equal(stats.topOpenings.length, 5);
    assert.equal(stats.topOpenings[0].name, 'Catalan');
    assert.equal(stats.topOpenings[0].games, 2);
    assert.equal(stats.topOpenings[0].winRate, 50);
    assert.deepEqual(Array.from(stats.topOpenings, opening => opening.games), [2, 1, 1, 1, 1]);
});

test('Dashboard tem filtros próprios e apenas uma tabela de aberturas com cada ID', () => {
    for (const id of [
        'statsSourceFilter', 'statsTimeControlFilter', 'statsPeriodFilter',
        'statsDateFrom', 'statsDateTo', 'openingsTable',
    ]) {
        assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `ID duplicado ou ausente: ${id}`);
    }
    assert.equal(html.includes('id="ratingChart"'), false);
    assert.ok(html.includes('id="openingsViewTable"'));
});
