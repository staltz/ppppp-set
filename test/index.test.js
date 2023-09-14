const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const os = require('node:os')
const rimraf = require('rimraf')
const p = require('node:util').promisify
const { createPeer } = require('./util')
const Keypair = require('ppppp-keypair')

const DIR = path.join(os.tmpdir(), 'ppppp-set')
rimraf.sync(DIR)

const aliceKeypair = Keypair.generate('ed25519', 'alice')

let peer
let aliceID
test('setup', async (t) => {
  peer = createPeer({ keypair: aliceKeypair, path: DIR })

  await peer.db.loaded()

  aliceID = await p(peer.db.account.create)({
    domain: 'account',
    _nonce: 'alice',
  })
  await p(peer.set.load)(aliceID)
})

function lastMsgID() {
  let last
  for (const item of peer.db.records()) {
    last = item
  }
  return last.id
}

let add1, add2, del1, add3, del2
test('Set add(), del(), has()', async (t) => {
  // Add 1st
  assert.equal(peer.set.has(aliceID, 'follows', '1st'), false, 'doesnt have 1st')
  assert(await p(peer.set.add)(aliceID, 'follows', '1st'), 'add 1st')
  assert.equal(peer.set.has(aliceID, 'follows', '1st'), true, 'has 1st')
  add1 = lastMsgID()
  assert.deepEqual(
    peer.set.getItemRoots(aliceID, 'follows'),
    { '1st': [add1] },
    'itemRoots'
  )

  // Add 2nd
  assert.equal(peer.set.has(aliceID, 'follows', '2nd'), false, 'doesnt have 2nd')
  assert(await p(peer.set.add)(aliceID, 'follows', '2nd'), 'add 2nd')
  assert.equal(peer.set.has(aliceID, 'follows', '2nd'), true, 'has 2nd')
  add2 = lastMsgID()
  assert.deepEqual(
    peer.set.getItemRoots(aliceID, 'follows'),
    { '1st': [add1], '2nd': [add2] },
    'itemRoots'
  )

  // Del 1st
  assert.equal(peer.set.has(aliceID, 'follows', '1st'), true, 'has 1st')
  assert(await p(peer.set.del)(aliceID, 'follows', '1st'), 'del 1st')
  assert.equal(peer.set.has(aliceID, 'follows', '1st'), false, 'doesnt have 1st')
  del1 = lastMsgID()
  assert.deepEqual(
    peer.set.getItemRoots(aliceID, 'follows'),
    { '1st': [del1], '2nd': [add2] },
    'itemRoots'
  )

  // Add 3rd
  assert.equal(peer.set.has(aliceID, 'follows', '3rd'), false, 'doesnt have 3rd')
  assert(await p(peer.set.add)(aliceID, 'follows', '3rd'), 'add 3rd')
  assert.equal(peer.set.has(aliceID, 'follows', '3rd'), true, 'has 3rd')
  add3 = lastMsgID()
  assert.deepEqual(
    peer.set.getItemRoots(aliceID, 'follows'),
    { '3rd': [add3], '2nd': [add2] },
    'itemRoots'
  )

  // Del 2nd
  assert.equal(peer.set.has(aliceID, 'follows', '2nd'), true, 'has 2nd')
  assert(await p(peer.set.del)(aliceID, 'follows', '2nd'), 'del 2nd') // msg seq 4
  assert.equal(peer.set.has(aliceID, 'follows', '2nd'), false, 'doesnt have 2nd')
  del2 = lastMsgID()
  assert.deepEqual(
    peer.set.getItemRoots(aliceID, 'follows'),
    { '3rd': [add3], '2nd': [del2] },
    'itemRoots'
  )

  // Del 2nd (idempotent)
  assert.equal(await p(peer.set.del)(aliceID, 'follows', '2nd'), false, 'del 2nd idempotent')
  assert.equal(peer.set.has(aliceID, 'follows', '2nd'), false, 'doesnt have 2nd')
  assert.deepEqual(
    peer.set.getItemRoots(aliceID, 'follows'),
    { '3rd': [add3], '2nd': [del2] },
    'itemRoots'
  )
})

let add4, add5
test('Set values()', async (t) => {
  assert(await p(peer.set.add)(aliceID, 'follows', '4th'), 'add 4th')
  add4 = lastMsgID()
  assert(await p(peer.set.add)(aliceID, 'follows', '5th'), 'add 5th')
  add5 = lastMsgID()

  const expected = new Set(['3rd', '4th', '5th'])
  for (const item of peer.set.values(aliceID, 'follows')) {
    assert.equal(expected.has(item), true, 'values() item')
    expected.delete(item)
  }
  assert.equal(expected.size, 0, 'all items')
})

test('predsl Set squeeze', async (t) => {
  assert.deepEqual(
    peer.set.getItemRoots(aliceID, 'follows'),
    { '3rd': [add3], '4th': [add4], '5th': [add5] },
    'itemRoots before squeeze'
  )

  assert.equal(peer.set._squeezePotential('follows'), 3, 'squeezePotential=3')

  assert.equal(await p(peer.set.squeeze)(aliceID, 'follows'), true, 'squeezed')
  const squeezed = lastMsgID()

  assert.equal(peer.set._squeezePotential('follows'), 0, 'squeezePotential=0')

  assert.deepEqual(
    peer.set.getItemRoots(aliceID, 'follows'),
    { '3rd': [squeezed], '4th': [squeezed], '5th': [squeezed] },
    'itemRoots after squeeze'
  )

  assert.equal(await p(peer.set.squeeze)(aliceID, 'follows'), false, 'squeeze again idempotent')
  const squeezed2 = lastMsgID()
  assert.equal(squeezed, squeezed2, 'squeezed msgID is same')
})

test('teardown', async (t) => {
  await p(peer.close)(true)
})
