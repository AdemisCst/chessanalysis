/* Regras puras da Central de Análises (M5). Executar com: npm test */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'js/queue-ui.js'), 'utf8');
const sandbox = { window: {}, console };
vm.runInNewContext(source, sandbox, { filename: 'js/queue-ui.js' });
const ui = sandbox.window.QueueUI;

test('estados da fila têm rótulos e grupos estáveis', () => {
    assert.equal(ui.stateMeta('pending').label, 'Pendente');
    assert.equal(ui.stateMeta('running').label, 'Rodando');
    assert.equal(ui.stateMeta('paused').label, 'Pausada');
    assert.equal(ui.stateMeta('error').chip, 'danger');
    assert.equal(ui.stateMeta('done').group, 'done');
    assert.equal(ui.stateMeta('canceled').label, 'Cancelada');
});

test('progresso individual usa o status vivo do executor', () => {
    const item = { key: 'a', state: 'running', positionsTotal: 20, positionsDone: 8 };
    const status = { itemKey: 'a', done: 12, total: 20 };
    assert.deepEqual({ ...ui.progressOf(item, status) }, { done: 12, total: 20, pct: 60, known: true });

    const other = { itemKey: 'b', done: 20, total: 20 };
    assert.deepEqual({ ...ui.progressOf(item, other) }, { done: 8, total: 20, pct: 40, known: true });
});

test('item concluído chega a 100% mesmo sem total declarado', () => {
    assert.deepEqual(
        { ...ui.progressOf({ key: 'a', state: 'done', positionsDone: 7, positionsTotal: null }, null) },
        { done: 7, total: 0, pct: 100, known: false }
    );
});

test('resumo global ignora canceladas e soma só o que tem total', () => {
    const items = [
        { key: 'a', state: 'done', positionsTotal: 10, positionsDone: 10 },
        { key: 'b', state: 'running', positionsTotal: 10, positionsDone: 4 },
        { key: 'c', state: 'canceled', positionsTotal: 10, positionsDone: 0 },
        { key: 'd', state: 'pending', positionsTotal: 10, positionsDone: 0 },
    ];
    const summary = ui.summarize(items, { itemKey: 'b', done: 6, total: 10 });
    assert.equal(summary.total, 30);
    assert.equal(summary.done, 16);
    assert.equal(summary.pct, 53);
    assert.equal(summary.unknown, 0);
    assert.equal(summary.counters.canceled, 1);
});

test('filtros agrupam pendentes, andamento, falhas e concluídas', () => {
    assert.equal(ui.matchesFilter({ state: 'paused' }, 'pending'), true);
    assert.equal(ui.matchesFilter({ state: 'interrupted' }, 'pending'), true);
    assert.equal(ui.matchesFilter({ state: 'running' }, 'active'), true);
    assert.equal(ui.matchesFilter({ state: 'error' }, 'failed'), true);
    assert.equal(ui.matchesFilter({ state: 'canceled' }, 'done'), true);
    assert.equal(ui.matchesFilter({ state: 'done' }, 'pending'), false);
    assert.equal(ui.matchesFilter({ state: 'error' }, 'all'), true);
});

test('ETA usa a média móvel das últimas partidas concluídas', () => {
    const items = [
        { state: 'done', startedAt: 1000, finishedAt: 11000, positionsTotal: 10 },
        { state: 'done', startedAt: 1000, finishedAt: 21000, positionsTotal: 10 },
    ];
    const remaining = ui.estimateRemaining(items, { done: 20, total: 40 });
    assert.equal(remaining, 30000); // média 1,5 s/posição × 20 posições
    assert.equal(ui.formatDuration(remaining), '~30 s');
    assert.equal(ui.estimateRemaining(items, { done: 40, total: 40 }), null);
});
