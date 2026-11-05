;(function () {
  'use strict'
  if (location.origin !== 'https://wx.qq.com' || document.getElementById('wechat-bro-management')) return
  // The per-page secret lives only in this private closure, never on window
  // or in the DOM. Other scripts on wx.qq.com cannot issue raw admin requests
  // simply by calling the exposed CDP binding.
  const nonce = '__WB_UI_NONCE__'
  const host = document.createElement('div')
  host.id = 'wechat-bro-management'
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none'
  const root = host.attachShadow({mode:'open'})
  root.innerHTML = [
    '<style>',
    ':host{font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202124}',
    '*{box-sizing:border-box}button,input,textarea,select{font:inherit}',
    '#open{position:absolute;right:14px;top:12px;pointer-events:auto;background:#087f5b;color:white;border:0;border-radius:18px;padding:9px 16px;cursor:pointer;box-shadow:0 2px 7px #0003}',
    '#panel{pointer-events:auto;position:absolute;right:12px;top:53px;width:min(385px,calc(100vw - 24px));max-height:calc(100vh - 65px);overflow-y:auto;background:#fff;border-radius:12px;box-shadow:0 7px 29px #0004;border:1px solid #ddd}',
    '[hidden]{display:none!important}header{padding:12px 15px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #eee}',
    'header strong{font-size:15px}#close{border:0;background:transparent;cursor:pointer;font-size:22px}',
    'nav{display:flex;padding:5px;gap:4px;border-bottom:1px solid #eee}',
    'nav button{flex:1;border:0;background:transparent;padding:9px 2px;border-radius:6px;cursor:pointer}',
    'nav button.active{background:#e3f2eb;color:#087f5b;font-weight:bold}',
    'section[data-pane]{padding:13px}label{font-weight:600;font-size:12px;display:block;margin:7px 0 5px}',
    'input,select,textarea{width:100%;border:1px solid #ddd;border-radius:6px;padding:8px;color:#222;background:white}',
    'select[data-wb-native]{display:none!important}',
    '.wb-trigger{width:100%;min-height:38px;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;text-align:left;border:1px solid #ddd;border-radius:6px;background:#fff;color:#222;font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}',
    '.wb-trigger:focus-visible{outline:2px solid #087f5b;outline-offset:2px}',
    '.wb-trigger .wb-value{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.wb-trigger .wb-chevron{font-size:12px;flex-shrink:0;color:#555}',
    '#wb-menu{position:absolute;z-index:100;pointer-events:auto;overflow-y:auto;overscroll-behavior:contain;background:white;color:#222;border:1px solid #cfd6d2;border-radius:8px;box-shadow:0 8px 22px #0003;padding:4px;font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}',
    '#wb-menu button{display:block;width:100%;text-align:left;font:inherit!important;line-height:1.45!important;font-size:13px!important;min-height:32px;padding:7px 9px;margin:0;background:transparent;border:0;border-radius:5px;color:inherit;cursor:pointer;white-space:nowrap;text-overflow:ellipsis;overflow:hidden}',
    '#wb-menu button:hover,#wb-menu button.wb-active{background:#e7f4ee}',
    '#wb-menu button[aria-selected="true"]{font-weight:600;color:#087f5b}',

    'textarea{height:210px;resize:vertical;font:12px ui-monospace,monospace;white-space:pre}',
    '.actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}',
    '.actions button{padding:8px 10px;border-radius:6px;border:1px solid #ddd;background:#f6f6f6;cursor:pointer}',
    '.actions .primary{background:#087f5b;color:white;border-color:#087f5b}',
    '.note{font-size:11px;color:#666;line-height:1.5;margin:8px 0}',
    '#feedback{margin:6px 13px 12px;padding:9px;border-radius:6px;background:#f2f5f2;white-space:pre-wrap;word-break:break-word}',
    '#feedback.error{color:#aa2424;background:#fff0ec}',
    '</style>',
    '<button id="open" type="button" title="WeChat-bro 设置">AI</button>',
    '<div id="panel" hidden><header><strong>WeChat-bro</strong><button id="close" type="button">×</button></header>',
    '<nav><button data-tab="chats" class="active">聊天</button>',
    '<button data-tab="agents">Agents</button><button data-tab="docs">Rules / Memory</button></nav>',
    '<section data-pane="chats"><div id="summary" class="note">加载中…</div>',
    '<label>联系人 / 群</label><select id="contacts"></select>',
    '<input id="context" maxlength="160" placeholder="或输入准确的联系人 / 群名">',
    '<div class="actions"><button id="current">使用当前聊天</button><button id="refresh">刷新</button></div>',
    '<label>Agent</label><select id="route"></select>',
    '<label>模式</label><select id="mode">',
    '<option value="maintainer">Maintainer · 自动维护</option>',
    '<option value="assistant">Assistant · 明确呼叫才回复</option></select>',
    '<div class="actions"><button id="watch" class="primary">关注 / 更新</button>',
    '<button id="unwatch">取消关注</button><button id="pause">暂停</button><button id="resume">恢复</button></div>',
    '<p class="note">关注配置长期有效；暂停仅持续到本次服务重启。filehelper 由 Orchestrator 固定管理。</p>',
    '</section>',
    '<section data-pane="agents" hidden><label>Agent</label><select id="agent"></select>',
    '<div id="agent-source" class="note"></div>',
    '<textarea id="agent-text" spellcheck="false" aria-label="Agent Markdown"></textarea>',
    '<div class="actions"><button id="agent-load">读取</button>',
    '<button id="agent-save" class="primary">保存 Agent</button></div>',
    '<p class="note">可编辑说明和 Prompt；路由请在聊天页调整，其他元数据保持不变。</p></section>',
    '<section data-pane="docs" hidden><label>范围</label>',
    '<select id="scope"><option value="global">全局</option><option value="contact">联系人 / 群</option></select>',
    '<input id="doc-contact" maxlength="160" placeholder="联系人 / 群名" hidden>',
    '<label>文档</label><select id="kind"><option value="rules">Rules · 规则</option>',
    '<option value="memory">Memory · 记忆</option></select>',
    '<textarea id="doc-text" spellcheck="false" aria-label="Rules and memory"></textarea>',
    '<div class="actions"><button id="doc-load">读取</button>',
    '<button id="doc-save" class="primary">保存文档</button></div>',
    '<p class="note">文件保存到本地 WeChat-bro 目录，不向微信联系人发送消息。</p></section>',
    '<div id="feedback" role="status" hidden></div></div>'
  ].join('')
  document.body.appendChild(host)
  const el = id => root.getElementById(id)
  const pending = new Map()
  let seq = 0, catalog = null, agentRev = null, docRev = null
  // Replace native macOS select popups: they do not reliably respect the
  // Shadow DOM's font size/viewport and can render huge and misplaced.
  // Keep the original select elements as the single source of form state.
  const menu = document.createElement('div')
  menu.id = 'wb-menu'
  menu.setAttribute('role', 'listbox')
  menu.hidden = true
  root.appendChild(menu)
  const triggers = new Map()
  let openSelectId = null
  let activeOption = -1

  function syncSelect(id) {
    const select = el(id), trigger = triggers.get(id)
    if (!trigger) return
    const selected = [...select.options].find(option => option.value === select.value)
    trigger.querySelector('.wb-value').textContent = selected ? selected.textContent : ''
    trigger.querySelector('.wb-value').style.color = !select.value ? '#666' : '#222'
  }

  function closeSelectMenu() {
    if (openSelectId) {
      triggers.get(openSelectId).setAttribute('aria-expanded', 'false')
    }
    openSelectId = null
    menu.hidden = true
    menu.replaceChildren()
  }

  function activate(index) {
    const items = [...menu.querySelectorAll('button[role="option"]')]
    if (!items.length) return
    activeOption = Math.min(items.length - 1, Math.max(0, index))
    for (let i = 0; i < items.length; i++) {
      items[i].classList.toggle('wb-active', i === activeOption)
    }
    items[activeOption].scrollIntoView({ block: 'nearest' })
  }

  function chooseOption(value) {
    if (!openSelectId) return
    const id = openSelectId
    const select = el(id)
    select.value = value
    syncSelect(id)
    closeSelectMenu()
    select.dispatchEvent(new Event('change', { bubbles: true }))
    // A programmatic change event is untrusted; this callback is only
    // reachable from a verified pointer/keyboard gesture in our menu.
    if (id === 'agent') {
      agentRev = null
      attempt(loadAgent)
    }
    triggers.get(id).focus()
  }

  function openSelectMenu(id) {
    if (openSelectId === id) { closeSelectMenu(); return }
    closeSelectMenu()
    const select = el(id), trigger = triggers.get(id)
    openSelectId = id
    trigger.setAttribute('aria-expanded', 'true')
    menu.setAttribute('aria-labelledby', trigger.id)
    menu.replaceChildren()
    const options = [...select.options].filter(option => !option.disabled)
    options.forEach((option, index) => {
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'option')
      item.setAttribute('aria-selected', String(option.value === select.value))
      item.textContent = option.textContent
      item.title = option.textContent
      item.addEventListener('click', event => {
        if (event.isTrusted) chooseOption(option.value)
      })
      menu.appendChild(item)
    })
    if (!options.length) {
      closeSelectMenu()
      return
    }
    menu.hidden = false
    const rect = trigger.getBoundingClientRect()
    const menuHeight = Math.min(256, menu.scrollHeight)
    const below = window.innerHeight - rect.bottom - 8
    const above = rect.top - 8
    const showAbove = below < Math.min(menuHeight, 128) && above > below
    const available = Math.max(48, showAbove ? above : below)
    const height = Math.min(menuHeight, available)
    menu.style.maxHeight = height + 'px'
    menu.style.width = Math.min(rect.width, window.innerWidth - 16) + 'px'
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)) + 'px'
    menu.style.top = Math.max(4, showAbove ? rect.top - height - 4 : rect.bottom + 4) + 'px'
    activeOption = options.findIndex(option => option.value === select.value)
    activate(Math.max(0, activeOption))
  }

  for (const id of ['contacts', 'route', 'mode', 'agent', 'scope', 'kind']) {
    const native = el(id)
    native.dataset.wbNative = 'true'
    const trigger = document.createElement('button')
    trigger.id = id + '-button'
    trigger.className = 'wb-trigger'
    trigger.type = 'button'
    trigger.setAttribute('aria-haspopup', 'listbox')
    trigger.setAttribute('aria-controls', 'wb-menu')
    trigger.setAttribute('aria-expanded', 'false')
    const label = document.createElement('span')
    label.className = 'wb-value'
    const arrow = document.createElement('span')
    arrow.className = 'wb-chevron'
    arrow.textContent = '⌄'
    arrow.setAttribute('aria-hidden', 'true')
    trigger.append(label, arrow)
    native.insertAdjacentElement('afterend', trigger)
    triggers.set(id, trigger)
    syncSelect(id)
    trigger.addEventListener('click', event => {
      if (event.isTrusted) openSelectMenu(id)
    })
    trigger.addEventListener('keydown', event => {
      if (!event.isTrusted) return
      if (event.key === 'Escape') { closeSelectMenu(); return }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        if (openSelectId === id) {
          const option = [...native.options].filter(item => !item.disabled)[activeOption]
          if (option) chooseOption(option.value)
        } else openSelectMenu(id)
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (openSelectId !== id) openSelectMenu(id)
        else activate(activeOption + (event.key === 'ArrowDown' ? 1 : -1))
      } else if (event.key === 'Tab') closeSelectMenu()
    })
  }
  root.addEventListener('pointerdown', event => {
    if (openSelectId && !menu.contains(event.target) &&
        event.target !== triggers.get(openSelectId) &&
        !triggers.get(openSelectId).contains(event.target)) closeSelectMenu()
  }, true)
  el('panel').addEventListener('scroll', closeSelectMenu, { passive: true })
  window.addEventListener('resize', closeSelectMenu)
  function alert(message, isError = false) {
    const node = el('feedback')
    node.hidden = !message
    node.textContent = String(message || '')
    node.classList.toggle('error', isError)
  }
  function request(action, fields) {
    return new Promise((resolve,reject) => {
      const id = 'u' + (++seq)
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(Error('请求超时：检查 WeChat-bro daemon'))
      }, 16000)
      pending.set(id,{
        ok: data => {clearTimeout(timer);resolve(data)},
        fail: reason => {clearTimeout(timer);reject(Error(reason))}
      })
      try {
        if (typeof window.wechatBroUiBridge !== 'function') throw Error('UI bridge unavailable')
        window.wechatBroUiBridge(nonce,id, Object.assign({action},fields || {}))
      } catch (error) {
        const item = pending.get(id); pending.delete(id)
        item.fail(error.message)
      }
    })
  }
  window.__wechatBroUiResponse = (id, result) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (result && result.ok) entry.ok(result.data)
    else entry.fail(result && result.error || '管理操作失败')
  }
  function fill(id, entries, placeholder) {
    const node = el(id), old = node.value
    node.replaceChildren()
    if (placeholder) node.add(new Option(placeholder,''))
    for (const entry of entries) node.add(new Option(entry.label,entry.value))
    if ([...node.options].some(option => option.value === old)) node.value = old
    syncSelect(id)
    if (openSelectId === id) closeSelectMenu()
  }
  function selectedChat() { return el('context').value.trim() || el('contacts').value }
  async function attempt(fn, message) {
    alert('')
    try {
      await fn()
      if (message) alert(message)
    } catch(error) { alert(error.message,true) }
  }
  async function refresh() {
    catalog = await request('catalog')
    const orch = catalog.orchestrator
    const states = orch && orch.contexts || []
    el('summary').textContent = orch
      ? 'Orchestrator 已连接 · ' + states.filter(s => s.watching).length + ' 个关注'
      : 'Orchestrator 未运行：' + (catalog.statusError || '请启动 wechat-bro orchestrator')
    fill('contacts', [
      ...catalog.contacts.map(name => ({value:name,label:name})),
      ...catalog.rooms.map(name => ({value:name,label:'[群] ' + name}))
    ],'选择联系人或群')
    fill('route',catalog.agents.filter(a=>a.type!=='orchestrator').map(a=>({
      value:a.name,label:a.name+' ('+a.type+')'
    })),'自动选择')
    fill('agent',catalog.agents.map(a=>({value:a.name,label:a.name})))
    syncActiveChat(true)
  }
  function updateSelection() {
    const current = selectedChat()
    const s = catalog && catalog.orchestrator && catalog.orchestrator.contexts &&
      catalog.orchestrator.contexts.find(item => item.context === current)
    // A newly highlighted chat must not inherit the previous chat's
    // selected Agent or assistant mode before a watch has been configured.
    el('route').value = s && s.agent || ''
    el('mode').value = s && s.mode || 'maintainer'
    syncSelect('route')
    syncSelect('mode')
    if (s) alert('当前：'+s.state+' · '+(s.agent||'未分配'))
    else alert('')
  }
  function currentChat() {
    // WeChat Web exposes getCurrentUserName(), not getCurrentChat().
    // Prefer the active contact model and its display name: the surrounding
    // header may also contain room member counts such as "(3)".
    const title = document.querySelector('.title_wrap .title_name')
    const active = document.querySelector('.chat_item.active[data-username]')
    const headerId = title && title.getAttribute('data-username')
    const listId = active && active.getAttribute('data-username')
    let modelId = null
    let contact = null
    try {
      const injector = window.angular && window.angular.element(document).injector()
      if (injector) {
        const chats = injector.get('chatFactory')
        const contacts = injector.get('contactFactory')
        modelId = chats.getCurrentUserName && chats.getCurrentUserName()
        const selectedId = modelId || headerId || listId
        if (selectedId) contact = contacts.getContact(selectedId)
      }
    } catch {}
    const id = modelId || headerId || listId
    if (!id) return null
    // If Angular is not ready or the chat is absent from its cache, read
    // only the name anchor (not .title_wrap with extra member counts).
    let name = ''
    try {
      name = String(contact && (
        (contact.getDisplayName && contact.getDisplayName()) ||
        contact.RemarkName || contact.NickName
      ) || '').trim()
    } catch {}
    if (!name && headerId === id) name = (title.textContent || '').trim()
    if (!name) return null
    const isRoom = !!(contact && contact.isRoomContact && contact.isRoomContact())
    return { id, name, isRoom }
  }

  let lastActiveSignature = null
  let syncQueued = false
  function syncActiveChat(force = false) {
    if (!catalog) return
    const selected = currentChat()
    if (!selected) return
    const signature = selected.id + '\n' + selected.name
    if (!force && signature === lastActiveSignature) return
    lastActiveSignature = signature

    const dropdown = el('contacts')
    // Remove only the prior temporary entry, not existing contacts.
    for (const option of [...dropdown.options]) {
      if (option.dataset.wbCurrentTemp === 'true') option.remove()
    }
    if (![...dropdown.options].some(option => option.value === selected.name)) {
      // Some active conversations have not been loaded into the contacts
      // catalogue yet. They must still be selectable without a manual entry.
      const option = new Option(
        (selected.isRoom ? '[群] ' : '') + selected.name, selected.name)
      option.dataset.wbCurrentTemp = 'true'
      dropdown.add(option)
    }
    dropdown.value = selected.name
    el('context').value = ''
    syncSelect('contacts')
    if (openSelectId === 'contacts') closeSelectMenu()
    updateSelection()
  }

  function scheduleActiveSync() {
    if (syncQueued) return
    syncQueued = true
    Promise.resolve().then(() => {
      syncQueued = false
      syncActiveChat()
    })
  }

  // WeChat changes the active chat in Angular and updates the title anchor.
  // Listen to both (rather than polling the whole page) so selection updates
  // even if the AI panel stays open while switching conversations.
  try {
    const injector = window.angular && window.angular.element(document).injector()
    const rootScope = injector && injector.get('$rootScope')
    const chats = injector && injector.get('chatFactory')
    if (rootScope && chats && typeof chats.getCurrentUserName === 'function') {
      rootScope.$watch(() => chats.getCurrentUserName(), scheduleActiveSync)
    }
  } catch {}
  const chatTitle = document.querySelector('.title_wrap')
  if (chatTitle) {
    new MutationObserver(scheduleActiveSync).observe(chatTitle, {
      subtree: true, characterData: true, childList: true,
      attributes: true, attributeFilter: ['data-username'],
    })
  }
  scheduleActiveSync()
  // A same-origin WeChat script must not be able to synthesize admin clicks.
  // CDP Input and real mouse/keyboard clicks set isTrusted; element.click()
  // and dispatchEvent() from page scripts do not.
  function bind(id,fn) {el(id).addEventListener('click', event => {
    if (!event.isTrusted) return
    fn()
  })}
  bind('open',()=>{
    el('panel').hidden = !el('panel').hidden
    if (!el('panel').hidden) {
      syncActiveChat(true)
      attempt(refresh)
    }
  })
  bind('close',()=>{el('panel').hidden = true})
  bind('refresh',()=>attempt(refresh,'状态已刷新'))
  bind('current',()=>{
    if (!currentChat()) return alert('无法获取当前聊天，请从列表选择',true)
    syncActiveChat(true)
  })
  el('contacts').addEventListener('change',()=>{el('context').value='';updateSelection()})
  el('context').addEventListener('change',updateSelection)
  for (const btn of root.querySelectorAll('nav button')) {
    btn.addEventListener('click',()=>{
      closeSelectMenu()
      for(const other of root.querySelectorAll('nav button')) other.classList.toggle('active',other===btn)
      for(const panel of root.querySelectorAll('[data-pane]')) panel.hidden=panel.dataset.pane!==btn.dataset.tab
      alert('')
    })
  }
  async function control(command,state) {
    const context = selectedChat()
    if (!context) return alert('请先选择聊天',true)
    await attempt(async()=>{
      const args = {command,context}
      if (command === 'watch') {
        args.mode = el('mode').value
        if (el('route').value) args.agent = el('route').value
      }
      if(state) args.state=state
      await request('control',args)
      await refresh()
    }, '已保存：'+context)
  }
  bind('watch',()=>control('watch'))
  bind('unwatch',()=>control('unwatch'))
  bind('pause',()=>control('pause','on'))
  bind('resume',()=>control('pause','off'))
  async function loadAgent() {
    const name=el('agent').value
    if(!name) throw Error('请选择 Agent')
    const result=await request('agent-read',{name})
    agentRev=result.revision
    el('agent-text').value=result.content
    el('agent-source').textContent=result.source === 'bundled default'
      ? '内置 Agent · 保存将创建用户覆盖文件' : '用户 Agent 文件'
  }
  el('agent').addEventListener('change',event=>{
    agentRev=null
    if(event.isTrusted) attempt(loadAgent)
  })
  bind('agent-load',()=>attempt(loadAgent,'已重新读取'))
  bind('agent-save',()=>attempt(async()=>{
    if (!agentRev) throw Error('请先读取 Agent')
    const result=await request('agent-save',{
      name:el('agent').value,revision:agentRev,content:el('agent-text').value
    })
    agentRev=result.revision
    el('agent-source').textContent='用户 Agent 文件'
  },'Agent 已保存'))
  function docParams() {
    return {scope:el('scope').value,kind:el('kind').value,context:el('doc-contact').value.trim()}
  }
  function invalidateDoc() {docRev=null;el('doc-text').value=''}
  el('scope').addEventListener('change',()=>{
    el('doc-contact').hidden=el('scope').value!=='contact'
    invalidateDoc()
  })
  el('kind').addEventListener('change',invalidateDoc)
  el('doc-contact').addEventListener('change',invalidateDoc)
  bind('doc-load',()=>attempt(async()=>{
    const result=await request('document-read',docParams())
    docRev=result.revision
    el('doc-text').value=result.content
  },'已读取文档'))
  bind('doc-save',()=>attempt(async()=>{
    if (!docRev) throw Error('请先读取文档')
    const result=await request('document-save',{
      ...docParams(),revision:docRev,content:el('doc-text').value
    })
    docRev=result.revision
  },'文档已保存'))
})()
