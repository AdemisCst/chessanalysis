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
