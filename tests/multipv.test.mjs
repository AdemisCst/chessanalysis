import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('engine solicita MultiPV 2 e preserva a segunda linha UCI', async () => {
    const messages = [];
    class MockWorker {
        postMessage(command) {
            messages.push(command);
            if (command === 'uci') {
                setTimeout(() => {
                    this.onmessage({ data: 'id name Mock Stockfish' });
                    this.onmessage({ data: 'uciok' });
                }, 0);
            } else if (command === 'isready') {
                setTimeout(() => this.onmessage({ data: 'readyok' }), 0);
            } else if (command.startsWith('go depth ')) {
                setTimeout(() => {
                    this.onmessage({
                        data: 'info depth 12 multipv 2 score cp -22 wdl 250 400 350 pv d2d4 d7d5',
                    });
                    this.onmessage({
                        data: 'info depth 12 multipv 1 score cp 34 wdl 450 400 150 pv e2e4 e7e5',
                    });
                    this.onmessage({ data: 'bestmove e2e4' });
                }, 0);
            }
        }
    }

    const context = vm.createContext({
        window: {},
        console,
        setTimeout,
        clearTimeout,
        location: { protocol: 'http:' },
        Worker: MockWorker,
    });
    const chess = await readFile(join(root, 'vendor/chess.js'), 'utf8');
    const engine = await readFile(join(root, 'js/engine.js'), 'utf8');
    vm.runInContext(chess, context, { filename: 'vendor/chess.js' });
    vm.runInContext(engine, context, { filename: 'js/engine.js' });

    const analysis = await context.window.Engine.analyzeGame(
        { id: 'multipv-test' },
        { startFen: new context.Chess().fen(), moves: [] },
        { depth: 12 }
    );

    assert.ok(messages.includes('setoption name MultiPV value 2'));
    assert.equal(analysis.positions[0].best, 'e2e4');
    assert.equal(analysis.positions[0].cp, 34);
    assert.equal(analysis.positions[0].secondBest, 'd2d4');
    assert.equal(analysis.positions[0].secondCp, -22);
    assert.deepEqual(Array.from(analysis.positions[0].secondPv), ['d2d4', 'd7d5']);
});
