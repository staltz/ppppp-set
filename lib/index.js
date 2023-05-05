const FeedV1 = require('ppppp-db/feed-v1')

const PREFIX = 'set_v1__'

/** @typedef {string} Subtype */

/** @typedef {string} MsgHash */

/** @typedef {`${Subtype}.${string}`} SubtypeItem */

/**
 * @param {string} type
 * @returns {Subtype}
 */
function toSubtype(type) {
  return type.slice(PREFIX.length)
}

/**
 * @param {Subtype} subtype
 * @returns {string}
 */
function fromSubtype(subtype) {
  return PREFIX + subtype
}

module.exports = {
  name: 'set',
  manifest: {
    add: 'async',
    del: 'async',
    has: 'sync',
    values: 'sync',
    getItemRoots: 'sync',
    squeeze: 'async',
  },
  init(peer, config) {
    //#region state
    const myWho = FeedV1.stripAuthor(config.keys.id)
    let cancelListeningToRecordAdded = null

    /** @type {Map<Subtype, unknown>} */
    const tangles = new Map()

    const itemRoots = {
      /** @type {Map<SubtypeItem, Set<MsgHash>} */
      _map: new Map(),
      _getKey(subtype, item) {
        return subtype + '/' + item
      },
      get(subtype, item = null) {
        if (item) {
          const key = this._getKey(subtype, item)
          return this._map.get(key)
        } else {
          const out = {}
          for (const [key, value] of this._map.entries()) {
            if (key.startsWith(subtype + '/')) {
              const item = key.slice(subtype.length + 1)
              out[item] = [...value]
            }
          }
          return out
        }
      },
      add(subtype, item, msgHash) {
        const key = this._getKey(subtype, item)
        const set = this._map.get(key) ?? new Set()
        set.add(msgHash)
        return this._map.set(key, set)
      },
      del(subtype, item, msgHash) {
        const key = this._getKey(subtype, item)
        const set = this._map.get(key)
        if (!set) return false
        set.delete(msgHash)
        if (set.size === 0) this._map.delete(key)
        return true
      },
      toString() {
        return this._map
      },
    }
    //#endregion

    //#region active processes
    const loadPromise = new Promise((resolve, reject) => {
      for (const { hash, msg } of peer.db.records()) {
        maybeLearnAboutSet(hash, msg)
      }
      cancelListeningToRecordAdded = peer.db.onRecordAdded(({ hash, msg }) => {
        maybeLearnAboutSet(hash, msg)
      })
      resolve()
    })

    peer.close.hook(function (fn, args) {
      cancelListeningToRecordAdded()
      fn.apply(this, args)
    })
    //#endregion

    //#region internal methods
    function isValidSetRootMsg(msg) {
      if (!msg) return false
      if (msg.metadata.who !== myWho) return false
      const type = msg.metadata.type
      if (!type.startsWith(PREFIX)) return false
      return FeedV1.isFeedRoot(msg, config.keys.id, type)
    }

    function isValidSetMsg(msg) {
      if (!msg) return false
      if (!msg.content) return false
      if (msg.metadata.who !== myWho) return false
      if (!msg.metadata.type.startsWith(PREFIX)) return false
      if (!Array.isArray(msg.content.add)) return false
      if (!Array.isArray(msg.content.del)) return false
      if (!Array.isArray(msg.content.supersedes)) return false
      return true
    }

    function readSet(authorId, subtype) {
      const type = fromSubtype(subtype)
      const rootHash = FeedV1.getFeedRootHash(authorId, type)
      const tangle = peer.db.getTangle(rootHash)
      if (!tangle || tangle.size() === 0) return new Set()
      const msgHashes = tangle.topoSort()
      const set = new Set()
      for (const msgHash of msgHashes) {
        const msg = peer.db.get(msgHash)
        if (isValidSetMsg(msg)) {
          const { add, del } = msg.content
          for (const value of add) set.add(value)
          for (const value of del) set.delete(value)
        }
      }
      return set
    }

    function learnSetRoot(hash, msg) {
      const { type } = msg.metadata
      const subtype = toSubtype(type)
      const tangle = tangles.get(subtype) ?? new FeedV1.Tangle(hash)
      tangle.add(hash, msg)
      tangles.set(subtype, tangle)
    }

    function learnSetUpdate(hash, msg) {
      const { who, type } = msg.metadata
      const rootHash = FeedV1.getFeedRootHash(who, type)
      const subtype = toSubtype(type)
      const tangle = tangles.get(subtype) ?? new FeedV1.Tangle(rootHash)
      tangle.add(hash, msg)
      tangles.set(subtype, tangle)
      const addOrRemove = [].concat(msg.content.add, msg.content.del)
      for (const item of addOrRemove) {
        const existing = itemRoots.get(subtype, item)
        if (!existing || existing.size === 0) {
          itemRoots.add(subtype, item, hash)
        } else {
          for (const existingHash of existing) {
            if (tangle.precedes(existingHash, hash)) {
              itemRoots.del(subtype, item, existingHash)
              itemRoots.add(subtype, item, hash)
            } else {
              itemRoots.add(subtype, item, hash)
            }
          }
        }
      }
    }

    function maybeLearnAboutSet(hash, msg) {
      if (msg.metadata.who !== myWho) return
      if (isValidSetRootMsg(msg)) {
        learnSetRoot(hash, msg)
        return
      }
      if (isValidSetMsg(msg)) {
        learnSetUpdate(hash, msg)
        return
      }
    }

    function loaded(cb) {
      if (cb === void 0) return loadPromise
      else loadPromise.then(() => cb(null), cb)
    }

    function _squeezePotential(subtype) {
      // TODO: improve this so that the squeezePotential is the size of the
      // tangle suffix built as a slice from the fieldRoots
      const rootHash = FeedV1.getFeedRootHash(myWho, fromSubtype(subtype))
      const tangle = peer.db.getTangle(rootHash)
      const maxDepth = tangle.getMaxDepth()
      const currentItemRoots = itemRoots.get(subtype)
      let minDepth = Infinity
      for (const item in currentItemRoots) {
        for (const msgHash of currentItemRoots[item]) {
          const depth = tangle.getDepth(msgHash)
          if (depth < minDepth) minDepth = depth
        }
      }
      return maxDepth - minDepth
    }
    //#endregion

    //#region public methods
    function add(authorId, subtype, value, cb) {
      const who = FeedV1.stripAuthor(authorId)
      // prettier-ignore
      if (who !== myWho) return cb(new Error(`Cannot add to another user's Set (${authorId}/${subtype})`))

      loaded(() => {
        const currentSet = readSet(authorId, subtype)
        if (currentSet.has(value)) return cb(null, false)
        const type = fromSubtype(subtype)

        // Populate supersedes
        const supersedes = []
        const toDeleteFromItemRoots = new Map()
        const currentItemRoots = itemRoots.get(subtype)
        for (const item in currentItemRoots) {
          // If we are re-adding this item, OR if this item has been deleted,
          // then we should update roots
          if (item === value || !currentSet.has(item)) {
            supersedes.push(...currentItemRoots[item])
            for (const msgHash of currentItemRoots[item]) {
              toDeleteFromItemRoots.set(msgHash, item)
            }
          }
        }

        const content = { add: [value], del: [], supersedes }
        peer.db.create({ type, content }, (err) => {
          // prettier-ignore
          if (err) return cb(new Error(`Failed to create msg when adding to Set (${authorId}/${subtype})`, { cause: err }))
          for (const [msgHash, item] of toDeleteFromItemRoots) {
            itemRoots.del(subtype, item, msgHash)
          }
          cb(null, true)
        })
      })
    }

    function del(authorId, subtype, value, cb) {
      const who = FeedV1.stripAuthor(authorId)
      // prettier-ignore
      if (who !== myWho) return cb(new Error(`Cannot delete from another user's Set (${authorId}/${subtype})`))

      loaded(() => {
        const currentSet = readSet(authorId, subtype)
        if (!currentSet.has(value)) return cb(null, false)
        const type = fromSubtype(subtype)

        // Populate supersedes
        const supersedes = []
        const currentItemRoots = itemRoots.get(subtype)
        for (const item in currentItemRoots) {
          if (item === value || !currentSet.has(item)) {
            supersedes.push(...currentItemRoots[item])
          }
        }

        const content = { add: [], del: [value], supersedes }
        peer.db.create({ type, content }, (err) => {
          // prettier-ignore
          if (err) return cb(new Error(`Failed to create msg when deleting from Set (${authorId}/${subtype})`, { cause: err }))
          cb(null, true)
        })
      })
    }

    function has(authorId, subtype, value) {
      const set = readSet(authorId, subtype)
      return set.has(value)
    }

    function values(authorId, subtype) {
      const set = readSet(authorId, subtype)
      return [...set]
    }

    function getItemRoots(authorId, subtype) {
      const who = FeedV1.stripAuthor(authorId)
      // prettier-ignore
      if (who !== myWho) return cb(new Error(`Cannot getItemRoots of another user's Set. (${authorId}/${subtype})`))
      return itemRoots.get(subtype)
    }

    function squeeze(authorId, subtype, cb) {
      const who = FeedV1.stripAuthor(authorId)
      // prettier-ignore
      if (who !== myWho) return cb(new Error(`Cannot squeeze another user's Set (${authorId}/${subtype})`))

      const potential = _squeezePotential(subtype)
      if (potential < 1) return cb(null, false)

      loaded(() => {
        const type = fromSubtype(subtype)
        const currentSet = readSet(authorId, subtype)

        const supersedes = []
        const currentItemRoots = itemRoots.get(subtype)
        for (const item in currentItemRoots) {
          supersedes.push(...currentItemRoots[item])
        }

        const content = { add: [...currentSet], del: [], supersedes }
        peer.db.create({ type, content }, (err) => {
          // prettier-ignore
          if (err) return cb(new Error(`Failed to create msg when squeezing Set (${authorId}/${subtype})`, { cause: err }))
          cb(null, true)
        })
      })
    }
    //#endregion

    return {
      add,
      del,
      has,
      values,
      getItemRoots,
      squeeze,

      _squeezePotential,
    }
  },
}
