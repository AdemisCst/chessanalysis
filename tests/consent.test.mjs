/* Consentimento e política de privacidade da IA (Groq).
   Executar com: npm test

   Carrega o js/ai.js real em um contexto `vm` com um Settings mutável e
   verifica a regra que dispara o novo aviso: consentimento antigo não vale. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(join(root, 'js/ai.js'), 'utf8');

function loadAI(privacy) {
    const state = { ai: { privacy } };
    const context = vm.createContext({
        window: {},
        console,
        Settings: { get: () => state },
    });
    vm.runInContext(source, context, { filename: 'js/ai.js' });
    return { AI: context.window.AI, state };
}

test('consentimento concedido sob a versão antiga deixa de valer', () => {
    const old = loadAI({ blocked: false, consentVersion: '2026-11-16-v1', consentAt: 1 });
    assert.equal(old.AI.CONSENT_VERSION, '2026-11-24-v3');
    assert.equal(old.AI.hasConsent(), false, 'versão antiga deve pedir novo aviso');

    const current = loadAI({ blocked: false, consentVersion: old.AI.CONSENT_VERSION, consentAt: 1 });
    assert.equal(current.AI.hasConsent(), true);
    const previous = loadAI({ blocked: false, consentVersion: '2026-11-17-v2', consentAt: 1 });
    assert.equal(previous.AI.hasConsent(), false, 'consentimento anterior não cobre FEN e dados de abertura');
});

test('“Não enviar dados à IA” continua bloqueando o envio', () => {
    const blocked = loadAI({ blocked: true, consentVersion: '2026-11-24-v3', consentAt: 1 });
    assert.equal(blocked.AI.isBlocked(), true);
    assert.equal(blocked.AI.hasConsent(), true);
    assert.equal(blocked.AI.privacy().blocked, true);
});

test('política de privacidade é a da Groq e não é reaproveitada por outro provedor', () => {
    const { AI } = loadAI({});
    assert.equal(AI.privacyPolicyUrl('api.groq.com'), 'https://groq.com/privacy-policy');
    assert.equal(AI.privacyPolicyUrl('provedor externo'), '');
    assert.equal(AI.privacyPolicyUrl(''), '');
});

test('o modal mantém a opção de recusar e identifica provedor/modelo dinamicamente', async () => {
    const ai = await readFile(join(root, 'js/ai.js'), 'utf8');
    assert.ok(ai.includes('Não enviar'));
    assert.ok(ai.includes('providerInfo()'));
    assert.ok(ai.includes('api.groq.com'));
    assert.ok(ai.includes('FEN, cor, lance, classificação, perda, melhor lance e PV em SAN'));
    assert.ok(ai.includes('PGN completo'));
});

test('providerInfo lê State.ai (const global), não window.State', () => {
    const context = vm.createContext({
        window: {},
        console,
        Settings: { get: () => ({}) },
        State: { ai: { providerLabel: 'api.groq.com', model: 'openai/gpt-oss-120b' } },
    });
    vm.runInContext(source, context, { filename: 'js/ai.js' });
    const info = context.window.AI.providerInfo();
    assert.equal(info.label, 'api.groq.com');
    assert.equal(info.model, 'openai/gpt-oss-120b');
});
