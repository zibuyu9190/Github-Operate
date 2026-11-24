const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalize, fuzzyWord, mount } = require('../help-manual.js');

function mockDOM() {
  class ClassList {
    constructor(owner) { this.owner = owner; this.set = new Set(); }
    sync() {
      const value = [...this.set].join(' ');
      if (this.owner._className !== value) this.owner._className = value;
    }
    add(...names) { names.filter(Boolean).forEach(n => this.set.add(n)); this.sync(); }
    remove(...names) { names.forEach(n => this.set.delete(n)); this.sync(); }
    toggle(name, force) {
      const on = force === undefined ? !this.set.has(name) : Boolean(force);
      if (on) this.set.add(name); else this.set.delete(name);
      this.sync();
      return on;
    }
    contains(name) { return this.set.has(name); }
  }

  class Element {
    constructor(tag, doc) {
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.ownerDocument = doc;
      this.childNodes = [];
      this.parentNode = null;
      this.attributes = {};
      this.dataset = {};
      this.events = {};
      this.hidden = false;
      this.disabled = false;
      this.value = '';
      this.title = '';
      this.type = '';
      this.scrollTop = 0;
      this.focused = false;
      this._className = '';
      this.classList = new ClassList(this);
    }
    get className() { return this._className; }
    set className(v) {
      this.classList.set = new Set(String(v || '').split(/\s+/).filter(Boolean));
      this._className = [...this.classList.set].join(' ');
    }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
    set textContent(v) {
      this.childNodes = v === '' || v === null || v === undefined ? [] : [{ nodeType: 3, textContent: String(v) }];
    }
    append(...items) {
      for (const item of items) {
        const node = typeof item === 'string' ? { nodeType: 3, textContent: item } : item;
        node.parentNode = this;
        this.childNodes.push(node);
      }
    }
    prepend(...items) {
      const wrapped = items.map(item => (typeof item === 'string' ? { nodeType: 3, textContent: item } : item));
      wrapped.forEach(n => { n.parentNode = this; });
      this.childNodes.unshift(...wrapped);
    }
    before(...items) {
      if (!this.parentNode) return;
      const list = this.parentNode.childNodes;
      const index = list.indexOf(this);
      const wrapped = items.map(item => (typeof item === 'string' ? { nodeType: 3, textContent: item } : item));
      wrapped.forEach(n => { n.parentNode = this.parentNode; });
      list.splice(index, 0, ...wrapped);
    }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k]; }
    addEventListener(type, handler) {
      if (!this.events[type]) this.events[type] = [];
      this.events[type].push(handler);
    }
    fire(type, event = {}) {
      for (const handler of this.events[type] || []) {
        handler({
          preventDefault() { event.defaultPrevented = true; },
          stopPropagation() { event.propagationStopped = true; },
          ...event
        });
      }
    }
    focus() { this.focused = true; }
  }

  const doc = {
    createElement(tag) { return new Element(tag, doc); },
    createTextNode(text) { return { nodeType: 3, textContent: String(text) }; }
  };
  return doc;
}

function collect(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  for (const child of node.children || []) collect(child, predicate, out);
  return out;
}

test('normalize 与 fuzzyWord 支持全角转换、漏字母与长词单错字模糊匹配', () => {
  assert.equal(normalize('  GIT   ＢＡＳＩＣ\t测试 '), 'git basic 测试');
  assert.equal(fuzzyWord('rbase', 'rebase'), true);
  assert.equal(fuzzyWord('comimt', 'commit'), true);
  assert.equal(fuzzyWord('chckout', 'checkout'), true);
  assert.equal(fuzzyWord('git', 'rebase'), false);
  assert.equal(fuzzyWord('abx', 'abc'), false);
});

test('mount 构建 4 标签 Bento 手册，切换分类、模糊搜索、Esc 清理与复合说明正常工作', () => {
  const doc = mockDOM();
  const dialog = doc.createElement('dialog');
  dialog.open = true;
  dialog.closedCount = 0;
  dialog.close = () => { dialog.open = false; dialog.closedCount++; };
  const title = doc.createElement('h2');
  title.id = 'help-title';
  const intro = doc.createElement('p');
  const content = doc.createElement('div');
  content.id = 'help-content';
  dialog.append(title, intro, content);
  dialog.querySelector = selector => (selector === '#help-title' ? title : null);

  const selected = [];
  const manual = mount({
    dialog,
    content,
    onSelectCommand: (command, selection) => selected.push({ command, selection })
  });

  // 4 个标签与初始可见性
  assert.equal(manual.tabs.children.length, 4);
  assert.equal(manual.panels.size, 4);
  assert.equal(manual.panels.get('templates').hidden, false);
  assert.equal(manual.panels.get('workflows').hidden, true);
  assert.equal(manual.panels.get('basic').hidden, true);
  assert.equal(manual.panels.get('advanced').hidden, true);

  manual.switchTab('advanced');
  assert.equal(manual.panels.get('templates').hidden, true);
  assert.equal(manual.panels.get('advanced').hidden, false);
  const advTab = manual.tabs.children.find(b => b.dataset.tab === 'advanced');
  assert.equal(advTab.attributes['aria-selected'], 'true');
  assert.equal(advTab.classList.contains('active'), true);

  // 搜索态跨标签检索并记录原滚动位置
  dialog.scrollTop = 120;
  manual.input.value = 'rbase';
  manual.filter();
  assert.equal(dialog.classList.contains('help-search-active'), true);
  assert.equal(manual.tabs.hidden, true);
  assert.equal(manual.clear.disabled, false);
  assert.match(manual.status.textContent, /找到 \d+ 条相关命令与流程/);
  assert.equal(manual.panels.get('templates').hidden, true);
  assert.equal(manual.panels.get('advanced').hidden, false);

  // 无匹配时全部卡片容器隐藏
  manual.input.value = '不存在的命令xyz';
  manual.filter();
  assert.match(manual.status.textContent, /没有找到匹配内容/);
  for (const panel of manual.panels.values()) assert.equal(panel.hidden, true);

  // 组合法输入法选字时不清空，非选字 Escape 清空并恢复原标签与 scrollTop
  const imeEvent = { key: 'Escape', isComposing: true };
  manual.input.fire('keydown', imeEvent);
  assert.equal(imeEvent.defaultPrevented, undefined);
  assert.equal(manual.input.value, '不存在的命令xyz');

  const escEvent = { key: 'Escape', isComposing: false };
  manual.input.fire('keydown', escEvent);
  assert.equal(escEvent.defaultPrevented, true);
  assert.equal(escEvent.propagationStopped, true);
  assert.equal(manual.input.value, '');
  assert.equal(dialog.classList.contains('help-search-active'), false);
  assert.equal(manual.tabs.hidden, false);
  assert.equal(manual.panels.get('advanced').hidden, false);
  assert.equal(manual.panels.get('templates').hidden, true);
  assert.equal(dialog.scrollTop, 120);

  // clear 按钮清理搜索并聚焦输入框
  manual.input.value = '取消暂存';
  manual.input.fire('input');
  assert.match(manual.status.textContent, /找到 \d+ 条相关命令与流程/);
  manual.clear.fire('click');
  assert.equal(manual.input.value, '');
  assert.equal(manual.input.focused, true);
  assert.equal(dialog.classList.contains('help-search-active'), false);

  // 复合操作折叠详情存在于挂载节点中，且点击命令芯片关闭弹窗并回调命令
  const guides = collect(content, el => el.tagName === 'DETAILS' && el.classList.contains('help-operation'));
  assert.ok(guides.length >= 10);
  const chip = collect(content, el => el.tagName === 'BUTTON' && el.classList.contains('command-chip'))[0];
  chip.fire('click');
  assert.equal(dialog.closedCount, 1);
  assert.equal(selected.length, 1);
  assert.match(selected[0].command, /^git /);
});
