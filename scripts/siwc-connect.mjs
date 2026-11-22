#!/usr/bin/env node
/**
 * siwc-login.mjs ile alınan ChatGPT bağlantısını bir LibreChat sunucusuna aktarır.
 *
 * Kullanım:  node scripts/siwc-connect.mjs [sunucu-adresi]
 *   SIWC_ENDPOINT  bağlanacak LibreChat endpoint adı (varsayılan "ChatGPT")
 *   SIWC_HOME      kimlik dosyalarının dizini (varsayılan ~/.mlpai)
 *
 * Aktarım başarılı olunca yerel access/refresh token'ları silinir: sunucu yenileme
 * token'ını ilk yenilemede değiştirir, eski kopyanın kullanılması OpenAI'nin tüm
 * bağlantıyı iptal etmesine yol açabilir. client_id ve host kimliği korunur.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const SERVER = (process.argv[2] ?? 'https://medical-chat-production-1260.up.railway.app').replace(
  /\/+$/,
  '',
);
const ENDPOINT = process.env.SIWC_ENDPOINT ?? 'ChatGPT';
const PROVIDER = 'chatgpt';
const AUTH_FILE = join(process.env.SIWC_HOME ?? join(homedir(), '.mlpai'), 'siwc-auth.json');

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (answer) => (rl.close(), resolve(answer.trim()))),
  );
}

/** Parolayı ekrana yazmadan okur. */
function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    let value = '';
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode?.(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          process.exit(130);
        }
        value = ch === '\u007f' ? value.slice(0, -1) : value + ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  if (!existsSync(AUTH_FILE)) {
    throw new Error(`${AUTH_FILE} yok. Önce: node scripts/siwc-login.mjs`);
  }
  const auth = JSON.parse(readFileSync(AUTH_FILE, 'utf8'));
  if (!auth.refresh_token || !auth.access_token) {
    throw new Error(
      'Yerel dosyada token yok (zaten aktarılmış olabilir). Önce: node scripts/siwc-login.mjs',
    );
  }

  console.log(`\nSunucu   : ${SERVER}`);
  console.log(`Endpoint : ${ENDPOINT}`);
  console.log(`ChatGPT  : ${auth.account?.email ?? '(bilinmiyor)'}\n`);

  const email = await ask('LibreChat e-posta: ');
  const password = await askHidden('LibreChat parola: ');

  const login = await fetch(`${SERVER}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const session = await login.json().catch(() => ({}));
  if (!login.ok || !session.token) {
    throw new Error(
      session.twoFAPending
        ? 'Hesapta iki faktörlü doğrulama açık; bu komut henüz 2FA desteklemiyor.'
        : `Giriş başarısız (HTTP ${login.status}): ${session.message ?? ''}`,
    );
  }

  const res = await fetch(`${SERVER}/api/connections/${PROVIDER}/${encodeURIComponent(ENDPOINT)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      client_id: auth.client_id,
      access_token: auth.access_token,
      refresh_token: auth.refresh_token,
      id_token: auth.id_token,
      expires_in: auth.expires_in,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Aktarım başarısız (HTTP ${res.status}): ${body.error ?? ''}`);
  }

  writeFileSync(
    AUTH_FILE,
    JSON.stringify(
      {
        client_id: auth.client_id,
        ext_agent_host_id: auth.ext_agent_host_id,
        id_token: auth.id_token,
        account: auth.account,
        transferred_to: SERVER,
        transferred_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  console.log('\nBağlantı aktarıldı.');
  console.log(`  hesap     : ${body.accountEmail ?? '-'}`);
  console.log(`  plan      : ${body.plan ?? '-'}`);
  console.log(`  durum     : ${body.connected ? 'bağlı' : 'yeniden bağlanma gerekli'}`);
  console.log("  yerel token'lar silindi (sunucu artık kendi yeniliyor).\n");
}

main().catch((err) => {
  console.error('\nHATA:', err.message, '\n');
  process.exitCode = 1;
});
