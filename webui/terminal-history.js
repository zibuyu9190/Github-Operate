(function (root) {
  'use strict';

  const { ACTORS } = typeof module !== 'undefined' && module.exports ? require('./simulator.js') : root.GitSimulator;
  const label = actor => actor === 'all' ? '全部身份' : ACTORS[actor].terminal;
  const statusOf = result => !result ? '已执行' : !result.ok ? '失败' : result.conflict ? '待解决冲突' : result.paused ? '已暂停' : '成功';
  const dateText = timestamp => new Date(timestamp).toLocaleString('zh-CN', { hour12: false });

  /** 独立于终端的 80 行显示上限，仅在当前页面内存保留本轮全部执行记录。 */
  class History {
    constructor() { this.entries = []; }

    record({ actor, branch, scene, command, output = '', result, timestamp = Date.now() }) {
      if (!Object.hasOwn(ACTORS, actor)) throw new Error('未知的命令执行身份。');
      if (!command.trim()) return;
      this.entries.push(Object.freeze({ sequence: this.entries.length + 1, actor, branch: branch || '分离 HEAD', scene, command, output: String(output), status: statusOf(result), timestamp }));
    }

    list(scope = 'all') {
      if (scope !== 'all' && !Object.hasOwn(ACTORS, scope)) throw new Error('未知的命令复制范围。');
      return this.entries.filter(entry => scope === 'all' || entry.actor === scope);
    }

    clear() { this.entries = []; }

    /** 纯文本保留输入原文与失败结果；全部身份按实际执行顺序排列，不能按身份重排。 */
    format(scope, { scene }) {
      const entries = this.list(scope);
      if (!entries.length) return null;
      const lines = ['Git 图解实验室 · 历史命令', '练习：' + scene, '复制范围：' + label(scope), '命令数量：' + entries.length,
        '仅包含本轮实际执行记录（含失败和按钮执行的 Git 命令），不包含未执行草稿。', ''];
      for (const entry of entries) {
        lines.push('[' + entry.sequence + '] ' + dateText(entry.timestamp) + ' | ' + label(entry.actor) + ' | 分支：' + entry.branch + ' | ' + entry.status,
          '$ ' + entry.command, entry.output, '');
      }
      return { text: lines.join('\n').replace(/\r\n?/g, '\n'), count: entries.length };
    }
  }

  /** 优先使用剪贴板 API；本地文件或浏览器拒绝该 API 时退回页面内复制，失败由界面明确提示。 */
  async function copyText(text) {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); return; }
      catch { /* 当前环境不允许剪贴板 API 时继续尝试兼容方式。 */ }
    }
    const focused = document.activeElement, start = focused?.selectionStart, end = focused?.selectionEnd;
    const field = document.createElement('textarea'); field.value = text; field.readOnly = true;
    field.tabIndex = -1; field.style.position = 'fixed'; field.style.left = '-9999px';
    try {
      document.body.append(field); field.select();
      if (!document.execCommand('copy')) throw new Error('浏览器未允许复制。');
    } finally {
      field.remove();
      if (focused?.isConnected) { focused.focus({ preventScroll: true }); if (typeof start === 'number') focused.setSelectionRange(start, end); }
    }
  }

  class View {
    constructor(parent, history, readContext, copy = copyText) {
      this.history = history; this.readContext = readContext; this.copy = copy; this.actor = readContext().actor; this.generation = 0;
      const make = (tag, text) => { const element = document.createElement(tag); if (text) element.textContent = text; return element; };
      this.root = make('div'); this.root.className = 'terminal-history';
      this.button = make('button', '复制历史'); this.button.id = 'terminal-history-copy'; this.button.type = 'button';
      this.button.setAttribute('aria-label', '复制当前窗口全部历史命令');
      this.button.addEventListener('click', () => this.copyHistory());
      this.feedback = make('p'); this.feedback.className = 'terminal-history-feedback'; this.feedback.setAttribute('role', 'status');
      this.root.append(this.feedback, this.button); parent.append(this.root); this.update();
    }

    /** 按钮始终复制当前窗口所属身份，不能把另一方命令混进当前窗口。 */
    update() {
      const actor = this.readContext().actor;
      if (actor !== this.actor) {
        this.actor = actor; this.generation++; this.feedback.textContent = '';
      }
      const count = this.history.list(actor).length;
      this.button.disabled = !count;
      this.button.textContent = '复制历史' + (count ? '（' + count + '）' : '');
      this.button.title = count ? '复制' + label(actor) + '本次练习的全部命令和执行结果' : '当前窗口暂无已执行命令';
    }

    reset() { this.generation++; this.actor = this.readContext().actor; this.feedback.textContent = ''; this.update(); }

    async copyHistory() {
      const context = this.readContext(), scope = context.actor, history = this.history.format(scope, context), generation = this.generation;
      if (!history) return;
      try { await this.copy(history.text); if (generation === this.generation) this.feedback.textContent = '已复制：' + label(scope) + '，共 ' + history.count + ' 条命令。'; }
      catch { if (generation === this.generation) this.feedback.textContent = '复制失败，请检查浏览器剪贴板权限后重试。'; }
    }
  }

  const api = { History, View, copyText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitTerminalHistory = api;
})(typeof window === 'undefined' ? globalThis : window);
