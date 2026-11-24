/* Whitelists dos prompts enviados ao provedor externo. Executar com: npm test */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'js/ai.js'), 'utf8');
const context = vm.createContext({ window: {}, console, Settings: { get: () => ({}) } });
vm.runInContext(source, context, { filename: 'js/ai.js' });
const AI = context.window.AI;

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

test('explicação de lance envia somente os campos permitidos', () => {
    const messages = AI.moveExplanationMessages({
        fen: START_FEN,
        color: 'w',
        playedSan: 'e4',
        classification: 'mistake',
        loss: 21.26,
        bestMove: 'd4',
        pvSan: 'd4 d5',
        white: 'Alex Secret',
        username: 'private-user',
        gameId: 'private-game-id',
        pgn: '[Event "Private"]',
    });
    const payload = JSON.parse(messages[1].content.split('DADOS DO LANCE:\n')[1]);

    assert.deepEqual(Object.keys(payload), [
        'fen', 'color', 'playedSan', 'classification', 'loss', 'bestMove', 'pvSan',
    ]);
    assert.equal(payload.color, 'Brancas');
    assert.equal(payload.loss, 21.3);
    assert.equal(messages[1].content.includes('Alex Secret'), false);
    assert.equal(messages[1].content.includes('private-user'), false);
    assert.equal(messages[1].content.includes('private-game-id'), false);
    assert.equal(messages[1].content.includes('[Event'), false);
});

test('repertório envia apenas cor, ECO, nome, partidas, V/E/D e aproveitamento', () => {
    const messages = AI.repertoireMessages({
        w: {
            best: [{
                eco: 'E00', name: 'Catalã', games: 12, win: 7, draw: 3, loss: 2, pct: 70,
                opponent: 'Alex Secret', lastOpponent: 'Private Player', rating: 1800, gameId: 'private-id',
            }],
            worst: [{
                eco: 'B20', name: 'Resultado desconhecido', games: 8, win: 0, draw: 0, loss: 0, pct: null,
            }],
        },
        b: { best: [], worst: [] },
        username: 'private-user',
        rating: 2000,
    });
    const payload = JSON.parse(messages[1].content.split('DADOS PERMITIDOS:\n')[1]);
    const entry = payload.brancas.melhores[0];

    assert.deepEqual(Object.keys(entry), [
        'color', 'eco', 'name', 'games', 'win', 'draw', 'loss', 'pct',
    ]);
    assert.equal(entry.color, 'Brancas');
    assert.equal(payload.brancas.piores.length, 0);
    assert.equal(messages[1].content.includes('Alex Secret'), false);
    assert.equal(messages[1].content.includes('Private Player'), false);
    assert.equal(messages[1].content.includes('private-user'), false);
    assert.equal(messages[1].content.includes('private-id'), false);
    assert.equal(messages[1].content.includes('"rating"'), false);
});

test('recusa FEN inválida em vez de montar um prompt incompleto', () => {
    assert.throws(() => AI.moveExplanationMessages({
        fen: 'not-a-fen',
        color: 'w',
        playedSan: 'e4',
        classification: 'mistake',
        loss: 20,
    }), /Dados insuficientes/);
});
