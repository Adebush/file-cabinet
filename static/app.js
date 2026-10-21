(() => {
  const CSRF = document.querySelector('meta[name="csrf"]').content;

  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };

  const ICON = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2 2.5h7A2.5 2.5 0 0 1 21 10v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17z"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    dl: '<svg viewBox="0 0 24 24"><path d="M12 4v11"/><path d="m7 11 5 5 5-5"/><path d="M5 20h14"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4l10-10-4-4L4 16z"/><path d="m14 6 4 4"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>',
    rename: '<svg viewBox="0 0 24 24"><path d="M4 17v3h3L18 9l-3-3L4 17z"/><path d="m14 5 3 3"/></svg>',
  };

  const state = { cwd: '/', entries: [], hidden: false, filter: '', tab: 'fs' };

  // ---------- 基础 ----------
  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', !!isErr);
    t.classList.add('show');
    clearTimeout(t._tm);
    t._tm = setTimeout(() => t.classList.remove('show'), 2400);
  }

  async function api(url, opts = {}) {
    const headers = Object.assign({ 'X-CSRF': CSRF }, opts.headers || {});
    const res = await fetch(url, Object.assign({}, opts, { headers }));
    if (res.status === 401) { location.href = '/login'; throw new Error('未登录'); }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : null;
    if (!res.ok) throw new Error((data && data.error) || `请求失败 (${res.status})`);
    return data;
  }

  const post = (url, body) => api(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });

  function fmtTime(ts) {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------- 弹窗 ----------
  let modalOk = null;
  function openModal({ title, desc = '', body = '', okText = '确定', danger = false, hideCancel = false, onOk }) {
    $('#m-title').textContent = title;
    $('#m-desc').textContent = desc;
    $('#m-body').innerHTML = body;
    const ok = $('#m-ok');
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'danger' : 'primary');
    $('#m-cancel').style.display = hideCancel ? 'none' : 'inline-flex';
    modalOk = onOk;
    $('#mask').classList.add('show');
    const input = $('#m-body input, #m-body textarea');
    if (input) setTimeout(() => { input.focus(); input.select && input.select(); }, 60);
  }
  function closeModal() { $('#mask').classList.remove('show'); modalOk = null; }
  $('#m-cancel').onclick = closeModal;
  $('#mask').onclick = (e) => { if (e.target.id === 'mask') closeModal(); };
  $('#m-ok').onclick = async () => {
    const okBtn = $('#m-ok');
    if (!modalOk) { closeModal(); return; }        // 纯提示弹窗：直接关闭
    const fn = modalOk;
    const label = okBtn.textContent;
    okBtn.disabled = true;
    okBtn.textContent = '处理中…';
    try {
      const keep = await fn();
      if (keep !== false) closeModal();
    } catch (e) {
      toast(e.message, true);
    } finally {
      okBtn.disabled = false;
      if (modalOk === fn) okBtn.textContent = label;   // 弹窗没被替换才恢复文案
    }
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
    if (e.key === 'Enter' && $('#mask').classList.contains('show') && e.target.tagName === 'INPUT') $('#m-ok').click();
  });

  // ---------- 服务器文件 ----------
  function crumbs(path) {
    const box = $('#crumbs');
    box.innerHTML = '';
    const root = el('a', '', '根目录');
    root.onclick = () => loadFs('/');
    box.appendChild(root);
    let acc = '';
    path.split('/').filter(Boolean).forEach((seg, i, arr) => {
      acc += '/' + seg;
      box.appendChild(el('span', 'sep', '/'));
      if (i === arr.length - 1) {
        box.appendChild(el('span', 'cur', seg));
      } else {
        const a = el('a', '', seg);
        const target = acc;
        a.onclick = () => loadFs(target);
        box.appendChild(a);
      }
    });
  }

  function listHead() {
    const h = el('div', 'list-head',
      '<span></span><span>名称</span><span>大小</span><span>修改时间</span><span style="text-align:right">操作</span>');
    return h;
  }

  function renderFs() {
    const box = $('#fs-list');
    box.innerHTML = '';
    box.appendChild(listHead());
    const kw = state.filter.trim().toLowerCase();
    const rows = state.entries.filter((e) => !kw || e.name.toLowerCase().includes(kw));
    if (!rows.length) {
      box.appendChild(el('div', 'empty', `${ICON.folder}<div>这个目录是空的</div>`));
      return;
    }
    for (const e of rows) box.appendChild(fsRow(e));
  }

  function fsRow(e) {
    const row = el('div', 'row');
    const ic = el('div', 'ic' + (e.dir ? ' dir' : ''), e.dir ? ICON.folder : ICON.file);
    const nm = el('div', 'nm', escapeHtml(e.name) + (e.link ? '<span class="badge">链接</span>' : ''));
    nm.title = e.name;
    nm.onclick = () => e.dir ? loadFs(e.path) : previewFile(e);

    const size = el('div', 'meta', e.size_h || '—');
    const time = el('div', 'meta', fmtTime(e.mtime));
    const acts = el('div', 'acts');

    if (!e.dir) {
      acts.appendChild(btn(ICON.dl, '下载', () => download(e.path)));
      acts.appendChild(btn(ICON.copy, '复制到暂存区', () => copyToStage(e.path)));
      acts.appendChild(btn(ICON.edit, '编辑文本', () => previewFile(e)));
    } else {
      acts.appendChild(btn(ICON.dl, '打包下载（暂不支持）', () => toast('目录请进入后逐项下载', true), true));
    }
    acts.appendChild(btn(ICON.rename, '重命名', () => renameItem(e)));
    acts.appendChild(btn(ICON.trash, '删除', () => deleteItems([e.path], e.name), 'del'));

    row.append(ic, nm, size, time, acts);
    return row;
  }

  function btn(icon, title, onclick, extra) {
    const b = el('button', 'iconbtn' + (extra ? ' ' + extra : ''), icon);
    b.title = title;
    b.onclick = (ev) => { ev.stopPropagation(); onclick(); };
    return b;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadFs(path) {
    try {
      const data = await api(`/api/fs?path=${encodeURIComponent(path)}${state.hidden ? '&hidden=1' : ''}`);
      state.cwd = data.path;
      state.entries = data.entries;
      state.parent = data.parent;
      crumbs(data.path);
      renderFs();
    } catch (e) { toast(e.message, true); }
  }

  function download(path) {
    location.href = `/api/fs/download?path=${encodeURIComponent(path)}`;
  }

  async function previewFile(e) {
    try {
      const data = await api(`/api/fs/read?path=${encodeURIComponent(e.path)}`);
      openModal({
        title: e.name,
        desc: `大小 ${e.size_h} · 修改于 ${fmtTime(e.mtime)} · 可直接编辑后保存`,
        body: `<textarea id="editor"></textarea>`,
        okText: '保存修改',
        onOk: async () => {
          const content = $('#editor').value;
          await post('/api/fs/write', { path: e.path, content });
          toast('已保存');
          loadFs(state.cwd);
        },
      });
      $('#editor').value = data.content;
    } catch (err) { toast(err.message, true); }
  }

  function renameItem(e) {
    openModal({
      title: '重命名',
      desc: e.path,
      body: `<input id="rename-input" value="${escapeHtml(e.name)}">`,
      onOk: async () => {
        const name = $('#rename-input').value.trim();
        if (!name) throw new Error('名称不能为空');
        await post('/api/fs/rename', { path: e.path, name });
        toast('已重命名');
        loadFs(state.cwd);
      },
    });
  }

  function deleteItems(paths, label) {
    openModal({
      title: '确认删除',
      desc: `将永久删除：${label || paths.join('、')}`,
      body: `<div style="font-size:12.5px;color:#ffc2c8">目录会连同内部所有文件一起删除，此操作不可撤销。</div>`,
      okText: '删除',
      danger: true,
      onOk: async () => {
        await post('/api/fs/delete', { paths });
        toast('已删除');
        loadFs(state.cwd);
      },
    });
  }

  async function copyToStage(path) {
    try {
      const r = await post('/api/staging/from-server', { path });
      toast(`已复制到暂存区：${r.name}`);
      if (state.tab === 'stage') loadStage();
    } catch (e) { toast(e.message, true); }
  }

  function mkdir() {
    openModal({
      title: '新建文件夹',
      desc: state.cwd,
      body: `<input id="mkdir-input" placeholder="文件夹名称">`,
      onOk: async () => {
        const name = $('#mkdir-input').value.trim();
        if (!name) throw new Error('请输入名称');
        await post('/api/fs/mkdir', { dir: state.cwd, name });
        toast('已创建');
        loadFs(state.cwd);
      },
    });
  }

  async function uploadFiles(files, dir) {
    if (!files.length) return;
    const fd = new FormData();
    fd.append('dir', dir);
    for (const f of files) fd.append('files', f, f.name);
    toast(`正在上传 ${files.length} 个文件…`);
    try {
      const r = await api('/api/fs/upload', { method: 'POST', body: fd });
      toast(`上传完成：${r.files.length} 个文件`);
      loadFs(state.cwd);
    } catch (e) { toast(e.message, true); }
  }

  // ---------- 暂存区 ----------
  async function loadStage() {
    try {
      const data = await api('/api/staging');
      state.stage = data.entries;
      $('#stage-count').textContent = data.entries.length;
      $('#stage-size').textContent = data.total_h;
      $('#stage-free').textContent = data.capacity_h;
      const box = $('#stage-list');
      box.innerHTML = '';
      box.appendChild(listHead());
      if (!data.entries.length) {
        box.appendChild(el('div', 'empty', `${ICON.file}<div>暂存区还没有文件，拖拽或点击上传</div>`));
        return;
      }
      for (const e of data.entries) box.appendChild(stageRow(e));
    } catch (e) { toast(e.message, true); }
  }

  function stageRow(e) {
    const row = el('div', 'row');
    const ic = el('div', 'ic', ICON.file);
    const nm = el('div', 'nm', escapeHtml(e.name));
    nm.onclick = () => { location.href = `/api/staging/download?name=${encodeURIComponent(e.name)}`; };
    const size = el('div', 'meta', e.size_h);
    const time = el('div', 'meta', fmtTime(e.mtime));
    const acts = el('div', 'acts');
    acts.appendChild(btn(ICON.dl, '下载', () => { location.href = `/api/staging/download?name=${encodeURIComponent(e.name)}`; }));
    acts.appendChild(btn(ICON.trash, '删除', () => {
      openModal({
        title: '删除暂存文件', desc: e.name, okText: '删除', danger: true,
        onOk: async () => {
          await post('/api/staging/delete', { names: [e.name] });
          toast('已删除'); loadStage();
        },
      });
    }, 'del'));
    row.append(ic, nm, size, time, acts);
    return row;
  }

  async function stageUpload(files) {
    if (!files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    toast(`正在上传 ${files.length} 个文件…`);
    try {
      await api('/api/staging/upload', { method: 'POST', body: fd });
      toast('上传完成');
      loadStage();
    } catch (e) { toast(e.message, true); }
  }

  // ---------- 事件 ----------
  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $('#panel-fs').style.display = tab === 'fs' ? 'flex' : 'none';
    $('#panel-stage').style.display = tab === 'stage' ? 'flex' : 'none';
    $('#panel-codes').style.display = tab === 'codes' ? 'flex' : 'none';
    if (tab === 'stage') loadStage();
    if (tab === 'codes') loadCodes();
  }
  document.querySelectorAll('.tab').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

  $('#btn-up').onclick = () => { if (state.parent) loadFs(state.parent); };
  $('#btn-mkdir').onclick = mkdir;
  $('#btn-hidden').onclick = (e) => {
    state.hidden = !state.hidden;
    e.target.textContent = state.hidden ? '隐藏文件：开' : '隐藏文件';
    loadFs(state.cwd);
  };
  $('#btn-upload').onclick = () => $('#file-input').click();
  $('#file-input').onchange = (e) => { uploadFiles([...e.target.files], state.cwd); e.target.value = ''; };
  $('#filter').oninput = (e) => { state.filter = e.target.value; renderFs(); };

  $('#btn-stage-upload').onclick = () => $('#stage-input').click();
  $('#stage-input').onchange = (e) => { stageUpload([...e.target.files]); e.target.value = ''; };
  $('#btn-stage-refresh').onclick = loadStage;
  $('#btn-codes-refresh').onclick = loadCodes;
  $('#btn-new-code').onclick = createCode;
  $('#stage-drop').onclick = () => $('#stage-input').click();

  // 拖拽上传：暂存区
  const drop = $('#stage-drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
    e.preventDefault(); drop.classList.remove('over');
  }));
  drop.addEventListener('drop', (e) => stageUpload([...e.dataTransfer.files]));

  // 全局拖拽：当前目录
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (state.tab !== 'fs' || !e.dataTransfer.types.includes('Files')) return;
    dragDepth++; $('#drop-overlay').classList.add('show');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#drop-overlay').classList.remove('show');
  });
  window.addEventListener('drop', (e) => {
    if (state.tab !== 'fs') return;
    e.preventDefault(); dragDepth = 0; $('#drop-overlay').classList.remove('show');
    if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files], state.cwd);
  });

  $('#logout').onclick = async () => { await post('/logout'); location.href = '/login'; };


  // ---------- 配对码 ----------
  async function loadCodes() {
    try {
      const data = await api('/api/codes');
      const box = $('#codes-list');
      box.innerHTML = '';
      box.appendChild(el('div', 'list-head code-head',
        '<span>配对码</span><span>文件</span><span>下载</span><span>状态</span><span style="text-align:right">操作</span>'));
      const usable = data.codes.filter((c) => !c.disabled && !c.expired && c.exists).length;
      $('#code-total').textContent = data.codes.length;
      $('#code-active').textContent = usable;
      if (!data.codes.length) {
        box.appendChild(el('div', 'empty', `${ICON.file}<div>还没有配对码，点右上角生成一个</div>`));
        return;
      }
      for (const c of data.codes) box.appendChild(codeRow(c));
    } catch (e) { toast(e.message, true); }
  }

  function codeRow(c) {
    const row = el('div', 'row code-row');
    const code = el('div', 'code-cell', escapeHtml(c.code));
    code.title = '点击复制';
    code.style.cursor = 'pointer';
    code.onclick = () => {
      navigator.clipboard && navigator.clipboard.writeText(c.code);
      toast(`已复制配对码 ${c.code}`);
    };

    const file = el('div', 'nm', escapeHtml(c.file) + (c.note ? `<div class="sub">${escapeHtml(c.note)}</div>` : ''));
    const dl = el('div', 'meta', c.max_downloads ? `${c.downloads} / ${c.max_downloads}` : `${c.downloads}`);

    let tag = '<span class="tag ok">可用</span>';
    if (c.disabled) tag = '<span class="tag off">已停用</span>';
    else if (c.expired) tag = '<span class="tag off">已过期</span>';
    else if (!c.exists) tag = '<span class="tag off">文件已删</span>';
    const status = el('div', '', tag + `<span class="tag">${escapeHtml(c.size_h)}</span>`);

    const acts = el('div', 'acts');
    acts.appendChild(btn(c.disabled ? ICON.copy : ICON.rename, c.disabled ? '启用' : '停用', async () => {
      await post('/api/codes/toggle', { code: c.code });
      toast(c.disabled ? '已启用' : '已停用');
      loadCodes();
    }));
    acts.appendChild(btn(ICON.trash, '删除', () => {
      openModal({
        title: '删除配对码', desc: `${c.code} · ${c.file}`, okText: '删除', danger: true,
        onOk: async () => { await post('/api/codes/delete', { code: c.code }); toast('已删除'); loadCodes(); },
      });
    }, 'del'));

    row.append(code, file, dl, status, acts);
    return row;
  }

  async function createCode() {
    let files = [];
    try {
      const data = await api('/api/staging');
      files = data.entries.filter((e) => !e.dir);
    } catch (e) { toast(e.message, true); }
    if (!files.length) { toast('暂存区还没有文件，请先上传', true); return; }

    const opts = files.map((f) => `<option value="${escapeHtml(f.name)}">${escapeHtml(f.name)}（${f.size_h}）</option>`).join('');
    openModal({
      title: '生成配对码',
      desc: '访客输入这 4 位数字即可下载对应文件',
      body: `
        <div class="form-grid">
          <div class="full"><label>选择暂存区文件</label><select id="c-file">${opts}</select></div>
          <div><label>配对码（留空自动生成）</label><input id="c-code" maxlength="4" inputmode="numeric" placeholder="自动生成"></div>
          <div><label>有效期（小时，0 = 永久）</label><input id="c-exp" type="number" min="0" value="0"></div>
          <div><label>下载次数上限（0 = 不限）</label><input id="c-max" type="number" min="0" value="0"></div>
          <div class="full"><label>备注（可选，仅自己可见）</label><input id="c-note" maxlength="80" placeholder="例如：给 XX 的照片"></div>
        </div>`,
      okText: '生成',
      onOk: async () => {
        const payload = {
          file: $('#c-file').value,
          code: $('#c-code').value.trim(),
          expire_hours: Number($('#c-exp').value || 0),
          max_downloads: Number($('#c-max').value || 0),
          note: $('#c-note').value.trim(),
        };
        const r = await post('/api/codes', payload);
        loadCodes();
        showCode(r.code);
        return false;
      },
    });
  }

  function showCode(code) {
    openModal({
      title: '配对码已生成',
      desc: `把下面这 4 位数字发给对方，打开 ${location.host} 输入即可下载`,
      body: `<div class="big-code">${escapeHtml(code)}</div>`,
      okText: '完成',
      hideCancel: true,
    });
  }

  // ---------- 启动 ----------
  loadFs('/');
})();
