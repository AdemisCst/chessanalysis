import { json, withCors } from './_lib.js';

const USER_AGENT = 'Acervo64/1.0 (+https://chessanalysis-murex.vercel.app)';
const TIMEOUT_MS = 15000;

function timedStream(body, controller) {
    if (!body) return null;
    const reader = body.getReader();
    let timer = null;
    let timedOut = false;
    let finished = false;

    function clearTimer() {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    }

    return new ReadableStream({
        async pull(streamController) {
            if (finished) return;
            clearTimer();
            timer = setTimeout(() => {
                timedOut = true;
                controller.abort();
                reader.cancel().catch(() => {});
            }, TIMEOUT_MS);
            try {
                const result = await reader.read();
                clearTimer();
                if (timedOut) {
                    const error = new Error('A resposta da origem ficou inativa por tempo demais.');
                    error.name = 'TimeoutError';
                    throw error;
                }
                if (result.done) {
                    finished = true;
                    streamController.close();
                    return;
                }
                streamController.enqueue(result.value);
            } catch (error) {
                clearTimer();
                finished = true;
                streamController.error(error);
            }
        },
        async cancel(reason) {
            finished = true;
            clearTimer();
            controller.abort();
            await reader.cancel(reason);
        },
    });
}

function upstreamError(status) {
    if (status === 404) {
        return json({ error: 'Usuário não encontrado na fonte.', code: 'not_found' }, 404);
    }
    if (status === 429) {
        return json({ error: 'A API pediu uma pausa. Aguarde e tente novamente.', code: 'rate_limited' }, 429);
    }
    if (status >= 500) {
        return json({
            error: 'A API de origem falhou. Tente novamente em instantes.',
            code: 'upstream',
            upstreamStatus: status,
        }, 502);
    }
    return json({ error: 'A API de origem recusou a requisição.', code: 'blocked' }, status);
}

export async function fetchUpstream(url, accept) {
    const controller = new AbortController();
    let timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            headers: {
                Accept: accept,
                'User-Agent': USER_AGENT,
            },
            signal: controller.signal,
        });
        clearTimeout(timer);
        timer = null;
        const contentType = response.headers.get('content-type') || '';

        if (contentType.split(';', 1)[0].trim().toLowerCase() === 'text/html') {
            return json({
                error: 'A API de origem retornou HTML em vez de dados. A requisição pode ter sido bloqueada.',
                code: 'blocked',
            }, 502);
        }
        if (!response.ok) return upstreamError(response.status);

        const body = timedStream(response.body, controller);
        return withCors(new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        }));
    } catch (error) {
        if (error.name === 'AbortError' || error.name === 'TimeoutError') {
            return json({ error: 'A consulta demorou demais e foi interrompida.', code: 'timeout' }, 504);
        }
        return json({ error: 'Não foi possível falar com o servidor de origem.', code: 'network' }, 502);
    } finally {
        if (timer !== null) clearTimeout(timer);
    }
}
