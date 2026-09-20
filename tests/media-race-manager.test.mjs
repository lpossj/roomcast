import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createMediaRaceCoordinator,
  MEDIA_RACE_VDO_DELAY_MS,
} from '../src/media-race-manager.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('P2P playable first wins immediately, loser closes only after stability guard', async () => {
  const selected = [];
  const stable = [];
  const cleaned = [];

  const race = createMediaRaceCoordinator({
    tieWindowMs: 20,
    stabilityGuardMs: 25,
    timeoutMs: 200,
    onSelected: event => selected.push(event),
    onStable: event => stable.push(event),
    cleanup: (route, reason) => cleaned.push([route, reason]),
  });

  race.start();
  race.markPlayable('p2p', { stream: 'p2p' });

  assert.equal(race.selectedRoute, 'p2p');
  assert.equal(selected.length, 1);
  assert.equal(cleaned.length, 0);

  await sleep(40);

  assert.equal(race.state, 'stable');
  assert.equal(stable.length, 1);
  assert.equal(cleaned.length, 1);
  assert.equal(cleaned[0][0], 'vdo');
});

test('VDO first but P2P inside tie window deterministically selects P2P', async () => {
  const selected = [];

  const race = createMediaRaceCoordinator({
    tieWindowMs: 30,
    stabilityGuardMs: 20,
    timeoutMs: 200,
    onSelected: event => selected.push(event),
  });

  race.start();
  race.markPlayable('vdo', { stream: 'vdo' });
  assert.equal(race.selectedRoute, null);
  assert.equal(race.state, 'provisional');

  await sleep(8);
  race.markPlayable('p2p', { stream: 'p2p' });

  assert.equal(race.selectedRoute, 'p2p');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].route, 'p2p');

  race.close();
});

test('VDO wins when P2P does not become playable inside tie window', async () => {
  const race = createMediaRaceCoordinator({
    tieWindowMs: 15,
    stabilityGuardMs: 50,
    timeoutMs: 200,
  });

  race.start();
  race.markPlayable('vdo', { stream: 'vdo' });

  await sleep(25);

  assert.equal(race.selectedRoute, 'vdo');
  assert.equal(race.state, 'selected');

  race.close();
});

test('winner failure during guard switches to an already-playable warm loser', async () => {
  const selected = [];

  const race = createMediaRaceCoordinator({
    tieWindowMs: 10,
    stabilityGuardMs: 60,
    timeoutMs: 300,
    onSelected: event => selected.push(event.route),
  });

  race.start();
  race.markPlayable('vdo', { stream: 'vdo' });
  await sleep(15);
  assert.equal(race.selectedRoute, 'vdo');

  // P2P becomes a warm loser after VDO has already won.
  race.markPlayable('p2p', { stream: 'p2p' });
  assert.equal(race.selectedRoute, 'vdo');

  race.markFailed('vdo', new Error('VDO dropped during guard'));

  assert.equal(race.selectedRoute, 'p2p');
  assert.deepEqual(selected, ['vdo', 'p2p']);

  race.close();
});

test('one failed candidate does not open the exhausted/TURN gate while the other still connects', async () => {
  const exhausted = [];

  const race = createMediaRaceCoordinator({
    tieWindowMs: 10,
    stabilityGuardMs: 10,
    timeoutMs: 100,
    onExhausted: event => exhausted.push(event),
  });

  race.start();
  race.markFailed('p2p', new Error('P2P failed'));

  assert.equal(race.state, 'racing');
  assert.equal(exhausted.length, 0);

  race.markPlayable('vdo', { stream: 'vdo' });
  assert.equal(race.selectedRoute, 'vdo');

  race.close();
});

test('both direct candidates failed opens exhausted gate exactly once', () => {
  const exhausted = [];
  const cleaned = [];

  const race = createMediaRaceCoordinator({
    timeoutMs: 200,
    onExhausted: event => exhausted.push(event),
    cleanup: (route, reason) => cleaned.push([route, reason]),
  });

  race.start();
  race.markFailed('p2p', new Error('P2P failed'));
  race.markFailed('vdo', new Error('VDO failed'));
  race.markFailed('vdo', new Error('late duplicate'));

  assert.equal(race.state, 'exhausted');
  assert.equal(exhausted.length, 1);
  assert.deepEqual(cleaned.map(([route]) => route).sort(), ['p2p', 'vdo']);
});

test('overall direct-race timeout opens exhausted gate if neither route is playable', async () => {
  const exhausted = [];

  const race = createMediaRaceCoordinator({
    timeoutMs: 25,
    tieWindowMs: 5,
    stabilityGuardMs: 5,
    onExhausted: event => exhausted.push(event),
  });

  race.start();
  await sleep(45);

  assert.equal(race.state, 'exhausted');
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].reason, 'timeout');
});

test('delayed VDO starts once at exactly 3000ms, independently of the tie window', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts = 0;
  const race = createMediaRaceCoordinator({ startVdo: () => starts++ });
  t.after(() => race.close());
  race.start(); race.start();
  assert.equal(MEDIA_RACE_VDO_DELAY_MS, 3000);
  assert.equal(race.snapshot.routes.vdo.status, 'waiting');
  t.mock.timers.tick(2999);
  assert.equal(starts, 0);
  t.mock.timers.tick(1);
  assert.equal(starts, 1);
  assert.equal(race.snapshot.routes.vdo.status, 'connecting');
  race.markFailed('p2p');
  t.mock.timers.tick(3000);
  assert.equal(starts, 1);
});

test('P2P playable before three seconds cancels VDO even while stability guard is pending', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts = 0;
  const race = createMediaRaceCoordinator({ startVdo: () => starts++ });
  t.after(() => race.close());
  race.start();
  t.mock.timers.tick(2999);
  race.markPlayable('p2p');
  t.mock.timers.tick(1);
  assert.equal(race.state, 'selected');
  assert.equal(starts, 0);
  t.mock.timers.tick(1000);
  assert.equal(race.state, 'stable');
  assert.equal(starts, 0);
});

test('early P2P failure starts VDO immediately and TURN waits for VDO failure', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts = 0, exhausted = 0;
  const race = createMediaRaceCoordinator({ startVdo: () => starts++, onExhausted: () => exhausted++ });
  t.after(() => race.close());
  race.start();
  t.mock.timers.tick(200);
  race.markFailed('p2p'); race.markFailed('p2p');
  assert.equal(starts, 1);
  assert.equal(exhausted, 0);
  race.markFailed('vdo');
  assert.equal(exhausted, 1);
  t.mock.timers.tick(3000);
  assert.equal(starts, 1);
});

test('P2P failure during guard starts the previously cancelled VDO delay immediately', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts = 0;
  const race = createMediaRaceCoordinator({ startVdo: () => starts++ });
  t.after(() => race.close());
  race.start(); race.markPlayable('p2p');
  t.mock.timers.tick(100);
  race.markFailed('p2p');
  assert.equal(starts, 1);
  race.markPlayable('vdo');
  assert.equal(race.selectedRoute, 'vdo');
});

test('closing or exhausting a waiting race cannot start a ghost VDO viewer', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts = 0;
  const disposed = createMediaRaceCoordinator({ startVdo: () => starts++ });
  const exhausted = createMediaRaceCoordinator({ startVdo: () => starts++, timeoutMs: 1000 });
  disposed.start(); exhausted.start();
  disposed.close();
  t.mock.timers.tick(3000);
  assert.equal(starts, 0);
  assert.equal(exhausted.state, 'exhausted');
  exhausted.close();
});

test('synchronous delayed startup failure exhausts once without reviving race state', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let exhausted = 0;
  const race = createMediaRaceCoordinator({ startVdo: () => { throw new Error('startup'); }, onExhausted: () => exhausted++ });
  t.after(() => race.close());
  race.start(); race.markFailed('p2p');
  assert.equal(exhausted, 1);
  assert.equal(race.state, 'exhausted');
});
