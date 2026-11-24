/* Regressões da sincronização das fontes. Executar com: npm test */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = { console };
sandbox.window = sandbox;
vm.runInNewContext(await readFile(join(root, 'js/sources.js'), 'utf8'), sandbox, {
    filename: 'js/sources.js',
});
vm.runInNewContext(await readFile(join(root, 'js/sync.js'), 'utf8'), sandbox, {
    filename: 'js/sync.js',
});
const Sync = sandbox.Sync;

test('sincronização monta consultas mensais e período Lichess limitado a 100', () => {
    const now = new Date('2024-01-15T12:00:00.000Z');
    const chesscom = Sync.buildRequests('chesscom', 'magnus', 3, now);
    assert.deepEqual(Array.from(chesscom, request => request.month), ['2023-11', '2023-12', '2024-01']);
    assert.deepEqual(Array.from(chesscom, request => request.url), [
        '/api/chesscom?username=magnus&month=2023-11',
        '/api/chesscom?username=magnus&month=2023-12',
        '/api/chesscom?username=magnus&month=2024-01',
    ]);

    const lichess = Sync.buildRequests('lichess', 'thibault', 3, now);
    assert.equal(lichess.length, 1);
    const url = new URL(lichess[0].url, 'https://acervo.example');
    assert.equal(url.pathname, '/api/lichess');
    assert.equal(url.searchParams.get('username'), 'thibault');
    assert.equal(url.searchParams.get('max'), '100');
    assert.equal(url.searchParams.get('since'), String(Date.UTC(2023, 10, 1)));
    assert.equal(url.searchParams.get('until'), String(now.getTime()));
});

test('todo o histórico usa archives no Chess.com e omite max no Lichess', () => {
    const chesscom = Sync.buildRequests('chesscom', 'magnus', 'all');
    assert.equal(chesscom.length, 1);
    assert.equal(chesscom[0].type, 'archives');
    assert.equal(chesscom[0].url, '/api/chesscom?username=magnus&format=archives');

    const lichess = Sync.buildRequests('lichess', 'thibault', 'all');
    const url = new URL(lichess[0].url, 'https://acervo.example');
    assert.equal(url.pathname, '/api/lichess');
    assert.equal(url.searchParams.get('username'), 'thibault');
    assert.equal(url.searchParams.has('max'), false);
    assert.equal(url.searchParams.has('since'), false);
    assert.equal(url.searchParams.has('until'), false);
});

test('archives do Chess.com viram consultas mensais válidas e sem duplicatas', () => {
    const requests = Sync.requestsFromArchives('magnus', {
        archives: [
            'https://api.chess.com/pub/player/magnus/games/2020/01',
            'https://api.chess.com/pub/player/magnus/games/2020/02',
            'https://api.chess.com/pub/player/magnus/games/2020/02',
        ],
    });
    assert.deepEqual(Array.from(requests, request => request.month), ['2020-01', '2020-02']);
    assert.deepEqual(Array.from(requests, request => request.url), [
        '/api/chesscom?username=magnus&month=2020-01',
        '/api/chesscom?username=magnus&month=2020-02',
    ]);
    assert.throws(() => Sync.monthsFromArchives({
        archives: ['https://evil.example/games/2020/03'],
    }), /mês inválido/);
});

test('splitPgnBlocks reagrupa chunks Lichess e só emite partidas completas', () => {
    const firstGame = '[Event "One"]\r\n[Site "https://lichess.org/abc12345"]\r\n\r\n1. e4 e5 1-0';
    const secondGame = '[Event "Two"]\n[Site "https://lichess.org/def67890"]\n\n1. d4 d5 0-1';
    const fullPgn = `${firstGame}\n\n${secondGame}`;
    const boundary = fullPgn.indexOf('[Event "Two"]');
    const first = Sync.splitPgnBlocks(fullPgn.slice(0, boundary + 5), false);
    assert.deepEqual(Array.from(first.blocks), []);
    const second = Sync.splitPgnBlocks(first.remainder + fullPgn.slice(boundary + 5, boundary + 12), false);
    assert.deepEqual(Array.from(second.blocks), []);
    const third = Sync.splitPgnBlocks(second.remainder + fullPgn.slice(boundary + 12), false);
    assert.deepEqual(Array.from(third.blocks), [firstGame.replace(/\r\n/g, '\n')]);
    const last = Sync.splitPgnBlocks(third.remainder, true);
    assert.deepEqual(Array.from(last.blocks), [secondGame]);
    assert.equal(last.remainder, '');
});

test('controles de tempo PGN são classificados e filtrados localmente', () => {
    assert.equal(Sync.classifyTimeControl('15+0'), 'ultraBullet');
    assert.equal(Sync.classifyTimeControl('60+0'), 'bullet');
    assert.equal(Sync.classifyTimeControl('180+2'), 'blitz');
    assert.equal(Sync.classifyTimeControl('600+0'), 'rapid');
    assert.equal(Sync.classifyTimeControl('1800+30'), 'classical');
    assert.equal(Sync.classifyTimeControl('-', {}), 'correspondence');
    assert.equal(Sync.classifyTimeControl('unknown'), null);

    const games = [
        { headers: { TimeControl: '180+2' } },
        { headers: { TimeControl: '600+0' } },
        { headers: { Event: 'Rated correspondence game', TimeControl: '-' } },
        { headers: { TimeControl: '?' } },
    ];
    assert.deepEqual(
        Array.from(Sync.filterGamesByPerf(games, ['blitz']), game => game.headers.TimeControl),
        ['180+2']
    );
    assert.equal(Sync.filterGamesByPerf(games, sandbox.Sources.PERF_TYPES).length, games.length);
});

test('Biblioteca expõe acionadores e registra a faixa de contas sincronizadas', async () => {
    const html = await readFile(join(root, 'index.html'), 'utf8');
    assert.ok(html.includes('id="syncBtn"'));
    assert.ok(html.includes('id="syncSources"'));
    assert.ok(html.includes('id="emptyChesscomSyncBtn"'));
    assert.ok(html.includes('id="emptyLichessSyncBtn"'));
    assert.ok(html.includes('<script src="js/sources.js" defer></script>'));
    assert.ok(html.includes('<script src="js/sync.js" defer></script>'));
    assert.ok(html.indexOf('js/sources.js') < html.indexOf('js/sync.js'));
});
