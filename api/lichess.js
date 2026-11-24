export const config = { runtime: 'edge' };

import { fetchUpstream } from './_upstream.js';
import { json, preflight } from './_lib.js';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,29}$/i;

function timestampParam(params, name) {
    const value = params.get(name);
    if (value === null) return { valid: true, value: null };
    if (!/^\d+$/.test(value)) return { valid: false, value: null };
    const timestamp = Number(value);
    if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return { valid: false, value: null };
    return { valid: true, value: String(timestamp) };
}

export default async function handler(request) {
    if (request.method === 'OPTIONS') return preflight();
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);

    const params = new URL(request.url).searchParams;
    const username = params.get('username') || '';
    if (!USERNAME_PATTERN.test(username)) {
        return json({ error: 'Nome de usuário inválido para o Lichess.', code: 'invalid_username' }, 400);
    }

    const query = new URLSearchParams();
    const maxValue = params.get('max');
    if (maxValue !== null) {
        const number = Number(maxValue);
        const max = Number.isFinite(number) ? Math.min(100, Math.max(1, Math.round(number))) : 100;
        query.set('max', String(max));
    }
    for (const name of ['since', 'until']) {
        const timestamp = timestampParam(params, name);
        if (!timestamp.valid) {
            return json({ error: `Parâmetro ${name} inválido.`, code: 'invalid_period' }, 400);
        }
        if (timestamp.value !== null) query.set(name, timestamp.value);
    }

    const queryString = query.toString();
    const suffix = queryString ? `?${queryString}` : '';
    const url = `https://lichess.org/api/games/user/${encodeURIComponent(username)}${suffix}`;
    return fetchUpstream(url, 'application/x-chess-pgn');
}
