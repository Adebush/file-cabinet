(() => {
  const $ = (s) => document.querySelector(s);
  const boxes = [...document.querySelectorAll('.code-digit')];
  const msg = $('#msg');
  const form = $('#pickup-form');
  const result = $('#result');
  const btn = $('#submit-btn');

  const code = () => boxes.map((b) => b.value).join('');

  boxes.forEach((box, i) => {
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(-1);
      box.classList.toggle('filled', !!box.value);
      clearMsg();
      if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
      if (code().length === 4) submit();
    });

    box.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !box.value && i > 0) {
        boxes[i - 1].focus();
        boxes[i - 1].value = '';
        boxes[i - 1].classList.remove('filled');
        e.preventDefault();
      }
      if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
      if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
    });

    box.addEventListener('paste', (e) => {
      const text = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 4);
      if (!text) return;
      e.preventDefault();
      text.split('').forEach((ch, idx) => {
        if (boxes[idx]) { boxes[idx].value = ch; boxes[idx].classList.add('filled'); }
      });
      const next = boxes[Math.min(text.length, boxes.length - 1)];
      next.focus();
      clearMsg();
      if (code().length === 4) submit();
    });

    box.addEventListener('focus', () => box.select());
  });

  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });

  function clearMsg() {
    msg.textContent = '';
    msg.classList.remove('show');
  }

  async function submit() {
    const value = code();
    if (value.length !== 4) {
      showMsg('请输入完整的 4 位配对码', true);
      return;
    }
    btn.disabled = true;
    btn.textContent = '查询中…';
    try {
      const res = await fetch('/api/public/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: value }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '查询失败');
      showResult(data);
    } catch (err) {
      showMsg(err.message, true);
      boxes.forEach((b) => { b.classList.add('shake'); });
      setTimeout(() => boxes.forEach((b) => b.classList.remove('shake')), 400);
      boxes[0].focus();
    } finally {
      btn.disabled = false;
      btn.textContent = '领取文件';
    }
  }

  function showMsg(text, isErr) {
    msg.textContent = text;
    msg.classList.toggle('err', !!isErr);
    msg.classList.add('show');
  }

  function showResult(d) {
    $('#r-name').textContent = d.name;
    const bits = [d.size_h];
    if (d.remaining !== null && d.remaining !== undefined) bits.push(`剩余 ${d.remaining} 次`);
    if (d.expires_at) bits.push(`${new Date(d.expires_at * 1000).toLocaleString('zh-CN', { hour12: false })} 过期`);
    $('#r-meta').textContent = bits.join(' · ');
    $('#r-note').textContent = d.note || '';
    $('#r-note').style.display = d.note ? 'block' : 'none';
    $('#r-dl').href = `/api/public/download?t=${encodeURIComponent(d.token)}`;
    form.style.display = 'none';
    result.style.display = 'block';
  }

  $('#r-again').onclick = () => {
    result.style.display = 'none';
    form.style.display = 'block';
    boxes.forEach((b) => { b.value = ''; b.classList.remove('filled'); });
    clearMsg();
    boxes[0].focus();
  };

  function focusFirst() {
    const empty = boxes.find((b) => !b.value) || boxes[0];
    empty.focus();
  }
  window.addEventListener('load', focusFirst);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('input, button, a')) focusFirst();
  });
  focusFirst();
})();
