/* 渲染层多语言适配：全局 t() / trHTML() / i18nSet() / i18nApplyStatic()
 * 字典以中文原文为 key（见 ../shared/i18n.js），缺译时原样返回中文。
 * trHTML() 只替换「被标签/属性引号包住」的整段文案，避免把应用名里的中文换掉。
 */
(function () {
  const dict = (typeof window !== 'undefined' && window.DSI18N) || null;
  let lang = 'zh-CN';
  let map = null;
  let pairs = null;

  function build(l) {
    lang = l === 'en' ? 'en' : 'zh-CN';
    if (!dict || !dict.EN) {
      map = {};
      pairs = [];
      return;
    }
    map = dict.EN;
    // 只拿「不含占位符」的条目做字符串替换；含 {n} 的必须走 t()
    pairs = Object.keys(map)
      .filter((k) => k.indexOf('{') < 0)
      .sort((a, b) => b.length - a.length)
      .map((k) => [k, map[k]]);
  }

  function t(text, vars) {
    if (text == null) return '';
    const s = String(text);
    if (lang === 'zh-CN') return vars ? dict.format(s, vars) : s;
    const tpl = (map && Object.prototype.hasOwnProperty.call(map, s)) ? map[s] : s;
    return (dict && dict.format) ? dict.format(tpl, vars) : tpl;
  }

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function trHTML(html) {
    if (lang === 'zh-CN' || !html) return html;
    let out = String(html);
    for (let i = 0; i < pairs.length; i++) {
      const k = pairs[i][0];
      if (out.indexOf(k) < 0) continue;
      out = out.replace(new RegExp('(?<=>|"|\\s)' + escRe(k) + '(?=<|"|\\s)', 'g'), pairs[i][1]);
    }
    return out;
  }

  function i18nApplyStatic() {
    const q = (sel) => Array.from(document.querySelectorAll(sel));
    q('[data-i18n]').forEach((n) => { n.textContent = t(n.dataset.i18n); });
    q('[data-i18n-ph]').forEach((n) => { n.setAttribute('placeholder', t(n.dataset.i18nPh)); });
    q('[data-i18n-title]').forEach((n) => { n.setAttribute('title', t(n.dataset.i18nTitle)); });
    q('[data-i18n-aria]').forEach((n) => { n.setAttribute('aria-label', t(n.dataset.i18nAria)); });
  }

  function i18nSet(settings) {
    const next = (settings && settings.language) === 'en' ? 'en' : 'zh-CN';
    const changed = next !== lang;
    if (changed || !pairs) build(next);
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    if (changed) i18nApplyStatic();
  }

  build('zh-CN');
  window.t = t;
  window.trHTML = trHTML;
  window.i18nSet = i18nSet;
  window.i18nApplyStatic = i18nApplyStatic;
})();
