/* Regras puras das integrações Chess.com e Lichess (Fase 4, M4.1).
   Executar com: npm test

   Carrega `js/sources.js` real em `vm`. Nada de rede aqui: o módulo é puro e
   os proxies são verificados à parte (M4.2). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'js/sources.js'), 'utf8');
const sandbox = { window: {}, console };
vm.runInNewContext(source, sandbox, { filename: 'js/sources.js' });
const Sources = sandbox.window.Sources;

const codeOf = fn => {
    try {
        fn();
    } catch (error) {
        return error.code;
    }
    return null;
};

/* ---------- usuário ---------- */

test('normalizeUsername aceita arroba, URL e maiúsculas', () => {
    assert.equal(Sources.normalizeUsername('lichess', '@Hikaru'), 'hikaru');
    assert.equal(Sources.normalizeUsername('chesscom', '  Hikaru  '), 'hikaru');
    assert.equal(Sources.normalizeUsername('lichess', 'https://lichess.org/@/Thibault'), 'thibault');
    assert.equal(Sources.normalizeUsername('chesscom', 'https://www.chess.com/member/Hikaru?x=1'), 'hikaru');
    assert.equal(Sources.normalizeUsername('lichess', ''), '');
    assert.equal(Sources.normalizeUsername('lichess', null), '');
});

test('validateUsername distingue vazio, inválido e válido por fonte', () => {
    assert.equal(Sources.validateUsername('lichess', '').error, 'empty_username');

    const curto = Sources.validateUsername('chesscom', 'ab');
    assert.equal(curto.ok, false);
    assert.equal(curto.error, 'invalid_username');
    assert.ok(curto.message.includes('3 a 25'));

    // O mesmo nome é válido no Lichess (mínimo de 2 caracteres).
    assert.equal(Sources.validateUsername('lichess', 'ab').ok, true);

    assert.equal(Sources.validateUsername('chesscom', 'nome com espaço').ok, false);
    assert.equal(Sources.validateUsername('chesscom', '-comeca-com-hifen').ok, false);

    const ok = Sources.validateUsername('lichess', 'https://lichess.org/@/DrNykterstein');
    assert.deepEqual({ ...ok }, { ok: true, username: 'drnykterstein' });
});

test('fonte desconhecida falha com código próprio', () => {
    assert.equal(codeOf(() => Sources.normalizeUsername('pgn', 'x')), 'unknown_source');
    assert.equal(codeOf(() => Sources.proxyPath('fide')), 'unknown_source');
    assert.equal(Sources.describeError('not_found'), 'Usuário não encontrado nesta fonte.');
    assert.ok(Sources.describeError('codigo-inexistente').length > 0);
});

/* ---------- período ---------- */

test('monthKey normaliza Date, timestamp e texto', () => {
    assert.equal(Sources.monthKey(new Date(Date.UTC(2024, 0, 31))), '2024-01');
    assert.equal(Sources.monthKey('2024-02-29'), '2024-02');
    assert.equal(Sources.monthKey('2024-2'), '2024-02');
    assert.equal(Sources.monthKey('2024-13'), null);
    assert.equal(Sources.monthKey('ontem'), null);
    assert.equal(Sources.monthKey(''), null);
});

test('parseMonth expõe ano, mês e índice contínuo', () => {
    assert.deepEqual({ ...Sources.parseMonth('2024-03') }, { key: '2024-03', year: 2024, month: 3, index: 2024 * 12 + 2 });
    assert.equal(Sources.parseMonth('2024-00'), null);
});

test('monthsBack devolve o período crescente e atravessa a virada do ano', () => {
    const tres = [...Sources.monthsBack(3, '2024-01-15')];
    assert.deepEqual(tres, ['2023-11', '2023-12', '2024-01']);
    assert.deepEqual([...Sources.monthsBack(1, '2024-11')], ['2024-11']);
    assert.equal(tres.length, Sources.DEFAULT_MONTHS);
});

test('monthsBack limita a quantidade em vez de gerar um período absurdo', () => {
    const meses = Sources.monthsBack(500, '2024-06');
    assert.equal(meses.length, Sources.MAX_MONTHS);
    assert.equal(meses[meses.length - 1], '2024-06');
    assert.equal(Sources.monthsBack(0, '2024-06').length, 1);
    assert.equal(codeOf(() => Sources.monthsBack(3, 'sem-mes')), 'invalid_period');
});

test('monthsBetween valida ordem, limite e inclusive os extremos', () => {
    assert.deepEqual([...Sources.monthsBetween('2023-12', '2024-02')], ['2023-12', '2024-01', '2024-02']);
    assert.deepEqual([...Sources.monthsBetween('2024-02', '2024-02')], ['2024-02']);
    assert.equal(codeOf(() => Sources.monthsBetween('2024-03', '2024-02')), 'invalid_period');
    assert.equal(codeOf(() => Sources.monthsBetween('2023-01', '2025-01')), 'period_too_long');
    assert.equal(Sources.monthsBetween('2023-02', '2025-01').length, Sources.MAX_MONTHS);
});

/* ---------- URLs oficiais ---------- */

test('URLs do Chess.com seguem o contrato oficial', () => {
    assert.equal(
        Sources.buildChesscomProfileUrl(null, 'hikaru'),
        'https://api.chess.com/pub/player/hikaru'
    );
    assert.equal(
        Sources.buildChesscomArchivesUrl(null, 'hikaru'),
        'https://api.chess.com/pub/player/hikaru/games/archives'
    );
    assert.equal(
        Sources.buildChesscomPgnUrl(null, 'hikaru', '2024-02'),
        'https://api.chess.com/pub/player/hikaru/games/2024/02/pgn'
    );
    // Base alternativa (o proxy usa a mesma função com a origem oficial).
    assert.equal(
        Sources.buildChesscomArchivesUrl('https://api.chess.com/', 'hikaru'),
        'https://api.chess.com/pub/player/hikaru/games/archives'
    );
    assert.equal(codeOf(() => Sources.buildChesscomPgnUrl(null, 'hikaru', '2024-13')), 'invalid_month');
});

test('URL Lichess de perfil usa /api/user', () => {
    assert.equal(
        Sources.buildLichessProfileUrl(null, 'thibault'),
        'https://lichess.org/api/user/thibault'
    );
});

test('URL Lichess de PGN aceita só parâmetros conhecidos e limita max', () => {
    const url = Sources.buildLichessPgnUrl(null, 'thibault', {
        max: 5000,
        since: new Date(Date.UTC(2024, 0, 1)),
        rated: false,
        perfType: 'Blitz, bullet,bogus',
        color: 'WHITE',
        clocks: true,
        moves: 'true',
        lixo: 'nao-passa',
        extra: 'tambem-nao',
    });
    assert.ok(url.startsWith('https://lichess.org/api/games/user/thibault?'));
    const query = new URL(url).searchParams;
    assert.equal(query.get('max'), String(Sources.LICHESS_MAX));
    assert.equal(query.get('since'), String(Date.UTC(2024, 0, 1)));
    assert.equal(query.get('rated'), '0');
    assert.equal(query.get('perfType'), 'blitz,bullet');
    assert.equal(query.get('color'), 'white');
    assert.equal(query.get('clocks'), '1');
    assert.equal(query.get('moves'), '1');
    assert.equal(query.has('lixo'), false);
    assert.equal(query.has('extra'), false);
    assert.equal(query.has('until'), false);

    assert.equal(
        Sources.buildLichessPgnUrl(null, 'thibault', {}),
        'https://lichess.org/api/games/user/thibault'
    );
    assert.equal(
        new URL(Sources.buildLichessPgnUrl(null, 'thibault', { max: 0 })).searchParams.get('max'),
        '1'
    );
});

test('URLs do proxy são determinísticas e descartam parâmetros vazios', () => {
    assert.equal(Sources.proxyPath('chesscom'), '/api/chesscom');
    assert.equal(Sources.proxyPath('lichess'), '/api/lichess');
    assert.equal(
        Sources.buildProxyUrl('chesscom', { username: 'hikaru', format: 'archives', month: '' }),
        '/api/chesscom?username=hikaru&format=archives'
    );
    assert.equal(
        Sources.buildProxyUrl('lichess', { username: 'a b', max: 100, since: null, until: undefined }),
        '/api/lichess?username=a%20b&max=100'
    );
    assert.equal(Sources.buildProxyUrl('lichess', {}), '/api/lichess');
});

/* ---------- identidade externa ---------- */

test('extractExternalId lê o Link do Chess.com (daily e live)', () => {
    const daily = Sources.extractExternalId({
        headers: { Link: 'https://www.chess.com/game/daily/82586502' },
    });
    assert.deepEqual({ ...daily }, {
        source: 'chesscom',
        externalId: '82586502',
        sourceUrl: 'https://www.chess.com/game/daily/82586502',
    });

    const live = Sources.extractExternalId({
        headers: { Link: 'https://www.chess.com/game/live/1234567890?ref=share' },
    }, 'chesscom');
    assert.equal(live.externalId, '1234567890');
});

test('extractExternalId lê GameId e Site do Lichess', () => {
    const porGameId = Sources.extractExternalId({
        headers: {
            GameId: 'rBRo2im9',
            Site: 'https://lichess.org/game/rBRo2im9',
        },
    });
    assert.deepEqual({ ...porGameId }, {
        source: 'lichess',
        externalId: 'rBRo2im9',
        sourceUrl: 'https://lichess.org/rBRo2im9',
    });

    const porSite = Sources.extractExternalId({
        headers: { Site: 'https://lichess.org/abcd1234' },
    }, 'lichess');
    assert.equal(porSite.externalId, 'abcd1234');

    // Com dica de fonte, o cabeçalho da outra fonte é ignorado.
    assert.equal(
        Sources.extractExternalId({ headers: { GameId: 'rBRo2im9' } }, 'chesscom'),
        null
    );
});

test('extractExternalId nunca inventa id quando o PGN não traz identidade', () => {
    assert.equal(Sources.extractExternalId({ headers: {} }), null);
    assert.equal(Sources.extractExternalId({}), null);
    assert.equal(Sources.extractExternalId(null), null);
    assert.equal(Sources.extractExternalId({ headers: { Site: 'Chess.com', GameId: 'curto' } }), null);
    assert.equal(Sources.extractExternalId({ headers: { Link: 'sem-numero' } }), null);
});

test('detectSource e gameSource classificam a origem exibida', () => {
    assert.equal(Sources.detectSource({ headers: { Link: 'https://www.chess.com/game/daily/1' } }), null);
    assert.equal(
        Sources.detectSource({ headers: { Link: 'https://www.chess.com/game/daily/82586502' } }),
        'chesscom'
    );
    assert.equal(
        Sources.detectSource({ headers: { GameId: 'rBRo2im9' } }),
        'lichess'
    );
    assert.equal(Sources.detectSource({ headers: { Event: 'Torneio local' } }), null);

    assert.equal(Sources.gameSource({ source: 'LICHESS' }), 'lichess');
    assert.equal(Sources.gameSource({ headers: { GameId: 'rBRo2im9' } }), 'lichess');
    assert.equal(Sources.gameSource({ importedFrom: 'arquivo.pgn' }), 'manual');
    assert.equal(Sources.gameSource({}), 'manual');
});

/* ---------- erros e espera ---------- */

test('retryAfterMs entende segundos, data HTTP e valores inválidos', () => {
    assert.equal(Sources.retryAfterMs('37'), 37000);
    assert.equal(Sources.retryAfterMs('0.5'), 500);
    assert.equal(Sources.retryAfterMs(12), 12000);
    assert.equal(
        Sources.retryAfterMs('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')),
        10000
    );
    // Data no passado nunca gera espera negativa.
    assert.equal(Sources.retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:30:00 GMT')), 0);
    assert.equal(Sources.retryAfterMs(''), null);
    assert.equal(Sources.retryAfterMs(null), null);
    assert.equal(Sources.retryAfterMs('em breve'), null);
});

test('classifyResponse separa sucesso, 304 e cada faixa de erro', () => {
    assert.equal(Sources.classifyResponse({ status: 200, expect: 'json' }).ok, true);

    const pgm = Sources.classifyResponse({ status: 200, expect: 'pgn', contentType: 'application/vnd.chess-pgn; charset=utf-8' });
    assert.equal(pgm.ok, true);

    const html = Sources.classifyResponse({ status: 200, expect: 'pgn', contentType: 'text/html; charset=utf-8' });
    assert.equal(html.ok, false);
    assert.equal(html.error, 'invalid_response');

    const cache = Sources.classifyResponse({ status: 304 });
    assert.equal(cache.ok, true);
    assert.equal(cache.notModified, true);

    const casos = [
        [404, 'not_found'],
        [429, 'rate_limited'],
        [401, 'unauthorized'],
        [403, 'blocked'],
        [500, 'upstream'],
        [503, 'upstream'],
        [418, 'upstream'],
        [0, 'network'],
    ];
    casos.forEach(([status, error]) => {
        const result = Sources.classifyResponse({ status });
        assert.equal(result.ok, false, `status ${status}`);
        assert.equal(result.error, error, `status ${status}`);
        assert.ok(result.message.length > 0, `status ${status}`);
    });
});

test('classifyResponse transporta o Retry-After do 429', () => {
    const result = Sources.classifyResponse({ status: 429, retryAfter: '45' });
    assert.equal(result.error, 'rate_limited');
    assert.equal(result.retryAfterMs, 45000);
    assert.equal(Sources.classifyResponse({ status: 429 }).retryAfterMs, null);
});

test('backoffMs cresce exponencialmente e respeita o teto', () => {
    assert.equal(Sources.backoffMs(1), 1000);
    assert.equal(Sources.backoffMs(2), 2000);
    assert.equal(Sources.backoffMs(3), 4000);
    assert.equal(Sources.backoffMs(10), Sources.BACKOFF_CAP_MS);
    assert.equal(Sources.backoffMs(1, 500, 5000), 500);
    assert.equal(Sources.backoffMs(4, 500, 5000), 4000);
});
