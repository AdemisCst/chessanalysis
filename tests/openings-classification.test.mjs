import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'js/openings.js'), 'utf8');

test('Livro exige que toda a sequência até o lance atual seja prefixo ECO', async () => {
    const entries = [{
        eco: 'C20',
        name: 'Kings Pawn Game',
        moves: ['e4', 'e5', 'Nf3', 'Nc6'],
    }];
    const context = vm.createContext({
        window: {},
        console,
        fetch: async () => ({ ok: true, json: async () => entries }),
    });
    vm.runInContext(source, context, { filename: 'js/openings.js' });
    const openings = context.window.Openings;
    await openings.load();

    assert.equal(openings.isBookSequence(['e4', 'e5', 'Nf3']), true);
    assert.equal(openings.isBookSequence(['e4', 'e5', 'Nf3', 'Nc6']), true);
    assert.equal(openings.isBookSequence(['e4', 'c5']), false);
    assert.equal(openings.isBookSequence(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']), false);
});
