(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const NODE_RADIUS = 19, LABEL_HEIGHT = 25, LABEL_GAP = 52, LABEL_ROW_GAP = 65;
  const labelWidth = text => Math.max(54, [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 255 ? 11 : 6.8), 18));
  const element = (name, attrs = {}, text) => {
    const node = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };

  /** 图中同时区分本地已知对象与虚拟远程对象；箭头由子提交指向父提交。 */
  class CommitGraph {
    constructor(svg, onSelect) { this.svg = svg; this.onSelect = onSelect; this.zoom = 1; this.previous = new Map(); }

    references(state) {
      const refs = [
        ...Object.entries(state.branches).map(([name, id]) => ({ key: 'local:' + name, text: name + (state.head.branch === name ? '*' : ''), id, active: state.head.branch === name, color: '#3988b6' })),
        ...Object.entries(state.tracking).map(([name, id]) => ({ key: 'tracking:' + name, text: 'origin/' + name, id, color: '#b4d3e1', small: true })),
        ...Object.entries(state.remote.branches).filter(([name, id]) => state.tracking[name] !== id).map(([name, id]) => ({ key: 'remote:' + name, text: '远端/' + name, id, color: '#b5b0ed', small: true }))
      ];
      if (!state.head.branch) refs.unshift({ key: 'head', text: 'HEAD*', id: state.head.id, active: true });
      return refs;
    }

    /** 为标签预留独立行距，单节点场景保留最小画布，避免图例被自动放大。 */
    layout(state) {
      const objects = { ...state.remote.commits, ...state.commits };
      const commits = Object.values(objects).sort((a, b) => a.order - b.order);
      const depths = new Map(), rows = new Map(), positions = new Map(), refCounts = new Map();
      const refs = this.references(state);
      for (const ref of refs) refCounts.set(ref.id, (refCounts.get(ref.id) || 0) + 1);
      const depth = id => {
        if (!depths.has(id)) depths.set(id, objects[id].parents.length ? 1 + Math.max(...objects[id].parents.map(depth)) : 0);
        return depths.get(id);
      };
      for (const commit of commits) { const d = depth(commit.id); if (!rows.has(d)) rows.set(d, []); rows.get(d).push(commit); }
      const width = Math.max(760, Math.max(...[...rows.values()].map(row => row.length)) * 280 + 100, ...refs.map(ref => 2 * (labelWidth(ref.text) + LABEL_GAP + 24)));
      let y = 65, height = 350;
      for (const [d, row] of [...rows].sort((a, b) => a[0] - b[0])) {
        row.forEach((commit, i) => {
          const parents = commit.parents.map(id => positions.get(id));
          const x = row.length > 1 ? width * (i + 1) / (row.length + 1) : parents.length ? parents.reduce((sum, p) => sum + p.x, 0) / parents.length : width / 2;
          positions.set(commit.id, { x, y });
        });
        const labelRows = Math.ceil(Math.max(...row.map(commit => refCounts.get(commit.id) || 0)) / 2);
        const clearance = labelRows ? 45 + (labelRows - 1) * LABEL_ROW_GAP + LABEL_HEIGHT + 45 : NODE_RADIUS + 35;
        height = Math.max(height, y + clearance);
        y += Math.max(145, clearance + NODE_RADIUS + 20);
      }
      return { commits, objects, positions, width, height };
    }

    draw(state, options = {}) {
      this.state = state;
      const svg = this.svg, layout = this.layout(state), positions = layout.positions;
      svg.replaceChildren(); svg.setAttribute('viewBox', '0 0 ' + layout.width + ' ' + layout.height);
      const title = element('title', {}, 'Git 提交图。箭头指向父提交；亮绿色标签表示当前分支。'); svg.append(title);
      const defs = element('defs');
      for (const [id, color] of [['parent-arrow', '#294a60'], ['label-arrow', '#fff']]) {
        const marker = element('marker', { id, markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto', markerUnits: 'userSpaceOnUse' });
        marker.append(element('path', { d: 'M0,0 L8,4 L0,8 Z', fill: color })); defs.append(marker);
      }
      svg.append(defs);
      const head = state.head.branch ? state.branches[state.head.branch] : state.head.id;
      const reachable = new Set();
      const visit = id => { if (!id || reachable.has(id)) return; reachable.add(id); layout.objects[id].parents.forEach(visit); };
      [...Object.values(state.branches), ...Object.values(state.tracking), ...Object.values(state.remote.branches), head].forEach(visit);
      for (const commit of layout.commits) {
        const point = positions.get(commit.id);
        for (const parent of commit.parents) {
          const to = positions.get(parent);
          const edge = element('path', { class: 'commit-edge', d: `M ${point.x} ${point.y - NODE_RADIUS - 1} C ${point.x} ${point.y - 73}, ${to.x} ${to.y + 73}, ${to.x} ${to.y + NODE_RADIUS + 6}`, 'marker-end': 'url(#parent-arrow)' });
          if (!reachable.has(commit.id)) { edge.setAttribute('opacity', '.28'); edge.setAttribute('stroke-dasharray', '5 4'); }
          if (!Object.hasOwn(state.commits, commit.id)) edge.setAttribute('stroke-dasharray', '5 4');
          svg.append(edge);
        }
      }
      for (const commit of layout.commits) {
        const point = positions.get(commit.id), local = Object.hasOwn(state.commits, commit.id);
        const orphan = !reachable.has(commit.id), active = commit.id === head;
        const group = element('g', { class: 'commit-node' + (orphan ? ' orphan' : '') + (!local ? ' remote-only' : '') + (options.animate && !this.previous.has(commit.id) ? ' new-node' : ''), transform: `translate(${point.x} ${point.y})`, tabindex: 0, role: 'button', 'aria-label': commit.id + ' ' + commit.message + (!local ? '，仅远程拥有' : '') });
        group.append(element('title', {}, commit.id + ' · ' + commit.message + (orphan ? '（失去引用的历史）' : '')));
        group.append(element('circle', { r: NODE_RADIUS, fill: active ? '#7bffc4' : orphan ? '#94c3d7' : !local ? '#b0b1ed' : '#55b5ba' }));
        group.append(element('text', { 'text-anchor': 'middle', dy: 5 }, commit.id));
        group.append(element('text', { class: 'node-hash', y: -34, 'text-anchor': 'middle' }, !local ? '仅在远程' : ''));
        const select = () => {
          svg.querySelectorAll('.node-selected').forEach(node => node.classList.remove('node-selected'));
          group.classList.add('node-selected'); this.onSelect(commit, !local);
        };
        group.addEventListener('click', select);
        group.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); select(); } });
        svg.append(group);
      }
      const refs = this.references(state);
      const counters = new Map(), tagPositions = new Map();
      for (const ref of refs) {
        const point = positions.get(ref.id), index = counters.get(ref.id) || 0;
        counters.set(ref.id, index + 1);
        const width = labelWidth(ref.text);
        const left = index % 2 === 0;
        const x = left ? Math.max(8, point.x - width - LABEL_GAP) : Math.min(layout.width - width - 8, point.x + LABEL_GAP);
        const y = point.y + 45 + Math.floor(index / 2) * LABEL_ROW_GAP;
        const group = element('g', { class: 'branch-tag', 'data-ref': ref.key, transform: `translate(${x} ${y})` });
        const endX = point.x - x + (left ? -16 : 16), endY = point.y - y + 10;
        // 下层指针从外侧绕行，避免穿过同一节点的上层分支标签。
        const startX = left ? width - 5 : 5, bendX = point.x - x + (left ? -34 : 34);
        group.append(element('path', { class: 'branch-pointer', d: `M ${startX} 0 Q ${bendX} 0 ${endX} ${endY}`, 'marker-end': 'url(#label-arrow)' }));
        group.append(element('rect', { width, height: LABEL_HEIGHT, rx: 7, fill: ref.active ? '#00fa8f' : ref.color, 'stroke-dasharray': ref.small ? '4 2' : 'none' }));
        group.append(element('text', { x: width / 2, y: 17, 'text-anchor': 'middle' }, ref.text));
        if (ref.active) group.append(element('text', { class: 'head-caption', x: width / 2, y: 39, 'text-anchor': 'middle' }, state.head.branch ? 'HEAD' : '分离状态'));
        svg.append(group); tagPositions.set(ref.key, { x, y });
        const previous = this.previousTags?.get(ref.key);
        if (options.animate && previous && !matchMedia('(prefers-reduced-motion: reduce)').matches && (previous.x !== x || previous.y !== y)) {
          group.animate([{ transform: `translate(${previous.x}px, ${previous.y}px)` }, { transform: `translate(${x}px, ${y}px)` }], { duration: 650, easing: 'cubic-bezier(.22,.8,.3,1)' });
        }
      }
      this.previous = positions; this.previousTags = tagPositions;
      this.resize(layout);
    }

    resize(layout = this.layout(this.state)) {
      this.svg.style.width = (this.zoom * 100) + '%';
      this.svg.style.height = Math.max(this.svg.parentElement.clientHeight, layout.height * .88) * this.zoom + 'px';
    }

    setZoom(value) { this.zoom = Math.max(.6, Math.min(2.5, value)); this.resize(); }
  }
  root.CommitGraph = CommitGraph;
})(globalThis);
