const os = require('node:os')
const path = require('node:path')
const rimraf = require('rimraf')
const caps = require('ppppp-caps')
const Keypair = require('ppppp-keypair')

function createPeer(opts) {
  if (opts.name) {
    const tmp = os.tmpdir()
    opts.db ??= {path: path.join(tmp, `ppppp-set-${opts.name}-${Date.now()}`)}
    opts.keypair ??= Keypair.generate('ed25519', opts.name)
    opts.name = undefined
  }
  if (!opts.db.path) throw new Error('need opts.db.path in createPeer()')
  if (!opts.keypair) throw new Error('need opts.keypair in createPeer()')

  rimraf.sync(opts.db.path)
  return require('secret-stack/bare')()
    .use(require('secret-stack/plugins/net'))
    .use(require('secret-handshake-ext/secret-stack'))
    .use(require('ppppp-db'))
    .use(require('ssb-box'))
    .use(require('../lib'))
    .call(null, {
      caps,
      connections: {
        incoming: {
          net: [{ scope: 'device', transform: 'shse', port: null }],
        },
        outgoing: {
          net: [{ transform: 'shse' }],
        },
      },
      ...opts,
    })
}

module.exports = { createPeer }
