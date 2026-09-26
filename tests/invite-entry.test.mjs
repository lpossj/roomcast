import assert from 'node:assert/strict';
import test from 'node:test';
import { readPageInvite, roomInviteFromUrl } from '../src/invite-entry.js';

const oldInvite = 'roomcast://join/ABCDEF12?secret=' + 'a'.repeat(43);
const newInvite = 'roomcast://join/DEADBEEF?secret=' + 'b'.repeat(43);
function pageFor(url, remembered = oldInvite) {
  const values = new Map([['roomcast:invite', remembered]]);
  const page = {
    location: new URL(url),
    sessionStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    history: { replaceState: (_, __, value) => { page.location = new URL(value, page.location); } },
  };
  return page;
}

test('fresh fragment and query invites override a remembered room', () => {
  for (const separator of ['#', '?']) {
    const page = pageFor(`https://viewer.example/roomcast/${separator}room=${encodeURIComponent(newInvite)}`);
    assert.equal(readPageInvite(page), newInvite);
    assert.equal(page.sessionStorage.getItem('roomcast:invite'), newInvite);
    if (separator === '#') assert.equal(page.location.hash, '');
  }
});

test('an explicit navigation without an invite does not reopen a remembered room', () => {
  const page = pageFor('https://viewer.example/roomcast/');
  assert.equal(readPageInvite(page, false), '');
  assert.equal(readPageInvite(page), oldInvite);
  page.location.hash = `room=${encodeURIComponent(newInvite)}`;
  assert.equal(readPageInvite(page, false), newInvite);
});

test('denied storage and history do not lose the invite or blank the page', () => {
  const page = pageFor(`https://viewer.example/#room=${encodeURIComponent(newInvite)}`);
  page.sessionStorage = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
  page.history.replaceState = () => { throw Error('denied'); };
  assert.equal(readPageInvite(page), newInvite);
  page.location.hash = '';
  assert.equal(readPageInvite(page), '');
});

test('pasted web links unwrap their invite without accepting executable URLs', () => {
  assert.equal(roomInviteFromUrl(`https://viewer.example/?room=${encodeURIComponent(newInvite)}`), newInvite);
  assert.equal(roomInviteFromUrl(`https://viewer.example/#room=${encodeURIComponent(newInvite)}`), newInvite);
  assert.equal(roomInviteFromUrl(' ' + newInvite + ' '), newInvite);
  assert.equal(roomInviteFromUrl(`javascript:alert(1)#room=${encodeURIComponent(newInvite)}`), '');
  assert.equal(roomInviteFromUrl('ordinary text'), '');
});
