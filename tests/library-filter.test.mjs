/* Filtro de origem da Biblioteca. Executar com: npm test */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const games = [
    { id: 'chesscom', source: 'chesscom', white: 'Magnus', black: 'Opponent', dateISO: '2024-01-01', importedAt: 1 },
    { id: 'lichess', source: 'lichess', white: 'Player', black: 'Opponent', dateISO: '2024-01-02', importedAt: 2 },
    { id: 'manual', source: 'manual', white: 'Player', black: 'Opponent', dateISO: '2024-01-03', importedAt: 3 },
    { id: 'legacy', white: 'Magnus', black: 'Opponent', dateISO: '2024-01-04', importedAt: 4 },
    { id: 'unknown', source: 'other', white: 'Magnus', black: 'Opponent', dateISO: '2024-01-05', importedAt: 5 },
];
const sandbox = {
    State: {
        games,
        filters: { tokens: [], color: '', sort: 'date_asc' },
        filterSource: 'all',
    },
    window: {},
    console,
    identity: () => ({}),
    Stats: {
        userColor: () => '',
        normalize: value => String(value || '').toLowerCase(),
    },
};
vm.runInNewContext(await readFile(join(root, 'js/library.js'), 'utf8'), sandbox, {
    filename: 'js/library.js',
});

test('filtro de origem separa Chess.com, Lichess, manuais e registros legados', () => {
    const cases = [
        ['all', ['chesscom', 'lichess', 'manual', 'legacy', 'unknown']],
        ['chesscom', ['chesscom']],
        ['lichess', ['lichess']],
        ['manual', ['manual', 'legacy']],
    ];
    cases.forEach(([source, expected]) => {
        sandbox.State.filterSource = source;
        assert.deepEqual(Array.from(sandbox.filteredGames(), game => game.id), expected);
    });
});

test('origem combina com busca textual e mantém a ordenação aplicada', () => {
    sandbox.State.filterSource = 'manual';
    sandbox.State.filters.tokens = ['white:Magnus'];
    assert.deepEqual(Array.from(sandbox.filteredGames(), game => game.id), ['legacy']);

    sandbox.State.filterSource = 'all';
    sandbox.State.filters.tokens = ['white:Magnus'];
    assert.deepEqual(Array.from(sandbox.filteredGames(), game => game.id), ['chesscom', 'legacy', 'unknown']);
});
