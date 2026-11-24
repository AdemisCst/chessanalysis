/* Migração das origens legadas. Executar com: npm test */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'js/app.js'), 'utf8');

function createContext(games, storedMarker) {
    const state = { marker: storedMarker || null, reads: 0, batches: [], yields: 0 };
    const sandbox = {
        document: { addEventListener() {} },
        localStorage: {
            getItem(key) {
                assert.equal(key, 'acervo64_source_migration_done');
                return state.marker;
            },
            setItem(key, value) {
                assert.equal(key, 'acervo64_source_migration_done');
                state.marker = value;
            },
        },
        DB: {
            async getAll(name) {
                assert.equal(name, 'games');
                state.reads++;
                return games;
            },
            async bulkPut(name, batch) {
                assert.equal(name, 'games');
                state.batches.push(batch);
            },
        },
        setTimeout(callback, delay) {
            assert.equal(delay, 0);
            state.yields++;
            callback();
        },
        console,
    };
    vm.runInNewContext(source, sandbox, { filename: 'js/app.js' });
    return { migrate: sandbox.migrateGameSources, state };
}

test('migra origens pelo cabeçalho Site ou Link e mantém fontes existentes', async () => {
    const { migrate, state } = createContext([
        { id: 'chesscom', headers: { lInK: 'https://www.chess.com/game/live/1' } },
        { id: 'lichess', headers: { Site: 'https://lichess.org/game/abc' } },
        { id: 'manual', headers: { Event: 'Torneio local' } },
        { id: 'existing', source: 'lichess', headers: { Site: 'https://chess.com/game/2' } },
    ]);

    const result = await migrate();

    assert.deepEqual(JSON.parse(JSON.stringify(state.batches[0])), [
        { id: 'chesscom', headers: { lInK: 'https://www.chess.com/game/live/1' }, source: 'chesscom' },
        { id: 'lichess', headers: { Site: 'https://lichess.org/game/abc' }, source: 'lichess' },
        { id: 'manual', headers: { Event: 'Torneio local' }, source: 'manual' },
    ]);
    assert.equal(result.updated, 3);
    assert.equal(state.marker, 'true');
});

test('grava em lotes e cede tempo entre lotes', async () => {
    const games = Array.from({ length: 401 }, (_, id) => ({ id: String(id) }));
    const { migrate, state } = createContext(games);

    const result = await migrate();

    assert.deepEqual(state.batches.map(batch => batch.length), [200, 200, 1]);
    assert.equal(state.yields, 2);
    assert.equal(result.updated, 401);
});

test('não repete a varredura depois de marcar a migração concluída', async () => {
    const { migrate, state } = createContext([], 'true');

    const result = await migrate();

    assert.equal(result.updated, 0);
    assert.equal(result.skipped, true);
    assert.equal(state.reads, 0);
    assert.equal(state.batches.length, 0);
});
