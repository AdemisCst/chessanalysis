/* Chaves de análise e separação por motor.
   Executar com: npm test

   Carrega o js/storage.js real em `vm`. O IndexedDB não é aberto: aqui só se
   verifica a função pura que monta a chave, que é a base da não colisão entre
   análises do SF10 e do SF19. A migração de verdade é exercitada no smoke CDP
   com IndexedDB real (docs/TESTES-FASE-2.md §13). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'js/storage.js'), 'utf8');
const context = vm.createContext({
    window: {},
    console,
    localStorage: { getItem: () => null, setItem: () => {} },
});
vm.runInContext(source, context, { filename: 'js/storage.js' });
const { DB } = context.window;

test('chave legada continua idêntica (gameId@depth)', () => {
    assert.equal(DB.analysisKey('g_1', 12), 'g_1@12');
    assert.equal(DB.analysisKey('g_1', 12, ''), 'g_1@12');
});

test('chave nova inclui o build (gameId@depth@build)', () => {
    assert.equal(
        DB.analysisKey('g_1', 12, 'stockfish-19-lite-single'),
        'g_1@12@stockfish-19-lite-single'
    );
});

test('SF10 e SF19 na mesma profundidade não colidem', () => {
    const legacy = DB.analysisKey('g_1', 12);
    const current = DB.analysisKey('g_1', 12, 'stockfish-19-lite-single');
    const other = DB.analysisKey('g_1', 12, 'stockfish-10-legacy');
    assert.notEqual(legacy, current);
    assert.notEqual(legacy, other);
    assert.notEqual(current, other);
});

test('profundidades diferentes continuam separadas', () => {
    assert.notEqual(
        DB.analysisKey('g_1', 10, 'stockfish-19-lite-single'),
        DB.analysisKey('g_1', 12, 'stockfish-19-lite-single')
    );
});

test('fila usa exatamente a mesma chave da análise', () => {
    assert.equal(DB.queueKey('g_1', 12, 'stockfish-19-lite-single'), DB.analysisKey('g_1', 12, 'stockfish-19-lite-single'));
    assert.equal(DB.queueKey('g_1', 12), 'g_1@12');
    assert.equal(DB.queueKey('g_1', 12, 'stockfish-10-legacy'), 'g_1@12@stockfish-10-legacy');
});

test('saveBatch grava metadados e lances na mesma transação', async () => {
    const records = { games: [], data: [] };
    const transactions = [];
    const db = {
        objectStoreNames: { contains: () => true },
        transaction(names, mode) {
            const pending = { games: [], data: [] };
            const tx = {
                error: null,
                objectStore(name) {
                    return { put: value => pending[name].push(value) };
                },
            };
            transactions.push({ names, mode });
            queueMicrotask(() => {
                Object.keys(pending).forEach(name => records[name].push(...pending[name]));
                if (tx.oncomplete) tx.oncomplete();
            });
            return tx;
        },
    };
    const indexedDB = {
        open() {
            const request = {};
            queueMicrotask(() => {
                request.result = db;
                request.onsuccess();
            });
            return request;
        },
    };
    context.indexedDB = indexedDB;
    context.window.indexedDB = indexedDB;

    await DB.saveBatch(
        [{ id: 'g1', white: 'A' }, { id: 'g2', white: 'B' }],
        [{ id: 'g1', moves: [1] }, { id: 'g2', moves: [2] }]
    );

    assert.equal(transactions.length, 1);
    assert.deepEqual(Array.from(transactions[0].names), ['games', 'data']);
    assert.equal(transactions[0].mode, 'readwrite');
    assert.deepEqual(records.games.map(game => game.id), ['g1', 'g2']);
    assert.deepEqual(records.data.map(data => data.id), ['g1', 'g2']);
    await assert.rejects(
        DB.saveBatch([{ id: 'g3' }], [{ id: 'other' }]),
        /não correspondem/
    );
    assert.equal(transactions.length, 1);
});
