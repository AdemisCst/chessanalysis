/* Regras puras da fila de análise (Fase 3, M1).
   Executar com: npm test

   Carrega js/queue.js real em `vm`. Não há IndexedDB aqui: a transação é
   testada no smoke CDP com banco real (docs/TESTES-FASE-3.md). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'js/queue.js'), 'utf8');
const context = vm.createContext({ window: {}, console });
vm.runInContext(source, context, { filename: 'js/queue.js' });
const { Queue } = context.window;

const entry = (gameId, depth = 12, extra = {}) => ({
    key: `game-${gameId}@${depth}@stockfish-19-lite-single`,
    gameId: `game-${gameId}`,
    depth,
    engineBuild: 'stockfish-19-lite-single',
    positionsTotal: 40,
    ...extra,
});

test('normalize devolve o contrato completo com defaults seguros', () => {
    const item = Queue.normalize(entry(1), 1000, 0);
    assert.equal(item.state, 'pending');
    assert.equal(item.attempts, 0);
    assert.equal(item.positionsDone, 0);
    assert.equal(item.positionsTotal, 40);
    assert.equal(item.priority, 1000);
    assert.equal(item.createdAt, 1000);
    assert.equal(item.leaseOwner, null);
    assert.equal(item.lastError, null);
});

test('normalize preserva a ordem de prioridade pelo índice do lote', () => {
    const a = Queue.normalize(entry(1), 1000, 0);
    const b = Queue.normalize(entry(2), 1000, 1);
    const c = Queue.normalize(entry(3), 1000, 2);
    assert.deepEqual([a.priority, b.priority, c.priority], [1000, 1001, 1002]);
});

test('normalize descarta entrada sem identidade ou profundidade inválida', () => {
    assert.equal(Queue.normalize(null, 1, 0), null);
    assert.equal(Queue.normalize({ gameId: 'g', depth: 12 }, 1, 0), null, 'sem key');
    assert.equal(Queue.normalize({ key: 'k', depth: 12 }, 1, 0), null, 'sem gameId');
    assert.equal(Queue.normalize(entry(1, 0), 1, 0), null, 'depth 0');
    assert.equal(Queue.normalize(entry(1, -3), 1, 0), null, 'depth negativo');
    assert.equal(Queue.normalize(entry(1, 'abc'), 1, 0), null, 'depth não numérica');
});

test('positionsTotal inválido vira null, não zero', () => {
    assert.equal(Queue.normalize(entry(1, 12, { positionsTotal: null }), 1, 0).positionsTotal, null);
    assert.equal(Queue.normalize(entry(1, 12, { positionsTotal: -1 }), 1, 0).positionsTotal, null);
});

test('plan ignora quem já está ativo na fila', () => {
    const active = [{ key: entry(1).key, state: 'pending' }];
    const result = Queue.plan(active, [entry(1), entry(2)], Queue.MAX_ITEMS);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.accepted[0].gameId, 'game-2');
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0], entry(1).key);
    assert.equal(result.capReached, false);
});

test('plan deduplica dentro do próprio lote', () => {
    const result = Queue.plan([], [entry(1), entry(1), entry(2)], Queue.MAX_ITEMS);
    assert.equal(result.accepted.length, 2);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0], entry(1).key);
});

test('plan não conta done/canceled no teto', () => {
    const terminal = [
        { key: 'done-1', state: 'done' },
        { key: 'done-2', state: 'canceled' },
    ];
    const result = Queue.plan(terminal, [entry(1)], 1);
    assert.equal(result.accepted.length, 1);
    assert.equal(result.capReached, false);
});

test('plan respeita o teto e reporta o excedente', () => {
    const batch = Array.from({ length: 5 }, (_, i) => entry(i + 1));
    const result = Queue.plan([], batch, 3);
    assert.equal(result.accepted.length, 3);
    assert.equal(result.rejected.length, 2);
    assert.equal(result.capReached, true);
    assert.equal(result.limit, 3);
});

test('teto padrão é 200 itens ativos', () => {
    assert.equal(Queue.MAX_ITEMS, 200);
    const batch = Array.from({ length: 205 }, (_, i) => entry(i + 1));
    const result = Queue.plan([], batch, Queue.MAX_ITEMS);
    assert.equal(result.accepted.length, 200);
    assert.equal(result.rejected.length, 5);
    assert.equal(result.capReached, true);
});

test('plan não altera os candidatos originais', () => {
    const original = entry(1);
    const snapshot = JSON.stringify(original);
    Queue.plan([], [original], Queue.MAX_ITEMS);
    assert.equal(JSON.stringify(original), snapshot);
});

test('estados ativos e terminais são exclusivos', () => {
    Queue.ACTIVE_STATES.forEach(state => {
        assert.equal(Queue.isActive({ state }), true, state);
        assert.equal(Queue.isTerminal({ state }), false, state);
    });
    Queue.TERMINAL_STATES.forEach(state => {
        assert.equal(Queue.isTerminal({ state }), true, state);
        assert.equal(Queue.isActive({ state }), false, state);
    });
    assert.equal(Queue.isActive(null), false);
    assert.equal(Queue.isTerminal({ state: 'desconhecido' }), false);
});
