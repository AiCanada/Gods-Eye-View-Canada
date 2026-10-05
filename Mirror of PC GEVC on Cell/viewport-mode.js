/*
 * Mirror of PC GEVC on Cell: the PC layout on a phone or tablet. Runs before
 * the page's styles and modules, so every size rule and every panel sees the
 * layout chosen here.
 *
 * Each kind of screen keeps its own choice, so a foldable is right on both of
 * its screens:
 *   - cover: a fold's narrow outer screen (under 380 px across): the phone
 *     layout unless chosen otherwise, as the PC layout cannot fit it;
 *   - phone: an ordinary phone screen: the PC layout;
 *   - large: an unfolded fold or a tablet: the PC layout.
 * In the PC layout the page is laid out at 1024 px (wide enough for every PC
 * size rule, which start at 961 px) and scaled to fit; pinch to zoom. Held
 * upright on a phone, a hint says to turn it sideways. DISPLAY > Screen (or
 * ?layout=pc / ?layout=phone) sets the choice for the screen in use. Folding
 * or unfolding moves to the other screen and reloads into its layout; turning
 * the phone sideways does not. A PC never changes.
 */
(function () {
  var KEY = 'gev.layoutMode';
  var HINT_KEY = 'gev.layoutHintDismissed';
  var PC_WIDTH = 1024;
  var NAMES = {
    cover: 'Cover screen',
    phone: 'Phone screen',
    large: 'Large screen',
  };
  var DEFAULTS = { cover: 'phone', phone: 'pc', large: 'pc' };

  function screenKind() {
    var across = Math.min(screen.width || 0, screen.height || 0);
    if (across < 380) return 'cover';
    if (across < 600) return 'phone';
    return 'large';
  }
  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  var kind = screenKind();
  var kindKey = KEY + '.' + kind;
  // A choice made before screens were told apart counts for phone and large screens.
  var mode =
    read(kindKey) || (kind === 'cover' ? null : read(KEY)) || DEFAULTS[kind];
  try {
    var asked = new URLSearchParams(location.search).get('layout');
    if (asked === 'pc' || asked === 'phone') {
      mode = asked;
      write(kindKey, mode);
    }
  } catch (error) {
    /* an old browser without URLSearchParams keeps the saved choice */
  }
  if (mode !== 'phone') mode = 'pc';
  var touch =
    window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  var narrow = Math.min(screen.width || 0, screen.height || 0) < PC_WIDTH;
  var mirrored = touch && narrow && mode === 'pc';
  var root = document.documentElement;
  root.setAttribute('data-touch-device', touch ? 'true' : 'false');
  root.setAttribute('data-screen-kind', kind);
  root.setAttribute('data-layout-mode', mode);
  root.setAttribute('data-pc-mirror', mirrored ? 'true' : 'false');
  if (mirrored) {
    var meta = document.querySelector('meta[name="viewport"]');
    if (meta)
      meta.setAttribute(
        'content',
        'width=' +
          PC_WIDTH +
          ', minimum-scale=0.1, maximum-scale=5, user-scalable=yes',
      );
  }

  // How much bigger a control must be drawn in the PC view to come out a
  // finger's size on the glass: the page is shrunk by screen width / 1024,
  // more upright than sideways. CSS reads it as --pc-mirror-boost.
  function setBoost() {
    if (!mirrored) return;
    var across = screen.width || PC_WIDTH;
    var boost = Math.max(1, Math.min(4, PC_WIDTH / across));
    root.style.setProperty('--pc-mirror-boost', boost.toFixed(3));
  }
  setBoost();
  window.addEventListener('orientationchange', function () {
    setTimeout(setBoost, 300);
  });
  window.addEventListener('resize', setBoost);

  /** Reload without ?layout=, so the screen now in use applies its own choice. */
  function reloadForScreen(choice) {
    var url = new URL(location.href);
    url.searchParams.delete('layout');
    // Kept in the address only when this browser keeps nothing.
    if (choice && !write(KEY + '.' + screenKind(), choice))
      url.searchParams.set('layout', choice);
    // An address that differs only after "#" would not reload the page (the
    // layout is chosen before it loads), so reload in place when it is the same.
    var here = new URL(location.href);
    if (url.pathname + url.search === here.pathname + here.search)
      location.reload();
    else location.replace(url.href);
  }

  // Folding or unfolding changes the screen: reload into its layout. Turning
  // the phone sideways keeps the same kind of screen and changes nothing.
  if (touch) {
    var settle = null;
    window.addEventListener('resize', function () {
      clearTimeout(settle);
      settle = setTimeout(function () {
        if (screenKind() !== kind) reloadForScreen(null);
      }, 700);
    });
  }

  /**
   * The one place to switch views: a PC / CELL button in the top toolbar.
   * It names the view it switches to, for the screen in use.
   */
  function addLayoutSwitch() {
    var bar = document.getElementById('top-center-actions');
    if (!bar || document.getElementById('layout-switch')) return;
    var next = mode === 'pc' ? 'phone' : 'pc';
    var name = next === 'pc' ? 'PC' : 'CELL';
    var button = document.createElement('button');
    button.type = 'button';
    button.id = 'layout-switch';
    button.textContent = name;
    var about =
      'Switch this ' +
      NAMES[kind].toLowerCase() +
      ' to the ' +
      (next === 'pc' ? 'PC' : 'cell') +
      ' view';
    button.title = about;
    button.setAttribute('aria-label', about);
    button.addEventListener('click', function () {
      reloadForScreen(next);
    });
    bar.append(button);
  }

  /**
   * A tap anywhere on a closed panel's box opens it; a tap on an open panel's
   * title bar closes it. Taps on the panel's own controls (buttons, fields,
   * menus, links) and anywhere inside an open panel's body work as before.
   * It presses the panel's own +/- button, so the dashboard keeps the state.
   */
  /**
   * Collapsed side boxes' headings fill their boxes at one size, the size
   * CONTEXT fits beside its icons (a longer heading wraps onto two lines). It is fitted again when a
   * box opens or closes and when the screen turns; an open box keeps its own
   * heading style (the inline size is removed).
   */
  function fitCollapsedTitles() {
    var TITLE = '.panel-title, .pp-header-label';
    var pending = false;
    function titleOf(panel) {
      var button = panel.querySelector(
        '.panel-collapse-btn[data-collapse-target="' + panel.id + '"]',
      );
      var bar = button ? button.parentElement : null;
      return bar ? bar.querySelector(TITLE) : null;
    }
    function fitOne(panel) {
      var title = titleOf(panel);
      if (!title) return;
      if (!panel.classList.contains('collapsed')) {
        title.style.removeProperty('font-size');
        title.style.removeProperty('--fit-size');
        title.removeAttribute('data-fitted');
        return;
      }
      title.setAttribute('data-fitted', 'true');
      var bar = title.parentElement;
      // The box's own height before any heading grew it: kept from the first fit,
      // so a re-fit never feeds on the height the last fit gave it.
      if (!title.getAttribute('data-fit-height'))
        title.setAttribute('data-fit-height', String(bar.clientHeight));
      var height =
        Number(title.getAttribute('data-fit-height')) || bar.clientHeight;
      if (!title.clientWidth || !height) return;
      // A box that shows a short label when collapsed (data-collapsed-title,
      // drawn after its hidden full name) has that label sized instead.
      var short = title.hasAttribute('data-collapsed-title');
      function size(px) {
        if (short) title.style.setProperty('--fit-size', px + 'px');
        else title.style.fontSize = px + 'px';
      }
      var low = 6;
      var high = Math.max(low, Math.floor(height * 0.9));
      // The largest size whose text fits the title's width and the bar's height.
      while (low < high) {
        var mid = Math.ceil((low + high) / 2);
        size(mid);
        var fits =
          title.scrollWidth <= title.clientWidth + 1 &&
          title.scrollHeight <= height + 1;
        if (fits) low = mid;
        else high = mid - 1;
      }
      size(low);
      var words = short
        ? title.getAttribute('data-collapsed-title')
        : title.textContent;
      return {
        size: size,
        px: low,
        title: title,
        oneWord: !/\s/.test(String(words || '').trim()),
      };
    }
    function fitAll() {
      pending = false;
      var panels = document.querySelectorAll(
        // The side columns only; the dock's two boxes keep their own labels.
        '#left-panel-stack .panel-collapsible[id], #right-context-rail .panel-collapsible[id]',
      );
      // Every heading the size CONTEXT fits (owner's choice; SCENES when
      // CONTEXT is not on screen); a longer one wraps onto a second line.
      var fitted = [];
      var common = null;
      for (var i = 0; i < panels.length; i++) {
        var one = fitOne(panels[i]);
        if (!one) continue;
        fitted.push(one);
        if (panels[i].id === 'global-context-panel') common = one.px;
        else if (panels[i].id === 'scene-panel' && common === null)
          common = one.px;
      }
      if (common === null) return;
      // A one-word heading cannot wrap: it goes only as small as it must.
      for (var k = 0; k < fitted.length; k++) {
        var item = fitted[k];
        var px = item.oneWord ? Math.min(common, item.px) : common;
        item.size(px);
        // A word wider than the box at that size ("ANALYSIS") steps the
        // heading down until every word fits across.
        while (px > 6 && item.title.scrollWidth > item.title.clientWidth + 1) {
          px -= 1;
          item.size(px);
        }
      }
    }
    function later() {
      if (pending) return;
      pending = true;
      requestAnimationFrame(fitAll);
    }
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var node = records[i].target;
        if (node.classList && node.classList.contains('panel-collapsible')) {
          later();
          return;
        }
      }
    }).observe(document.body, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    window.addEventListener('resize', later);
    window.addEventListener('orientationchange', function () {
      setTimeout(later, 300);
    });
    later();
    // Panels and fonts settle after start-up.
    setTimeout(later, 1500);
    setTimeout(later, 5000);
    if (document.fonts && document.fonts.ready)
      document.fonts.ready.then(later);
  }

  function tapPanelBoxes() {
    var CONTROLS =
      'button, a[href], input, select, textarea, label, [role="button"], [contenteditable="true"]';
    // The dock's two wings open on their own touch already.
    var SKIP = { 'location-bar': true, 'control-panel': true };
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var buttons = document.querySelectorAll(
        '.panel-collapse-btn[data-collapse-target]',
      );
      for (var i = 0; i < buttons.length; i++) {
        var button = buttons[i];
        var id = button.getAttribute('data-collapse-target');
        if (SKIP[id]) continue;
        var panel = document.getElementById(id);
        if (!panel || !panel.contains(target)) continue;
        if (button === target || button.contains(target)) return;
        // The innermost panel answers: a box inside a box is its own.
        var inner = target.closest('[data-panel-id], .panel-collapsible');
        if (
          inner &&
          inner !== panel &&
          panel.contains(inner) &&
          inner.id !== id
        )
          continue;
        if (panel.classList.contains('collapsed')) {
          if (
            target.closest(CONTROLS) &&
            !target.closest('.panel-collapse-btn')
          )
            return;
          button.click();
          return;
        }
        var bar = button.parentElement;
        if (bar && bar.contains(target) && !target.closest(CONTROLS))
          button.click();
        return;
      }
    });
  }

  function upright() {
    return (screen.height || 0) > (screen.width || 0);
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (touch) {
      addLayoutSwitch();
      tapPanelBoxes();
      fitCollapsedTitles();
    }
    if (!mirrored) return;
    var dismissed = false;
    try {
      dismissed = sessionStorage.getItem(HINT_KEY) === '1';
    } catch (error) {
      dismissed = false;
    }
    // Upright, the PC layout is shrunk to about a third: say how to read it.
    var hint = document.createElement('div');
    hint.id = 'pc-mirror-hint';
    hint.setAttribute('role', 'status');
    var text = document.createElement('span');
    text.textContent =
      'PC view: turn your phone sideways to read it, or pinch to zoom. CELL at the top switches views. ';
    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'OK';
    close.setAttribute('aria-label', 'Hide this note');
    close.addEventListener('click', function () {
      dismissed = true;
      try {
        sessionStorage.setItem(HINT_KEY, '1');
      } catch (error) {
        /* hidden for this page only */
      }
      sync();
    });
    hint.append(text, close);
    document.body.append(hint);
    function sync() {
      hint.hidden = dismissed || !upright() || kind === 'large';
    }
    sync();
    window.addEventListener('orientationchange', sync);
    window.addEventListener('resize', sync);
  });
})();
