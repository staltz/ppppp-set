const test = require('tape')
const path = require('path')
const os = require('os')
const rimraf = require('rimraf')
const SecretStack = require('secret-stack')
const FeedV1 = require('ppppp-db/feed-v1')
const caps = require('ssb-caps')
const p = require('util').promisify
const { generateKeypair } = require('./util')

const DIR = path.join(os.tmpdir(), 'ppppp-set')
rimraf.sync(DIR)

const aliceKeys = generateKeypair('alice')
const who = aliceKeys.id

let peer
test('setup', async (t) => {
  peer = SecretStack({ appKey: caps.shs })
    .use(require('ppppp-db'))
    .use(require('ssb-box'))
    .use(require('../lib'))
    .call(null, {
      keys: aliceKeys,
      path: DIR,
    })

  await peer.db.loaded()
})

function lastMsgHash() {
  let last
  for (const item of peer.db.records()) {
    last = item
  }
  return last.hash
}

let add1, add2, del1, add3, del2
test('Set add(), del(), has()', async (t) => {
  // Add 1st
  t.false(peer.set.has(who, 'follows', '1st'), 'doesnt have 1st')
  t.ok(await p(peer.set.add)(who, 'follows', '1st'), 'add 1st')
  t.true(peer.set.has(who, 'follows', '1st'), 'has 1st')
  add1 = lastMsgHash()
  t.deepEquals(
    peer.set.getItemRoots(who, 'follows'),
    { '1st': [add1] },
    'itemRoots'
  )

  // Add 2nd
  t.false(peer.set.has(who, 'follows', '2nd'), 'doesnt have 2nd')
  t.ok(await p(peer.set.add)(who, 'follows', '2nd'), 'add 2nd')
  t.true(peer.set.has(who, 'follows', '2nd'), 'has 2nd')
  add2 = lastMsgHash()
  t.deepEquals(
    peer.set.getItemRoots(who, 'follows'),
    { '1st': [add1], '2nd': [add2] },
    'itemRoots'
  )

  // Del 1st
  t.true(peer.set.has(who, 'follows', '1st'), 'has 1st')
  t.ok(await p(peer.set.del)(who, 'follows', '1st'), 'del 1st')
  t.false(peer.set.has(who, 'follows', '1st'), 'doesnt have 1st')
  del1 = lastMsgHash()
  t.deepEquals(
    peer.set.getItemRoots(who, 'follows'),
    { '1st': [del1], '2nd': [add2] },
    'itemRoots'
  )

  // Add 3rd
  t.false(peer.set.has(who, 'follows', '3rd'), 'doesnt have 3rd')
  t.ok(await p(peer.set.add)(who, 'follows', '3rd'), 'add 3rd')
  t.true(peer.set.has(who, 'follows', '3rd'), 'has 3rd')
  add3 = lastMsgHash()
  t.deepEquals(
    peer.set.getItemRoots(who, 'follows'),
    { '3rd': [add3], '2nd': [add2] },
    'itemRoots'
  )

  // Del 2nd
  t.true(peer.set.has(who, 'follows', '2nd'), 'has 2nd')
  t.ok(await p(peer.set.del)(who, 'follows', '2nd'), 'del 2nd') // msg seq 4
  t.false(peer.set.has(who, 'follows', '2nd'), 'doesnt have 2nd')
  del2 = lastMsgHash()
  t.deepEquals(
    peer.set.getItemRoots(who, 'follows'),
    { '3rd': [add3], '2nd': [del2] },
    'itemRoots'
  )

  // Del 2nd (idempotent)
  t.notOk(await p(peer.set.del)(who, 'follows', '2nd'), 'del 2nd idempotent')
  t.false(peer.set.has(who, 'follows', '2nd'), 'doesnt have 2nd')
  t.deepEquals(
    peer.set.getItemRoots(who, 'follows'),
    { '3rd': [add3], '2nd': [del2] },
    'itemRoots'
  )
})

let add4, add5
test('Set values()', async (t) => {
  t.ok(await p(peer.set.add)(who, 'follows', '4th'), 'add 4th')
  add4 = lastMsgHash()
  t.ok(await p(peer.set.add)(who, 'follows', '5th'), 'add 5th')
  add5 = lastMsgHash()

  const expected = new Set(['3rd', '4th', '5th'])
  for (const item of peer.set.values(who, 'follows')) {
    t.true(expected.has(item), 'values() item')
    expected.delete(item)
  }
  t.equals(expected.size, 0, 'all items')
})

test('predsl Set squeeze', async (t) => {
  t.deepEquals(
    peer.set.getItemRoots(who, 'follows'),
    { '3rd': [add3], '4th': [add4], '5th': [add5] },
    'itemRoots before squeeze'
  )

  t.equals(peer.set._squeezePotential('follows'), 3, 'squeezePotential=3')

  t.true(await p(peer.set.squeeze)(who, 'follows'), 'squeezed')
  const squeezed = lastMsgHash()

  t.equals(peer.set._squeezePotential('follows'), 0, 'squeezePotential=0')

  t.deepEquals(
    peer.set.getItemRoots(who, 'follows'),
    { '3rd': [squeezed], '4th': [squeezed], '5th': [squeezed] },
    'itemRoots after squeeze'
  )

  t.false(await p(peer.set.squeeze)(who, 'follows'), 'squeeze again idempotent')
  const squeezed2 = lastMsgHash()
  t.equals(squeezed, squeezed2, 'squeezed msg hash is same')
})

test('teardown', (t) => {
  peer.close(t.end)
})
