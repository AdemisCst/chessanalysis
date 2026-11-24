export const config = { runtime: 'edge' };

import { fetchUpstream } from './_upstream.js';
import { json, preflight } from './_lib.js';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,24}$/i;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export default async function handler(request) {
    if (request.method === 'OPTIONS') return preflight();
    if (request.method !== 'GET') return json({ error: 'Use GET.' }, 405);

    const params = new URL(request.url).searchParams;
    const username = params.get('username') || '';
    if (!USERNAME_PATTERN.test(username)) {
        return json({ error: 'Nome de usuário inválido para o Chess.com.', code: 'invalid_username' }, 400);
    }

    const month = params.get('month');
    let path = `/pub/player/${encodeURIComponent(username)}/games/archives`;
    let accept = 'application/json';
    if (month !== null) {
        const match = month.match(MONTH_PATTERN);
        if (!match) return json({ error: 'Mês inválido. Use o formato YYYY-MM.', code: 'invalid_month' }, 400);
        path = `/pub/player/${encodeURIComponent(username)}/games/${match[1]}/${match[2]}/pgn`;
        accept = 'application/x-chess-pgn';
    }

    return fetchUpstream(`https://api.chess.com${path}`, accept);
}
