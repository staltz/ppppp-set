const test = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const os = require('node:os')
const rimraf = require('rimraf')
const MsgV3 = require('ppppp-db/msg-v3')
const p = require('node:util').promisify
const { createPeer } = require('./util')
const Keypair = require('ppppp-keypair')

const DIR = path.join(os.tmpdir(), 'ppppp-set')
rimraf.sync(DIR)

const aliceKeypair = Keypair.generate('ed25519', 'alice')

let peer
let aliceID
test('setup', async (t) => {
  peer = createPeer({
    keypair: aliceKeypair,
    path: DIR,
    set: { ghostSpan: 4 },
  })

  await peer.db.loaded()

  aliceID = await p(peer.db.account.create)({
    domain: 'account',
    _nonce: 'alice',
  })
  await p(peer.set.load)(aliceID)

  assert.equal(peer.set.getGhostSpan(), 4, 'getGhostSpan')
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
  assert.equal(
    peer.set.has('follows', '1st'),
    false,
    'doesnt have 1st'
  )
  assert(await p(peer.set.add)('follows', '1st'), 'add 1st')
  assert.equal(peer.set.has('follows', '1st'), true, 'has 1st')
  add1 = lastMsgID()
  assert.deepEqual(
    peer.set._getItemRoots('follows'),
    { '1st': [add1] },
    'itemRoots'
  )

  // Add 2nd
  assert.equal(
    peer.set.has('follows', '2nd'),
    false,
    'doesnt have 2nd'
  )
  assert(await p(peer.set.add)('follows', '2nd'), 'add 2nd')
  assert.equal(peer.set.has('follows', '2nd'), true, 'has 2nd')
  add2 = lastMsgID()
  assert.deepEqual(
    peer.set._getItemRoots('follows'),
    { '1st': [add1], '2nd': [add2] },
    'itemRoots'
  )

  // Del 1st
  assert.equal(peer.set.has('follows', '1st'), true, 'has 1st')
  assert(await p(peer.set.del)('follows', '1st'), 'del 1st')
  assert.equal(
    peer.set.has( 'follows', '1st'),
    false,
    'doesnt have 1st'
  )
  del1 = lastMsgID()
  assert.deepEqual(
    peer.set._getItemRoots('follows'),
    { '1st': [del1], '2nd': [add2] },
    'itemRoots'
  )

  // Add 3rd
  assert.equal(
    peer.set.has( 'follows', '3rd'),
    false,
    'doesnt have 3rd'
  )
  assert(await p(peer.set.add)('follows', '3rd'), 'add 3rd')
  assert.equal(peer.set.has( 'follows', '3rd'), true, 'has 3rd')
  add3 = lastMsgID()
  assert.deepEqual(
    peer.set._getItemRoots('follows'),
    { '3rd': [add3], '2nd': [add2] },
    'itemRoots'
  )

  // Del 2nd
  assert.equal(peer.set.has( 'follows', '2nd'), true, 'has 2nd')
  assert(await p(peer.set.del)('follows', '2nd'), 'del 2nd') // msg seq 4
  assert.equal(
    peer.set.has( 'follows', '2nd'),
    false,
    'doesnt have 2nd'
  )
  del2 = lastMsgID()
  assert.deepEqual(
    peer.set._getItemRoots('follows'),
    { '3rd': [add3], '2nd': [del2] },
    'itemRoots'
  )

  // Del 2nd (idempotent)
  assert.equal(
    await p(peer.set.del)('follows', '2nd'),
    false,
    'del 2nd idempotent'
  )
  assert.equal(
    peer.set.has( 'follows', '2nd'),
    false,
    'doesnt have 2nd'
  )
  assert.deepEqual(
    peer.set._getItemRoots('follows'),
    { '3rd': [add3], '2nd': [del2] },
    'itemRoots'
  )
})

let add4, add5
test('Set values()', async (t) => {
  assert(await p(peer.set.add)('follows', '4th'), 'add 4th')
  add4 = lastMsgID()
  assert(await p(peer.set.add)('follows', '5th'), 'add 5th')
  add5 = lastMsgID()

  const expected = new Set(['3rd', '4th', '5th'])
  for (const item of peer.set.values( 'follows')) {
    assert.equal(expected.has(item), true, 'values() item')
    expected.delete(item)
  }
  assert.equal(expected.size, 0, 'all items')
})

test('predsl Set squeeze', async (t) => {
  assert.deepEqual(
    peer.set._getItemRoots('follows'),
    { '3rd': [add3], '4th': [add4], '5th': [add5] },
    'itemRoots before squeeze'
  )

  assert.equal(peer.set._squeezePotential('follows'), 3, 'squeezePotential=3')

  assert.equal(await p(peer.set.squeeze)('follows'), true, 'squeezed')
  const squeezed = lastMsgID()

  assert.equal(peer.set._squeezePotential('follows'), 0, 'squeezePotential=0')

  assert.deepEqual(
    peer.set._getItemRoots('follows'),
    { '3rd': [squeezed], '4th': [squeezed], '5th': [squeezed] },
    'itemRoots after squeeze'
  )

  assert.equal(
    await p(peer.set.squeeze)('follows'),
    false,
    'squeeze again idempotent'
  )
  const squeezed2 = lastMsgID()
  assert.equal(squeezed, squeezed2, 'squeezed msgID is same')
})

test('Set isGhostable', (t) => {
  const moot = MsgV3.createMoot(aliceID, 'set_v1__follows', aliceKeypair)
  const mootID = MsgV3.getMsgID(moot)

  assert.equal(mootID, peer.set.getFeedID('follows'), 'getFeedID')

  const tangle = peer.db.getTangle(mootID)
  const msgIDs = tangle.topoSort()

  const itemRoots = peer.set._getItemRoots('follows')
  assert.deepEqual(itemRoots, {
    '3rd': [msgIDs[8]],
    '4th': [msgIDs[8]],
    '5th': [msgIDs[8]],
  })

  // Remember from the setup, that ghostSpan=4
  assert.equal(msgIDs.length, 9)
  assert.equal(peer.set.isGhostable(msgIDs[0], mootID), false) // moot
  assert.equal(peer.set.isGhostable(msgIDs[1], mootID), false)
  assert.equal(peer.set.isGhostable(msgIDs[2], mootID), false)
  assert.equal(peer.set.isGhostable(msgIDs[3], mootID), false)
  assert.equal(peer.set.isGhostable(msgIDs[4], mootID), true) // in ghostSpan
  assert.equal(peer.set.isGhostable(msgIDs[5], mootID), true) // in ghostSpan
  assert.equal(peer.set.isGhostable(msgIDs[6], mootID), true) // in ghostSpan
  assert.equal(peer.set.isGhostable(msgIDs[7], mootID), true) // in ghostSpan
  assert.equal(peer.set.isGhostable(msgIDs[8], mootID), false) // item root
})

test('teardown', async (t) => {
  await p(peer.close)(true)
})
