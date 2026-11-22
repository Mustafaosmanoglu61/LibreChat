#!/usr/bin/env node
/**
 * Sign in with ChatGPT — yerel el sıkışma yardımcısı.
 *
 * OpenAI'nin kayıtsız yerel istemciler için açtığı `dynamic_agent_client` akışını
 * kullanır: 127.0.0.1 üzerinde geri çağrıyı dinler, tarayıcıda ChatGPT girişini
 * açar, yetkilendirme kodunu token'a çevirir ve sonucu yerel bir dosyaya yazar.
 *
 * Kullanım:  node scripts/siwc-login.mjs
 * Seçenekler (ortam değişkeni):
 *   SIWC_PORT      geri çağrı portu (varsayılan 1455)
 *   SIWC_APP_NAME  OpenAI'ye bildirilen uygulama adı (varsayılan "MLP/AI")
 *   SIWC_HOME      kimlik dosyalarının dizini (varsayılan ~/.mlpai)
 */

import { createServer } from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const DISCOVERY = 'https://auth.openai.com/.well-known/openid-configuration';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PORT = Number(process.env.SIWC_PORT ?? 1455);
const APP_NAME = process.env.SIWC_APP_NAME ?? 'MLP/AI';
const HOME = process.env.SIWC_HOME ?? join(homedir(), '.mlpai');
const HOST_FILE = join(HOME, 'siwc-host.json');
const AUTH_FILE = join(HOME, 'siwc-auth.json');
const REDIRECT_PATH = '/auth/callback';
const REDIRECT_URI = `http://127.0.0.1:${PORT}${REDIRECT_PATH}`;

const b64url = (buf) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function readJson(path) {
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

/** Aynı makine her girişte aynı host kimliğini göndermeli. */
function loadHostId() {
  const stored = readJson(HOST_FILE);
  if (stored?.ext_agent_host_id) {
    return stored.ext_agent_host_id;
  }
  const hostId = `urn:uuid:${randomUUID()}`;
  writeJson(HOST_FILE, { ext_agent_host_id: hostId, createdAt: new Date().toISOString() });
  return hostId;
}

function decodeJwtClaims(jwt) {
  try {
    const payload = jwt.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

const BROWSER_COMMANDS = { darwin: 'open', win32: 'start' };

function openBrowser(url) {
  const command = BROWSER_COMMANDS[process.platform] ?? 'xdg-open';
  const child = spawn(command, [url], {
    stdio: 'ignore',
    detached: true,
    shell: process.platform === 'win32',
  });
  child.unref();
}

const PAGE = (title, body) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0">` +
  `<div style="text-align:center"><h2>${title}</h2><p style="opacity:.7">${body}</p></div>`;

/** Geri çağrıyı bekler; yalnızca loopback Host başlığını kabul eder. */
function waitForCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const host = req.headers.host ?? '';
      if (!host.startsWith('127.0.0.1:')) {
        res.writeHead(400).end('bad host');
        return;
      }
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== REDIRECT_PATH) {
        res.writeHead(404).end();
        return;
      }
      const params = Object.fromEntries(url.searchParams.entries());
      const finish = (status, page, settle) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(page);
        server.close(() => settle());
      };
      if (params.error) {
        finish(
          400,
          PAGE('Yetkilendirme reddedildi', params.error_description ?? params.error),
          () => reject(new Error(`${params.error}: ${params.error_description ?? ''}`)),
        );
        return;
      }
      if (params.state !== expectedState) {
        finish(400, PAGE('Durum eşleşmedi', 'Bu pencereyi kapatıp tekrar deneyin.'), () =>
          reject(new Error('state uyuşmuyor — isteği başka bir oturum başlatmış olabilir')),
        );
        return;
      }
      finish(200, PAGE('Bağlantı tamam', 'Bu sekmeyi kapatabilirsiniz.'), () => resolve(params));
    });
    server.on('error', (err) =>
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(`${PORT} portu meşgul. SIWC_PORT ile başka bir port verin.`)
          : err,
      ),
    );
    server.listen({ port: PORT, host: '127.0.0.1' });
  });
}

async function postForm(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token isteği ${res.status}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

async function main() {
  const discovery = await fetch(DISCOVERY).then((r) => r.json());
  const hostId = loadHostId();
  const saved = readJson(AUTH_FILE);
  const issuedClientId = saved?.client_id;

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(24));
  const nonce = b64url(randomBytes(24));

  const params = new URLSearchParams({
    client_id: issuedClientId ?? 'dynamic_agent_client',
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    resource: RESOURCE,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ext_agent_host_id: hostId,
  });
  if (!issuedClientId) {
    params.set('agent_name_hint', APP_NAME);
  } else if (saved?.id_token) {
    params.set('id_token_hint', saved.id_token);
  }

  const authorizeUrl = `${discovery.authorization_endpoint}?${params}`;

  console.log(`\nUygulama adı : ${APP_NAME}`);
  console.log(`Host kimliği : ${hostId}`);
  console.log(`İstemci      : ${issuedClientId ?? 'dynamic_agent_client (ilk kayıt)'}`);
  console.log(`Geri çağrı   : ${REDIRECT_URI}`);
  console.log('\nTarayıcı açılıyor. Açılmazsa şu adrese gidin:\n');
  console.log(authorizeUrl + '\n');

  const pending = waitForCallback(state);
  openBrowser(authorizeUrl);
  const callback = await pending;

  const callbackClientId =
    callback.client_id ??
    Object.values(callback).find((v) => typeof v === 'string' && v.startsWith('oaiapp_'));
  if (!issuedClientId && !callbackClientId) {
    console.warn(
      'UYARI: geri çağrıda verilen client_id yok. Dönen alanlar:',
      Object.keys(callback).join(', '),
    );
  }
  const exchangeClientId = callbackClientId ?? issuedClientId ?? 'dynamic_agent_client';

  const tokens = await postForm(discovery.token_endpoint, {
    grant_type: 'authorization_code',
    client_id: exchangeClientId,
    code: callback.code,
    code_verifier: verifier,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
  });

  const claims = tokens.id_token ? decodeJwtClaims(tokens.id_token) : {};
  const access = tokens.access_token ? decodeJwtClaims(tokens.access_token) : {};
  const auth = claims['https://api.openai.com/auth'] ?? {};

  writeJson(AUTH_FILE, {
    client_id: exchangeClientId,
    ext_agent_host_id: hostId,
    id_token: tokens.id_token,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    expires_in: tokens.expires_in,
    obtained_at: new Date().toISOString(),
    account: {
      email: claims.email,
      plan: auth.chatgpt_plan_type,
      account_id: auth.chatgpt_account_id,
    },
  });

  console.log('Giriş tamamlandı.\n');
  console.log(`  hesap        : ${claims.email ?? '(bilinmiyor)'}`);
  console.log(`  plan         : ${auth.chatgpt_plan_type ?? '(bildirilmedi)'}`);
  console.log(`  client_id    : ${exchangeClientId}`);
  console.log(
    `  kapsamlar    : ${(access.scope ?? access.scp ?? []).join?.(' ') ?? tokens.scope ?? '(yok)'}`,
  );
  console.log(`  access ömrü  : ${tokens.expires_in ?? '?'} sn`);
  console.log(
    `  refresh      : ${tokens.refresh_token ? 'var' : 'YOK (offline_access verilmedi)'}`,
  );
  console.log(`  kaydedildi   : ${AUTH_FILE}\n`);

  process.stdout.write('Doğrulama: /v1/models çağrılıyor... ');
  const res = await fetch(`${RESOURCE}/models`, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const body = await res.text();
  if (!res.ok) {
    console.log(`BAŞARISIZ (HTTP ${res.status})\n${body.slice(0, 500)}\n`);
    process.exitCode = 1;
    return;
  }
  const parsed = JSON.parse(body);
  const slugs = (parsed.models ?? parsed.data ?? []).map((m) => m.slug ?? m.id).filter(Boolean);
  console.log(`tamam — ${slugs.length} model.`);
  console.log('  ' + slugs.join(', '));
  console.log('');
}

main().catch((err) => {
  console.error('\nHATA:', err.message, '\n');
  process.exitCode = 1;
});
