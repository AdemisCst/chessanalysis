/* ========================================================================
   ARQUIVO: js/sources.js
   DESCRIÇÃO: Regras puras das integrações Chess.com e Lichess (Fase 4, M4.1).

   Este módulo NÃO faz rede, NÃO toca no DOM e NÃO grava nada. Ele só decide:
   - como normalizar e validar um nome de usuário;
   - qual é o período (meses) de uma sincronização;
   - quais URLs oficiais devem ser chamadas (diretas e pelo proxy /api);
   - como extrair a identidade externa de uma partida importada;
   - como classificar uma resposta HTTP e quanto esperar antes de repetir.

   A rede fica em `js/sync.js` (M4.3) e nos proxies `api/chesscom.js` e
   `api/lichess.js` (M4.2). Separar as regras permite testar tudo em Node, sem
   navegador, como já é feito com `js/queue.js`.

   Contrato das APIs oficiais (verificado em 24/11/2026):
   - Chess.com: https://api.chess.com/pub/player/{user}/games/archives
                https://api.chess.com/pub/player/{user}/games/{YYYY}/{MM}/pgn
   - Lichess:   https://lichess.org/api/user/{user}
                https://lichess.org/api/games/user/{user}
     O Lichess responde 404 quando a requisição não traz um User-Agent
     descritivo; o navegador não pode definir esse cabeçalho. Por isso a
     chamada de produção passa pelo proxy, que assina a requisição.
   ======================================================================== */

const Sources = (() => {
    const USER_AGENT = 'Acervo64/1.0 (+https://chessanalysis-murex.vercel.app)';
    const DEFAULT_MONTHS = 3;
    const MAX_MONTHS = 24;
    const LICHESS_MAX = 100;
    const REQUEST_GAP_MS = 1000;
    const BACKOFF_BASE_MS = 1000;
    const BACKOFF_CAP_MS = 30000;

    const PERF_TYPES = ['ultraBullet', 'bullet', 'blitz', 'rapid', 'classical', 'correspondence'];
    const COLORS = ['white', 'black'];

    const DEFINITIONS = {
        chesscom: {
            id: 'chesscom',
            label: 'Chess.com',
            apiPath: '/api/chesscom',
            upstreamBase: 'https://api.chess.com',
            profilePage: username => `https://www.chess.com/member/${username}`,
            usernamePattern: /^[a-z0-9][a-z0-9_-]{2,24}$/,
            usernameHint: '3 a 25 caracteres: letras, números, _ ou -',
            supportsMonths: true,
            supportsPerfTypes: false,
        },
        lichess: {
            id: 'lichess',
            label: 'Lichess',
            apiPath: '/api/lichess',
            upstreamBase: 'https://lichess.org',
            profilePage: username => `https://lichess.org/@/${username}`,
            usernamePattern: /^[a-z0-9][a-z0-9_-]{1,29}$/,
            usernameHint: '2 a 30 caracteres: letras, números, _ ou -',
            supportsMonths: false,
            supportsPerfTypes: true,
        },
    };

    const ERROR_MESSAGES = {
        empty_username: 'Informe o nome de usuário.',
        invalid_username: 'Nome de usuário inválido para esta fonte.',
        not_found: 'Usuário não encontrado nesta fonte.',
        rate_limited: 'A API pediu uma pausa. Aguarde e tente novamente.',
        blocked: 'A API recusou a requisição. Verifique o identificador do aplicativo ou tente mais tarde.',
        unauthorized: 'A API exigiu autenticação para esta consulta.',
        upstream: 'A API de origem falhou. Tente novamente em instantes.',
        network: 'Não foi possível falar com o servidor. Verifique a conexão.',
        timeout: 'A consulta demorou demais e foi interrompida.',
        invalid_response: 'A resposta não veio no formato esperado.',
        invalid_month: 'Mês inválido.',
        invalid_period: 'Período inválido.',
        period_too_long: `O período máximo é de ${MAX_MONTHS} meses.`,
        unknown_source: 'Fonte de partidas desconhecida.',
    };

    function codedError(code, message) {
        const error = new Error(message || describeError(code));
        error.code = code;
        return error;
    }

    function describeError(code) {
        return ERROR_MESSAGES[code] || 'Falha inesperada na sincronização.';
    }

    function definition(source) {
        const key = String(source || '').toLowerCase();
        const found = DEFINITIONS[key];
        if (!found) throw codedError('unknown_source');
        return found;
    }

    function clampInt(value, min, max, fallback) {
        const number = Number(value);
        if (!Number.isFinite(number)) return fallback;
        return Math.min(max, Math.max(min, Math.round(number)));
    }

    function pad2(value) {
        return String(value).padStart(2, '0');
    }

    function isDate(value) {
        return !!value && typeof value.getTime === 'function' && Number.isFinite(value.getTime());
    }

    /* ---------- usuário ---------- */

    /**
     * Aceita "@Nome", "Nome", "https://lichess.org/@/Nome" ou
     * "chess.com/member/Nome" e devolve a forma canônica usada pelas APIs
     * (minúsculas, sem arroba, sem URL). Não valida o tamanho: isso é papel de
     * `validateUsername`.
     */
    function normalizeUsername(source, raw) {
        definition(source);
        let value = String(raw == null ? '' : raw).trim();
        if (!value) return '';
        value = value.replace(/^@+/, '');
        if (/[/:]/.test(value)) {
            const cleaned = value.replace(/[?#].*$/, '').replace(/\/+$/, '');
            const parts = cleaned.split('/').filter(Boolean);
            value = parts.length ? parts[parts.length - 1] : '';
            value = value.replace(/^@+/, '');
        }
        return value.replace(/\s+/g, '').toLowerCase();
    }

    function validateUsername(source, raw) {
        const def = definition(source);
        const username = normalizeUsername(source, raw);
        if (!username) {
            return { ok: false, error: 'empty_username', message: describeError('empty_username') };
        }
        if (!def.usernamePattern.test(username)) {
            return {
                ok: false,
                error: 'invalid_username',
                message: `${describeError('invalid_username')} Use ${def.usernameHint}.`,
            };
        }
        return { ok: true, username };
    }

    /* ---------- período ---------- */

    /**
     * Converte Date, timestamp ou "YYYY-MM-DD"/"YYYY-MM" em "YYYY-MM" (UTC para
     * Date). Devolve null quando não há como interpretar.
     */
    function monthKey(value) {
        if (isDate(value)) {
            return `${value.getUTCFullYear()}-${pad2(value.getUTCMonth() + 1)}`;
        }
        if (typeof value === 'number' && Number.isFinite(value)) {
            const date = new Date(value);
            return Number.isFinite(date.getTime())
                ? `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}`
                : null;
        }
        const match = String(value == null ? '' : value).trim().match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?(?:$|[T ])/);
        if (!match) return null;
        const month = Number(match[2]);
        if (month < 1 || month > 12) return null;
        return `${match[1]}-${pad2(month)}`;
    }

    function parseMonth(value) {
        const key = monthKey(value);
        if (!key) return null;
        const year = Number(key.slice(0, 4));
        const month = Number(key.slice(5, 7));
        return { key, year, month, index: year * 12 + (month - 1) };
    }

    function monthFromIndex(index) {
        const year = Math.floor(index / 12);
        const month = (index % 12) + 1;
        return `${year}-${pad2(month)}`;
    }

    /**
     * Os `count` meses que terminam no mês de referência, em ordem crescente
     * (o mais antigo primeiro), para que a importação siga a cronologia.
     */
    function monthsBack(count, reference) {
        const total = clampInt(count, 1, MAX_MONTHS, DEFAULT_MONTHS);
        const end = parseMonth(reference == null ? new Date() : reference);
        if (!end) throw codedError('invalid_period');
        const months = [];
        for (let index = total - 1; index >= 0; index--) {
            months.push(monthFromIndex(end.index - index));
        }
        return months;
    }

    /** Intervalo inclusivo "YYYY-MM" → ["YYYY-MM", ...], crescente. */
    function monthsBetween(from, to) {
        const start = parseMonth(from);
        const end = parseMonth(to);
        if (!start || !end) throw codedError('invalid_period');
        if (start.index > end.index) throw codedError('invalid_period');
        if (end.index - start.index + 1 > MAX_MONTHS) throw codedError('period_too_long');
        const months = [];
        for (let index = start.index; index <= end.index; index++) {
            months.push(monthFromIndex(index));
        }
        return months;
    }

    /* ---------- URLs oficiais (usadas pelo proxy) ---------- */

    function baseOf(base, fallback) {
        return String(base || fallback || '').replace(/\/+$/, '');
    }

    function buildChesscomProfileUrl(base, username) {
        return `${baseOf(base, DEFINITIONS.chesscom.upstreamBase)}/pub/player/${encodeURIComponent(username)}`;
    }

    function buildChesscomArchivesUrl(base, username) {
        return `${baseOf(base, DEFINITIONS.chesscom.upstreamBase)}/pub/player/${encodeURIComponent(username)}/games/archives`;
    }

    function buildChesscomPgnUrl(base, username, month) {
        const parsed = parseMonth(month);
        if (!parsed) throw codedError('invalid_month');
        return `${baseOf(base, DEFINITIONS.chesscom.upstreamBase)}/pub/player/${encodeURIComponent(username)}`
            + `/games/${parsed.year}/${pad2(parsed.month)}/pgn`;
    }

    function buildLichessProfileUrl(base, username) {
        return `${baseOf(base, DEFINITIONS.lichess.upstreamBase)}/api/user/${encodeURIComponent(username)}`;
    }

    function timestamp(value) {
        if (isDate(value)) return value.getTime();
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
    }

    function flag(value) {
        return value === true || value === 1 || value === '1' || value === 'true';
    }

    function normalizePerfTypes(value) {
        const list = Array.isArray(value)
            ? value
            : String(value || '').split(',');
        const chosen = [];
        list.forEach(item => {
            const text = String(item || '').trim().toLowerCase();
            if (!text) return;
            const canonical = PERF_TYPES.find(perf => perf.toLowerCase() === text);
            if (canonical && chosen.indexOf(canonical) === -1) chosen.push(canonical);
        });
        return chosen;
    }

    /**
     * Monta a URL de exportação PGN do Lichess. Só os parâmetros conhecidos
     * entram; qualquer outro é ignorado. `max` é limitado a 100 para não
     * transformar uma sincronização em um download gigante.
     */
    function buildLichessPgnUrl(base, username, options) {
        const opts = options || {};
        const params = [];
        if (opts.max != null) {
            params.push(['max', String(clampInt(opts.max, 1, LICHESS_MAX, LICHESS_MAX))]);
        }
        const since = timestamp(opts.since);
        if (since != null) params.push(['since', String(since)]);
        const until = timestamp(opts.until);
        if (until != null) params.push(['until', String(until)]);
        if (typeof opts.rated === 'boolean') params.push(['rated', flag(opts.rated) ? '1' : '0']);
        const perfTypes = normalizePerfTypes(opts.perfType);
        if (perfTypes.length) params.push(['perfType', perfTypes.join(',')]);
        const color = String(opts.color || '').toLowerCase();
        if (COLORS.indexOf(color) !== -1) params.push(['color', color]);
        ['clocks', 'evals', 'opening', 'moves'].forEach(name => {
            if (flag(opts[name])) params.push([name, '1']);
        });
        const query = params
            .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
            .join('&');
        const url = `${baseOf(base, DEFINITIONS.lichess.upstreamBase)}/api/games/user/${encodeURIComponent(username)}`;
        return query ? `${url}?${query}` : url;
    }

    /* ---------- URLs do proxy (usadas pela interface) ---------- */

    function proxyPath(source) {
        return definition(source).apiPath;
    }

    /** Query string determinística, com chaves na ordem informada. */
    function buildProxyUrl(source, params) {
        const entries = Object.keys(params || {})
            .filter(key => params[key] !== undefined && params[key] !== null && params[key] !== '')
            .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`);
        const path = proxyPath(source);
        return entries.length ? `${path}?${entries.join('&')}` : path;
    }

    /* ---------- identidade externa ---------- */

    const CHESSCOM_LINK = /(?:analysis\/)?game\/(?:live|daily)\/(\d{4,})/i;
    const LICHESS_PATH = /lichess\.org\/(?:game\/)?([A-Za-z0-9]{8,12})\b/i;
    const LICHESS_ID = /^[A-Za-z0-9]{8,12}$/;

    function header(headers, name) {
        if (!headers) return '';
        const found = Object.keys(headers).find(key => key.toLowerCase() === name.toLowerCase());
        return found ? String(headers[found] == null ? '' : headers[found]) : '';
    }

    /**
     * Descobre a identidade externa pelos cabeçalhos que as próprias APIs
     * gravam no PGN:
     * - Chess.com: `[Link "https://www.chess.com/game/daily/82586502"]`
     * - Lichess:   `[GameId "rBRo2im9"]` e/ou `[Site "https://lichess.org/game/rBRo2im9"]`
     * Sem cabeçalho reconhecível devolve null — nunca inventa um id.
     */
    function extractExternalId(game, sourceHint) {
        const headers = game && game.headers ? game.headers : {};
        const hint = sourceHint ? definition(sourceHint).id : null;

        if (!hint || hint === 'chesscom') {
            const link = header(headers, 'Link');
            const site = header(headers, 'Site');
            const match = String(link).match(CHESSCOM_LINK) || String(site).match(CHESSCOM_LINK);
            if (match) {
                return {
                    source: 'chesscom',
                    externalId: match[1],
                    sourceUrl: link || `https://www.chess.com/game/daily/${match[1]}`,
                };
            }
        }

        if (!hint || hint === 'lichess') {
            const gameId = header(headers, 'GameId').trim();
            const site = header(headers, 'Site');
            if (gameId && LICHESS_ID.test(gameId)) {
                const siteMatch = site.match(LICHESS_PATH);
                return {
                    source: 'lichess',
                    externalId: gameId,
                    sourceUrl: siteMatch ? `https://lichess.org/${gameId}` : site || `https://lichess.org/${gameId}`,
                };
            }
            const match = site.match(LICHESS_PATH);
            if (match) {
                return {
                    source: 'lichess',
                    externalId: match[1],
                    sourceUrl: `https://lichess.org/${match[1]}`,
                };
            }
        }

        return null;
    }

    function detectSource(game) {
        if (extractExternalId(game, 'chesscom')) return 'chesscom';
        if (extractExternalId(game, 'lichess')) return 'lichess';
        return null;
    }

    /** Origem exibida na Biblioteca; partidas antigas (sem campo) são manuais. */
    function gameSource(game) {
        const explicit = String((game && game.source) || '').toLowerCase();
        if (DEFINITIONS[explicit]) return explicit;
        return detectSource(game) || 'manual';
    }

    /* ---------- erros e espera ---------- */

    /**
     * `Retry-After` pode vir em segundos ("37") ou como data HTTP. Devolve
     * milissegundos a partir de `now` (padrão: agora) ou null se não der para
     * interpretar. Nunca devolve valor negativo.
     */
    function retryAfterMs(value, now) {
        if (value == null || value === '') return null;
        const text = String(value).trim();
        if (/^\d+(?:\.\d+)?$/.test(text)) {
            return Math.max(0, Math.round(Number(text) * 1000));
        }
        const when = Date.parse(text);
        if (!Number.isFinite(when)) return null;
        const reference = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        return Math.max(0, when - reference);
    }

    /**
     * Classifica a resposta HTTP sem lançar. `expect` diferencia um PGN de um
     * JSON: um 200 com HTML no lugar do PGN é resposta inválida, não sucesso.
     */
    function classifyResponse(response) {
        const input = response || {};
        const status = Number(input.status) || 0;
        const contentType = String(input.contentType || '').toLowerCase();
        const expect = input.expect === 'pgn' || input.expect === 'json' ? input.expect : null;
        const retry = retryAfterMs(input.retryAfter, input.now);
        const base = {
            status,
            ok: false,
            notModified: false,
            error: null,
            message: '',
            retryAfterMs: retry,
        };

        if (status === 304) {
            return Object.assign(base, { ok: true, notModified: true });
        }
        if (status >= 200 && status < 300) {
            if (expect === 'pgn' && contentType.indexOf('html') !== -1) {
                return Object.assign(base, {
                    error: 'invalid_response',
                    message: describeError('invalid_response'),
                });
            }
            return Object.assign(base, { ok: true });
        }
        if (status === 404) {
            return Object.assign(base, { error: 'not_found', message: describeError('not_found') });
        }
        if (status === 429) {
            return Object.assign(base, { error: 'rate_limited', message: describeError('rate_limited') });
        }
        if (status === 401) {
            return Object.assign(base, { error: 'unauthorized', message: describeError('unauthorized') });
        }
        if (status === 403) {
            return Object.assign(base, { error: 'blocked', message: describeError('blocked') });
        }
        if (!status) {
            return Object.assign(base, { error: 'network', message: describeError('network') });
        }
        if (status >= 500) {
            return Object.assign(base, { error: 'upstream', message: describeError('upstream') });
        }
        return Object.assign(base, {
            error: 'upstream',
            message: `HTTP ${status}. ${describeError('upstream')}`,
        });
    }

    /**
     * Espera exponencial determinística (sem jitter). O chamador adiciona o
     * jitter; aqui o valor é previsível para poder ser testado.
     */
    function backoffMs(attempt, base, cap) {
        const step = clampInt(attempt, 1, 8, 1);
        const origin = Number(base) > 0 ? Number(base) : BACKOFF_BASE_MS;
        const ceiling = Number(cap) > 0 ? Number(cap) : BACKOFF_CAP_MS;
        return Math.min(ceiling, origin * Math.pow(2, step - 1));
    }

    return {
        USER_AGENT,
        DEFAULT_MONTHS,
        MAX_MONTHS,
        LICHESS_MAX,
        REQUEST_GAP_MS,
        BACKOFF_BASE_MS,
        BACKOFF_CAP_MS,
        PERF_TYPES,
        COLORS,
        SOURCES: DEFINITIONS,
        ERROR_MESSAGES,
        describeError,
        definition,
        normalizeUsername,
        validateUsername,
        monthKey,
        parseMonth,
        monthsBack,
        monthsBetween,
        buildChesscomProfileUrl,
        buildChesscomArchivesUrl,
        buildChesscomPgnUrl,
        buildLichessProfileUrl,
        buildLichessPgnUrl,
        proxyPath,
        buildProxyUrl,
        extractExternalId,
        detectSource,
        gameSource,
        retryAfterMs,
        classifyResponse,
        backoffMs,
    };
})();

if (typeof window !== 'undefined') window.Sources = Sources;
