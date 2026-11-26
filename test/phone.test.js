// Tests voor telefoonnummers (phone.js) en de code waarmee je je nummer bevestigt (phone-codes.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import {
  containsPhone, formatPhone, normalizePhone, phoneVariants,
} from '../src/phone.js';
import {
  CODE_ATTEMPTS, CODE_MINUTES, cancelVerification, checkCode, createCodeHasher, newCode, pendingVerification,
  removePhone, savePhone, startVerification,
} from '../src/phone-codes.js';
import { createSmsSender } from '../src/sms.js';

// --- Nummers netjes maken --------------------------------------------------------------------

test('een Nederlands nummer, hoe je het ook intypt, wordt +31...', () => {
  for (const input of ['06 12345678', '0612345678', '06-12345678', '06 12 34 56 78', '(06) 12345678', '+31 6 12345678', '+31612345678', '0031 6 1234 5678', ' 06.12.34.56.78 ']) {
    assert.deepEqual(normalizePhone(input), { phone: '+31612345678', error: null }, input);
  }
  assert.equal(normalizePhone('020 1234567').phone, '+31201234567');
});

test('een buitenlands nummer moet met landcode', () => {
  assert.equal(normalizePhone('+44 7700 900123').phone, '+447700900123');
  assert.equal(normalizePhone('0032 470 12 34 56').phone, '+32470123456');
  assert.match(normalizePhone('7700 900123').error, /Begin met 0 \(Nederland\) of met \+ en de landcode/);
});

test('onzin is geen telefoonnummer, en de foutmelding zegt waarom', () => {
  const cases = [
    ['', /Vul een telefoonnummer in/],
    ['   ', /Vul een telefoonnummer in/],
    ['bel me', /bestaat uit cijfers/],
    ['06 1234 5678 <script>', /bestaat uit cijfers/],
    ['06+12345678', /\+ mag alleen aan het begin/],
    ['++31612345678', /\+ mag alleen aan het begin/],
    ['06 1234', /10 cijfers/],
    ['06 123456789', /10 cijfers/],
    ['+0 123 4567', /geen geldig telefoonnummer/],
    ['1'.repeat(31), /bestaat uit cijfers/],
  ];
  for (const [input, message] of cases) {
    const result = normalizePhone(input);
    assert.equal(result.phone, null, input);
    assert.match(result.error, message, input);
  }
  assert.equal(normalizePhone(undefined).phone, null);
});

test('een nummer tonen zoals mensen het schrijven', () => {
  assert.equal(formatPhone('+31612345678'), '06 12345678');
  assert.equal(formatPhone('+31201234567'), '020 1234567');
  assert.equal(formatPhone('+447700900123'), '+447700900123');
  assert.equal(formatPhone(null), '');
});

test('de schrijfwijzen voor de zoekopdracht', () => {
  assert.deepEqual(phoneVariants('+31612345678'), ['0612345678', '06-12345678', '06 12345678', '+31612345678']);
  assert.deepEqual(phoneVariants('+447700900123'), ['+447700900123', '+44 7700900123']);
});

test('staat je nummer in een tekst? Elke schrijfwijze telt, een langer of ander nummer niet', () => {
  const phone = '+31612345678';
  for (const text of [
    'Bel 06-12345678 voor een afspraak', 'Tel. 06 12 34 56 78', 'Mobiel: +31 6 12345678', '+31 (0)6 12345678',
    '0031 6 1234 5678', 'nummer 0612345678.', '(06) 12345678',
  ]) {
    assert.equal(containsPhone(text, phone), true, text);
  }
  for (const text of ['061234567890', '1061234567', 'Bel 06-12345679', 'postcode 1234 AB', '', null]) {
    assert.equal(containsPhone(text, phone), false, String(text));
  }
  assert.equal(containsPhone('Bel 06-12345678', null), false); // geen bevestigd nummer: nooit een treffer
});

// --- De code ------------------------------------------------------------------------------------

test('een code is altijd zes cijfers', () => {
  for (let i = 0; i < 200; i += 1) assert.match(newCode(), /^\d{6}$/);
});

test('de vingerafdruk van een code hoort bij één account, één nummer en één sleutel', () => {
  const hash = createCodeHasher(Buffer.alloc(32, 1));
  const same = createCodeHasher(Buffer.alloc(32, 1));
  const otherKey = createCodeHasher(Buffer.alloc(32, 2));
  const fingerprint = hash(1, '+31612345678', '123456');
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(same(1, '+31612345678', '123456'), fingerprint);
  assert.notEqual(hash(2, '+31612345678', '123456'), fingerprint);
  assert.notEqual(hash(1, '+31612345679', '123456'), fingerprint);
  assert.notEqual(hash(1, '+31612345678', '123457'), fingerprint);
  assert.notEqual(otherKey(1, '+31612345678', '123456'), fingerprint);
});

function withUser() {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO users (name, email, password_hash, created_at) VALUES ('Anna', 'anna@example.com', 'x', 1)").run();
  return { db, userId: db.prepare('SELECT id FROM users').get().id };
}

test('een code klopt één keer, en dan is hij opgebruikt; in de database staat alleen de vingerafdruk', () => {
  const { db, userId } = withUser();
  const hashCode = createCodeHasher();
  const now = 1_000_000;
  startVerification(db, {
    userId, phone: '+31612345678', codeHash: hashCode(userId, '+31612345678', '012345'), now,
  });
  const row = db.prepare('SELECT * FROM phone_codes').get();
  assert.doesNotMatch(JSON.stringify({ ...row }), /012345/);
  assert.deepEqual(pendingVerification(db, userId, now), { phone: '+31612345678', attempts: 0, expiresAt: now + CODE_MINUTES * 60_000 });

  assert.deepEqual(checkCode(db, {
    userId, code: '012345', hashCode, now,
  }), { ok: true, phone: '+31612345678' });
  assert.equal(pendingVerification(db, userId, now), null);
  assert.deepEqual(checkCode(db, {
    userId, code: '012345', hashCode, now,
  }), { ok: false, reason: 'none' });
});

test(`na ${CODE_ATTEMPTS} verkeerde codes vervalt de code, ook de goede werkt dan niet meer`, () => {
  const { db, userId } = withUser();
  const hashCode = createCodeHasher();
  startVerification(db, {
    userId, phone: '+31612345678', codeHash: hashCode(userId, '+31612345678', '111111'), now: 0,
  });
  for (let left = CODE_ATTEMPTS - 1; left > 0; left -= 1) {
    assert.deepEqual(checkCode(db, {
      userId, code: '222222', hashCode, now: 1,
    }), { ok: false, reason: 'wrong', left });
  }
  assert.deepEqual(checkCode(db, {
    userId, code: '222222', hashCode, now: 1,
  }), { ok: false, reason: 'too_many' });
  assert.deepEqual(checkCode(db, {
    userId, code: '111111', hashCode, now: 1,
  }), { ok: false, reason: 'none' });
});

test(`een code is ${CODE_MINUTES} minuten geldig, en een nieuwe code vervangt de oude`, () => {
  const { db, userId } = withUser();
  const hashCode = createCodeHasher();
  const start = (code, now) => startVerification(db, {
    userId, phone: '+31612345678', codeHash: hashCode(userId, '+31612345678', code), now,
  });
  start('111111', 0);
  const expired = CODE_MINUTES * 60_000;
  assert.equal(pendingVerification(db, userId, expired), null);
  assert.equal(checkCode(db, {
    userId, code: '111111', hashCode, now: expired,
  }).reason, 'none');

  start('111111', 0);
  start('333333', 10); // de oude code vervalt
  assert.equal(checkCode(db, {
    userId, code: '111111', hashCode, now: 20,
  }).reason, 'wrong');
  assert.equal(checkCode(db, {
    userId, code: '333333', hashCode, now: 20,
  }).ok, true);
});

test('na een herstart van de server werkt een openstaande code niet meer (de sleutel stond in het geheugen)', () => {
  const { db, userId } = withUser();
  const before = createCodeHasher();
  startVerification(db, {
    userId, phone: '+31612345678', codeHash: before(userId, '+31612345678', '444444'), now: 0,
  });
  const after = createCodeHasher();
  assert.equal(checkCode(db, {
    userId, code: '444444', hashCode: after, now: 1,
  }).reason, 'wrong');
});

test('een nummer opslaan, en weer weghalen met een openstaande code erbij', () => {
  const { db, userId } = withUser();
  savePhone(db, userId, '+31612345678', 5);
  assert.deepEqual({ ...db.prepare('SELECT phone, phone_verified_at FROM users').get() }, { phone: '+31612345678', phone_verified_at: 5 });
  startVerification(db, {
    userId, phone: '+31687654321', codeHash: 'ab', now: 6,
  });
  removePhone(db, userId);
  assert.deepEqual({ ...db.prepare('SELECT phone, phone_verified_at FROM users').get() }, { phone: null, phone_verified_at: null });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM phone_codes').get().n, 0);
  cancelVerification(db, userId); // niets meer om te annuleren: geen fout
});

// --- Sms ------------------------------------------------------------------------------------------

test('op je eigen computer komen sms\'jes in een testpostvak; op een openbare site is er nog geen sms-dienst', async () => {
  const local = createSmsSender();
  assert.equal(local.available, true);
  await local.send('+31612345678', 'eerste');
  await local.send('+31612345678', 'tweede');
  assert.deepEqual(local.outbox.map((message) => message.text), ['tweede', 'eerste']);
  for (let i = 0; i < 30; i += 1) await local.send('+31612345678', `nr ${i}`);
  assert.equal(local.outbox.length, 20);

  const online = createSmsSender({ production: true });
  assert.equal(online.available, false);
  await assert.rejects(online.send('+31612345678', 'test'), /geen sms-dienst/);
  assert.equal(online.outbox.length, 0);
});
