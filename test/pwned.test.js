// Tests voor de check tegen Pwned Passwords. Er gaat hier niets echt het
// internet op: we gebruiken een nep-API die we zelf vullen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPwned, timesPwned } from '../src/pwned.js';

// De SHA-1-hash van "password" is 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8.
const PREFIX = '5BAA6';
const SUFFIX = '1E4C9B93F3F0682250B6CF8331B7EE68FD8';

function fakeApi(body, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    return new Response(body, { status: 200 });
  };
}

test('alleen de eerste 5 tekens van de hash gaan naar de API', async () => {
  const calls = [];
  await timesPwned('password', { fetchFn: fakeApi('', calls) });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.pwnedpasswords.com/range/${PREFIX}`);
  assert.ok(!calls[0].url.includes(SUFFIX));
  assert.equal(calls[0].options.headers['Add-Padding'], 'true');
});

test('herkent een wachtwoord dat in een datalek staat', async () => {
  const body = `0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${SUFFIX}:12345\r\n`;
  assert.equal(await timesPwned('password', { fetchFn: fakeApi(body) }), 12345);
  assert.equal(await isPwned('password', { fetchFn: fakeApi(body) }), true);
});

test('een wachtwoord dat niet in de lijst staat geeft 0', async () => {
  const body = '0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n';
  assert.equal(await timesPwned('password', { fetchFn: fakeApi(body) }), 0);
});

test('opvulregels met telling 0 tellen niet mee', async () => {
  const body = `${SUFFIX}:0\r\n`;
  assert.equal(await isPwned('password', { fetchFn: fakeApi(body) }), false);
});

test('een foutcode van de API telt als niet bereikbaar', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const broken = async () => new Response('', { status: 503 });

  await assert.rejects(timesPwned('password', { fetchFn: broken }), /status 503/);
  assert.equal(await isPwned('password', { fetchFn: broken }), false);
});

test('als de API niet bereikbaar is, gaat de registratie gewoon door', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const offline = async () => { throw new Error('geen internet'); };
  assert.equal(await isPwned('password', { fetchFn: offline }), false);
});
