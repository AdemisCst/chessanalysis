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

/* ---------- coordenação entre abas (M4) ---------- */

test('lease vale menos de 20 s e é renovado a cada 5 s', () => {
    assert.equal(Queue.LEASE_MS, 20000);
    assert.equal(Queue.HEARTBEAT_MS, 5000);
    assert.equal(Queue.CHECKPOINT_EVERY, 4);
    assert.equal(Queue.isLeaseActive({ tabId: 'a', heartbeatAt: 1000 }, 20000), true, '19 s');
    assert.equal(Queue.isLeaseActive({ tabId: 'a', heartbeatAt: 1000 }, 21000), false, '20 s exatos');
    assert.equal(Queue.isLeaseActive({ tabId: 'a', heartbeatAt: 1000 }, 22000), false, '21 s');
    assert.equal(Queue.isLeaseActive(null, 1000), false);
});

test('nextItem escolhe o primeiro executável por prioridade', () => {
    const items = [
        { key: 'done', state: 'done', priority: 1, createdAt: 1 },
        { key: 'error', state: 'error', priority: 2, createdAt: 2 },
        { key: 'paused', state: 'paused', priority: 5, createdAt: 5 },
        { key: 'pending-b', state: 'pending', priority: 4, createdAt: 4 },
        { key: 'pending-a', state: 'pending', priority: 3, createdAt: 3 },
        { key: 'canceled', state: 'canceled', priority: 0, createdAt: 0 },
    ];
    assert.equal(Queue.nextItem(items, 1000).key, 'pending-a');
});

test('nextItem respeita o lease ativo e libera o expirado', () => {
    const items = [{ key: 'a', state: 'pending', priority: 1, createdAt: 1, leaseOwner: 'tab-a', heartbeatAt: 1000 }];
    assert.equal(Queue.nextItem(items, 19000), null, 'lease ativo');
    assert.equal(Queue.nextItem(items, 22000).key, 'a', 'lease expirado');
    assert.equal(Queue.nextItem([], 1000), null);
});

const checkpoint = (extra = {}) => ({
    key: 'g@12@stockfish-19-lite-single',
    gameId: 'g',
    depth: 12,
    engineBuild: 'stockfish-19-lite-single',
    startFen: 'start',
    movesLength: 4,
    positions: [{ cp: 1 }, { cp: 2 }, { cp: 3 }],
    resumeAt: 3,
    fenAtResume: 'fen3',
    ...extra,
});

const expected = (extra = {}) => ({
    key: 'g@12@stockfish-19-lite-single',
    gameId: 'g',
    depth: 12,
    engineBuild: 'stockfish-19-lite-single',
    startFen: 'start',
    movesLength: 4,
    total: 5,
    fenAtResume: 'fen3',
    ...extra,
});

test('validateCheckpoint aceita checkpoint consistente', () => {
    const result = Queue.validateCheckpoint(checkpoint(), expected());
    assert.equal(result.ok, true);
    assert.equal(result.empty, false);
    assert.equal(result.resumeAt, 3);
    assert.equal(result.positions.length, 3);
    assert.equal(result.positions[2].cp, 3);
});

test('validateCheckpoint trata ausência como começo do zero', () => {
    const result = Queue.validateCheckpoint(null, expected());
    assert.equal(result.ok, false);
    assert.equal(result.empty, true);
});

test('validateCheckpoint rejeita cada campo divergente', () => {
    ['key', 'gameId', 'depth', 'engineBuild', 'startFen', 'movesLength', 'fenAtResume'].forEach(field => {
        const broken = {};
        broken[field] = 'outro';
        const result = Queue.validateCheckpoint(checkpoint(broken), expected());
        assert.equal(result.ok, false, field);
        assert.equal(result.empty, false, field);
    });
});

test('validateCheckpoint rejeita resumeAt fora da partida ou sem posições', () => {
    assert.equal(Queue.validateCheckpoint(checkpoint({ resumeAt: 9 }), expected()).ok, false);
    assert.equal(Queue.validateCheckpoint(checkpoint({ resumeAt: -1 }), expected()).ok, false);
    assert.equal(Queue.validateCheckpoint(checkpoint({ resumeAt: 4 }), expected()).ok, false, 'posições insuficientes');
    assert.equal(Queue.validateCheckpoint(checkpoint({ positions: new Array(8).fill({}) }), expected()).ok, false, 'posições excedentes');
});

test('validateCheckpoint aceita partida inteira já coberta', () => {
    const full = checkpoint({ resumeAt: 5, positions: [{}, {}, {}, {}, {}], fenAtResume: null });
    const result = Queue.validateCheckpoint(full, expected({ total: 5, fenAtResume: null }));
    assert.equal(result.ok, true);
    assert.equal(result.resumeAt, 5);
    assert.equal(result.positions.length, 5);
});
