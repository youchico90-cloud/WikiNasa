/* ==================================================================
   WikiNasa — Негізгі JavaScript (script.js) — ТҮЗЕТІЛГЕН НҰСҚА
   
   (#aboutSection.is-hidden ережесі style.css файлына қосылған.)

   Мазмұны:
     • JSON жүктеу + қате өңдеу
     • Іздеу (live debounce + autocomplete + Enter/Ctrl+K)
     • URL hash күйі
     • Сұрыптау (relevance / күні / атауы)
     • Карточкаларды рендерлеу + highlight
     • Мақала ішінде кесте (data.json → "table")
     • Таңдаулылар (localStorage) + Toast
     • Loading / Error / Empty күйлері
   ================================================================== */

'use strict';

/* ============ 1. КОНФИГУРАЦИЯ ============ */
const CONFIG = Object.freeze({
  dataUrl: 'data.json',
  selectors: {
    wrapper: '#cardsWrapper',
    searchInput: '#searchInput',
    searchBtn: '#searchBtn',
    aboutSection: '#aboutSection',
    homeLink: '#homeLink'
  },
  debounceMs: 280,
  historyLimit: 5,
  siteName: 'WikiNasa',
  storage: {
    favorites: 'akasu.favorites',
    history: 'akasu.history'
  }
});

/* ============ 2. КҮЙ ============ */
const State = {
  articles: [],
  filtered: [],
  query: '',
  articleId: null,
  favoritesOnly: false,
  sortBy: 'relevance',
  favorites: new Set(),
  searchHistory: [],
  isLoading: false,
  suggestionIndex: -1
};

/* ============ 3. УТИЛИТАЛАР ============ */
const CATEGORIES = Object.freeze({
  astrophysics: 'Астрофизика',
  cosmology: 'Космология',
  'space-tech': 'Ғарыш технологиялары',
  observational: 'Бақылау астрономиясы',
  physics: 'Физика'
});

const MONTHS = ['қаңтар', 'ақпан', 'наурыз', 'сәуір', 'мамыр', 'маусым',
                'шілде', 'тамыз', 'қыркүйек', 'қазан', 'қараша', 'желтоқсан'];

const Utils = {
  debounce(fn, delay) {
    let t;
    const wrapped = function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), delay);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  },

  escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  },

  normalize(s) {
    return (s == null ? '' : String(s)).toLocaleLowerCase('kk').trim();
  },

  /* Сұранысты сөздерге бөледі: "қара құрдым" → ["қара", "құрдым"] */
  tokens(query) {
    return Utils.normalize(query).split(/\s+/).filter(Boolean);
  },

  /* Алдымен түпнұсқа мәтінде іздейміз, содан кейін бөліктерді жеке
     escape жасаймыз — HTML entities (amp, lt, 39) бұзылмайды. */
  highlight(text, query) {
    const src = text == null ? '' : String(text);
    const toks = Utils.tokens(query).sort((a, b) => b.length - a.length);
    if (!toks.length) return Utils.escapeHtml(src);
    const re = new RegExp(`(${toks.map(Utils.escapeRegex).join('|')})`, 'gi');
    return src
      .split(re)
      .map((part, i) => (i % 2 ? `<mark>${Utils.escapeHtml(part)}</mark>` : Utils.escapeHtml(part)))
      .join('');
  },

  parseTags(v) {
    if (Array.isArray(v)) return v.filter(Boolean).map(t => String(t).trim());
    if (typeof v === 'string') return v.split(/[,\s]+/).map(t => t.trim()).filter(Boolean);
    return [];
  },

  /* "2024-02-03" форматын қолмен талдаймыз — уақыт белдеуі ығысуын болдырмау үшін */
  formatDate(d) {
    if (!d) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
    if (!m) return String(d);
    const idx = Number(m[2]) - 1;
    if (idx < 0 || idx > 11) return String(d);
    return `${Number(m[3])} ${MONTHS[idx]} ${m[1]}`;
  },

  safeJson(v, fb) {
    try { return JSON.parse(v) ?? fb; } catch { return fb; }
  }
};

/* ============ 4. LOCALSTORAGE ============ */
const LocalStore = {
  read(key) {
    try { return Utils.safeJson(localStorage.getItem(key), []); } catch { return []; }
  },
  getFavorites() {
    const arr = LocalStore.read(CONFIG.storage.favorites);
    return new Set(Array.isArray(arr) ? arr : []);
  },
  saveFavorites(set) {
    try { localStorage.setItem(CONFIG.storage.favorites, JSON.stringify([...set])); } catch {}
  },
  getHistory() {
    const arr = LocalStore.read(CONFIG.storage.history);
    return Array.isArray(arr) ? arr : [];
  },
  saveHistory(list) {
    try { localStorage.setItem(CONFIG.storage.history, JSON.stringify(list.slice(0, CONFIG.historyLimit))); } catch {}
  },
  pushHistory(term) {
    const clean = (term || '').trim();
    if (!clean) return;
    const list = LocalStore.getHistory().filter(x => x !== clean);
    list.unshift(clean);
    LocalStore.saveHistory(list);
    State.searchHistory = list.slice(0, CONFIG.historyLimit);
  }
};

/* ============ 5. ДЕРЕКТЕР ҚЫЗМЕТІ ============ */
const DataService = {
  normalizeTable(t) {
    if (!t || !Array.isArray(t.columns) || !Array.isArray(t.rows)) return null;
    const columns = t.columns.map(c => (c == null ? '' : String(c)));
    const rows = t.rows
      .filter(Array.isArray)
      .map(r => r.map(c => (c == null ? '' : String(c))));
    if (!rows.length) return null;
    return { title: t.title ? String(t.title) : '', columns, rows };
  },

  async load() {
    const res = await fetch(CONFIG.dataUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const raw = Array.isArray(data) ? data : (data.articles || []);
    return raw.map((a, i) => {
      return {
        id: a.id ?? i + 1,
        title: a.title || 'Атаусыз',
        description: a.description || '',
        tags: Utils.parseTags(a.tags),
        aliases: Utils.parseTags(a.aliases),
        category: a.category || '',
        categoryLabel: CATEGORIES[a.category] || '',
        date: a.date || '',
        image: a.image || '',
        gallery: Array.isArray(a.gallery)
          ? [...new Set(a.gallery.filter(Boolean))].filter(src => src !== a.image)
          : [],
        table: DataService.normalizeTable(a.table)
      };
    });
  }
};

/* ============ 6. ІЗДЕУ ДВИЖОКІ ============ */
const SearchEngine = {
  score(a, toks) {
    const title = Utils.normalize(a.title);
    const tags = Utils.normalize(a.tags.join(' '));
    const desc = Utils.normalize(a.description);
    const aliases = Utils.normalize(a.aliases.join(' '));
    const cat = Utils.normalize(a.categoryLabel);
    let s = 0;
    for (const t of toks) {
      if (title.includes(t)) s += 3;
      if (aliases.includes(t)) s += 2;
      if (tags.includes(t)) s += 2;
      if (cat.includes(t)) s += 1;
      if (desc.includes(t)) s += 1;
    }
    return s;
  },

  apply(articles, { query, sortBy, favoritesOnly }) {
    const toks = Utils.tokens(query);
    let out = articles.filter(a => {
      if (favoritesOnly && !State.favorites.has(a.id)) return false;
      if (!toks.length) return true;
      const hay = Utils.normalize([a.title, a.description, a.categoryLabel, ...a.tags, ...a.aliases].join(' '));
      return toks.every(t => hay.includes(t));
    });

    const time = a => { const t = Date.parse(a.date); return Number.isNaN(t) ? null : t; };
    const byDate = dir => (x, y) => {
      const a = time(x), b = time(y);
      if (a === null && b === null) return 0;
      if (a === null) return 1;
      if (b === null) return -1;
      return dir * (a - b);
    };

    if (sortBy === 'title-asc') out.sort((x, y) => x.title.localeCompare(y.title, 'kk'));
    else if (sortBy === 'title-desc') out.sort((x, y) => y.title.localeCompare(x.title, 'kk'));
    else if (sortBy === 'date-desc') out.sort(byDate(-1));
    else if (sortBy === 'date-asc') out.sort(byDate(1));
    else if (toks.length) {
      const scores = new Map(out.map(a => [a.id, SearchEngine.score(a, toks)]));
      out.sort((x, y) => scores.get(y.id) - scores.get(x.id));
    }
    return out;
  },

  suggest(articles, query, limit = 6) {
    const q = Utils.normalize(query);
    if (!q) return [];
    const seen = new Set();
    const out = [];
    for (const a of articles) {
      if (out.length >= limit) break;
      if (Utils.normalize(a.title).includes(q) && !seen.has(a.title)) {
        seen.add(a.title); out.push(a.title);
      }
    }
    for (const h of State.searchHistory) {
      if (out.length >= limit) break;
      if (Utils.normalize(h).includes(q) && !seen.has(h)) { seen.add(h); out.push(h); }
    }
    return out;
  }
};

/* ============ 7. РЕНДЕРЛЕУШІ ============ */
const Renderer = {
  wrapper() { return document.querySelector(CONFIG.selectors.wrapper); },

  loading() {
    const w = Renderer.wrapper();
    if (!w) return;
    w.innerHTML = `
      <div class="state-block loading-state">
        <div class="spinner"></div>
        <p>Деректер жүктелуде...</p>
      </div>`;
  },

  error(msg) {
    const w = Renderer.wrapper();
    if (!w) return;
    w.innerHTML = `
      <div class="state-block error-state">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <p>${Utils.escapeHtml(msg || 'Қате орын алды.')}</p>
        <button type="button" class="retry-btn" id="retryBtn">Қайталау</button>
      </div>`;
    const b = document.getElementById('retryBtn');
    if (b) b.addEventListener('click', () => App.init());
  },

  empty() {
    const w = Renderer.wrapper();
    if (!w) return;
    const text = State.query
      ? `«${Utils.escapeHtml(State.query)}» бойынша ештеңе табылмады.`
      : 'Бұл бөлімде әзірге мақала жоқ.';
    w.innerHTML = `
      <div class="state-block empty-state">
        <i class="fa-solid fa-magnifying-glass"></i>
        <p>${text}</p>
        <p class="hint">Басқа кілт сөзді қолданып көріңіз.</p>
      </div>`;
  },

  favoritesEmpty() {
    const w = Renderer.wrapper();
    if (!w) return;
    w.innerHTML = `
      <div class="state-block empty-state favorites-empty">
        <i class="fa-regular fa-heart"></i>
        <p>Әзірге таңдаулы мақала жоқ.</p>
        <p class="hint">Мақаладағы ♡ батырмасын басып, осында сақтаңыз.</p>
      </div>`;
  },

  home() {
    const w = Renderer.wrapper();
    if (!w) return;
    w.innerHTML = `
      <div class="state-block empty-state home-hint">
        <i class="fa-solid fa-satellite-dish"></i>
        <p>Іздеу үшін жоғарыдағы өріске сөз жазыңыз</p>
        <p class="hint">Ctrl+K немесе / пернесімен іздеуге тез өтуге болады</p>
      </div>`;
  },

  cards(list) {
    const w = Renderer.wrapper();
    if (!w) return;
    if (!list.length) { Renderer.empty(); return; }
    w.innerHTML = '';
    const frag = document.createDocumentFragment();
    list.forEach((a, i) => frag.appendChild(Renderer.card(a, i)));
    w.appendChild(frag);
  },

  single(id) {
    const w = Renderer.wrapper();
    if (!w) return;
    w.innerHTML = '';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'back-btn';
    back.innerHTML = '<i class="fa-solid fa-arrow-left"></i> Барлық мақалаларға қайту';
    back.addEventListener('click', () => App.closeArticle());
    w.appendChild(back);

    const a = State.articles.find(x => String(x.id) === String(id));
    if (!a) {
      const nf = document.createElement('div');
      nf.className = 'state-block empty-state';
      nf.innerHTML = '<i class="fa-solid fa-satellite-dish"></i><p>Мұндай мақала табылмады.</p><p class="hint">Сілтеме ескірген немесе қате болуы мүмкін.</p>';
      w.appendChild(nf);
      return;
    }
    w.appendChild(Renderer.card(a, 0, true));
  },

  tableHtml(t) {
    if (!t) return '';
    const esc = Utils.escapeHtml;
    const head = t.columns.map(c => `<th scope="col">${esc(c)}</th>`).join('');
    const body = t.rows
      .map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`)
      .join('');
    return `
      <section class="card-table-section">
        <h4 class="card-table-title">${esc(t.title || 'Қысқаша мәлімет')}</h4>
        <div class="card-table-wrap">
          <table class="data-table">
            <thead><tr>${head}</tr></thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </section>`;
  },

  /* Мақала сілтемесіне ағымдағы сүзгі күйін қосамыз — осылайша
     мақала ашылғанда URL-ден толық күйді қалпына келтіруге болады. */
  articleHref(a) {
    const parts = [`article=${encodeURIComponent(a.id)}`];
    if (State.query) parts.push(`q=${encodeURIComponent(State.query)}`);
    if (State.favoritesOnly) parts.push('fav=1');
    return `#${parts.join('&')}`;
  },

  card(a, i, single = false) {
    const esc = Utils.escapeHtml;
    const card = document.createElement('article');
    card.className = 'card';
    card.dataset.id = a.id;
    card.style.animationDelay = `${Math.min(i * 80, 480)}ms`;
    const isFav = State.favorites.has(a.id);
    card.classList.toggle('is-favorite', isFav);

    const tags = a.tags
      .map(t => `<span class="card-tag" data-tag="${esc(t)}">${esc(t)}</span>`)
      .join(' ');

    const cover = a.image
      ? `<div class="card-cover">
           <img src="${esc(a.image)}" alt="${esc(a.title)}" loading="lazy" onerror="this.closest('.card-cover').remove()">
         </div>`
      : '';

    const gallery = (single && a.gallery.length)
      ? `<div class="card-gallery">
           ${a.gallery.map((src, idx) =>
             `<figure class="gallery-item">
                <img src="${esc(src)}" alt="${esc(a.title)} — сурет ${idx + 1}" loading="lazy">
              </figure>`
           ).join('')}
         </div>`
      : '';

    const table = Renderer.tableHtml(a.table);

    card.innerHTML = `
      <div class="card-top">
        <div class="card-actions">
          <button type="button" class="link-btn" title="Сілтемені көшіру">
            <i class="fa-solid fa-link"></i>
          </button>
          <button type="button" class="fav-btn ${isFav ? 'active' : ''}" title="Таңдаулыға қосу">
            <i class="fa-${isFav ? 'solid' : 'regular'} fa-heart"></i>
          </button>
        </div>
      </div>

      <div class="card-body ${cover ? 'has-cover' : ''}">
        <div class="card-text">
          ${a.categoryLabel ? `<span class="card-category">${esc(a.categoryLabel)}</span>` : ''}
          <h3 class="card-title">${single
            ? Utils.highlight(a.title, State.query)
            : `<a href="${Renderer.articleHref(a)}" title="Мақаланы жеке ашу">${Utils.highlight(a.title, State.query)}</a>`}</h3>
          <p class="card-description">${Utils.highlight(a.description, State.query)}</p>
          <div class="card-meta">
            ${a.date ? `<span class="card-date"><i class="fa-regular fa-calendar"></i> ${esc(Utils.formatDate(a.date))}</span>` : ''}
          </div>
          <div class="card-tags-wrapper">${tags}</div>
        </div>
        ${cover}
      </div>

      ${table}
      ${gallery}
    `;

    const linkBtn = card.querySelector('.link-btn');
    if (linkBtn) {
      linkBtn.addEventListener('click', e => {
        e.stopPropagation();
        App.copyLink(a.id);
      });
    }

    const favBtn = card.querySelector('.fav-btn');
    if (favBtn) {
      favBtn.addEventListener('click', e => {
        e.stopPropagation();
        App.toggleFavorite(a.id, favBtn, card);
      });
    }

    card.querySelectorAll('.card-tag').forEach(tagEl => {
      tagEl.addEventListener('click', e => {
        e.stopPropagation();
        const term = tagEl.dataset.tag.replace(/^#/, '');
        const input = document.querySelector(CONFIG.selectors.searchInput);
        if (input) input.value = term;
        App.setQuery(term);
        App.hideSuggestions();
      });
    });

    return card;
  },

  resultCount() {
    let el = document.getElementById('resultCount');
    if (!el) {
      el = document.createElement('div');
      el.id = 'resultCount';
      el.className = 'result-count';
      const w = Renderer.wrapper();
      if (w && w.parentNode) w.parentNode.insertBefore(el, w);
    }
    const anyFilter = !State.articleId && (State.query || State.favoritesOnly);
    el.style.display = anyFilter ? 'block' : 'none';
    if (!anyFilter) return;
    el.textContent = `Табылған нәтижелер: ${State.filtered.length}`;
  },

  activeNav() {
    const fav = document.getElementById('favoritesLink');
    if (fav) fav.classList.toggle('active', State.favoritesOnly && !State.articleId);
  }
};

/* ============ 8. TOAST ============ */
const Toast = {
  show(msg, type = 'info') {
    let box = document.getElementById('toastBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'toastBox';
      box.className = 'toast-box';
      document.body.appendChild(box);
    }
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => {
      t.classList.add('toast-hide');
      setTimeout(() => t.remove(), 300);
    }, 2200);
  }
};

/* ============ 9. БАСТЫ БАСҚАРУШЫ ============ */
const App = {
  async init() {
    State.isLoading = true;
    State.favorites = LocalStore.getFavorites();
    State.searchHistory = LocalStore.getHistory();
    FavoritesView.updateCount();
    Renderer.loading();
    try {
      State.articles = await DataService.load();
      State.isLoading = false;
      App.initSortControl();
      Stats.render();
      App.refresh();
    } catch (err) {
      console.error(err);
      State.isLoading = false;
      Renderer.error(
        window.location.protocol === 'file:'
          ? 'Файлды тікелей ашуға болмайды. Жергілікті сервер арқылы іске қосыңыз (мысалы, Live Server).'
          : 'Деректерді жүктеу мүмкін болмады. data.json файлын тексеріңіз.'
      );
    }
  },

  refresh() {
    State.filtered = SearchEngine.apply(State.articles, {
      query: State.query,
      sortBy: State.sortBy,
      favoritesOnly: State.favoritesOnly
    });

    const hasFilter = !!(State.query || State.favoritesOnly);
    const hideAbout = hasFilter || !!State.articleId;

    /* Басты беттегі «Біз туралы» бөлімі тек басты бетте көрінеді.
       Іздеу, категория, таңдаулылар немесе мақала ашылғанда жасырылады.
       (CSS-те #aboutSection.is-hidden { display: none; } болуы керек) */
    const about = document.querySelector(CONFIG.selectors.aboutSection);
    if (about) about.classList.toggle('is-hidden', hideAbout);

    /* Тақырыпты бір рет, дұрыс басымдықпен орнатамыз */
    if (State.articleId) {
      const a = State.articles.find(x => String(x.id) === String(State.articleId));
      document.title = a ? `${a.title} — ${CONFIG.siteName}` : CONFIG.siteName;
    } else if (State.favoritesOnly) {
      document.title = `Таңдаулылар — ${CONFIG.siteName}`;
    } else {
      document.title = CONFIG.siteName;
    }

    if (State.articleId) {
      Renderer.single(State.articleId);
    } else if (!hasFilter) {
      Renderer.home();
    } else if (State.favoritesOnly && !State.favorites.size) {
      Renderer.favoritesEmpty();
    } else {
      Renderer.cards(State.filtered);
    }

    const sel = document.getElementById('sortControl');
    if (sel) sel.style.display = (State.articleId || !hasFilter) ? 'none' : '';
    Renderer.resultCount();
    Renderer.activeNav();
  },

  closeArticle() {
    State.articleId = null;
    App.updateUrlHash();
    App.refresh();
    App.scrollToContent();
  },

  copyLink(id) {
    const url = `${window.location.href.split('#')[0]}#article=${encodeURIComponent(id)}`;
    const ok = () => Toast.show('Сілтеме көшірілді', 'success');
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let done = false;
      try { done = document.execCommand('copy'); } catch {}
      ta.remove();
      done ? ok() : Toast.show('Көшіру мүмкін болмады', 'error');
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(ok, fallback);
    } else {
      fallback();
    }
  },

  setQuery(q) {
    State.query = (q || '').trim();
    if (State.query) State.articleId = null;
    State.suggestionIndex = -1;
    App.refresh();
    App.updateUrlHash();
    App.renderSuggestions();
  },

  setFavorites(on) {
    State.favoritesOnly = !!on;
    State.articleId = null;
    State.query = '';
    const input = document.querySelector(CONFIG.selectors.searchInput);
    if (input) input.value = '';
    App.hideSuggestions();
    App.refresh();
    App.updateUrlHash();
    App.scrollToContent();
  },

  setSort(sortBy) {
    State.sortBy = sortBy;
    App.refresh();
  },

  commitSearch() {
    if (Bindings._deb) Bindings._deb.cancel();
    const input = document.querySelector(CONFIG.selectors.searchInput);
    if (input) State.query = input.value.trim();
    if (State.query) {
      LocalStore.pushHistory(State.query);
      State.articleId = null;
    }
    App.hideSuggestions();
    App.refresh();
    App.updateUrlHash();
    if (State.query) App.scrollToContent();
  },

  toggleFavorite(id, btn, card) {
    if (State.favorites.has(id)) {
      State.favorites.delete(id);
      Toast.show('Таңдаулылардан жойылды', 'info');
    } else {
      State.favorites.add(id);
      Toast.show('Таңдаулыға қосылды', 'success');
    }
    LocalStore.saveFavorites(State.favorites);
    const on = State.favorites.has(id);
    if (btn) {
      btn.classList.toggle('active', on);
      const icon = btn.querySelector('i');
      if (icon) icon.className = on ? 'fa-solid fa-heart' : 'fa-regular fa-heart';
    }
    if (card) card.classList.toggle('is-favorite', on);

    FavoritesView.updateCount(true);
    if (State.favoritesOnly && !State.articleId) App.refresh();
  },

  /* -------- Autocomplete -------- */
  renderSuggestions() {
    const input = document.querySelector(CONFIG.selectors.searchInput);
    if (!input) return;
    let box = document.getElementById('suggestionsBox');
    const list = SearchEngine.suggest(State.articles, State.query);
    if (!list.length || !State.query) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = document.createElement('div');
      box.id = 'suggestionsBox';
      box.className = 'suggestions-box';
      input.parentNode.style.position = 'relative';
      input.parentNode.appendChild(box);
    }
    box.innerHTML = list
      .map((s, i) => `<div class="suggestion-item" data-index="${i}">${Utils.highlight(s, State.query)}</div>`)
      .join('');
    box.querySelectorAll('.suggestion-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        input.value = el.textContent;
        App.commitSearch();
      });
    });
  },

  hideSuggestions() {
    const box = document.getElementById('suggestionsBox');
    if (box) box.remove();
  },

  /* -------- Сұрыптау басқару элементі -------- */
  initSortControl() {
    const wrap = Renderer.wrapper();
    if (!wrap || !wrap.parentNode) return;
    if (document.getElementById('sortControl')) return;
    const sel = document.createElement('select');
    sel.id = 'sortControl';
    sel.className = 'sort-control';
    sel.innerHTML = `
      <option value="relevance">Сұраныс бойынша</option>
      <option value="date-desc">Жаңалары алдымен</option>
      <option value="date-asc">Ескілері алдымен</option>
      <option value="title-asc">Атауы A→Z</option>
      <option value="title-desc">Атауы Z→A</option>
    `;
    sel.value = State.sortBy;
    sel.addEventListener('change', () => App.setSort(sel.value));
    wrap.parentNode.insertBefore(sel, wrap);
  },

  /* -------- URL hash -------- */
  updateUrlHash() {
    const params = new URLSearchParams();
    if (State.articleId) params.set('article', State.articleId);
    if (State.query) params.set('q', State.query);
    if (State.favoritesOnly) params.set('fav', '1');

    const qs = params.toString();
    let hash = '';
    if (qs === 'fav=1') hash = '#favorites';
    else if (qs) hash = '#' + qs;

    history.replaceState(null, '', hash || (window.location.pathname + window.location.search));
  },

  /* URL-ден барлық күйді қалпына келтіреді: мақала, категория, іздеу, таңдаулылар */
  readUrl() {
    const raw = window.location.hash.replace(/^#\/?/, '');
    let q = '', art = null, fav = false;

    if (raw === 'favorites') {
      fav = true;
    } else if (raw.includes('=')) {
      const p = new URLSearchParams(raw);
      q = p.get('q') || '';
      art = p.get('article');
      fav = p.get('fav') === '1';
    }

    /* Барлық өрістерді әрқашан қалпына келтіреміз — тіпті мақала ашылса да */
    State.articleId = art;
    State.query = q.trim();
    State.favoritesOnly = fav;

    const input = document.querySelector(CONFIG.selectors.searchInput);
    if (input) input.value = State.query;
  },

  scrollToContent() {
    const w = Renderer.wrapper();
    if (w) w.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },

  resetAll() {
    State.query = '';
    State.articleId = null;
    State.favoritesOnly = false;
    State.sortBy = 'relevance';
    const input = document.querySelector(CONFIG.selectors.searchInput);
    if (input) input.value = '';
    const sel = document.getElementById('sortControl');
    if (sel) sel.value = 'relevance';
    App.hideSuggestions();
    App.refresh();
    App.updateUrlHash();
    const about = document.querySelector(CONFIG.selectors.aboutSection);
    if (about) about.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

/* ============ 9.1 СТАТИСТИКА ЖӘНЕ ДИАГРАММА ============ */
const Stats = {
  render() {
    const n = State.articles.length;
    const cell = document.getElementById('statArticleCount');
    if (cell) cell.textContent = `${n} тереңдетілген ғылыми мақала`;
    Stats.drawChart();
  },

  /* Мақалалар санын санаттар бойынша көрсететін көлденең бағанды диаграмма
     (сыртқы кітапханасыз, таза Canvas). Деректер data.json-нан алынады. */
  drawChart() {
    const canvas = document.getElementById('sourcesChart');
    if (!canvas || !canvas.getContext) return;

    const counts = new Map();
    State.articles.forEach(a => {
      if (!a.categoryLabel) return;
      counts.set(a.categoryLabel, (counts.get(a.categoryLabel) || 0) + 1);
    });
    const rows = [...counts.entries()].sort((x, y) => y[1] - x[1]);
    if (!rows.length) return;

    const W = 720, H = 70 + rows.length * 52;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    const colors = ['#ffb347', '#5ac8fa', '#ff7eb6', '#a594ff', '#6ee7b7'];
    const max = Math.max(...rows.map(r => r[1]));
    const labelW = 190, left = 20, barX = left + labelW, barMaxW = W - barX - 60;

    ctx.fillStyle = '#f4f6ff';
    ctx.font = '700 17px Montserrat, "Segoe UI", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Мақалалар саны санаттар бойынша', left, 26);

    rows.forEach(([label, n], i) => {
      const y = 70 + i * 52;
      const w = Math.max(6, (n / max) * barMaxW);
      ctx.fillStyle = '#cdd5f4';
      ctx.font = '600 14px Nunito, "Segoe UI", sans-serif';
      ctx.fillText(label, left, y + 14);
      ctx.fillStyle = 'rgba(160, 182, 255, 0.12)';
      ctx.fillRect(barX, y, barMaxW, 28);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(barX, y, w, 28);
      ctx.fillStyle = '#f4f6ff';
      ctx.font = '700 14px Nunito, "Segoe UI", sans-serif';
      ctx.fillText(String(n), barX + w + 10, y + 14);
    });
  }
};

/* ============ 10. ТАҢДАУЛЫЛАР БӨЛІМІ ============ */
const FavoritesView = {
  get active() { return State.favoritesOnly; },

  updateCount(bump = false) {
    const el = document.getElementById('favCount');
    if (!el) return;
    el.textContent = State.favorites.size;
    if (bump) {
      const link = document.getElementById('favoritesLink');
      if (link) {
        link.classList.remove('bump');
        void link.offsetWidth;
        link.classList.add('bump');
        setTimeout(() => link.classList.remove('bump'), 500);
      }
    }
  },

  open() { App.setFavorites(true); },

  close() {
    if (!State.favoritesOnly) return;
    State.favoritesOnly = false;
    App.refresh();
    App.updateUrlHash();
  }
};

/* ============ 11. ОҚИҒА БАЙЛАНЫСТАРУ ============ */
const Bindings = {
  _deb: null,

  search() {
    const input = document.querySelector(CONFIG.selectors.searchInput);
    const btn = document.querySelector(CONFIG.selectors.searchBtn);

    if (input) {
      Bindings._deb = Utils.debounce(v => App.setQuery(v), CONFIG.debounceMs);
      input.addEventListener('input', e => Bindings._deb(e.target.value));

      input.addEventListener('keydown', e => {
        const box = document.getElementById('suggestionsBox');
        const items = box ? box.querySelectorAll('.suggestion-item') : [];

        if (e.key === 'ArrowDown' && items.length) {
          e.preventDefault();
          State.suggestionIndex = Math.min(State.suggestionIndex + 1, items.length - 1);
          Bindings._highlightSuggest(items);
        } else if (e.key === 'ArrowUp' && items.length) {
          e.preventDefault();
          State.suggestionIndex = Math.max(State.suggestionIndex - 1, -1);
          Bindings._highlightSuggest(items);
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (State.suggestionIndex >= 0 && items[State.suggestionIndex]) {
            input.value = items[State.suggestionIndex].textContent;
          }
          App.commitSearch();
        } else if (e.key === 'Escape') {
          Bindings._deb.cancel();
          input.value = '';
          App.setQuery('');
          App.hideSuggestions();
        }
      });

      input.addEventListener('blur', () => setTimeout(App.hideSuggestions, 120));
    }

    if (btn) {
      btn.addEventListener('click', e => {
        e.preventDefault();
        App.commitSearch();
      });
    }
  },

  _highlightSuggest(items) {
    items.forEach((it, i) => it.classList.toggle('active', i === State.suggestionIndex));
  },

  favorites() {
    const favLink = document.getElementById('favoritesLink');
    if (!favLink) return;
    favLink.addEventListener('click', e => {
      e.preventDefault();
      /* Қайта басқанда таңдаулылар көрінісінен шығады */
      App.setFavorites(!(State.favoritesOnly && !State.articleId));
    });
  },

  home() {
    const home = document.querySelector(CONFIG.selectors.homeLink);
    if (home) {
      home.addEventListener('click', e => {
        e.preventDefault();
        App.resetAll();
      });
    }
  },

  hashRoute() {
    window.addEventListener('hashchange', () => {
      App.readUrl();
      App.refresh();
      if (State.articleId) window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  },

  shortcuts() {
    document.addEventListener('keydown', e => {
      const active = document.activeElement;
      const inField = !!active && (/^(input|textarea|select)$/i.test(active.tagName) || active.isContentEditable);

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const input = document.querySelector(CONFIG.selectors.searchInput);
        if (input) input.focus();
      } else if (e.key === '/' && !inField) {
        e.preventDefault();
        const input = document.querySelector(CONFIG.selectors.searchInput);
        if (input) input.focus();
      }
    });
  },

  outsideClick() {
    document.addEventListener('click', e => {
      const box = document.getElementById('suggestionsBox');
      const input = document.querySelector(CONFIG.selectors.searchInput);
      if (box && input && !input.parentNode.contains(e.target)) {
        App.hideSuggestions();
      }
    });
  }
};

/* ============ 12. ІСКЕ ҚОСУ ============ */
document.addEventListener('DOMContentLoaded', () => {
  Bindings.search();
  Bindings.favorites();
  Bindings.home();
  Bindings.hashRoute();
  Bindings.shortcuts();
  Bindings.outsideClick();

  App.readUrl();
  App.init();
});

/* Сыртқы API */
window.WikiNasa = { App, State, SearchEngine, Renderer, Utils, Toast, FavoritesView, Stats };
