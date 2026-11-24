/* Testes das utilidades do proxy de IA. Executar com: npm test */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isPlaceholderKey,
    validateMessages,
    upstreamUrl,
    upstreamBody,
    maxCompletionTokens,
    providerLabel,
    describeProviderError,
} from '../api/_lib.js';

test('chaves de exemplo são recusadas antes de chamar o provedor', () => {
    assert.equal(isPlaceholderKey(''), true);
    assert.equal(isPlaceholderKey('sua_chave_aqui'), true);
    assert.equal(isPlaceholderKey('coloque-a-chave-real'), true);
    assert.equal(isPlaceholderKey('sk-substitua'), true);
    assert.equal(isPlaceholderKey('curta'), true);
    assert.equal(isPlaceholderKey('sk-1234567890abcdefghijklmnop'), false);
});

test('validação de mensagens rejeita corpo vazio e papéis inválidos', () => {
    assert.match(validateMessages(null), /ao menos uma mensagem/i);
    assert.match(validateMessages({ messages: [] }), /ao menos uma mensagem/i);
    assert.match(validateMessages({ messages: [{ role: 'hacker', content: 'oi' }] }), /Papel de mensagem inválido/i);
    assert.match(validateMessages({ messages: [{ role: 'user', content: 'a'.repeat(60001) }] }), /Contexto grande demais/i);
    assert.equal(validateMessages({ messages: [{ role: 'user', content: 'Analise esta partida.' }] }), null);
});

test('OpenAI usa /chat/completions e preserva o modelo configurado no servidor', () => {
    const provider = { provider: 'openai', prefix: 'AI', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b', path: '' };
    assert.equal(upstreamUrl(provider), 'https://api.groq.com/openai/v1/chat/completions');
    const body = upstreamBody({ model: 'enviado-pelo-cliente', messages: [{ role: 'user', content: 'oi' }] }, provider);
    assert.equal(body.model, 'openai/gpt-oss-120b');
    assert.equal(body.stream, true);
    assert.equal(body.max_completion_tokens, 4096);
});

test('teto de tokens vem só do servidor, com padrão e faixa segura', () => {
    const original = { ...process.env };
    try {
        delete process.env.AI_MAX_TOKENS;
        assert.equal(maxCompletionTokens('AI'), 4096);

        process.env.AI_MAX_TOKENS = '8192';
        assert.equal(maxCompletionTokens('AI'), 8192);

        process.env.AI_MAX_TOKENS = '10';
        assert.equal(maxCompletionTokens('AI'), 256);

        process.env.AI_MAX_TOKENS = '999999';
        assert.equal(maxCompletionTokens('AI'), 32768);

        process.env.AI_MAX_TOKENS = 'abc';
        assert.equal(maxCompletionTokens('AI'), 4096);

        // O corpo do navegador não consegue elevar o teto.
        const body = upstreamBody(
            { model: 'x', messages: [{ content: 'oi' }], options: { max_tokens: 60000 } },
            { provider: 'openai', prefix: 'AI', base: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' }
        );
        assert.equal(body.max_completion_tokens, 4096);
    } finally {
        process.env = original;
    }
});

test('rótulo do provedor expõe apenas o host, nunca a chave', () => {
    assert.equal(providerLabel({ base: 'https://api.groq.com/openai/v1' }), 'api.groq.com');
    assert.equal(providerLabel(null), 'não configurado');
});

test('erros do provedor têm mensagens seguras e acionáveis', () => {
    assert.match(describeProviderError(401, 'api.groq.com'), /AI_API_KEY/);
    assert.match(describeProviderError(404, 'api.groq.com'), /AI_MODEL/);
    assert.match(describeProviderError(429, 'api.groq.com'), /limite de uso/i);
    assert.match(describeProviderError(503, 'api.groq.com'), /indisponível/i);
});

test('/api/tags recusa chave de exemplo sem chamar a rede', async () => {
    const original = { ...process.env };
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_BASE_URL = 'https://api.groq.com/openai/v1';
    process.env.AI_MODEL = 'openai/gpt-oss-120b';
    process.env.AI_API_KEY = 'sua_chave_de_exemplo';
    delete process.env.AI_FALLBACK_BASE_URL;
    try {
        const { default: handler } = await import('../api/tags.js');
        const response = await handler(new Request('https://example.com/api/tags'));
        const body = await response.json();
        assert.equal(response.status, 503);
        assert.equal(body.code, 'credential_rejected');
        assert.match(body.error, /exemplo, não uma credencial real/i);
    } finally {
        process.env = original;
    }
});

test('/api/chat recusa configuração incompleta antes de gastar cota', async () => {
    const original = { ...process.env };
    process.env.AI_PROVIDER = 'openai';
    process.env.AI_BASE_URL = 'https://api.groq.com/openai/v1';
    process.env.AI_MODEL = 'openai/gpt-oss-120b';
    process.env.AI_API_KEY = 'sua_chave_de_exemplo';
    delete process.env.AI_FALLBACK_BASE_URL;
    try {
        const { default: handler } = await import('../api/chat.js');
        const response = await handler(new Request('https://example.com/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'Analise esta partida.' }] }),
        }));
        const body = await response.json();
        assert.equal(response.status, 503);
        assert.equal(body.code, 'not_configured');
        assert.match(body.error, /AI_API_KEY/);
    } finally {
        process.env = original;
    }
});

test('/api/chesscom permite só username/month e escolhe o endpoint adequado', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options) => {
        calls.push({ url: String(url), options });
        return new Response('pgn', {
            status: 200,
            headers: { 'Content-Type': 'application/x-chess-pgn; charset=utf-8' },
        });
    };
    try {
        const { default: handler } = await import('../api/chesscom.js');
        const response = await handler(new Request(
            'https://example.com/api/chesscom?username=Hikaru&month=2024-02&ignored=evil'
        ));
        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'pgn');
        assert.equal(
            calls[0].url,
            'https://api.chess.com/pub/player/Hikaru/games/2024/02/pgn'
        );
        assert.equal(calls[0].options.headers['User-Agent'], 'Acervo64/1.0 (+https://chessanalysis-murex.vercel.app)');

        await handler(new Request('https://example.com/api/chesscom?username=Hikaru&unknown=1'));
        assert.equal(
            calls[1].url,
            'https://api.chess.com/pub/player/Hikaru/games/archives'
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('/api/lichess limita max e descarta parâmetros não permitidos', async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl;
    globalThis.fetch = async url => {
        calledUrl = String(url);
        return new Response('pgn', {
            status: 200,
            headers: { 'Content-Type': 'application/x-chess-pgn' },
        });
    };
    try {
        const { default: handler } = await import('../api/lichess.js');
        const response = await handler(new Request(
            'https://example.com/api/lichess?username=thibault&max=500&since=123&until=456&evil=1'
        ));
        assert.equal(response.status, 200);
        const url = new URL(calledUrl);
        assert.equal(url.origin, 'https://lichess.org');
        assert.equal(url.pathname, '/api/games/user/thibault');
        assert.equal(url.searchParams.get('max'), '100');
        assert.equal(url.searchParams.get('since'), '123');
        assert.equal(url.searchParams.get('until'), '456');
        assert.equal(url.searchParams.has('evil'), false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('/api/lichess preserva max omitido para a exportação completa', async () => {
    const originalFetch = globalThis.fetch;
    let calledUrl;
    globalThis.fetch = async url => {
        calledUrl = String(url);
        return new Response('pgn', {
            headers: { 'Content-Type': 'application/x-chess-pgn' },
        });
    };
    try {
        const { default: handler } = await import('../api/lichess.js');
        const response = await handler(new Request(
            'https://example.com/api/lichess?username=thibault'
        ));
        assert.equal(response.status, 200);
        const url = new URL(calledUrl);
        assert.equal(url.pathname, '/api/games/user/thibault');
        assert.equal(url.searchParams.has('max'), false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('proxy upstream rejeita HTML e traduz erros de origem para JSON', async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const { fetchUpstream } = await import('../api/_upstream.js');
    try {
        globalThis.fetch = async () => new Response('<html>blocked</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
        });
        const blocked = await fetchUpstream('https://upstream.example', 'application/json');
        assert.equal(blocked.status, 502);
        assert.equal((await blocked.json()).code, 'blocked');

        for (const [status, expected, proxyStatus] of [
            [404, 'not_found', 404],
            [429, 'rate_limited', 429],
            [503, 'upstream', 502],
        ]) {
            globalThis.fetch = async () => new Response('', {
                status,
                headers: { 'Content-Type': 'application/json' },
            });
            const response = await fetchUpstream('https://upstream.example', 'application/json');
            assert.equal(response.status, proxyStatus);
            assert.equal((await response.json()).code, expected);
        }

        globalThis.setTimeout = (callback, delay) => {
            assert.equal(delay, 15000);
            callback();
            return 1;
        };
        globalThis.fetch = async (url, options) => {
            assert.equal(options.signal.aborted, true);
            const error = new Error('aborted');
            error.name = 'AbortError';
            throw error;
        };
        const timeout = await fetchUpstream('https://upstream.example', 'application/json');
        assert.equal(timeout.status, 504);
        assert.equal((await timeout.json()).code, 'timeout');
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.setTimeout = originalSetTimeout;
    }
});

test('proxy upstream encaminha o PGN em stream sem esperar o corpo inteiro', async () => {
    const originalFetch = globalThis.fetch;
    const { fetchUpstream } = await import('../api/_upstream.js');
    let finishBody;
    globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('primeira parte'));
            finishBody = () => {
                controller.enqueue(new TextEncoder().encode(' segunda parte'));
                controller.close();
            };
        },
    }), {
        headers: { 'Content-Type': 'application/x-chess-pgn' },
    });
    try {
        const response = await fetchUpstream('https://upstream.example', 'application/x-chess-pgn');
        const reader = response.body.getReader();
        const first = await reader.read();
        assert.equal(new TextDecoder().decode(first.value), 'primeira parte');
        finishBody();
        const second = await reader.read();
        assert.equal(new TextDecoder().decode(second.value), ' segunda parte');
        assert.equal((await reader.read()).done, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('proxy upstream cancela o stream após 15 segundos sem atividade', async () => {
    const originalFetch = globalThis.fetch;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = [];
    globalThis.setTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        timers.push(timer);
        return timer;
    };
    globalThis.clearTimeout = timer => {
        if (timer) timer.cleared = true;
    };
    globalThis.fetch = async () => new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode('primeira parte'));
        },
    }), {
        headers: { 'Content-Type': 'application/x-chess-pgn' },
    });
    try {
        const { fetchUpstream } = await import('../api/_upstream.js');
        const response = await fetchUpstream('https://upstream.example', 'application/x-chess-pgn');
        const reader = response.body.getReader();
        await reader.read();
        const pending = reader.read();
        await new Promise(resolve => setImmediate(resolve));
        const idleTimer = timers.filter(timer => !timer.cleared).pop();
        assert.ok(idleTimer);
        assert.equal(idleTimer.delay, 15000);
        idleTimer.callback();
        await assert.rejects(pending, /inativa por tempo demais/);
    } finally {
        globalThis.fetch = originalFetch;
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
    }
});
