// @ts-ignore
const Obz = require('obz')
const MsgV4 = require('ppppp-db/msg-v4')

const PREFIX = 'set_v1__'

/**
 * @typedef {ReturnType<import('ppppp-db').init>} PPPPPDB
 * @typedef {import('ppppp-db').RecPresent} RecPresent
 * @typedef {{
 *   hook: (
 *     cb: (
 *       this: any,
 *       fn: (this: any, ...a: Array<any>) => any,
 *       args: Array<any>
 *     ) => void
 *   ) => void
 * }} ClosableHook
 * @typedef {string} Subdomain
 * @typedef {string} MsgID
 * @typedef {`${Subdomain}/${string}`} SubdomainItem
 * @typedef {{
 *   add: Array<string>,
 *   del: Array<string>,
 *   supersedes: Array<MsgID>,
 * }} SetMsgData
 * @typedef {{
 *   set: (ev: { event: 'add' | 'del', subdomain: string, value: string }) => void
 * }} ObzType
 * @typedef {{
 *   set?: {
 *     ghostSpan?: number
 *   }
 * }} Config
 */

/**
 * @template [T = any]
 * @typedef {import('ppppp-db/msg-v4').Msg<T>} Msg<T>
 */

/**
 * @template T
 * @typedef {T extends void ?
 *   (...args: [Error] | []) => void :
 *   (...args: [Error] | [null, T]) => void
 * } CB
 */

/**
 * @param {string} domain
 * @returns {Subdomain}
 */
function toSubdomain(domain) {
  return domain.slice(PREFIX.length)
}

/**
 * @param {Subdomain} subdomain
 * @returns {string}
 */
function fromSubdomain(subdomain) {
  return PREFIX + subdomain
}

/**
 * @param {unknown} check
 * @param {string} message
 * @returns {asserts check}
 */
function assert(check, message) {
  if (!check) throw new Error(message)
}

/**
 * @param {{ db: PPPPPDB, close: ClosableHook }} peer
 * @param {Config} config
 */
function initSet(peer, config) {
  let ghostSpan = config.set?.ghostSpan ?? 32
  if (ghostSpan < 1) throw new Error('config.set.ghostSpan must be >= 0')

  //#region state
  let loadedAccountID = /** @type {string | null} */ (null)
  let loadPromise = /** @type {Promise<void> | null} */ (null)
  let cancelOnRecordAdded = /** @type {CallableFunction | null} */ (null)
  const watch = /**@type {ObzType}*/ (Obz())
  const tangles = /** @type {Map<Subdomain, MsgV4.Tangle>} */ (new Map())

  const itemRoots = {
    _map: /** @type {Map<SubdomainItem, Set<MsgID>>} */ (new Map()),
    /**
     * @param {string} subdomain
     * @param {string} item
     * @returns {SubdomainItem}
     */
    _getKey(subdomain, item) {
      return `${subdomain}/${item}`
    },
    /**
     * @param {string} subdomain
     * @returns {{[item in string]: Array<MsgID>}}
     */
    getAll(subdomain) {
      const out = /** @type {{[item in string]: Array<MsgID>}} */ ({})
      for (const [key, value] of this._map.entries()) {
        if (key.startsWith(subdomain + '/')) {
          const item = key.slice(subdomain.length + 1)
          out[item] = [...value]
        }
      }
      return out
    },
    /**
     * @param {string} subdomain
     * @param {string} item
     * @returns {Set<MsgID> | undefined}
     */
    get(subdomain, item) {
      const key = this._getKey(subdomain, item)
      return this._map.get(key)
    },
    /**
     * @param {string} subdomain
     * @param {string} item
     * @param {string} msgID
     */
    add(subdomain, item, msgID) {
      const key = this._getKey(subdomain, item)
      const set = this._map.get(key) ?? new Set()
      set.add(msgID)
      return this._map.set(key, set)
    },
    /**
     * @param {string} subdomain
     * @param {string} item
     * @param {string} msgID
     */
    del(subdomain, item, msgID) {
      const key = this._getKey(subdomain, item)
      const set = this._map.get(key)
      if (!set) return false
      set.delete(msgID)
      if (set.size === 0) this._map.delete(key)
      return true
    },
    toString() {
      return this._map
    },
  }
  //#endregion

  //#region active processes
  peer.close.hook(function (fn, args) {
    cancelOnRecordAdded?.()
    fn.apply(this, args)
  })
  //#endregion

  //#region internal methods
  /**
   * @private
   * @param {Msg | null | undefined} msg
   * @returns {msg is Msg}
   */
  function isValidSetMoot(msg) {
    if (!msg) return false
    if (msg.metadata.account !== loadedAccountID) return false
    const domain = msg.metadata.domain
    if (!domain.startsWith(PREFIX)) return false
    return MsgV4.isMoot(msg, loadedAccountID, domain)
  }

  /**
   * @private
   * @param {Msg | null | undefined} msg
   * @returns {msg is Msg<SetMsgData>}
   */
  function isValidSetMsg(msg) {
    if (!msg) return false
    if (!msg.data) return false
    if (msg.metadata.account !== loadedAccountID) return false
    if (!msg.metadata.domain.startsWith(PREFIX)) return false
    if (!Array.isArray(msg.data.add)) return false
    if (!Array.isArray(msg.data.del)) return false
    if (!Array.isArray(msg.data.supersedes)) return false
    return true
  }

  /**
   * @param {string} id
   * @param {string} subdomain
   */
  function readSet(id, subdomain) {
    const domain = fromSubdomain(subdomain)
    const mootID = MsgV4.getMootID(id, domain)
    const tangle = peer.db.getTangle(mootID)
    if (!tangle || tangle.size === 0) return new Set()
    const msgIDs = tangle.topoSort()
    const set = new Set()
    for (const msgID of msgIDs) {
      const msg = peer.db.get(msgID)
      if (isValidSetMsg(msg)) {
        const { add, del } = msg.data
        for (const value of add) set.add(value)
        for (const value of del) set.delete(value)
      }
    }
    return set
  }

  /**
   * @param {string} mootID
   * @param {Msg} moot
   */
  function learnSetMoot(mootID, moot) {
    const { domain } = moot.metadata
    const subdomain = toSubdomain(domain)
    const tangle = tangles.get(subdomain) ?? new MsgV4.Tangle(mootID)
    tangle.add(mootID, moot)
    tangles.set(subdomain, tangle)
  }

  /**
   * @param {string} msgID
   * @param {Msg<SetMsgData>} msg
   */
  function learnSetUpdate(msgID, msg) {
    const { account, domain } = msg.metadata
    const mootID = MsgV4.getMootID(account, domain)
    const subdomain = toSubdomain(domain)
    const tangle = tangles.get(subdomain) ?? new MsgV4.Tangle(mootID)
    tangle.add(msgID, msg)
    tangles.set(subdomain, tangle)
    const addOrDel = msg.data.add.concat(msg.data.del)
    for (const item of addOrDel) {
      const existing = itemRoots.get(subdomain, item)
      if (!existing || existing.size === 0) {
        itemRoots.add(subdomain, item, msgID)
      } else {
        for (const existingID of existing) {
          if (tangle.precedes(existingID, msgID)) {
            itemRoots.del(subdomain, item, existingID)
            itemRoots.add(subdomain, item, msgID)
          } else {
            itemRoots.add(subdomain, item, msgID)
          }
        }
      }
    }
  }

  /**
   * @param {string} msgID
   * @param {Msg} msg
   */
  function maybeLearnAboutSet(msgID, msg) {
    if (msg.metadata.account !== loadedAccountID) return
    if (isValidSetMoot(msg)) {
      learnSetMoot(msgID, msg)
      return
    }
    if (isValidSetMsg(msg)) {
      learnSetUpdate(msgID, msg)
      return
    }
  }

  /**
   * @private
   * @param {CB<void>} cb
   */
  function loaded(cb) {
    if (cb === void 0) return loadPromise
    else loadPromise?.then(() => cb(), cb)
  }

  /**
   * @param {string} subdomain
   */
  function _squeezePotential(subdomain) {
    // prettier-ignore
    if (!loadedAccountID) throw new Error('Cannot squeeze potential before loading')
    // TODO: improve this so that the squeezePotential is the size of the
    // tangle suffix built as a slice from the fieldRoots
    const mootID = MsgV4.getMootID(loadedAccountID, fromSubdomain(subdomain))
    const tangle = peer.db.getTangle(mootID)
    const maxDepth = tangle.maxDepth
    const currentItemRoots = itemRoots.getAll(subdomain)
    let minDepth = Infinity
    for (const item in currentItemRoots) {
      for (const msgID of currentItemRoots[item]) {
        const depth = tangle.getDepth(msgID)
        if (depth < minDepth) minDepth = depth
      }
    }
    return maxDepth - minDepth
  }
  //#endregion

  //#region public methods
  /**
   * @param {string} accountID
   * @param {CB<void>} cb
   */
  function load(accountID, cb) {
    if (accountID === loadedAccountID) {
      loaded(cb)
      return
    }
    if (loadedAccountID !== null) {
      // prettier-ignore
      cb(new Error(`Cannot load Set for account "${accountID}" because Set for account "${loadedAccountID}" is already loaded`))
      return
    }
    loadedAccountID = accountID
    loadPromise = new Promise((resolve, reject) => {
      // microtask is needed to ensure that loadPromise is assigned BEFORE this
      // body is executed (which in turn does inversion of control when `cb` or
      // `resolve` is called)
      queueMicrotask(() => {
        for (const rec of peer.db.records()) {
          if (!rec.msg) continue
          maybeLearnAboutSet(rec.id, rec.msg)
        }
        cancelOnRecordAdded = peer.db.onRecordAdded(
          (/** @type {RecPresent} */ rec) => {
            try {
              maybeLearnAboutSet(rec.id, rec.msg)
            } catch (err) {
              console.error(err)
            }
          }
        )
        resolve()
        cb()
      })
    })
  }

  /**
   * @param {string} subdomain
   * @param {string} value
   * @param {CB<boolean>} cb
   */
  function add(subdomain, value, cb) {
    // TODO this error needs to be put into the `cb`, not thrown
    assert(!!loadedAccountID, 'Cannot add to Set before loading')
    // prettier-ignore
    assert(typeof cb === 'function', 'add() does not accept an accountID in the 3rd argument, must be callback instead')

    loaded(() => {
      // TODO this error needs to be put into the `cb`, not thrown
      assert(!!loadedAccountID, 'Cannot add to Set before loading')
      const currentSet = readSet(loadedAccountID, subdomain)
      if (currentSet.has(value)) return cb(null, false)
      const domain = fromSubdomain(subdomain)

      // Populate supersedes
      const supersedes = []
      const toDeleteFromItemRoots = new Map()
      const currentItemRoots = itemRoots.getAll(subdomain)
      for (const item in currentItemRoots) {
        // If we are re-adding this item, OR if this item has been deleted,
        // then we should update roots
        if (item === value || !currentSet.has(item)) {
          supersedes.push(...currentItemRoots[item])
          for (const msgID of currentItemRoots[item]) {
            toDeleteFromItemRoots.set(msgID, item)
          }
        }
      }

      const data = { add: [value], del: [], supersedes }
      peer.db.feed.publish(
        { account: loadedAccountID, domain, data },
        (err, rec) => {
          // prettier-ignore
          if (err) return cb(new Error(`Failed to create msg when adding to Set "${subdomain}"`, { cause: err }))
          for (const [msgID, item] of toDeleteFromItemRoots) {
            itemRoots.del(subdomain, item, msgID)
          }
          // @ts-ignore
          cb(null, true)
          watch.set({ event: 'add', subdomain, value })
        }
      )
    })
  }

  /**
   * @param {string} subdomain
   * @param {string} value
   * @param {CB<boolean>} cb
   */
  function del(subdomain, value, cb) {
    // TODO this error needs to be put into the `cb`, not thrown
    assert(!!loadedAccountID, 'Cannot add to Set before loading')
    // prettier-ignore
    assert(typeof cb === 'function', 'del() does not accept an accountID in the 3rd argument, must be callback instead')

    loaded(() => {
      // TODO this error needs to be put into the `cb`, not thrown
      assert(!!loadedAccountID, 'Cannot add to Set before loading')
      const currentSet = readSet(loadedAccountID, subdomain)
      if (!currentSet.has(value)) return cb(null, false)
      const domain = fromSubdomain(subdomain)

      // Populate supersedes
      const supersedes = []
      const currentItemRoots = itemRoots.getAll(subdomain)
      for (const item in currentItemRoots) {
        if (item === value || !currentSet.has(item)) {
          supersedes.push(...currentItemRoots[item])
        }
      }

      const data = { add: [], del: [value], supersedes }
      peer.db.feed.publish(
        { account: loadedAccountID, domain, data },
        (err, rec) => {
          // prettier-ignore
          if (err) return cb(new Error(`Failed to create msg when deleting from Set "${subdomain}"`, { cause: err }))
          // @ts-ignore
          cb(null, true)
          watch.set({ event: 'del', subdomain, value })
        }
      )
    })
  }

  /**
   * @param {string} subdomain
   * @param {any} value
   * @param {string=} id
   */
  function has(subdomain, value, id) {
    assert(!!loadedAccountID, 'Cannot call has() before loading')
    const set = readSet(id ?? loadedAccountID, subdomain)
    return set.has(value)
  }

  /**
   * @param {string} subdomain
   * @param {string=} id
   */
  function values(subdomain, id) {
    assert(!!loadedAccountID, 'Cannot call values() before loading')
    const set = readSet(id ?? loadedAccountID, subdomain)
    return [...set]
  }

  /**
   * @public
   * @param {string} tangleID
   * @returns {number}
   */
  function minGhostDepth(tangleID) {
    return Math.max(0, minRequiredDepth(tangleID) - ghostSpan)
  }

  /**
   * @public
   * @param {string} tangleID
   * @returns {number}
   */
  function minRequiredDepth(tangleID) {
    const tangle = peer.db.getTangle(tangleID)

    // prettier-ignore
    if (!tangle || tangle.size === 0) throw new Error(`Tangle "${tangleID}" is locally unknown`)
    // prettier-ignore
    if (!MsgV4.isMoot(tangle.root)) throw new Error(`Tangle "${tangleID}" is not a moot`)
    const domain = tangle.root.metadata.domain
    // prettier-ignore
    if (!domain.startsWith(PREFIX)) throw new Error(`Tangle "${tangleID}" is not a Set moot`)

    // Discover item roots
    const itemRoots = new Set()
    const msgIDs = tangle.topoSort()
    for (const msgID of msgIDs) {
      const msg = peer.db.get(msgID)
      if (!msg?.data) continue
      for (const supersededMsgID of msg.data.supersedes) {
        itemRoots.delete(supersededMsgID)
      }
      itemRoots.add(msgID)
    }

    // Get minimum depth of all item roots
    let minDepth = Infinity
    for (const msgID of itemRoots) {
      const depth = tangle.getDepth(msgID)
      if (depth < minDepth) minDepth = depth
    }

    return minDepth
  }

  /**
   * @public
   * @param {string} subdomain
   * @returns {string}
   */
  function getFeedID(subdomain) {
    assert(!!loadedAccountID, 'Cannot getFeedID() before loading')
    const domain = fromSubdomain(subdomain)
    return MsgV4.getMootID(loadedAccountID, domain)
  }

  /**
   * @public
   * @param {MsgID} ghostableMsgID
   * @param {MsgID} tangleID
   */
  function isGhostable(ghostableMsgID, tangleID) {
    if (ghostableMsgID === tangleID) return false

    const msg = peer.db.get(ghostableMsgID)

    // prettier-ignore
    if (!msg) throw new Error(`isGhostable() msgID "${ghostableMsgID}" does not exist in the database`)

    const minItemRootDepth = minRequiredDepth(tangleID)
    const minGhostDepth = minItemRootDepth - ghostSpan
    const msgDepth = msg.metadata.tangles[tangleID].depth
    if (minGhostDepth <= msgDepth && msgDepth < minItemRootDepth) return true
    return false
  }

  /**
   * @returns {number}
   */
  function getGhostSpan() {
    return ghostSpan
  }

  /**
   * @param {number} span
   * @returns {void}
   */
  function setGhostSpan(span) {
    if (span < 1) throw new Error('ghostSpan must be >= 0')
    ghostSpan = span
  }

  /**
   * @param {any} subdomain
   */
  function _getItemRoots(subdomain) {
    if (!loadedAccountID) throw new Error(`Cannot getItemRoots before loading`)
    return itemRoots.getAll(subdomain)
  }

  /**
   * @param {string} subdomain
   * @param {CB<boolean>} cb
   */
  function squeeze(subdomain, cb) {
    // TODO this error needs to be put into the `cb`, not thrown
    assert(!!loadedAccountID, 'Cannot squeeze Set before loading')

    const potential = _squeezePotential(subdomain)
    if (potential < 1) return cb(null, false)

    loaded(() => {
      // TODO this error needs to be put into the `cb`, not thrown
      assert(!!loadedAccountID, 'Cannot squeeze Set before loading')
      const domain = fromSubdomain(subdomain)
      const currentSet = readSet(loadedAccountID, subdomain)

      const supersedes = []
      const currentItemRoots = itemRoots.getAll(subdomain)
      for (const item in currentItemRoots) {
        supersedes.push(...currentItemRoots[item])
      }

      const data = { add: [...currentSet], del: [], supersedes }
      peer.db.feed.publish(
        { account: loadedAccountID, domain, data },
        (err, rec) => {
          // prettier-ignore
          if (err) return cb(new Error(`Failed to create msg when squeezing Set "${subdomain}"`, { cause: err }))
          // @ts-ignore
          cb(null, true)
        }
      )
    })
  }
  //#endregion

  return {
    load,
    add,
    del,
    has,
    values,
    watch,
    getDomain: fromSubdomain,
    getFeedID,
    isGhostable,
    getGhostSpan,
    setGhostSpan,
    minGhostDepth,
    minRequiredDepth,
    squeeze,

    _getItemRoots,
    _squeezePotential,
  }
}

exports.name = 'set'
exports.needs = ['db']
exports.init = initSet
