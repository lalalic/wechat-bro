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
    updateSelection()
  }
  function updateSelection() {
    const current = selectedChat()
    const s = catalog && catalog.orchestrator && catalog.orchestrator.contexts &&
      catalog.orchestrator.contexts.find(item => item.context === current)
    if (s && s.agent) el('route').value = s.agent
    if (s && s.mode) el('mode').value = s.mode
    if (s) alert('当前：'+s.state+' · '+(s.agent||'未分配'))
  }
  function currentChat() {
    try {
      const injector = window.angular && angular.element(document).injector()
      const chats = injector && injector.get('chatFactory')
      const contacts = injector && injector.get('contactFactory')
      let chat = chats && chats.getCurrentChat && chats.getCurrentChat()
      if (!chat) return null
      if (typeof chat === 'string') chat = contacts.getContact(chat)
      else if (chat.UserName && contacts) chat = contacts.getContact(chat.UserName) || chat
      return String(chat.getDisplayName ? chat.getDisplayName() :
        (chat.RemarkName||chat.NickName||'')).trim() || null
    } catch {return null}
  }
  // A same-origin WeChat script must not be able to synthesize admin clicks.
  // CDP Input and real mouse/keyboard clicks set isTrusted; element.click()
  // and dispatchEvent() from page scripts do not.
  function bind(id,fn) {el(id).addEventListener('click', event => {
    if (!event.isTrusted) return
    fn()
  })}
  bind('open',()=>{el('panel').hidden = !el('panel').hidden; if(!el('panel').hidden) attempt(refresh)})
  bind('close',()=>{el('panel').hidden = true})
  bind('refresh',()=>attempt(refresh,'状态已刷新'))
  bind('current',()=>{
    const name = currentChat()
    if (!name) return alert('无法获取当前聊天，请从列表选择',true)
    el('context').value = name
    updateSelection()
  })
  el('contacts').addEventListener('change',()=>{el('context').value='';updateSelection()})
  el('context').addEventListener('change',updateSelection)
  for (const btn of root.querySelectorAll('nav button')) {
    btn.addEventListener('click',()=>{
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
