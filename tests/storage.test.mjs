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
