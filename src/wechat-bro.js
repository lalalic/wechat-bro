/**
 * WeChat Web Bridge — Event-Driven Edition
 *
 * Hooks into AngularJS internals to detect login/logout/QR events reactively
 * (no polling). Communicates with main process via window.sendToPuppeteer().
 *
 * Event detection strategy:
 *   QR barcode:  $watch on loginScope.qrcodeUrl + MutationObserver fallback
 *   Login:       Object.defineProperty trap on MMCgi.isLogin + $rootScope events
 *   Logout:      Same property trap + monkey-patch loginFactory.loginout()
 */

;(function () {
  'use strict'

  if (window.WechatyBro && window.WechatyBro.vars && window.WechatyBro.vars.initState) {
    console.log('[WechatyBro] Already initialized, skipping')
    return
  }

  var retObj = { code: 0, message: '' }

  // === Cleanup registry — all watchers/observers register here ===
  var _cleanups = []
  function addCleanup(fn) { _cleanups.push(fn) }
  function runCleanups() {
    _cleanups.forEach(function (fn) { try { fn() } catch (e) {} })
    _cleanups.length = 0
  }

  function log() {
    console.log.apply(console, ['[WechatyBro]'].concat(Array.from(arguments)))
  }

  function angularIsReady() {
    return !!(
      typeof angular !== 'undefined' &&
      angular.element &&
      angular.element('body') &&
      angular.element(document).injector()
    )
  }

  function toLoginUrl(qrUrl) {
    if (!qrUrl || typeof qrUrl !== 'string') {
      return null
    }

    return qrUrl.replace('/qrcode/', '/l/')
  }

  function getSkey() {
    try {
      var injector = angular.element(document).injector()
      var accountFactory = injector.get('accountFactory')
      if (accountFactory.getSkey) return accountFactory.getSkey()
      if (window.MMCgi && window.MMCgi.skey) return window.MMCgi.skey
      return ''
    } catch (e) {
      return ''
    }
  }

  function getUserName() {
    try {
      var injector = angular.element(document).injector()
      var accountFactory = injector.get('accountFactory')
      return accountFactory.getUserName()
    } catch (e) {
      return null
    }
  }

  function asContact(contact, isForList=false){
    const empty=value=>value===0 || value===false || value==="" || (Array.isArray(value) && value.length===0)
    const base={
      id: WechatyBro._resolveId(contact.UserName),
      name: contact.getDisplayName?.(),
      isRoomContact: contact.isRoomContact?.(),
      isFileHelper: contact.isFileHelper?.(),
      isContact: contact.isContact?.(),
    }

    if(isForList){
      return base
    }

    const result = Object.keys(contact).reduce(function (acc, key) {
      if(typeof(contact[key])=="function"){ 
        try {
          if(key.startsWith("get")) {
            let value = contact[key]()
            if(!empty(value)){
              let propName = key.slice(3)
              acc[propName] = value
            }
          }else if(key.startsWith("is")) {
            if(!!contact[key]()){
              acc[key] = true
            }
          }else if(key.startsWith("has")) {
            acc[key]= !!contact[key]()
          }
        } catch (e) {
          // Skip methods that throw (e.g. isInChatroom during init).
          // A single throwing method should not crash the whole contact.
        }
        return acc
      }else if(empty(contact[key])){
        
      }else{
        acc[key] = contact[key]
      }
      return acc
    }, base)

    if(result.MemberList){
      result.MemberList = result.MemberList.map(contact=>({
        id: WechatyBro._resolveId(contact.UserName),
        name: cleanName(contact.DisplayName),
      }))
    }

    if(!WechatyBro.requireThumb){
      delete result.HeadImgUrl
    }
    return result
  }

  /** Convert emoji <img> tags to Unicode chars, then strip remaining HTML */
  function cleanName(s) {
    return (s || '')
      .replace(/<img[^>]*class="emoji emoji([0-9a-f]+)"[^>]*>/gi, function (_, code) {
        try { return String.fromCodePoint(parseInt(code, 16)) } catch (e) { return '' }
      })
      .replace(/<[^>]+>/g, '').trim()
  }

  /** Convert a-z/A-Z/0-9 to Unicode mathematical bold */
  function _toBold(t) {
    return t.replace(/[A-Za-z0-9]/g, function (c) {
      var p = c.charCodeAt(0)
      if (p >= 0x41 && p <= 0x5A) return String.fromCodePoint(p - 0x41 + 0x1D5D4)
      if (p >= 0x61 && p <= 0x7A) return String.fromCodePoint(p - 0x61 + 0x1D5EE)
      return String.fromCodePoint(p - 0x30 + 0x1D7EC)
    })
  }
  function _toItalic(t) {
    return t.replace(/[A-Za-z]/g, function (c) {
      var p = c.charCodeAt(0)
      if (p >= 0x41 && p <= 0x5A) return String.fromCodePoint(p - 0x41 + 0x1D608)
      return String.fromCodePoint(p - 0x61 + 0x1D622)
    })
  }
  function _toBoldItalic(t) {
    return t.replace(/[A-Za-z]/g, function (c) {
      var p = c.charCodeAt(0)
      if (p >= 0x41 && p <= 0x5A) return String.fromCodePoint(p - 0x41 + 0x1D63C)
      return String.fromCodePoint(p - 0x61 + 0x1D656)
    })
  }
  function _toMono(t) {
    return t.replace(/[A-Za-z0-9]/g, function (c) {
      var p = c.charCodeAt(0)
      if (p >= 0x41 && p <= 0x5A) return String.fromCodePoint(p - 0x41 + 0x1D670)
      if (p >= 0x61 && p <= 0x7A) return String.fromCodePoint(p - 0x61 + 0x1D68A)
      return String.fromCodePoint(p - 0x30 + 0x1D7F6)
    })
  }

  /** Hidden AI watermark: zero-width chars invisible to humans but detectable programmatically */
  var AI_WATERMARK = '\u200B\u200C\u200B\u200C'

  /** Convert markdown formatting to Unicode-styled plain text */
  function mdToUnicode(md) {
    var r = md
    r = r.replace(/```([^`]+)```/g, function (_, c) { return _toMono(c.trim()) })
    r = r.replace(/`([^`]+)`/g, function (_, c) { return _toMono(c) })
    r = r.replace(/\*\*\*(.+?)\*\*\*/g, function (_, t) { return _toBoldItalic(t) })
    r = r.replace(/\*\*(.+?)\*\*/g, function (_, t) { return _toBold(t) })
    r = r.replace(/\*(.+?)\*/g, function (_, t) { return _toItalic(t) })
    r = r.replace(/^### (.+)$/gm, function (_, t) { return '  ' + _toBold(t) })
    r = r.replace(/^## (.+)$/gm, function (_, t) { return _toBold(t) })
    r = r.replace(/^# (.+)$/gm, function (_, t) { return _toBold(t) + '\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501' })
    r = r.replace(/^[-*] (.+)$/gm, '  \u2022 $1')
    r = r.replace(/^(\d+)\. (.+)$/gm, function (_, n, t) {
      var num = parseInt(n, 10)
      // Use circled numbers ①-⑳ for 1-20, fall back to bold number
      var prefix = (num >= 1 && num <= 20) ? String.fromCharCode(0x2460 + num - 1) : _toBold(n + '.')
      return '  ' + prefix + ' ' + t
    })
    r = r.replace(/^---+$/gm, '\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501')
    r = r.replace(/^> (.+)$/gm, '\u2503 $1')
    r = r.replace(/~~(.+?)~~/g, function (_, t) {
      return t.split('').map(function (c) { return c + '\u0336' }).join('')
    })
    return r
  }

  function buildScanPayload(code, url, extra) {
    var payload = {
      code: code,
      url: url,
      loginUrl: toLoginUrl(url),
    }

    if (extra && typeof extra === 'object') {
      Object.keys(extra).forEach(function (key) {
        payload[key] = extra[key]
      })
    }

    return payload
  }

  // ==========================================================================
  // Core bridge object
  // ==========================================================================
  window.WechatyBro = {
    vars: {
      initState: false,
      heartBeatTimmer: null,
      scanCode: null,
      scanUrl: null,
      loginState: false,
      contactsReady: false,
      loginConfirmTimer: null,
      lastLoginConfirmClickAt: 0,
    },
    glue: {},

    // Contact ID maps: pyId ↔ UserName
    _idToUserName: {},   // 'licheng' → '@hash...'
    _userNameToId: {},   // '@hash...' → 'licheng'

    // Sent message tracking for AI detection (MsgId → timestamp)
    _sentMsgIds: {},
    _SENT_MSG_TTL: 60 * 60 * 1000,  // 1 hour
    _SENT_MSG_MAX: 1000,

    _trackSentMsg: function (msg) {
      var id = msg && (msg.MsgId || msg.ClientMsgId || msg.MsgSvrID)
      if (!id) return
      WechatyBro._sentMsgIds[id] = Date.now()
      // Purge if over limit
      var keys = Object.keys(WechatyBro._sentMsgIds)
      if (keys.length > WechatyBro._SENT_MSG_MAX) {
        var cutoff = Date.now() - WechatyBro._SENT_MSG_TTL
        keys.forEach(function (k) {
          if (WechatyBro._sentMsgIds[k] < cutoff) delete WechatyBro._sentMsgIds[k]
        })
      }
    },

    _isSentByUs: function (msgId) {
      if (!msgId) return false
      return !!WechatyBro._sentMsgIds[msgId]
    },

    // Dedup: track seen MsgIds to suppress replayed messages (e.g. after relogin)
    _seenMsgIds: {},
    _SEEN_MSG_MAX: 2000,
    _SEEN_MSG_TTL: 2 * 60 * 60 * 1000,  // 2 hours

    // Cross-login replay suppression: highest CreateTime seen so far.
    // Survives process restarts via wx_last_msg_time HTTP cookie.
    _lastMsgTime: 0,

    /** Read wx_last_msg_time from document.cookie and update _lastMsgTime.
     *  Called on init and after page reload (cookie is set by the bridge). */
    _loadLastMsgTime: function () {
      try {
        var m = document.cookie.match(/\bwx_last_msg_time=(\d+)/)
        if (m) {
          WechatyBro._lastMsgTime = parseInt(m[1], 10) || 0
          log('Loaded lastMsgTime=' + WechatyBro._lastMsgTime + ' from cookie')
        }
      } catch (e) { /* ignore */ }
    },

    /** Persist _lastMsgTime back to document.cookie so the bridge picks it up
     *  on saveCookies() and it survives process restarts. Debounced to avoid
     *  hammering document.cookie on every message. */
    _saveLastMsgTime: function () {
      if (WechatyBro._saveLastMsgTimer) clearTimeout(WechatyBro._saveLastMsgTimer)
      WechatyBro._saveLastMsgTimer = setTimeout(function () {
        WechatyBro._saveLastMsgTimer = null
        var t = WechatyBro._lastMsgTime
        if (t <= 0) return
        try {
          document.cookie = 'wx_last_msg_time=' + t +
            '; path=/; max-age=86400; SameSite=Lax'
        } catch (e) { /* ignore */ }
      }, 2000)  // debounce 2s
    },

    /** Build stable ID maps from current contacts. Called on contacts-ready. */
    _buildIdMaps: function () {
      WechatyBro._idToUserName = {}
      WechatyBro._userNameToId = {}
      try {
        var contactFactory = WechatyBro.glue.contactFactory
        if (!contactFactory) return
        var all = contactFactory.getAllContacts()
        var contacts = Object.values(all)

        // First pass: collect preferred pinyin per contact
        var pyGroups = {}  // pyId → [UserName, ...]
        contacts.forEach(function (c) {
          if (!c.UserName) return
          var py = c.PYQuanPin
          if (!pyGroups[py]) pyGroups[py] = []
          pyGroups[py].push(c.UserName)
        })

        // Second pass: assign IDs with dedup suffix for collisions
        Object.keys(pyGroups).forEach(function (py) {
          var userNames = pyGroups[py]
          if (userNames.length === 1) {
            WechatyBro._idToUserName[py] = userNames[0]
            WechatyBro._userNameToId[userNames[0]] = py
          } else {
            userNames.forEach(function (un, i) {
              var id = `${py}_${all[un].AttrStatus}`
              WechatyBro._idToUserName[id] = un
              WechatyBro._userNameToId[un] = id
            })
          }
        })

        log('ID maps built:', Object.keys(WechatyBro._idToUserName).length, 'contacts')
      } catch (e) {
        log('_buildIdMaps error:', e.message)
      }
    },

    /** Resolve a contact id (pyId or UserName) → UserName */
    _resolveUserName: function (id) {
      if (!id) return null
      // Direct UserName (starts with @ or is a system account)
      if (id.charAt(0) === '@' || id === 'filehelper' || id === 'weixin') return id
      // Look up in ID map
      return WechatyBro._idToUserName[id] || WechatyBro._idToUserName[id.toLowerCase()] || null
    },

    /** Get the stable pyId for a UserName */
    _resolveId: function (userName) {
      if (!userName) return userName
      return WechatyBro._userNameToId[userName] || userName
    },

    emit: function (event, data) {
      log('emit:', event, typeof data === 'object' ? JSON.stringify(data).substring(0, 120) : data)
      if (typeof window.sendToPuppeteer === 'function') {
        window.sendToPuppeteer(event, data)
      }
    },

    angularIsReady: angularIsReady,

    getAccount: function () {
      return this.getContact(getUserName())
    },

    getContact: function (id) {
      try {
        var injector = angular.element(document).injector()
        var contactFactory = injector.get('contactFactory')
        // Resolve id: accept either pyId or UserName
        var userName = WechatyBro._resolveUserName(id) || id
        var contact = contactFactory.getContact(userName)
        if (!contact) return { id: id}
        return asContact(contact)
      } catch (e) {
        return { id: id}
      }
    },

    contactList: function (filter=a=>true) {
      try {
        var injector = angular.element(document).injector()
        var contactFactory = injector.get('contactFactory')
        var accountFactory = injector.get('accountFactory')
        var selfUserName = accountFactory.getUserName() || ''
        var all = contactFactory.getAllContacts()
        return Object.values(all).filter(filter).map(a=>asContact(a, true))
      } catch (e) {
        log('contactList error:', e.message)
        return []
      }
    },

     /**
     * Get members of a group chat (room).
     * Calls getChatRoomMembersContact to populate member details if needed.
     * @param {string} roomId - pyId or UserName of the room (@@...)
     * @returns {Array<{id, name, UserName, NickName, DisplayName}>}
     */
    getRoomMembers: function (roomId) {
      try {
        var injector = angular.element(document).injector()
        var contactFactory = injector.get('contactFactory')
        var userName = WechatyBro._resolveUserName(roomId) || roomId
        var room = contactFactory.getContact(userName)
        if (!room || !room.MemberList) return []

        // Fetch full member details if first member has empty NickName
        if (room.MemberList.length > 0 && !room.MemberList[0].NickName) {
          try { contactFactory.getChatRoomMembersContact(userName) } catch (e) {}
        }

        return room.MemberList.map(function (m) {
          // Look up full contact for stable ID and better names
          var full = contactFactory.getContact(m.UserName)
          return asContact(full || m, true)
        })
      } catch (e) {
        log('getRoomMembers error:', e.message)
        return []
      }
    },

    downloadVoice: function (msgId, callback) {
      try {
        var xhr = new XMLHttpRequest()
        xhr.open('GET', '/cgi-bin/mmwebwx-bin/webwxgetvoice?msgid=' + msgId + '&skey=' + encodeURIComponent(getSkey()), true)
        xhr.responseType = 'arraybuffer'
        xhr.onload = function () {
          if (xhr.status === 200) {
            var bytes = new Uint8Array(xhr.response)
            var binary = ''
            for (var i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i])
            }
            callback(btoa(binary))
          } else {
            log('downloadVoice failed: HTTP ' + xhr.status)
            callback(null)
          }
        }
        xhr.onerror = function () {
          log('downloadVoice error')
          callback(null)
        }
        xhr.send()
      } catch (e) {
        log('downloadVoice exception:', e.message)
        callback(null)
      }
    },

    /** Download an image message as base64.
     *  Uses the webwxgetmsgimg endpoint with type=big for full resolution.
     *  @param {string} msgId - Message ID
     *  @param {function} callback - (base64String|null) */
    downloadImage: function (msgId, callback) {
      try {
        var xhr = new XMLHttpRequest()
        xhr.open('GET', '/cgi-bin/mmwebwx-bin/webwxgetmsgimg?MsgID=' + msgId + '&skey=' + encodeURIComponent(getSkey()) + '&type=big', true)
        xhr.responseType = 'arraybuffer'
        xhr.onload = function () {
          if (xhr.status === 200) {
            var bytes = new Uint8Array(xhr.response)
            var binary = ''
            for (var i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i])
            }
            callback(btoa(binary))
          } else {
            log('downloadImage failed: HTTP ' + xhr.status)
            callback(null)
          }
        }
        xhr.onerror = function () {
          log('downloadImage error')
          callback(null)
        }
        xhr.send()
      } catch (e) {
        log('downloadImage exception:', e.message)
        callback(null)
      }
    },

    /** Get contact thumbnail image as base64. Accepts pyId or UserName. */
    getContactImage: function (id, callback) {
      try {
        var userName = WechatyBro._resolveUserName(id) || id
        var injector = angular.element(document).injector()
        var contactFactory = injector.get('contactFactory')
        var contact = contactFactory.getContact(userName)
        if (!contact || !contact.HeadImgUrl) {
          callback(null)
          return
        }
        var xhr = new XMLHttpRequest()
        xhr.open('GET', contact.HeadImgUrl, true)
        xhr.responseType = 'arraybuffer'
        xhr.onload = function () {
          if (xhr.status === 200) {
            var bytes = new Uint8Array(xhr.response)
            var binary = ''
            for (var i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i])
            }
            callback(btoa(binary))
          } else {
            callback(null)
          }
        }
        xhr.onerror = function () { callback(null) }
        xhr.send()
      } catch (e) {
        log('getContactImage error:', e.message)
        callback(null)
      }
    },

    /** Returns list of supported QQ-style emoji codes for use in text messages.
     *  Usage: send('claire', 'Hello! [Smile][Rose]')  */
    getSupportedEmojis: function () {
      return [
        // Chinese
        '[微笑]','[撇嘴]','[色]','[发呆]','[得意]','[流泪]','[害羞]','[闭嘴]','[睡]','[大哭]',
        '[尴尬]','[发怒]','[调皮]','[呲牙]','[惊讶]','[难过]','[酷]','[冷汗]','[抓狂]','[吐]',
        '[偷笑]','[可爱]','[白眼]','[傲慢]','[饥饿]','[困]','[惊恐]','[流汗]','[憨笑]','[大兵]',
        '[奋斗]','[咒骂]','[疑问]','[嘘]','[晕]','[折磨]','[衰]','[骷髅]','[敲打]','[再见]',
        '[擦汗]','[抠鼻]','[鼓掌]','[糗大了]','[坏笑]','[左哼哼]','[右哼哼]','[哈欠]','[鄙视]','[委屈]',
        '[快哭了]','[阴险]','[亲亲]','[吓]','[可怜]','[菜刀]','[西瓜]','[啤酒]','[篮球]','[乒乓]',
        '[咖啡]','[饭]','[猪头]','[玫瑰]','[凋谢]','[示爱]','[爱心]','[心碎]','[蛋糕]','[闪电]',
        '[炸弹]','[刀]','[足球]','[瓢虫]','[便便]','[月亮]','[太阳]','[礼物]','[拥抱]','[强]',
        '[弱]','[握手]','[胜利]','[抱拳]','[勾引]','[拳头]','[差劲]','[爱你]','[NO]','[OK]',
        '[爱情]','[飞吻]','[跳跳]','[发抖]','[怄火]','[转圈]','[磕头]','[回头]','[跳绳]','[激动]',
        '[献吻]','[左太极]','[右太极]','[嘿哈]','[捂脸]','[奸笑]','[机智]','[皱眉]','[耶]','[红包]','[鸡]',
        // English
        '[Smile]','[Grimace]','[Drool]','[Scowl]','[CoolGuy]','[Sob]','[Shy]','[Silent]','[Sleep]','[Cry]',
        '[Awkward]','[Angry]','[Tongue]','[Grin]','[Surprise]','[Frown]','[Ruthless]','[Blush]','[Scream]','[Puke]',
        '[Chuckle]','[Joyful]','[Slight]','[Smug]','[Hungry]','[Panic]','[Sweat]','[Laugh]','[Commando]','[Determined]',
        '[Scold]','[Shocked]','[Shhh]','[Dizzy]','[Tormented]','[Toasted]','[Skull]','[Hammer]','[Wave]','[Speechless]',
        '[NosePick]','[Clap]','[Shame]','[Trick]','[Yawn]','[Lookdown]','[Wronged]','[Sly]','[Kiss]','[Whimper]',
        '[Cleaver]','[Watermelon]','[Beer]','[PingPong]','[Coffee]','[Rice]','[Pig]','[Rose]','[Wilt]','[Lips]',
        '[Heart]','[BrokenHeart]','[Cake]','[Lightning]','[Bomb]','[Dagger]','[Soccer]','[Ladybug]','[Poop]','[Moon]',
        '[Sun]','[Gift]','[Hug]','[Strong]','[Shake]','[Victory]','[Admire]','[Beckon]','[Fist]','[Pinky]',
        '[Love]','[No]','[OK]','[InLove]','[Blowkiss]','[Waddle]','[Tremble]','[Twirl]','[Kotow]','[Dramatic]',
        '[Jump]','[Surrender]','[Hooray]','[Facepalm]','[Smirk]','[Smart]','[Concerned]','[Packet]','[Chicken]',
      ]
    },

    /**
     * Build an @mention string for use in messages.
     * The result can be concatenated into message text.
     * WeChat uses @DisplayName + thin space (\u2005) as the mention format.
     *
     * Usage: send(roomId, at('alice') + 'check this out')
     *        send(roomId, 'Hey ' + at('alice') + at('bob') + 'look!')
     *
     * @param {string} userId - pyId or UserName of user to mention
     * @param {string} [roomId] - optional room context (for DisplayName lookup)
     * @returns {string} e.g. "@Alice\u2005"
     */
    at: function (userId, roomId) {
      try {
        var injector = angular.element(document).injector()
        var contactFactory = injector.get('contactFactory')
        var memberUserName = WechatyBro._resolveUserName(userId) || userId

        // Always use the full contact's NickName (not MemberList NickName which may be localized)
        var full = contactFactory.getContact(memberUserName)

        // If roomId provided, check for DisplayName first (room-specific alias)
        if (roomId) {
          var roomUN = WechatyBro._resolveUserName(roomId) || roomId
          var room = contactFactory.getContact(roomUN)
          if (room && room.MemberList) {
            if (room.MemberList.length > 0 && !room.MemberList[0].NickName) {
              try { contactFactory.getChatRoomMembersContact(roomUN) } catch (e) {}
            }
            for (var i = 0; i < room.MemberList.length; i++) {
              if (room.MemberList[i].UserName === memberUserName) {
                var dn = cleanName(room.MemberList[i].DisplayName)
                if (dn) return '@' + dn + '\u2005'
                break
              }
            }
          }
        }

        // Use full contact's NickName (NOT RemarkName — it's private)
        var name = cleanName(full && full.NickName) || userId
        return '@' + name + '\u2005'
      } catch (e) {
        log('at error:', e.message)
        return '@' + userId + '\u2005'
      }
    },

    /**
     * Check if a message was sent by AI (has hidden watermark).
     * @param {string|object} msgOrContent - Message content string or message object with Content field
     * @returns {boolean}
     */
    isFromAI: function (msgOrContent) {
      var content = (typeof msgOrContent === 'object' && msgOrContent !== null)
        ? (msgOrContent.Content || msgOrContent.content || '') : (msgOrContent || '')
      return content.indexOf(AI_WATERMARK) !== -1
    },

    /**
     * Simulate an incoming message for testing.
     * Builds processed message data and emits directly (bypasses Angular events).
     * @param {string} from - Contact/room id or UserName
     * @param {string} content - Message text (clean, without sender prefix)
     * @param {string} [sender] - Actual sender id/UserName (for room messages)
     * @param {number} [msgType=1] - WeChat MsgType (1=text, 3=image, etc.)
     * @returns {object} The processed message data
     */
    simulateMessage: function (from, content, sender, msgType) {
      var fromUN = WechatyBro._resolveUserName(from) || from
      var senderUN = sender ? (WechatyBro._resolveUserName(sender) || sender) : null
      var isRoom = fromUN && fromUN.startsWith('@@')

      var data = {
        FromUserName: fromUN,
        ToUserName: getUserName(),
        Content: content,
        MsgType: msgType || 1,
        MsgId: 'sim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        from: WechatyBro.getContact(fromUN),
        to: WechatyBro.getContact(getUserName()),
      }

      // Room messages: resolve sender and parse @mentions
      if (isRoom && senderUN) {
        data.sender = WechatyBro.getContact(senderUN)
      }

      if (isRoom && content) {
        var mentionRe = /@([^\u2005@]+)\u2005/g
        var mentionMatch
        var mentionNames = []
        while ((mentionMatch = mentionRe.exec(content)) !== null) {
          mentionNames.push(mentionMatch[1])
        }
        if (mentionNames.length) {
          try {
            var injector = angular.element(document).injector()
            var contactFactory = injector.get('contactFactory')
            var room = contactFactory.getContact(fromUN)
            var selfUserName = getUserName()
            var selfNickName = ''
            try {
              var selfContact = contactFactory.getContact(selfUserName)
              selfNickName = cleanName(selfContact && selfContact.NickName) || ''
            } catch (e) {}
            data.mentions = []
            data.mentionMe = false
            var members = (room && room.MemberList) || []
            for (var mi = 0; mi < mentionNames.length; mi++) {
              var mName = mentionNames[mi]
              if (selfNickName && mName === selfNickName) {
                data.mentionMe = true
                data.mentions.push(WechatyBro._resolveId(selfUserName) || selfUserName)
                continue
              }
              var found = false
              for (var ri = 0; ri < members.length; ri++) {
                var dn = cleanName(members[ri].DisplayName)
                var nn = cleanName(members[ri].NickName)
                if ((dn && dn === mName) || (nn && nn === mName)) {
                  var mUN = members[ri].UserName
                  if (mUN === selfUserName) data.mentionMe = true
                  data.mentions.push(WechatyBro._resolveId(mUN) || mUN)
                  found = true
                  break
                }
              }
            }
          } catch (e) {
            log('simulateMessage mention parse error:', e.message)
          }
        }
      }

      // Emit directly (bypass Angular — no risk of interfering with WeChat)
      var typeName = MSG_TYPE_NAMES[data.MsgType] || 'unknown'
      WechatyBro.emit('message', data)
      WechatyBro.emit('message:' + typeName, data)
      return data
    },

    send: function (to, content, watermark) {
      try {
        var injector = angular.element(document).injector()
        var chatFactory = injector.get('chatFactory')
        var confFactory = injector.get('confFactory')

        // Resolve to → UserName using ID map
        var userName = WechatyBro._resolveUserName(to) || to

        // Auto-convert markdown to Unicode-styled text
        var styled = mdToUnicode(content)
        // Optionally prepend AI watermark
        if (watermark) styled = AI_WATERMARK + styled

        log('send: resolved ' + to + ' -> ' + userName)
        var m = chatFactory.createMessage({
          ToUserName: userName,
          Content: styled,
          MsgType: confFactory.MSGTYPE_TEXT,
        })
        chatFactory.appendMessage(m)
        chatFactory.sendMessage(m)
        WechatyBro._trackSentMsg(m)
        return true
      } catch (e) {
        log('send error:', e.message)
        return false
      }
    },

    /**
     * Get upload parameters for Node.js-side media upload.
     * Upload must be done from Node.js to avoid CORS with file.wx.qq.com.
     * @param {string} to - pyId or UserName of recipient
     * @returns {object} params needed for upload (url, auth, cookies)
     */
    getUploadParams: function (to) {
      try {
        var userName = WechatyBro._resolveUserName(to) || to
        var selfUserName = getUserName()
        var injector = angular.element(document).injector()
        var accountFactory = injector.get('accountFactory')
        var confFactory = injector.get('confFactory')

        var br = accountFactory.getBaseRequest()
        return {
          uploadUrl: confFactory.API_webwxuploadmedia,
          baseRequest: br.BaseRequest || br,
          passTicket: accountFactory.getPassticket() || '',
          fromUserName: selfUserName,
          toUserName: userName,
          webwxDataTicket: (document.cookie.match(/webwx_data_ticket=([^;]+)/) || [])[1] || '',
          skey: getSkey(),
        }
      } catch (e) {
        log('getUploadParams error:', e.message)
        return null
      }
    },
    _uploadCount: 0,

    /**
     * Send an image using a pre-uploaded MediaId (upload done from Node.js).
     * @param {string} to - pyId or UserName
     * @param {string} mediaId - from webwxuploadmedia response
     * @returns {boolean}
     */
    sendImageWithMediaId: function (to, mediaId) {
      try {
        var injector = angular.element(document).injector()
        var chatFactory = injector.get('chatFactory')
        var confFactory = injector.get('confFactory')
        var userName = WechatyBro._resolveUserName(to) || to

        var m = chatFactory.createMessage({
          ToUserName: userName,
          MsgType: confFactory.MSGTYPE_IMAGE,
          MediaId: mediaId,
          Content: '',
        })
        chatFactory.appendMessage(m)
        chatFactory.sendMessage(m)
        WechatyBro._trackSentMsg(m)
        log('sendImageWithMediaId success to ' + to)
        return true
      } catch (e) {
        log('sendImageWithMediaId error:', e.message)
        return false
      }
    },

    /**
     * Send a file attachment using a pre-uploaded MediaId.
     * @param {string} to - pyId or UserName
     * @param {string} mediaId - from webwxuploadmedia response
     * @param {string} filename - e.g. 'document.pdf'
     * @param {number} fileSize - file size in bytes
     * @returns {boolean}
     */
    sendFileWithMediaId: function (to, mediaId, filename, fileSize) {
      try {
        var injector = angular.element(document).injector()
        var chatFactory = injector.get('chatFactory')
        var confFactory = injector.get('confFactory')
        var userName = WechatyBro._resolveUserName(to) || to

        var m = chatFactory.createMessage({
          ToUserName: userName,
          MsgType: confFactory.MSGTYPE_APP || 49,
          AppMsgType: confFactory.APPMSGTYPE_ATTACH || 6,
          MediaId: mediaId,
          Content: '',
          FileName: filename,
          FileSize: fileSize,
          Signature: '',
        })
        chatFactory.appendMessage(m)
        chatFactory.sendMessage(m)
        WechatyBro._trackSentMsg(m)
        log('sendFileWithMediaId success to ' + to + ': ' + filename)
        return true
      } catch (e) {
        log('sendFileWithMediaId error:', e.message)
        return false
      }
    },

    // === Main init ===
    init: function () {
      if (!angularIsReady()) {
        retObj.code = 503
        retObj.message = 'init() without a ready angular env'
        return retObj
      }

      if (WechatyBro.vars.initState === true) {
        retObj.code = 304
        retObj.message = 'already inited'
        return retObj
      }

      glueToAngular()
      hookMessageEvents()
      installLoginPropertyTrap()
      installLogoutMethodTrap()
      watchScanReactive()
      watchLoginViaRootScope()
      watchDOMForStateChanges()
      // Restore cross-login replay cutoff from document.cookie (set by bridge)
      WechatyBro._loadLastMsgTime()

      // Check initial state
      if (window.MMCgi && window.MMCgi.isLogin) {
        doLogin('initial state')
      }

      // Heartbeat (kept — useful for liveness)
      heartBeat(true)

      WechatyBro.vars.initState = true
      log('inited (event-driven)!')

      retObj.code = 200
      retObj.message = 'WechatyBro Init Succ'
      return retObj
    },

    config(key, value){
      switch(key){
        case 'requireThumb':
          WechatyBro.requireThumb = !!value
          break
        default:
          log('set: unknown key', key)
      }
    },

    /**
     * Change a contact's remark name (备注名).
     * Uses the webwxoplog API via Angular's $http.
     * @param {string} id - pyId or UserName of the contact
     * @param {string} newRemark - new remark name
     * @returns {Promise<boolean>} true if successful
     */
    setRemark: function (id, newRemark) {
      try {
        var injector = angular.element(document).injector()
        var http = injector.get('$http')
        var accountFactory = injector.get('accountFactory')
        var userName = WechatyBro._resolveUserName(id) || id

        var br = accountFactory.getBaseRequest()
        var req = br.BaseRequest || br

        return http({
          method: 'POST',
          url: '/cgi-bin/mmwebwx-bin/webwxoplog',
          params: { pass_ticket: accountFactory.getPassticket() || '' },
          data: {
            BaseRequest: req,
            CmdId: 2,
            RemarkName: newRemark,
            UserName: userName,
          },
        }).then(function (resp) {
          var ok = resp.data && resp.data.BaseResponse && resp.data.BaseResponse.Ret === 0
          if (ok) {
            log('setRemark success:', userName, '->', newRemark)
          } else {
            var msg = (resp.data && resp.data.BaseResponse && resp.data.BaseResponse.ErrMsg) || 'unknown error'
            log('setRemark failed:', userName, msg)
          }
          return !!ok
        })
      } catch (e) {
        log('setRemark error:', e.message)
        return false
      }
    },
  }

  // ==========================================================================
  // Internal: AngularJS glue
  // ==========================================================================
  function glueToAngular() {
    var injector = angular.element(document).injector()
    if (!injector) throw new Error('glueToAngular: no injector')

    WechatyBro.glue = {
      injector: injector,
      rootScope: injector.get('$rootScope'),
      appScope: angular.element('[ng-controller="appController"]').scope(),
      loginScope: angular.element('[ng-controller="loginController"]').scope(),
      accountFactory: injector.get('accountFactory'),
      chatFactory: injector.get('chatFactory'),
      contactFactory: injector.get('contactFactory'),
      chatroomFactory: injector.get('chatroomFactory'),
      confFactory: injector.get('confFactory'),
      utilFactory: injector.get('utilFactory'),
      loginFactory: injector.get('loginFactory'),
    }

    return true
  }

  // ==========================================================================
  // Signal 1: QR Barcode — reactive via $watch + MutationObserver
  // ==========================================================================
  function watchScanReactive() {
    var loginScope = WechatyBro.glue.loginScope
    if (!loginScope) {
      log('watchScanReactive: no loginScope yet, will rely on DOM observer')
      return
    }

    // AngularJS $watch — fires whenever qrcodeUrl or code changes
    var unwatchUrl = loginScope.$watch('qrcodeUrl', function (newUrl, oldUrl) {
      if (!newUrl) return
      if (WechatyBro.vars.loginState) return
      var code = +loginScope.code
      log('$watch qrcodeUrl:', oldUrl, '->', newUrl, 'code:', code)
      emitScanIfChanged(code, newUrl)
    })
    addCleanup(unwatchUrl)

    var unwatchCode = loginScope.$watch('code', function (newCode, oldCode) {
      if (WechatyBro.vars.loginState) return
      var code = +newCode
      var url = loginScope.qrcodeUrl
      if (!url) return
      log('$watch code:', oldCode, '->', newCode)
      emitScanIfChanged(code, url)
      if (code === 201 || code === 200) {
        scheduleLoginConfirmClick('loginScope.code=' + code)
      }
    })
    addCleanup(unwatchCode)

    // Watch isNeedRefresh — WeChat sets this when QR expires
    var unwatchRefresh = loginScope.$watch('isNeedRefresh', function (needRefresh) {
      if (!needRefresh) return
      log('$watch isNeedRefresh: QR expired, awaiting new QR')
    })
    addCleanup(unwatchRefresh)

    // Watch isScan — changes when phone scans the QR
    var unwatchScan = loginScope.$watch('isScan', function (isScan, wasScan) {
      if (isScan === wasScan) return
      log('$watch isScan:', wasScan, '->', isScan)
      if (isScan) {
        scheduleLoginConfirmClick('loginScope.isScan')
        WechatyBro.emit('scan', buildScanPayload(201, loginScope.qrcodeUrl, {
          userAvatar: loginScope.userAvatar,
        }))
      }
    })
    addCleanup(unwatchScan)

    // Emit initial QR if already present
    if (loginScope.qrcodeUrl) {
      emitScanIfChanged(+loginScope.code, loginScope.qrcodeUrl)
      if (+loginScope.code === 201 || +loginScope.code === 200 || loginScope.isScan) {
        scheduleLoginConfirmClick('watchScanReactive init')
      }
    }

    // Watch isAssociationLogin — when true, the "Log in" button appears
    // instead of a QR code (cookie-based auto-login prompt)
    var unwatchAssoc = loginScope.$watch('isAssociationLogin', function (isAssoc, wasAssoc) {
      if (isAssoc === wasAssoc) return
      log('$watch isAssociationLogin:', wasAssoc, '->', isAssoc)
      if (isAssoc) {
        scheduleLoginConfirmClick('isAssociationLogin')
      }
    })
    addCleanup(unwatchAssoc)

    // If association login is already showing on init, auto-click
    if (loginScope.isAssociationLogin) {
      scheduleLoginConfirmClick('isAssociationLogin init')
    }
  }

  function emitScanIfChanged(code, url) {
    if (code === WechatyBro.vars.scanCode && url === WechatyBro.vars.scanUrl) return
    WechatyBro.vars.scanCode = code
    WechatyBro.vars.scanUrl = url
    WechatyBro.emit('scan', buildScanPayload(code, url))
  }

  function scheduleLoginConfirmClick(source) {
    if (WechatyBro.vars.loginState) return

    if (WechatyBro.vars.loginConfirmTimer) {
      clearTimeout(WechatyBro.vars.loginConfirmTimer)
      WechatyBro.vars.loginConfirmTimer = null
    }

    var attempts = 0

    function attemptClick() {
      if (WechatyBro.vars.loginState) {
        WechatyBro.vars.loginConfirmTimer = null
        return
      }

      attempts += 1
      if (tryClickLoginConfirmButton(source + '#' + attempts) || attempts >= 8) {
        WechatyBro.vars.loginConfirmTimer = null
        return
      }

      WechatyBro.vars.loginConfirmTimer = setTimeout(attemptClick, 500)
    }

    WechatyBro.vars.loginConfirmTimer = setTimeout(attemptClick, 50)
  }

  function tryClickLoginConfirmButton(source) {
    if (!shouldTryLoginConfirmButton()) return false

    var now = Date.now()
    if (now - WechatyBro.vars.lastLoginConfirmClickAt < 1500) {
      return false
    }

    // Prefer calling Angular scope method directly — most reliable
    var loginScope = WechatyBro.glue.loginScope
    if (loginScope && loginScope.isAssociationLogin && typeof loginScope.associationLogin === 'function') {
      WechatyBro.vars.lastLoginConfirmClickAt = now
      log('Auto-confirm via loginScope.associationLogin() source:', source)
      try {
        loginScope.associationLogin()
        if (loginScope.$applyAsync) loginScope.$applyAsync()
        return true
      } catch (e) {
        log('associationLogin() failed:', e.message, '— falling back to DOM click')
      }
    }

    // Fallback: find and click the DOM button
    var button = findLoginConfirmButton()
    if (!button) return false

    WechatyBro.vars.lastLoginConfirmClickAt = now
    var text = getElementText(button)
    log('Auto-click login confirm button via:', source, '| text:', text)

    try {
      triggerElementClick(button)
      return true
    } catch (e) {
      log('Auto-click login confirm button failed:', e.message)
      return false
    }
  }

  function shouldTryLoginConfirmButton() {
    var loginScope = WechatyBro.glue.loginScope
    if (!loginScope || WechatyBro.vars.loginState) return false

    var code = +loginScope.code
    return code === 201 || code === 200 || !!loginScope.isScan || !!loginScope.isAssociationLogin
  }

  function findLoginConfirmButton() {
    var selectors = [
      '[ng-controller="loginController"] button',
      '[ng-controller="loginController"] a',
      '[ng-controller="loginController"] .btn',
      '.login_box button',
      '.login_box a',
      '.login_box .btn',
      '.association button',
      '.association a',
      '.association .btn',
      'button',
      'a',
      '[role="button"]',
      '.btn',
    ]

    var nodes = []
    selectors.forEach(function (selector) {
      Array.prototype.push.apply(nodes, document.querySelectorAll(selector))
    })

    var seen = []
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i]
      if (!node || seen.indexOf(node) >= 0) continue
      seen.push(node)

      if (!isVisibleElement(node)) continue

      var text = getElementText(node)
      if (!text) continue
      if (!/(登录|login|log in|进入微信|进入wechat|continue|继续|confirm|确认)/i.test(text)) continue
      if (/(退出|logout|log out|cancel|取消)/i.test(text)) continue

      return node
    }

    return null
  }

  function isVisibleElement(el) {
    if (!el || !el.getBoundingClientRect) return false
    var style = window.getComputedStyle(el)
    if (!style) return false
    if (style.display === 'none' || style.visibility === 'hidden' || +style.opacity === 0) return false
    var rect = el.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }

  function getElementText(el) {
    return ((el.innerText || el.textContent || el.value || '') + '').replace(/\s+/g, ' ').trim()
  }

  function triggerElementClick(el) {
    ;['mouseover', 'mousedown', 'mouseup', 'click'].forEach(function (type) {
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
      }))
    })
    if (typeof el.click === 'function') {
      el.click()
    }
  }

  // ==========================================================================
  // Signal 2: Login — Object.defineProperty trap on MMCgi.isLogin
  // ==========================================================================
  function installLoginPropertyTrap() {
    if (!window.MMCgi) {
      log('installLoginPropertyTrap: MMCgi not found, deferring')
      // Watch for MMCgi to appear
      var checkMMCgi = setInterval(function () {
        if (window.MMCgi) {
          clearInterval(checkMMCgi)
          _trapIsLogin()
        }
      }, 200)
      addCleanup(function () { clearInterval(checkMMCgi) })
      return
    }
    _trapIsLogin()
  }

  function _trapIsLogin() {
    var mmcgi = window.MMCgi
    
    // Determine actual login state — check both the property value and Angular state
    // This handles cases where a previous trap's backing value is stale
    var currentPropValue = mmcgi.isLogin
    var angularSaysLoggedIn = false
    try {
      var injector = angular.element(document).injector()
      if (injector) {
        var acc = injector.get('accountFactory')
        angularSaysLoggedIn = !!(acc && acc.getUserName && acc.getUserName())
      }
    } catch (e) {}
    
    var _isLogin = !!(currentPropValue || angularSaysLoggedIn)

    try {
      Object.defineProperty(mmcgi, 'isLogin', {
        get: function () { return _isLogin },
        set: function (v) {
          var old = _isLogin
          _isLogin = v
          log('MMCgi.isLogin trap:', old, '->', v)
          if (v && !old) {
            doLogin('MMCgi.isLogin trap')
          } else if (!v && old) {
            doLogout('MMCgi.isLogin trap')
          }
        },
        configurable: true,
        enumerable: true,
      })
      log('MMCgi.isLogin property trap installed (initial:', _isLogin, ')')
    } catch (e) {
      log('Failed to trap MMCgi.isLogin:', e.message)
    }
  }

  // ==========================================================================
  // Signal 2b: Login — $rootScope event watchers
  // ==========================================================================
  function watchLoginViaRootScope() {
    var rootScope = WechatyBro.glue.rootScope
    if (!rootScope) return

    // root:pageInit:success fires after login completes
    var off1 = rootScope.$on('root:pageInit:success', function () {
      log('rootScope event: root:pageInit:success')
      doLogin('root:pageInit:success')
    })
    addCleanup(off1)

    // newLoginPage fires on login page transitions
    var off2 = rootScope.$on('newLoginPage', function () {
      log('rootScope event: newLoginPage')
      // This indicates we're back at login page — could mean logout
      if (WechatyBro.vars.loginState) {
        doLogout('newLoginPage event')
      }
    })
    addCleanup(off2)
  }

  // ==========================================================================
  // Signal 3: Logout — monkey-patch loginFactory.loginout()
  // ==========================================================================
  function installLogoutMethodTrap() {
    var loginFactory = WechatyBro.glue.loginFactory
    if (!loginFactory || !loginFactory.loginout) {
      log('installLogoutMethodTrap: loginFactory.loginout not found')
      return
    }

    var origLoginout = loginFactory.loginout
    loginFactory.loginout = function () {
      log('loginFactory.loginout() intercepted')
      doLogout('loginFactory.loginout intercepted')
      return origLoginout.apply(this, arguments)
    }
    addCleanup(function () { loginFactory.loginout = origLoginout })
    log('loginFactory.loginout() monkey-patched')
  }

  // ==========================================================================
  // Signal 3b: DOM observer — detect login/logout page transitions
  // ==========================================================================
  function watchDOMForStateChanges() {
    // Watch for login panel appearing — covers edge cases where
    // MMCgi trap and Angular events both miss the transition.
    // Debounced to avoid false positives during page reload transitions
    // (login panel appears briefly during reload even when user stays logged in).
    var _domLogoutTimer = null

    var observer = new MutationObserver(function () {
      if (shouldTryLoginConfirmButton()) {
        tryClickLoginConfirmButton('DOM observer')
      }

      if (!WechatyBro.vars.loginState) return

      var loginPanel = document.querySelector('.login_box, .qrcode, [ng-controller="loginController"]')
      if (!loginPanel) {
        // Login panel gone — cancel any pending logout
        if (_domLogoutTimer) { clearTimeout(_domLogoutTimer); _domLogoutTimer = null }
        return
      }

      // Debounce: wait 2s to confirm it's a real logout, not a transient reload
      if (!_domLogoutTimer) {
        _domLogoutTimer = setTimeout(function () {
          _domLogoutTimer = null
          // Re-check: is the login panel still visible AND MMCgi says not logged in?
          var stillVisible = document.querySelector('.login_box, .qrcode, [ng-controller="loginController"]')
          // Also check chat area — if it's still present, the session is alive despite login panel showing
          var chatStillVisible = document.querySelector('.chat_box, #chatArea, .box_ft, [ng-controller="chatController"]')
          if (stillVisible && !window.MMCgi.isLogin && !chatStillVisible) {
            log('DOM observer: login panel confirmed after debounce — logout detected')
            doLogout('DOM observer')
            try {
              var injector = angular.element(document).injector()
              if (injector) {
                WechatyBro.glue.loginScope = angular.element('[ng-controller="loginController"]').scope()
                watchScanReactive()
              }
            } catch (e) {}
          }
        }, 2000)
      }
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    })
    addCleanup(function () {
      observer.disconnect()
      if (_domLogoutTimer) clearTimeout(_domLogoutTimer)
    })

    // Also watch for QR image mutations (refresh without scope change)
    _watchQRImageMutations()
  }

  function _watchQRImageMutations() {
    // The QR image element — watch its src attribute for refreshes
    function findAndWatch() {
      var qrImg = document.querySelector('.qrcode img, .login_box img[src*="qrcode"]')
      if (!qrImg) return false

      var imgObserver = new MutationObserver(function () {
        if (WechatyBro.vars.loginState) return
        var loginScope = WechatyBro.glue.loginScope
        if (loginScope && loginScope.qrcodeUrl) {
          emitScanIfChanged(+loginScope.code, loginScope.qrcodeUrl)
        }
      })
      imgObserver.observe(qrImg, { attributes: true, attributeFilter: ['src'] })
      addCleanup(function () { imgObserver.disconnect() })
      log('QR image MutationObserver installed')
      return true
    }

    // QR image may not exist yet — use the main DOM observer to find it lazily
    if (!findAndWatch()) {
      var waitObserver = new MutationObserver(function () {
        if (findAndWatch()) {
          waitObserver.disconnect()
        }
      })
      waitObserver.observe(document.body, { childList: true, subtree: true })
      addCleanup(function () { waitObserver.disconnect() })
    }
  }

  // ==========================================================================
  // Login/Logout state transitions (de-duplicated)
  // ==========================================================================
  var _loginPending = false  // Guard against concurrent doLogin calls

  function doLogin(source, attempt) {
    if (WechatyBro.vars.loginState && attempt === undefined) {
      log('doLogin: already logged in, ignoring source:', source)
      return
    }
    // Prevent concurrent doLogin chains from different signals
    if (attempt === undefined && _loginPending) {
      log('doLogin: login already pending, ignoring source:', source)
      return
    }
    if (!attempt) { attempt = 0; _loginPending = true }

    // Bail if logout happened during retry window
    if (attempt > 0 && !window.MMCgi.isLogin) {
      log('doLogin: MMCgi.isLogin went false during retry, aborting')
      _loginPending = false
      return
    }

    var userName = getUserName()
    var user = userName && WechatyBro.getContact(userName)

    // Retry if user info not ready yet
    if ((!user?.name) && attempt < 10) {
      setTimeout(function () { doLogin(source, attempt + 1) }, 500)
      return
    }

    _loginPending = false
    if (WechatyBro.vars.loginConfirmTimer) {
      clearTimeout(WechatyBro.vars.loginConfirmTimer)
      WechatyBro.vars.loginConfirmTimer = null
    }
    WechatyBro.vars.loginState = true
    WechatyBro.vars.scanCode = null
    WechatyBro.vars.scanUrl = null
    WechatyBro.emit('login', user)

    // Start watching for contacts to be fully loaded (PYQuanPin etc.)
    waitForContactsReady()
  }

  // ==========================================================================
  // Contacts-ready detection — poll every 5s for 2 minutes after login
  // ==========================================================================
  var _contactsReadyTimer = null

  function waitForContactsReady() {
    if (_contactsReadyTimer) { clearInterval(_contactsReadyTimer); _contactsReadyTimer = null }
    WechatyBro.vars.contactsReady = false

    var lastPinyinCount = 0
    var startTime = Date.now()

    function check() {
      if (!WechatyBro.vars.loginState) {
        // Logged out — stop polling
        if (_contactsReadyTimer) { clearInterval(_contactsReadyTimer); _contactsReadyTimer = null }
        return
      }

      try {
        var contactFactory = WechatyBro.glue.contactFactory
        if (!contactFactory) return

        var all = contactFactory.getAllContacts()
        var contacts = Object.values(all)
        var withPinyin = contacts.filter(function (c) {
          return c.UserName && !c.UserName.startsWith('@@') && c.PYQuanPin && c.PYQuanPin.length > 0
        })

        if (withPinyin.length > lastPinyinCount) {
          lastPinyinCount = withPinyin.length
          WechatyBro.vars.contactsReady = true
          WechatyBro._buildIdMaps()
          log('CONTACTS READY: ' + contacts.length + ' total, ' + withPinyin.length + ' with PYQuanPin')
          WechatyBro.emit('contacts-ready', {
            total: contacts.length,
            withPinyin: withPinyin.length,
            elapsedMs: Date.now() - startTime,
          })
        }
      } catch (e) {
        log('contacts-ready check error:', e.message)
      }

      // Stop after 2 minutes
      if (Date.now() - startTime > 120000) {
        log('contacts-ready polling complete after 2 minutes')
        if (_contactsReadyTimer) { clearInterval(_contactsReadyTimer); _contactsReadyTimer = null }
      }
    }

    _contactsReadyTimer = setInterval(check, 5000)
    // Also check immediately
    check()

    addCleanup(function () {
      if (_contactsReadyTimer) { clearInterval(_contactsReadyTimer); _contactsReadyTimer = null }
    })
  }

  function doLogout(source) {
    if (!WechatyBro.vars.loginState && !_loginPending) {
      log('doLogout: already logged out, ignoring source:', source)
      return
    }

    _loginPending = false
    if (_contactsReadyTimer) {
      clearInterval(_contactsReadyTimer)
      _contactsReadyTimer = null
    }
    WechatyBro.vars.contactsReady = false
    WechatyBro._idToUserName = {}
    WechatyBro._userNameToId = {}
    WechatyBro._sentMsgIds = {}
    if (WechatyBro.vars.loginConfirmTimer) {
      clearTimeout(WechatyBro.vars.loginConfirmTimer)
      WechatyBro.vars.loginConfirmTimer = null
    }
    WechatyBro.vars.loginState = false
    WechatyBro.vars.scanCode = null
    WechatyBro.vars.scanUrl = null
    log('LOGOUT confirmed via:', source)
    WechatyBro.emit('logout', source)

    // After logout, re-setup scan watching since loginScope may have changed
    setTimeout(function () {
      try {
        WechatyBro.glue.loginScope = angular.element('[ng-controller="loginController"]').scope()
        watchScanReactive()
      } catch (e) {
        log('post-logout scan re-watch failed:', e.message)
      }
    }, 1000)
  }

  // ==========================================================================
  // Message events — still uses Angular $on (already event-driven)
  // ==========================================================================
  var MSG_TYPE_NAMES = {
    1: 'text', 3: 'image', 34: 'voice', 37: 'verify',
    42: 'card', 43: 'video', 47: 'emoticon', 48: 'location',
    49: 'app', 51: 'status', 62: 'microvideo',
    10000: 'system', 10002: 'recalled',
  }

  function emitTypedMessage(data) {
    // Cross-login replay suppression: skip messages older than last seen time.
    // The cutoff (wx_last_msg_time cookie) is loaded from document.cookie on
    // init and persisted by the bridge so it survives process restarts.
    if (WechatyBro._lastMsgTime > 0 && data.CreateTime > 0 && data.CreateTime <= WechatyBro._lastMsgTime) {
      return  // replayed history message, already handled in previous session
    }
    // Track the highest CreateTime for next session and persist to cookie
    if (data.CreateTime > WechatyBro._lastMsgTime) {
      WechatyBro._lastMsgTime = data.CreateTime
      WechatyBro._saveLastMsgTime()
    }

    // Deduplicate: skip if we've already emitted this MsgId
    if (data.MsgId) {
      if (WechatyBro._seenMsgIds[data.MsgId]) return
      WechatyBro._seenMsgIds[data.MsgId] = Date.now()
      // Purge old entries if over limit
      var seenKeys = Object.keys(WechatyBro._seenMsgIds)
      if (seenKeys.length > WechatyBro._SEEN_MSG_MAX) {
        var cutoff = Date.now() - WechatyBro._SEEN_MSG_TTL
        seenKeys.forEach(function (k) {
          if (WechatyBro._seenMsgIds[k] < cutoff) delete WechatyBro._seenMsgIds[k]
        })
      }
    }
    // Suppress events for messages we sent ourselves
    if (WechatyBro._isSentByUs(data.MsgId)) {
      delete WechatyBro._sentMsgIds[data.MsgId] // clean up
      return
    }
    if (data.MsgType === 1 && data.Content && data.Content.indexOf(AI_WATERMARK) !== -1) {
      return
    }
    var typeName = MSG_TYPE_NAMES[data.MsgType] || 'unknown'
    WechatyBro.emit('message', data)
    WechatyBro.emit('message:' + typeName, data)
  }

  function hookMessageEvents() {
    var rootScope = WechatyBro.glue.rootScope
    if (!rootScope) {
      log('hookMessageEvents: no rootScope')
      return false
    }

    var off = rootScope.$on('message:add:success', function (event, data) {
      data.from = WechatyBro.getContact(data.FromUserName)
      data.to = WechatyBro.getContact(data.ToUserName)

      // Room messages: FromUserName is the room, actual sender is in Content prefix
      if (data.FromUserName && data.FromUserName.startsWith('@@') && data.Content) {
        var match = data.Content.match(/^(@[a-f0-9]+):\n([\s\S]*)/)
        if (match) {
          data.sender = WechatyBro.getContact(match[1])
          data.Content = match[2]
        }

        // Parse @mentions from Content: @Name\u2005
        var mentionRe = /@([^\u2005@]+)\u2005/g
        var mentionMatch
        var mentions = []
        while ((mentionMatch = mentionRe.exec(data.Content)) !== null) {
          mentions.push(mentionMatch[1])
        }
        if (mentions.length) {
          try {
            var injector = angular.element(document).injector()
            var contactFactory = injector.get('contactFactory')
            var room = contactFactory.getContact(data.FromUserName)
            var selfUserName = getUserName()
            var selfNickName = ''
            try {
              var selfContact = contactFactory.getContact(selfUserName)
              selfNickName = cleanName(selfContact && selfContact.NickName) || ''
            } catch (e) {}
            data.mentions = []
            data.mentionMe = false
            var members = (room && room.MemberList) || []
            for (var mi = 0; mi < mentions.length; mi++) {
              var mName = mentions[mi]
              // Check self first
              if (selfNickName && mName === selfNickName) {
                data.mentionMe = true
                data.mentions.push(WechatyBro._resolveId(selfUserName) || selfUserName)
                continue
              }
              // Search room members by DisplayName or NickName
              var found = false
              for (var ri = 0; ri < members.length; ri++) {
                var dn = cleanName(members[ri].DisplayName)
                var nn = cleanName(members[ri].NickName)
                if ((dn && dn === mName) || (nn && nn === mName)) {
                  var mUN = members[ri].UserName
                  if (mUN === selfUserName) data.mentionMe = true
                  data.mentions.push(WechatyBro._resolveId(mUN) || mUN)
                  found = true
                  break
                }
              }
              if (!found) {
                // Fallback: try full contact lookup by NickName
                var full = contactFactory.getContact(mName)
                if (full && full.UserName) {
                  if (full.UserName === selfUserName) data.mentionMe = true
                  data.mentions.push(WechatyBro._resolveId(full.UserName) || full.UserName)
                }
              }
            }
          } catch (e) {
            log('mention parse error:', e.message)
          }
        }
      }

      if (data.MsgType === 34 && data.MsgId) {
        WechatyBro.downloadVoice(data.MsgId, function (base64Audio) {
          data.voiceBase64 = base64Audio
          data.voiceLength = data.VoiceLength || 0
          emitTypedMessage(data)
        })
      } else if (data.MsgType === 3 && data.MsgId) {
        WechatyBro.downloadImage(data.MsgId, function (base64Img) {
          data.imageBase64 = base64Img
          emitTypedMessage(data)
        })
      } else if (data.MsgType === 49) {
        // Extract file/link info from app message XML
        try {
          var xml = data.Content || ''
          var titleMatch = xml.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)
          var descMatch = xml.match(/<des><!\[CDATA\[(.*?)\]\]><\/des>/)
          var urlMatch = xml.match(/<url><!\[CDATA\[(.*?)\]\]><\/url>/)
          var typeMatch = xml.match(/<type>(\d+)<\/type>/)
          var fnMatch = xml.match(/<appattach>[\s\S]*?<cdnattachurl><!\[CDATA\[(.*?)\]\]><\/cdnattachurl>/)
          data.appTitle = titleMatch ? titleMatch[1] : ''
          data.appDesc = descMatch ? descMatch[1] : ''
          data.appUrl = urlMatch ? urlMatch[1] : ''
          data.appType = typeMatch ? parseInt(typeMatch[1]) : 0
        } catch (e) {
          log('app msg parse error:', e.message)
        }
        emitTypedMessage(data)
      } else {
        emitTypedMessage(data)
      }
    })
    addCleanup(off)
    return true
  }

  // ==========================================================================
  // Heartbeat (kept for liveness detection)
  // ==========================================================================
  function heartBeat(firstTime) {
    var TIMEOUT = 15000
    if (firstTime && WechatyBro.vars.heartBeatTimmer) return

    WechatyBro.emit('heartbeat', 'heartbeat@browser')
    WechatyBro.vars.heartBeatTimmer = setTimeout(heartBeat, TIMEOUT)
    return TIMEOUT
  }

})()
