/* 命令只解析为数据；不调用 Shell，也不解释脚本。浏览器与 Node 共用同一解析器。 */
(function (root) {
  'use strict';

  /** 保留引号内的空格，拒绝 Shell 连接符，避免把多条命令误当作一次练习。 */
  function tokenize(input) {
    if (input.length > 2000) throw new Error('命令过长，请控制在 2000 个字符内。');
    const tokens = [];
    let word = '', quote = '', started = false;
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (quote) {
        if (ch === quote) quote = '';
        else if (ch === '\\' && quote === '"' && ['"', '\\'].includes(input[i + 1])) word += input[++i];
        else word += ch;
      } else if (ch === '"' || ch === "'") {
        quote = ch; started = true;
      } else if (/\s/.test(ch)) {
        if (started) { tokens.push(word); word = ''; started = false; }
      } else if (/[;&|`<>]/.test(ch)) {
        throw new Error('一次请输入一条 Git 命令；不支持管道、重定向或 Shell 连接符。');
      } else {
        word += ch; started = true;
      }
    }
    if (quote) throw new Error('引号没有闭合，请检查提交说明或文件名。');
    if (started) tokens.push(word);
    return tokens;
  }

  /** 完成全部参数检查后才交给引擎，未知选项不会被静默忽略。 */
  function parse(input) {
    const tokens = tokenize(input.trim());
    if (tokens[0] === 'git') tokens.shift();
    const name = tokens.shift(), a = tokens;
    const invalid = () => { throw new Error('暂不支持这种写法。请查看「命令手册」中的 ' + (name || 'Git') + ' 示例。'); };
    const plain = value => value && !value.startsWith('-');
    if (!name) throw new Error('请输入 Git 命令，例如 git status。');
    switch (name) {
      case 'status': if (a.length) invalid(); return { name };
      case 'reflog': if (a.length && !(a.length === 1 && a[0] === '--oneline')) invalid(); return { name };
      case 'log':
        if (a.some(x => !['--oneline', '--graph', '--all'].includes(x)) || new Set(a).size !== a.length) invalid();
        return { name, all: a.includes('--all'), graph: a.includes('--graph'), oneline: a.includes('--oneline') };
      case 'diff':
        if (a.length > 1 || (a.length && a[0] !== '--cached')) invalid();
        return { name, cached: a.length > 0 };
      case 'show':
        if (a.length > 1 || a.some(x => !plain(x))) invalid();
        return { name, ref: a[0] || 'HEAD' };
      case 'remote':
        if (a.length > 1 || (a.length && a[0] !== '-v')) invalid();
        return { name, verbose: a.length > 0 };
      case 'restore': {
        const staged = a[0] === '--staged', paths = staged ? a.slice(1) : a;
        if (!paths.length || paths.some(x => !plain(x))) invalid();
        return { name, staged, paths };
      }
      case 'stash': {
        const action = a[0] || 'push';
        if (['list', 'clear', 'pop', 'apply', 'drop'].includes(action)) {
          if (['list', 'clear'].includes(action) ? a.length !== 1 : a.length > 2 || (a[1] && !/^stash@\{\d+\}$/.test(a[1]))) invalid();
          return { name, action, index: a[1] ? Number(a[1].slice(7, -1)) : 0 };
        }
        if (action !== 'push') invalid();
        let includeUntracked = false, message = null;
        for (let i = 1; i < a.length; i++) {
          if (a[i] === '-u' && !includeUntracked) includeUntracked = true;
          else if (a[i] === '-m' && message === null && a[i + 1]?.trim()) message = a[++i];
          else invalid();
        }
        return { name, action, includeUntracked, message };
      }
      case 'add': if (!a.length || a.some(x => !plain(x))) invalid(); return { name, paths: a };
      case 'rm': {
        const cached = a[0] === '--cached', paths = cached ? a.slice(1) : a;
        if (!paths.length || paths.some(x => !plain(x))) invalid();
        return { name, cached, paths };
      }
      case 'mv': if (a.length !== 2 || a.some(x => !plain(x))) invalid(); return { name, source: a[0], destination: a[1] };
      case 'commit': {
        let message = null, amend = false, all = false, noEdit = false;
        for (let i = 0; i < a.length; i++) {
          if (a[i] === '--amend' && !amend) amend = true;
          else if (a[i] === '--no-edit' && !noEdit) noEdit = true;
          else if (a[i] === '-a' && !all) all = true;
          else if (['-m', '-am'].includes(a[i]) && message === null && a[i + 1]?.trim()) { if (a[i] === '-am') { if (all) invalid(); all = true; } message = a[++i]; }
          else invalid();
        }
        if ((message === null && !(amend && noEdit)) || (noEdit && (!amend || message !== null))) invalid();
        return { name, message, amend, all };
      }
      case 'tag': {
        if (!a.length || (a.length === 1 && a[0] === '-l')) return { name, action: 'list' };
        if (a[0] === '-d' && a.length === 2 && plain(a[1])) return { name, action: 'delete', tag: a[1] };
        if (a[0] === '-a') {
          if (!plain(a[1])) invalid();
          const rest = a.slice(2), m = rest.indexOf('-m');
          if (m < 0 || !rest[m + 1]?.trim() || rest.length !== (m === 0 ? 2 : 3) || m > 1 || (m === 1 && !plain(rest[0]))) invalid();
          return { name, action: 'create', tag: a[1], ref: m === 1 ? rest[0] : 'HEAD', message: rest[m + 1] };
        }
        if (a.length <= 2 && a.every(plain)) return { name, action: 'create', tag: a[0], ref: a[1] || 'HEAD' };
        return invalid();
      }
      case 'branch':
        if (!a.length) return { name, action: 'list' };
        if (a.every(x => ['-a', '-vv'].includes(x)) && new Set(a).size === a.length) return { name, action: 'list', all: a.includes('-a'), verbose: a.includes('-vv') };
        if (a.length <= 2 && a.every(plain)) return { name, action: 'create', branch: a[0], ref: a[1] || 'HEAD' };
        if (a[0] === '-m' && [2, 3].includes(a.length) && a.slice(1).every(plain)) return { name, action: 'rename', branch: a.length === 3 ? a[1] : null, target: a.at(-1) };
        if (a.length === 2 && a[0] === '-d' && plain(a[1])) return { name, action: 'delete', branch: a[1] };
        return invalid();
      case 'switch': case 'checkout':
        if (name === 'checkout' && a.includes('--')) {
          const separator = a.indexOf('--');
          if (separator > 1 || (separator === 1 && !plain(a[0])) || !a.slice(separator + 1).length || !a.slice(separator + 1).every(plain)) invalid();
          return { name, ref: separator ? a[0] : null, paths: a.slice(separator + 1) };
        }
        if (a[0] === '--detach' && (a.length === 1 || a.length === 2 && plain(a[1]))) return { name, ref: a[1] || 'HEAD', detach: true };
        if (a.length === 1 && (plain(a[0]) || a[0] === '-')) return { name, ref: a[0], create: false };
        if (a.length === 2 && a[0] === (name === 'switch' ? '-c' : '-b') && plain(a[1])) return { name, ref: a[1], create: true };
        return invalid();
      case 'cherry-pick':
        if (a.length === 1 && ['--continue', '--abort', '--skip'].includes(a[0])) return { name, action: a[0].slice(2) };
        if (a.length && a.every(plain)) return { name, action: 'start', refs: a };
        return invalid();
      case 'merge': case 'rebase': case 'revert':
        if (a.length === 1 && ['--continue', '--abort'].includes(a[0])) return { name, action: a[0].slice(2) };
        if (a.length === 1 && plain(a[0])) return { name, action: 'start', ref: a[0] };
        if (name === 'merge' && a.length === 2 && a[0] === '--no-ff' && plain(a[1])) return { name, action: 'start', ref: a[1], noFF: true };
        return invalid();
      case 'reset': {
        const modes = a.filter(x => x.startsWith('-')), refs = a.filter(x => !x.startsWith('-'));
        if (modes.length > 1 || refs.length > 1 || modes.some(x => !['--soft', '--mixed', '--hard'].includes(x))) invalid();
        return { name, mode: (modes[0] || '--mixed').slice(2), ref: refs[0] || 'HEAD' };
      }
      case 'fetch':
        if (a.length > 1 || (a.length && a[0] !== 'origin')) invalid();
        return { name };
      case 'pull': case 'push': {
        const options = a.filter(x => x.startsWith('-')), positional = a.filter(x => !x.startsWith('-'));
        const allowed = name === 'pull' ? ['--rebase', '--no-rebase'] : ['-u'];
        if (options.length > 1 || options.some(x => !allowed.includes(x)) || positional.length > 2 || (positional.length && positional[0] !== 'origin')) invalid();
        if (options.includes('-u') && positional.length !== 2) invalid();
        return { name, branch: positional[1], rebase: options.includes('--rebase'), setUpstream: options.includes('-u'), explicit: positional.length > 0 };
      }
      default: throw new Error('教学版尚未支持 ' + name + '。请查看「命令手册」，已支持的命令可连续组合练习。');
    }
  }

  const api = { tokenize, parse };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GitCommands = api;
})(globalThis);
