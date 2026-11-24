/* ========================================================================
   ARQUIVO: js/sync.js
   DESCRIÇÃO: Sincronização de partidas Chess.com/Lichess pela API local.
   ======================================================================== */

const Sync = (() => {
    const STORAGE_KEY = 'acervo64_sync_sources_v1';
    const PERIODS = [3, 6, 12];
    const ALL_HISTORY = 'all';
    const BATCH_SIZE = 100;
    const ESTIMATED_BYTES_PER_GAME = 500;
    const ESTIMATED_GAMES_PER_ARCHIVE = 50;
    const PERF_OPTIONS = [
        { id: 'ultraBullet', label: 'Ultra-bullet' },
        { id: 'bullet', label: 'Bullet' },
        { id: 'blitz', label: 'Blitz' },
        { id: 'rapid', label: 'Rápida' },
        { id: 'classical', label: 'Clássica' },
        { id: 'correspondence', label: 'Correspondência' },
    ];
    const SOURCES = {
        chesscom: { label: 'Chess.com' },
        lichess: { label: 'Lichess' },
    };

    let initialized = false;
    let activeSource = 'chesscom';
    let drafts = {};
    let warnedStorage = false;

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[character]));
    }

    function readConnections() {
        try {
            const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
            const result = {};
            Object.keys(SOURCES).forEach(source => {
                const record = parsed && parsed[source];
                if (!record || typeof record.username !== 'string') return;
                const savedMonths = record.months === ALL_HISTORY
                    ? ALL_HISTORY
                    : Number(record.months);
                result[source] = {
                    username: record.username,
                    lastSyncAt: typeof record.lastSyncAt === 'string' ? record.lastSyncAt : '',
                    months: savedMonths === ALL_HISTORY || PERIODS.includes(savedMonths) ? savedMonths : 3,
                    perfTypes: Array.isArray(record.perfTypes)
                        ? record.perfTypes.filter(type => Sources.PERF_TYPES.includes(type))
                        : Sources.PERF_TYPES.slice(),
                    newCount: Number(record.newCount) || 0,
                    existingCount: Number(record.existingCount) || 0,
                    failedCount: Number(record.failedCount) || 0,
                };
            });
            return result;
        } catch (error) {
            if (!warnedStorage) {
                console.warn('Não foi possível ler as configurações de sincronização.', error);
                warnedStorage = true;
            }
            return {};
        }
    }

    function saveConnection(source, values) {
        try {
            const all = readConnections();
            all[source] = values;
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
            return true;
        } catch (error) {
            console.warn('Não foi possível salvar as configurações de sincronização.', error);
            toast('Sincronização concluída, mas não foi possível salvar a conta neste navegador.', 'warning');
            return false;
        }
    }

    function formatSyncDate(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return 'data desconhecida';
        return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    }

    function renderConnections() {
        const host = document.getElementById('syncSources');
        if (!host) return;
        const connections = readConnections();
        const items = Object.keys(SOURCES)
            .filter(source => connections[source])
            .map(source => {
                const item = connections[source];
                const definition = Sources.SOURCES[source];
                const profile = definition.profilePage(item.username);
                return `<span class="sync-source-item">
                    <a href="${escapeHtml(profile)}" target="_blank" rel="noopener noreferrer">${SOURCES[source].label}</a>
                    · ${escapeHtml(item.username)} · Última sync: ${escapeHtml(formatSyncDate(item.lastSyncAt))}
                </span>`;
            });
        host.innerHTML = items.join('');
        host.classList.toggle('hidden', items.length === 0);
    }

    function buildRequests(source, username, months, reference) {
        if (months === ALL_HISTORY || String(months).toLowerCase() === 'all') {
            if (source === 'chesscom') {
                return [{
                    month: null,
                    type: 'archives',
                    url: Sources.buildProxyUrl('chesscom', { username, format: 'archives' }),
                }];
            }
            if (source === 'lichess') {
                return [{
                    month: null,
                    type: 'pgn',
                    url: Sources.buildProxyUrl('lichess', { username }),
                }];
            }
            throw new Error('Fonte de partidas desconhecida.');
        }
        const now = reference == null ? new Date() : (reference instanceof Date ? reference : new Date(reference));
        if (!Number.isFinite(now.getTime())) throw new Error('Data de referência inválida.');
        const period = Sources.monthsBack(months, now);
        if (source === 'chesscom') {
            return period.map(month => ({
                month,
                type: 'pgn',
                url: Sources.buildProxyUrl('chesscom', { username, month }),
            }));
        }
        if (source === 'lichess') {
            const start = Sources.parseMonth(period[0]);
            return [{
                month: null,
                type: 'pgn',
                url: Sources.buildProxyUrl('lichess', {
                    username,
                    max: Sources.LICHESS_MAX,
                    since: Date.UTC(start.year, start.month - 1, 1),
                    until: now.getTime(),
                }),
            }];
        }
        throw new Error('Fonte de partidas desconhecida.');
    }

    function monthsFromArchives(payload) {
        if (!payload || !Array.isArray(payload.archives)) {
            throw new Error('A lista de arquivos do Chess.com veio em formato inválido.');
        }
        const months = [];
        const seen = new Set();
        payload.archives.forEach(value => {
            if (typeof value !== 'string') {
                throw new Error('A lista de arquivos do Chess.com contém uma entrada inválida.');
            }
            const match = value.match(/^https:\/\/api\.chess\.com\/pub\/player\/[^/?#]+\/games\/(\d{4})\/(0[1-9]|1[0-2])(?:\/pgn)?(?:[?#].*)?$/i);
            if (!match) {
                throw new Error('A lista de arquivos do Chess.com contém um mês inválido.');
            }
            const month = `${match[1]}-${match[2]}`;
            if (seen.has(month)) return;
            seen.add(month);
            months.push(month);
        });
        return months;
    }

    function requestsFromArchives(username, payload) {
        return monthsFromArchives(payload).map(month => ({
            month,
            type: 'pgn',
            url: Sources.buildProxyUrl('chesscom', { username, month }),
        }));
    }

    function splitPgnBlocks(text, final, maxBlocks) {
        const input = String(text || '').replace(/\r\n?/g, '\n');
        const blocks = [];
        const limit = Number.isSafeInteger(maxBlocks) && maxBlocks > 0 ? maxBlocks : Infinity;
        let start = 0;
        let offset = 0;
        let seenMoves = false;

        while (offset < input.length) {
            const newline = input.indexOf('\n', offset);
            if (newline < 0 && !final) break;
            const end = newline < 0 ? input.length : newline + 1;
            const line = input.slice(offset, newline < 0 ? input.length : newline).trim();
            if (line && !line.startsWith('%')) {
                const isTag = /^\[[A-Za-z0-9_]+\s+"(?:[^"\\]|\\.)*"\]\s*$/.test(line);
                if (isTag) {
                    if (seenMoves) {
                        const block = input.slice(start, offset).trim();
                        if (block) blocks.push(block);
                        start = offset;
                        seenMoves = false;
                        if (blocks.length >= limit) {
                            return { blocks, remainder: input.slice(start) };
                        }
                    }
                } else {
                    seenMoves = true;
                }
            }
            offset = end;
        }

        if (final) {
            const block = input.slice(start).trim();
            if (block) blocks.push(block);
            return { blocks, remainder: '' };
        }
        return { blocks, remainder: input.slice(start) };
    }

    function classifyTimeControl(value, headers) {
        const tags = headers || {};
        if (/correspondence/i.test(String(tags.Event || ''))) return 'correspondence';
        const text = String(value || '').trim();
        if (text === '-' || /^correspondence$/i.test(text)) return 'correspondence';

        const match = text.match(/^(?:\d+\/)?(\d+(?:\.\d+)?)(?:\+(\d+(?:\.\d+)?))?/);
        if (!match) return null;
        const initial = Number(match[1]);
        const increment = Number(match[2] || 0);
        const estimatedSeconds = initial + increment * 40;
        if (estimatedSeconds < 30) return 'ultraBullet';
        if (estimatedSeconds < 180) return 'bullet';
        if (estimatedSeconds < 480) return 'blitz';
        if (estimatedSeconds < 1500) return 'rapid';
        return 'classical';
    }

    function filterGamesByPerf(games, perfTypes) {
        const selected = new Set((perfTypes || []).filter(type => Sources.PERF_TYPES.includes(type)));
        if (!selected.size) return [];
        if (selected.size === Sources.PERF_TYPES.length) return (games || []).slice();
        return (games || []).filter(game => {
            const headers = game.headers || {};
            const perf = classifyTimeControl(game.timeControl || headers.TimeControl, headers);
            return selected.has(perf);
        });
    }

    function captureDraft() {
        const username = document.getElementById('syncUsername');
        const months = document.getElementById('syncMonths');
        if (!username || !months) return;
        drafts[activeSource] = {
            username: username.value,
            months: months.value === ALL_HISTORY ? ALL_HISTORY : Number(months.value),
            perfTypes: Array.from(document.querySelectorAll('[data-sync-perf]:checked'))
                .map(input => input.value),
        };
    }

    function renderForm(source) {
        activeSource = source;
        const saved = readConnections()[source] || {};
        const draft = drafts[source] || {};
        const username = draft.username !== undefined ? draft.username : (saved.username || '');
        const draftMonths = draft.months === ALL_HISTORY
            ? ALL_HISTORY
            : Number(draft.months);
        const savedMonths = saved.months === ALL_HISTORY
            ? ALL_HISTORY
            : Number(saved.months);
        const months = draftMonths === ALL_HISTORY || PERIODS.includes(draftMonths)
            ? draftMonths
            : (savedMonths === ALL_HISTORY || PERIODS.includes(savedMonths) ? savedMonths : 3);
        const selectedTypes = new Set(draft.perfTypes || saved.perfTypes || Sources.PERF_TYPES);
        const tabs = Object.keys(SOURCES).map(id => `
            <button type="button" class="btn btn-sm ${id === source ? 'btn-secondary sync-tab' : 'btn-ghost sync-tab'}"
                    role="tab" aria-selected="${id === source}" data-sync-tab="${id}">
                ${SOURCES[id].label}
            </button>`).join('');
        const periodOptions = PERIODS.map(count =>
            `<option value="${count}" ${months === count ? 'selected' : ''}>Últimos ${count} meses</option>`
        ).join('') + `<option value="${ALL_HISTORY}" ${months === ALL_HISTORY ? 'selected' : ''}>Todo o histórico</option>`;
        const perfOptions = PERF_OPTIONS.map(option => `
            <label class="sync-perf-option">
                <input type="checkbox" data-sync-perf value="${option.id}" ${selectedTypes.has(option.id) ? 'checked' : ''}>
                ${option.label}
            </label>`).join('');

        openModal({
            title: 'Sincronizar partidas',
            body: `
                <div class="sync-tabs" role="tablist" aria-label="Fonte de partidas">${tabs}</div>
                <form id="syncForm" class="sync-form">
                    <label for="syncUsername">Usuário ${SOURCES[source].label}
                        <input id="syncUsername" class="input" type="text" autocomplete="username"
                               placeholder="Nome de usuário" value="${escapeHtml(username)}" required>
                    </label>
                    <label for="syncMonths">Período
                        <select id="syncMonths" class="select">${periodOptions}</select>
                    </label>
                    <fieldset>
                        <legend class="muted small">Controles de tempo</legend>
                        <div class="sync-perf-grid">${perfOptions}</div>
                    </fieldset>
                    <p class="sync-note">O filtro de ritmo é aplicado localmente pelo TimeControl do PGN (estimativa de 40 lances).</p>
                </form>`,
            footer: `<button id="syncCancel" class="btn btn-ghost" type="button">Cancelar</button>
                     <button class="btn btn-primary" type="submit" form="syncForm">Buscar partidas</button>`,
        });

        document.querySelectorAll('[data-sync-tab]').forEach(button => {
            button.addEventListener('click', () => {
                captureDraft();
                renderForm(button.dataset.syncTab);
            });
        });
        document.getElementById('syncCancel').addEventListener('click', closeModal);
        document.getElementById('syncForm').addEventListener('submit', event => {
            event.preventDefault();
            captureDraft();
            const currentDraft = drafts[source];
            const validation = Sources.validateUsername(source, currentDraft.username);
            if (!validation.ok) {
                toast(validation.message, 'warning');
                document.getElementById('syncUsername').focus();
                return;
            }
            const chosen = currentDraft.perfTypes;
            if (!chosen.length) {
                toast('Selecione ao menos um controle de tempo.', 'warning');
                return;
            }
            start(source, validation.username, currentDraft.months, chosen);
        });
    }

    function open(source) {
        renderForm(SOURCES[source] ? source : 'chesscom');
    }

    function showProgress(source, current, total, status) {
        const fill = document.getElementById('syncProgressFill');
        const statusElement = document.getElementById('syncStatus');
        const determinate = Number.isFinite(total) && total > 0;
        if (fill) {
            const progress = fill.parentElement;
            progress.classList.toggle('indeterminate', !determinate);
            if (determinate) {
                fill.style.width = `${Math.max(0, Math.min(100, (current / total) * 100))}%`;
                progress.setAttribute('aria-valuemax', String(total));
                progress.setAttribute('aria-valuenow', String(current));
            } else {
                fill.style.removeProperty('width');
                progress.removeAttribute('aria-valuemax');
                progress.removeAttribute('aria-valuenow');
            }
        }
        if (statusElement) statusElement.textContent = status;
        if (!fill || !statusElement) {
            openModal({
                title: `Sincronizando ${SOURCES[source].label}`,
                body: `<p id="syncStatus">${escapeHtml(status)}</p>
                       <div class="modal-progress${determinate ? '' : ' indeterminate'}" role="progressbar" aria-valuemin="0"${determinate ? ` aria-valuemax="${total}" aria-valuenow="${current}"` : ''}>
                           <span id="syncProgressFill"${determinate ? ` style="width:${Math.max(0, Math.min(100, (current / total) * 100))}%"` : ''}></span>
                       </div>
                       <p class="muted small">A consulta pode levar alguns instantes.</p>`,
                closable: false,
            });
        }
    }

    async function fetchArchives(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(url, {
                headers: { Accept: 'application/json' },
                signal: controller.signal,
            });
            const contentType = response.headers.get('content-type') || '';
            const classification = Sources.classifyResponse({
                status: response.status,
                expect: 'json',
                contentType,
                retryAfter: response.headers.get('retry-after'),
            });
            if (!classification.ok) {
                let message = classification.message || Sources.describeError('upstream');
                if (contentType.toLowerCase().includes('json')) {
                    try {
                        const payload = await response.json();
                        if (payload && typeof payload.error === 'string') message = payload.error;
                    } catch (error) {
                        // Mantém a mensagem HTTP quando o corpo não for JSON válido.
                    }
                }
                return { ok: false, error: message };
            }
            const payload = await response.json();
            return { ok: true, payload };
        } catch (error) {
            const code = error.name === 'AbortError' ? 'timeout' : 'network';
            return { ok: false, error: Sources.describeError(code) };
        } finally {
            clearTimeout(timer);
        }
    }

    async function fetchPgn(url, onText, onHeaders, onProgress) {
        const controller = new AbortController();
        let timer = null;
        const armTimeout = () => {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => controller.abort(), 15000);
        };
        const clearTimer = () => {
            if (timer !== null) clearTimeout(timer);
            timer = null;
        };
        let reader = null;
        let processingError = null;
        async function sendText(text) {
            try {
                await onText(text);
            } catch (error) {
                processingError = error;
                throw error;
            }
        }
        try {
            armTimeout();
            const response = await fetch(url, {
                headers: { Accept: 'application/x-chess-pgn' },
                signal: controller.signal,
            });
            clearTimer();
            const contentType = response.headers.get('content-type') || '';
            const classification = Sources.classifyResponse({
                status: response.status,
                expect: 'pgn',
                contentType,
                retryAfter: response.headers.get('retry-after'),
            });
            if (!classification.ok) {
                let message = classification.message || Sources.describeError('upstream');
                if (contentType.toLowerCase().includes('json')) {
                    try {
                        const payload = await response.json();
                        if (payload && typeof payload.error === 'string') message = payload.error;
                    } catch (error) {
                        // Mantém a mensagem HTTP quando o corpo não for JSON válido.
                    }
                }
                return { ok: false, error: message, retryAfterMs: classification.retryAfterMs };
            }

            const rawLength = response.headers.get('content-length');
            const contentLength = rawLength && /^\d+$/.test(rawLength) ? Number(rawLength) : null;
            if (onHeaders && await onHeaders({ contentLength }) === false) {
                await response.body?.cancel();
                return { ok: false, cancelled: true };
            }

            let bytesRead = 0;
            if (!response.body) {
                const text = await response.text();
                bytesRead = new TextEncoder().encode(text).byteLength;
                await sendText(text);
                if (onProgress) onProgress(bytesRead, contentLength);
                return { ok: true, bytesRead, contentLength };
            }

            reader = response.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
                armTimeout();
                const result = await reader.read();
                clearTimer();
                if (result.done) break;
                bytesRead += result.value.byteLength;
                if (onProgress) onProgress(bytesRead, contentLength);
                const text = decoder.decode(result.value, { stream: true });
                if (text) await sendText(text);
            }
            const tail = decoder.decode();
            if (tail) await sendText(tail);
            return { ok: true, bytesRead, contentLength };
        } catch (error) {
            if (processingError) throw processingError;
            const code = error.name === 'AbortError' || error.name === 'TimeoutError' ? 'timeout' : 'network';
            return { ok: false, error: Sources.describeError(code) };
        } finally {
            clearTimer();
            if (reader) reader.releaseLock();
        }
    }

    function wait(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    function showSummary(result) {
        const parts = [
            `${result.imported} ${result.imported === 1 ? 'nova' : 'novas'}`,
            `${result.existing} ${result.existing === 1 ? 'existente' : 'existentes'}`,
            `${result.filteredOut} ${result.filteredOut === 1 ? 'filtrada' : 'filtradas'}`,
            `${result.failedCount} ${result.failedCount === 1 ? 'falha' : 'falhas'}`,
        ];
        const detailItems = result.details.slice(0, 8)
            .map(detail => `<li>${escapeHtml(detail)}</li>`).join('');
        const queueButton = result.imported
            ? `<button id="syncQueueBtn" class="btn btn-primary">Adicionar ${result.imported} ${result.imported === 1 ? 'nova' : 'novas'} à fila</button>`
            : '';
        openModal({
            title: 'Resumo da sincronização',
            body: `<p class="sync-summary">${parts.join(' · ')}</p>
                   ${detailItems ? `<div class="modal-detail"><ul>${detailItems}</ul></div>` : ''}`,
            footer: `${queueButton}<button id="syncSummaryClose" class="btn btn-ghost">Fechar</button>`,
        });
        document.getElementById('syncSummaryClose').addEventListener('click', closeModal);
        const queue = document.getElementById('syncQueueBtn');
        if (queue) {
            queue.addEventListener('click', async () => {
                closeModal();
                const ids = new Set(result.newIds);
                const games = State.games.filter(game => ids.has(game.id));
                if (!games.length) {
                    toast('As novas partidas não estão disponíveis na biblioteca.', 'warning');
                    return;
                }
                await QueueUI.enqueueGames(games, { start: true, goToView: true });
            });
        }
    }

    function createPgnProcessor(source, username, perfTypes, seen, stats) {
        let remainder = '';
        let pendingBlocks = [];

        async function storeGames(games) {
            if (!games.length) return;
            await saveSourceBatch(games, source);
            stats.imported += games.length;
            games.forEach(game => stats.newIds.push(game.id));
            await wait(0);
        }

        async function parseBlocks(blocks) {
            if (!blocks.length) return;
            const parsed = await PgnReader.parse(
                blocks.join('\n\n'),
                `${SOURCES[source].label} - ${username}`
            );
            stats.parsed += parsed.games.length;
            const filtered = filterGamesByPerf(parsed.games, perfTypes);
            stats.filteredOut += parsed.games.length - filtered.length;
            const unique = [];
            filtered.forEach(game => {
                if (seen.has(game.id)) {
                    stats.existing++;
                    return;
                }
                seen.add(game.id);
                unique.push(game);
            });
            for (let offset = 0; offset < unique.length; offset += BATCH_SIZE) {
                await storeGames(unique.slice(offset, offset + BATCH_SIZE));
            }
            (parsed.errors || []).forEach(error => {
                stats.failedCount++;
                if (stats.details.length < 20) stats.details.push(error.message);
            });
        }

        async function consume(text) {
            let input = remainder + text;
            while (true) {
                const split = splitPgnBlocks(input, false, BATCH_SIZE);
                remainder = split.remainder;
                split.blocks.forEach(block => pendingBlocks.push(block));
                while (pendingBlocks.length >= BATCH_SIZE) {
                    await parseBlocks(pendingBlocks.splice(0, BATCH_SIZE));
                }
                if (split.blocks.length < BATCH_SIZE) break;
                input = remainder;
            }
        }

        async function flushComplete() {
            while (pendingBlocks.length) {
                await parseBlocks(pendingBlocks.splice(0, BATCH_SIZE));
            }
        }

        async function finish() {
            let input = remainder;
            remainder = '';
            while (input) {
                const split = splitPgnBlocks(input, true, BATCH_SIZE);
                split.blocks.forEach(block => pendingBlocks.push(block));
                input = split.remainder;
                while (pendingBlocks.length >= BATCH_SIZE) {
                    await parseBlocks(pendingBlocks.splice(0, BATCH_SIZE));
                }
                if (!split.remainder) break;
            }
            await flushComplete();
        }

        return { consume, flushComplete, finish };
    }

    async function start(source, username, months, perfTypes) {
        const allHistory = months === ALL_HISTORY || String(months).toLowerCase() === 'all';
        const stats = {
            imported: 0,
            existing: 0,
            filteredOut: 0,
            failedCount: 0,
            parsed: 0,
            details: [],
            newIds: [],
        };
        const seen = new Set((State.games || []).map(game => game.id));
        try {
            let requests = buildRequests(source, username, months, new Date());
            openModal({
                title: `Sincronizando ${SOURCES[source].label}`,
                body: `<p id="syncStatus">Preparando consulta…</p>
                       <div class="modal-progress" role="progressbar" aria-valuemin="0">
                           <span id="syncProgressFill"></span>
                       </div>
                       <p class="muted small">A consulta pode levar alguns instantes.</p>`,
                closable: false,
            });

            if (allHistory && source === 'chesscom') {
                showProgress(source, 0, 0, 'Consultando os meses disponíveis…');
                const archiveResult = await fetchArchives(requests[0].url);
                if (!archiveResult.ok) {
                    stats.failedCount++;
                    stats.details.push(archiveResult.error);
                    requests = [];
                } else {
                    try {
                        requests = requestsFromArchives(username, archiveResult.payload);
                        const estimatedGames = requests.length * ESTIMATED_GAMES_PER_ARCHIVE;
                        if (estimatedGames > 5000 && !window.confirm(
                            `O histórico tem ${requests.length} meses e pode incluir cerca de ${estimatedGames.toLocaleString('pt-BR')} partidas. A sincronização pode levar vários minutos. Deseja continuar?`
                        )) {
                            closeModal();
                            return;
                        }
                    } catch (error) {
                        stats.failedCount++;
                        stats.details.push(error.message);
                        requests = [];
                    }
                }
            }

            for (let index = 0; index < requests.length; index++) {
                const request = requests[index];
                if (source === 'chesscom' && (index > 0 || allHistory)) {
                    await wait(Sources.REQUEST_GAP_MS);
                }
                const label = request.month
                    ? `Buscando mês ${index + 1} de ${requests.length} (${request.month})`
                    : allHistory
                        ? `Baixando o histórico de ${username}…`
                        : `Buscando até ${Sources.LICHESS_MAX} partidas de ${username}…`;
                const progressTotal = allHistory && source === 'lichess' ? null : requests.length;
                showProgress(source, index, progressTotal, label);
                const processor = createPgnProcessor(source, username, perfTypes, seen, stats);
                const result = await fetchPgn(
                    request.url,
                    text => processor.consume(text),
                    async ({ contentLength }) => {
                        if (!allHistory || source !== 'lichess') return true;
                        const estimatedGames = contentLength === null
                            ? null
                            : Math.ceil(contentLength / ESTIMATED_BYTES_PER_GAME);
                        if (estimatedGames !== null && estimatedGames <= 5000) {
                            showProgress(source, 0, contentLength, `Baixando o histórico de ${username}…`);
                            return true;
                        }
                        const estimate = estimatedGames === null
                            ? 'O servidor não informou o tamanho do histórico'
                            : `O histórico tem cerca de ${estimatedGames.toLocaleString('pt-BR')} partidas`;
                        const confirmed = window.confirm(
                            `${estimate}. O download completo pode levar vários minutos. Deseja continuar?`
                        );
                        if (confirmed && contentLength !== null) {
                            showProgress(source, 0, contentLength, `Baixando o histórico de ${username}…`);
                        }
                        return confirmed;
                    },
                    (bytesRead, contentLength) => {
                        if (!allHistory || source !== 'lichess') return;
                        if (contentLength !== null) {
                            showProgress(
                                source,
                                bytesRead,
                                contentLength,
                                `Baixando o histórico · ${stats.parsed} partidas processadas`
                            );
                        } else {
                            showProgress(
                                source,
                                0,
                                0,
                                `Baixando o histórico · ${bytesRead.toLocaleString('pt-BR')} bytes · ${stats.parsed} partidas processadas`
                            );
                        }
                    }
                );
                if (result.cancelled) {
                    closeModal();
                    return;
                }
                if (result.ok) {
                    await processor.finish();
                } else {
                    await processor.flushComplete();
                    const message = request.month
                        ? `${request.month}: ${result.error}`
                        : result.error;
                    stats.failedCount++;
                    if (stats.details.length < 20) stats.details.push(message);
                }
                const progressText = request.month
                    ? `Buscando mês ${index + 1} de ${requests.length} (${request.month}) · ${stats.imported} novas`
                    : `Histórico processado · ${stats.parsed} partidas lidas · ${stats.imported} novas`;
                showProgress(source, index + 1, requests.length, progressText);
            }

            if (stats.imported) {
                await reloadGames();
                State.page = 0;
                renderLibrary();
            }
            const completedAt = new Date().toISOString();
            saveConnection(source, {
                username,
                lastSyncAt: completedAt,
                months,
                perfTypes,
                newCount: stats.imported,
                existingCount: stats.existing,
                failedCount: stats.failedCount,
            });
            renderConnections();
            showSummary({
                source,
                imported: stats.imported,
                existing: stats.existing,
                filteredOut: stats.filteredOut,
                failedCount: stats.failedCount,
                details: stats.details,
                newIds: stats.newIds,
            });
        } catch (error) {
            console.error('Falha ao sincronizar partidas:', error);
            closeModal();
            toast(`Não foi possível concluir a sincronização: ${error.message || error}`, 'error');
        }
    }

    function init() {
        if (initialized) return;
        const syncButton = document.getElementById('syncBtn');
        if (!syncButton) return;
        initialized = true;
        syncButton.addEventListener('click', () => open('chesscom'));
        document.getElementById('emptyChesscomSyncBtn').addEventListener('click', () => open('chesscom'));
        document.getElementById('emptyLichessSyncBtn').addEventListener('click', () => open('lichess'));
        renderConnections();
    }

    return {
        init,
        open,
        buildRequests,
        monthsFromArchives,
        requestsFromArchives,
        splitPgnBlocks,
        classifyTimeControl,
        filterGamesByPerf,
    };
})();

window.Sync = Sync;
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', Sync.init, { once: true });
    } else {
        Sync.init();
    }
}
