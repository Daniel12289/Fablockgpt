/* FABLOCK AI BUILDER PRO - frontend (no build step).
   Talks to the Floot backend, which holds the Groq key. Real SSE streaming:
   every chunk from /ai/* is parsed as it arrives and written into the editor
   and the sandboxed phone preview. */
(function () {
  "use strict";
  var API = (window.FABLOCK_CONFIG && window.FABLOCK_CONFIG.API) || "";
  var $ = function (s) { return document.querySelector(s); };
  var KEY = { token: "fablock.pro.token", user: "fablock.pro.user", projects: "fablock.pro.projects", current: "fablock.pro.current" };

  /* ---------- safe storage ---------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function lsJson(k, d) { try { var v = JSON.parse(lsGet(k)); return v == null ? d : v; } catch (e) { return d; } }

  /* ---------- state ---------- */
  var S = {
    token: lsGet(KEY.token), user: lsJson(KEY.user, null),
    project: null, savedSnap: {}, docs: {}, rendered: {}, tabs: [], active: null,
    openFolders: {}, hidden: false, chat: [], gen: null, lastReq: null, snapshot: null,
    errors: [], device: "phone", mode: "new", streamWrite: false, follow: true,
    frameMode: "none", frameReady: false, pending: null, scrollY: 0, tabWin: null
  };

  /* ---------- tiny utils ---------- */
  function uid() { return "p_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    for (var k in (attrs || {})) {
      if (k === "class") n.className = attrs[k]; else if (k === "text") n.textContent = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]); else n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  var toastT;
  function toast(msg, bad) {
    var t = $("#toast"); t.textContent = "";
    t.appendChild(el("div", { class: "toast-in" + (bad ? " bad" : ""), text: msg }));
    t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("show"); }, 3200);
  }
  function debounce(fn, ms) { var t; return function () { var a = arguments, c = this; clearTimeout(t); t = setTimeout(function () { fn.apply(c, a); }, ms); }; }
  function isKeep(p) { return /(^|\/)\.keep$/.test(p); }
  function realFiles(files) { var o = {}; Object.keys(files).forEach(function (k) { if (!isKeep(k)) o[k] = files[k]; }); return o; }
  function validPath(p) { return typeof p === "string" && p.length > 0 && p.length <= 200 && /^[\w\-./ ]+$/.test(p) && p.indexOf("..") < 0 && p[0] !== "/" && p.slice(-1) !== "/"; }
  function normPath(p) { return String(p || "").trim().replace(/^\.\//, "").replace(/^\/+/, ""); }
  function modeFor(p) {
    var e = (p.split(".").pop() || "").toLowerCase();
    if (e === "html" || e === "htm") return "htmlmixed";
    if (e === "css") return "css";
    if (e === "js" || e === "mjs") return "javascript";
    if (e === "json") return { name: "javascript", json: true };
    if (e === "md") return "markdown";
    if (e === "svg" || e === "xml") return "xml";
    return null;
  }

  /* ---------- API ---------- */
  function unwrap(txt) {
    var j; try { j = JSON.parse(txt); } catch (e) { return { error: txt.slice(0, 200) }; }
    if (j && typeof j === "object" && "json" in j && Object.keys(j).every(function (k) { return k === "json" || k === "meta"; })) return j.json;
    return j;
  }
  function withToken(path) { return API + path + (path.indexOf("?") < 0 ? "?" : "&") + "token=" + encodeURIComponent(S.token || ""); }
  // text/plain keeps these "simple" cross-origin requests, so no CORS preflight is needed.
  function call(path, body, method, signal) {
    var opts = { method: method || (body ? "POST" : "GET"), signal: signal };
    if (body !== undefined && opts.method !== "GET") { opts.body = typeof body === "string" ? body : JSON.stringify(body); opts.headers = { "Content-Type": "text/plain" }; }
    return fetch(withToken(path), opts).then(function (r) {
      return r.text().then(function (t) {
        var d = unwrap(t);
        if (r.status === 401) { onAuthLost(); throw new Error((d && (d.error || d.message)) || "Please sign in again."); }
        if (!r.ok) throw new Error((d && (d.error || d.message)) || ("Request failed (" + r.status + ")"));
        return d;
      });
    });
  }

  /* ---------- auth ---------- */
  function showAuth() { $("#auth").hidden = false; $("#app").hidden = true; }
  function onAuthLost() { S.token = null; lsDel(KEY.token); if (S.gen) abortGen("sign-in expired"); showAuth(); }
  $("#authForm").addEventListener("submit", function (e) {
    e.preventDefault(); $("#authErr").textContent = ""; var b = $("#authBtn"); b.disabled = true; b.textContent = "Signing in…";
    fetch(API + "/auth/login_with_password", { method: "POST", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ json: { email: $("#authEmail").value.trim(), password: $("#authPass").value } }) })
      .then(function (r) { return r.text().then(function (t) { return { ok: r.ok, d: unwrap(t) }; }); })
      .then(function (x) {
        if (!x.ok || !x.d || !x.d.token) throw new Error((x.d && (x.d.message || x.d.error)) || "Sign-in failed");
        S.token = x.d.token; S.user = x.d.user; lsSet(KEY.token, S.token); lsSet(KEY.user, JSON.stringify(S.user));
        $("#authPass").value = ""; startApp();
      })
      .catch(function (err) { $("#authErr").textContent = (err && err.message === "Failed to fetch") ? "Cannot reach the backend. Check your connection." : (err.message || "Sign-in failed"); })
      .then(function () { b.disabled = false; b.textContent = "Sign in"; });
  });

  /* ---------- project storage ---------- */
  function newProject(name) {
    var now = new Date().toISOString();
    return { id: uid(), name: name || "Untitled project", createdAt: now, updatedAt: now, files: {}, framework: "html", preview: { device: "phone" }, chat: [] };
  }
  function allLocal() { return lsJson(KEY.projects, {}); }
  function persistLocal() {
    var p = S.project; if (!p) return;
    p.updatedAt = new Date().toISOString(); p.chat = S.chat.slice(-40); p.preview = { device: S.device };
    var all = allLocal(); all[p.id] = p;
    if (!lsSet(KEY.projects, JSON.stringify(all))) toast("Browser storage is full. Export your project as ZIP.", true);
    lsSet(KEY.current, p.id);
  }
  var autosave = debounce(persistLocal, 700);
  function cloudSave() {
    if (!S.token || !S.project) return Promise.resolve();
    var p = S.project;
    return call("/projects/save", { id: p.id, name: p.name, data: { files: realFiles(p.files), framework: p.framework, preview: { device: S.device } } });
  }
  function dirtyPaths() {
    var f = S.project.files, out = {};
    Object.keys(f).forEach(function (k) { if (!isKeep(k) && S.savedSnap[k] !== f[k]) out[k] = 1; });
    Object.keys(S.savedSnap).forEach(function (k) { if (!(k in f)) out[k] = 1; });
    return out;
  }
  function refreshDirty() { var n = Object.keys(dirtyPaths()).length; $("#saveDot").hidden = !n; renderTabs(); }
  function doSave(quiet) {
    persistLocal(); S.savedSnap = JSON.parse(JSON.stringify(S.project.files)); refreshDirty();
    return cloudSave().then(function () { if (!quiet) toast("Project saved."); }, function (e) { toast("Saved on this device. Cloud sync failed: " + e.message, true); });
  }

  function loadProject(p) {
    if (S.gen) { toast("Stop the current generation first.", true); return; }
    Object.keys(S.docs).forEach(function (k) { delete S.docs[k]; }); S.rendered = {};
    S.project = p; S.savedSnap = JSON.parse(JSON.stringify(p.files || {})); S.tabs = []; S.active = null; S.errors = [];
    S.chat = (p.chat || []).slice(); S.device = (p.preview && p.preview.device) || "phone"; S.snapshot = null;
    $("#projName").textContent = p.name;
    var names = Object.keys(realFiles(p.files)); var first = names.indexOf("index.html") >= 0 ? "index.html" : names[0];
    if (first) openTab(first); else renderEditor();
    renderTree(); renderTabs(); renderChat(); setDevice(S.device); setMode(names.length ? "edit" : "new");
    $("#btnRegen").disabled = true; $("#btnRevert").disabled = true; refreshDirty(); renderErrors();
    fullReload(); persistLocal();
  }

  /* ---------- editor ---------- */
  var cm;
  function initEditor() {
    cm = CodeMirror($("#editorHost"), {
      value: "", lineNumbers: true, tabSize: 2, indentUnit: 2, smartIndent: true, lineWrapping: false,
      autoCloseBrackets: true, matchBrackets: true, autoCloseTags: true, styleActiveLine: true,
      extraKeys: { "Ctrl-Space": "autocomplete", "Ctrl-S": function () { doSave(); }, "Cmd-S": function () { doSave(); }, "Tab": function (c) { if (c.somethingSelected()) c.indentSelection("add"); else c.replaceSelection("  ", "end"); } }
    });
    cm.on("cursorActivity", function () { var c = cm.getCursor(); $("#cursorPos").textContent = "Ln " + (c.line + 1) + ", Col " + (c.ch + 1); });
    cm.on("inputRead", function (inst, ch) {
      if (S.streamWrite || S.gen || !ch.text || !/^[\w<.:-]$/.test(ch.text[0])) return;
      if (inst.state.completionActive) return;
      var m = inst.getModeAt(inst.getCursor()).name;
      if (m === "xml" || m === "css" || m === "javascript") inst.showHint({ hint: CodeMirror.hint.auto, completeSingle: false });
    });
    cm.on("scroll", function () {
      if (!S.gen) return; var i = cm.getScrollInfo();
      S.follow = (i.top + i.clientHeight) >= (i.height - 60);
    });
  }
  function getDoc(path) {
    if (!S.docs[path]) {
      var txt = S.project.files[path] || "";
      var d = CodeMirror.Doc(txt, modeFor(path));
      d.on("change", function () { onDocChange(path, d); });
      S.docs[path] = d; S.rendered[path] = txt;
    }
    return S.docs[path];
  }
  var previewSoon = debounce(function () { if (S.gen) return; fullReload(); }, 700);
  function onDocChange(path, d) {
    if (S.streamWrite) return;
    S.project.files[path] = d.getValue(); S.rendered[path] = S.project.files[path];
    autosave(); refreshDirty(); previewSoon();
  }
  function renderEditor() {
    var has = S.active && S.project.files[S.active] != null;
    $("#editorEmpty").hidden = !!has; $("#editorHost").style.visibility = has ? "visible" : "hidden";
    if (has) { cm.swapDoc(getDoc(S.active)); cm.setOption("readOnly", S.gen ? true : false); markErrLines(); setTimeout(function () { cm.refresh(); }, 0); }
  }
  function openTab(path) {
    if (S.project.files[path] == null) return;
    if (S.tabs.indexOf(path) < 0) S.tabs.push(path);
    S.active = path; renderTabs(); renderEditor(); renderTree();
  }
  function closeTab(path) {
    var i = S.tabs.indexOf(path); if (i < 0) return; S.tabs.splice(i, 1);
    if (S.active === path) S.active = S.tabs[Math.min(i, S.tabs.length - 1)] || null;
    renderTabs(); renderEditor(); renderTree();
  }
  function renderTabs() {
    var host = $("#tabsStrip"); host.textContent = ""; var dirty = S.project ? dirtyPaths() : {};
    S.tabs.forEach(function (p) {
      var live = S.gen && S.gen.curPath === p;
      var t = el("div", { class: "etab" + (p === S.active ? " on" : ""), title: p, onclick: function () { if (S.gen) S.follow = false; openTab(p); } }, [
        live ? el("span", { class: "live", title: "Generating" }) : null,
        p.split("/").pop(),
        dirty[p] && !live ? el("span", { class: "dot", title: "Unsaved changes" }) : null,
        el("button", { class: "x", "aria-label": "Close " + p, text: "×", onclick: function (e) { e.stopPropagation(); closeTab(p); } })
      ]);
      host.appendChild(t);
    });
  }
  function setFileText(path, text) {
    S.project.files[path] = text;
    var d = S.docs[path];
    if (!d) { S.rendered[path] = text; return; }
    var last = S.rendered[path] || "";
    S.streamWrite = true;
    try {
      if (text.indexOf(last) === 0) {
        if (text.length > last.length) { var end = { line: d.lastLine(), ch: d.getLine(d.lastLine()).length }; d.replaceRange(text.slice(last.length), end, end, "+stream"); }
      } else d.setValue(text);
    } finally { S.streamWrite = false; }
    S.rendered[path] = text;
    if (path === S.active && S.follow) { var h = cm.getScrollInfo().height; cm.scrollTo(null, h); }
  }
  function dropFileState(path) { delete S.docs[path]; delete S.rendered[path]; }

  /* ---------- explorer ---------- */
  function buildTree(files) {
    var root = { dirs: {}, files: [] };
    Object.keys(files).forEach(function (p) {
      var parts = p.split("/"), n = root;
      for (var i = 0; i < parts.length - 1; i++) { n = n.dirs[parts[i]] = n.dirs[parts[i]] || { dirs: {}, files: [] }; }
      if (!isKeep(p)) n.files.push({ name: parts[parts.length - 1], path: p });
    });
    return root;
  }
  function renderTree() {
    var host = $("#tree"); host.textContent = "";
    if (!S.project) return;
    var root = buildTree(S.project.files);
    (function walk(node, prefix, depth) {
      Object.keys(node.dirs).sort().forEach(function (d) {
        var full = prefix + d, open = S.openFolders[full] !== false;
        var row = el("div", { class: "trow", style: "padding-left:" + (6 + depth * 12) + "px", onclick: function () { S.openFolders[full] = !open; renderTree(); } }, [
          el("span", { text: open ? "▾ 📁" : "▸ 📁" }), el("span", { class: "nm", text: d }),
          el("span", { class: "ops" }, [
            el("button", { title: "Rename folder", text: "✎", onclick: function (e) { e.stopPropagation(); renameFolder(full); } }),
            el("button", { title: "Delete folder", text: "✕", onclick: function (e) { e.stopPropagation(); deleteFolder(full); } })])
        ]);
        host.appendChild(row);
        if (open) walk(node.dirs[d], full + "/", depth + 1);
      });
      node.files.sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (f) {
        host.appendChild(el("div", { class: "trow" + (f.path === S.active ? " on" : ""), style: "padding-left:" + (6 + depth * 12) + "px", title: f.path, onclick: function () { if (S.gen) S.follow = false; openTab(f.path); if (matchMedia("(max-width:1100px)").matches) { $("#files").classList.add("collapsed"); S.hidden = true; } } }, [
          el("span", { text: "📄" }), el("span", { class: "nm", text: f.name }),
          el("span", { class: "ops" }, [
            el("button", { title: "Rename", text: "✎", onclick: function (e) { e.stopPropagation(); renameFile(f.path); } }),
            el("button", { title: "Delete", text: "✕", onclick: function (e) { e.stopPropagation(); deleteFile(f.path); } })])
        ]));
      });
    })(root, "", 0);
    if (!host.firstChild) host.appendChild(el("div", { class: "muted small", style: "padding:10px", text: "No files yet." }));
  }
  function guardGen() { if (S.gen) { toast("Wait for generation to finish (or stop it).", true); return true; } return false; }
  function newFile() {
    if (guardGen()) return;
    ask({ title: "New file", label: "Path (e.g. about.html or src/app.js)", confirm: "Create" }).then(function (v) {
      if (v == null) return; v = normPath(v);
      if (!validPath(v)) return toast("Invalid file name.", true);
      if (S.project.files[v] != null) return toast("That file already exists.", true);
      var dir = v.indexOf("/") > 0 ? v.slice(0, v.lastIndexOf("/") + 1) : "";
      if (dir && S.project.files[dir + ".keep"] != null) delete S.project.files[dir + ".keep"];
      S.project.files[v] = ""; autosave(); openTab(v); refreshDirty(); toast("Created " + v);
    });
  }
  function newFolder() {
    if (guardGen()) return;
    ask({ title: "New folder", label: "Folder path (e.g. src/components)", confirm: "Create" }).then(function (v) {
      if (v == null) return; v = normPath(v).replace(/\/+$/, "");
      if (!validPath(v)) return toast("Invalid folder name.", true);
      S.project.files[v + "/.keep"] = ""; S.openFolders[v] = true; autosave(); renderTree();
    });
  }
  function renameFile(path) {
    if (guardGen()) return;
    ask({ title: "Rename file", label: "New path", value: path, confirm: "Rename" }).then(function (v) {
      if (v == null) return; v = normPath(v);
      if (v === path) return; if (!validPath(v)) return toast("Invalid file name.", true);
      if (S.project.files[v] != null) return toast("A file with that name exists.", true);
      moveFile(path, v); renderTree(); renderTabs(); renderEditor(); autosave(); refreshDirty(); previewSoon();
    });
  }
  function moveFile(a, b) {
    S.project.files[b] = S.project.files[a]; delete S.project.files[a]; dropFileState(a); dropFileState(b);
    S.tabs = S.tabs.map(function (t) { return t === a ? b : t; }); if (S.active === a) S.active = b;
  }
  function renameFolder(folder) {
    if (guardGen()) return;
    ask({ title: "Rename folder", label: "New folder path", value: folder, confirm: "Rename" }).then(function (v) {
      if (v == null) return; v = normPath(v).replace(/\/+$/, ""); if (v === folder) return; if (!validPath(v)) return toast("Invalid folder name.", true);
      Object.keys(S.project.files).filter(function (p) { return p.indexOf(folder + "/") === 0; }).forEach(function (p) {
        var np = v + p.slice(folder.length); if (S.project.files[np] != null) return; moveFile(p, np);
      });
      renderTree(); renderTabs(); renderEditor(); autosave(); refreshDirty(); previewSoon();
    });
  }
  function deleteFile(path) {
    if (guardGen()) return;
    ask({ title: "Delete file", body: "Delete " + path + "? This cannot be undone.", confirm: "Delete", danger: true, noInput: true }).then(function (v) {
      if (v == null) return; delete S.project.files[path]; dropFileState(path); closeTabQuiet(path);
      renderTree(); renderTabs(); renderEditor(); autosave(); refreshDirty(); previewSoon();
    });
  }
  function closeTabQuiet(p) { var i = S.tabs.indexOf(p); if (i >= 0) S.tabs.splice(i, 1); if (S.active === p) S.active = S.tabs[S.tabs.length - 1] || null; }
  function deleteFolder(folder) {
    if (guardGen()) return;
    var list = Object.keys(S.project.files).filter(function (p) { return p.indexOf(folder + "/") === 0; });
    ask({ title: "Delete folder", body: "Delete " + folder + " and the " + list.filter(function (p) { return !isKeep(p); }).length + " file(s) inside it?", confirm: "Delete", danger: true, noInput: true }).then(function (v) {
      if (v == null) return; list.forEach(function (p) { delete S.project.files[p]; dropFileState(p); closeTabQuiet(p); });
      renderTree(); renderTabs(); renderEditor(); autosave(); refreshDirty(); previewSoon();
    });
  }

  /* ---------- modal ---------- */
  function ask(o) {
    return new Promise(function (resolve) {
      var m = $("#modal"), sheet = el("form", { class: "sheet" }), inp;
      sheet.appendChild(el("h3", { text: o.title }));
      if (o.body) sheet.appendChild(el("p", { class: "muted", text: o.body }));
      if (!o.noInput) { inp = el("input", { type: "text", value: o.value || "", autocomplete: "off", spellcheck: "false" }); sheet.appendChild(el("label", {}, [o.label || "", inp])); }
      var done = function (v) { m.hidden = true; m.textContent = ""; resolve(v); };
      sheet.appendChild(el("div", { class: "row end" }, [
        el("button", { class: "btn", type: "button", text: o.cancel || "Cancel", onclick: function () { done(null); } }),
        el("button", { class: "btn " + (o.danger ? "danger" : "primary"), type: "submit", text: o.confirm || "OK" })]));
      sheet.addEventListener("submit", function (e) { e.preventDefault(); done(inp ? inp.value : true); });
      m.textContent = ""; m.appendChild(sheet); m.hidden = false; if (inp) { inp.focus(); inp.select(); }
    });
  }
  function openSheet(build) {
    var m = $("#modal"), sheet = el("div", { class: "sheet" }); var close = function () { m.hidden = true; m.textContent = ""; };
    build(sheet, close); m.textContent = ""; m.appendChild(sheet); m.hidden = false;
  }
  $("#modal").addEventListener("mousedown", function (e) { if (e.target === this) { this.hidden = true; this.textContent = ""; } });

  /* ---------- preview engine ---------- */
  var frame = $("#frame");
  function htmlName() {
    var f = S.project.files; if (f["index.html"] != null) return "index.html";
    var k = Object.keys(f).filter(function (p) { return /\.html?$/i.test(p) && !isKeep(p); }); return k[0] || null;
  }
  function isLocal(href) { return href && !/^([a-z]+:)?\/\//i.test(href) && href.indexOf("data:") !== 0; }
  function lookup(href, base) {
    href = normPath(href.split("#")[0].split("?")[0]);
    var dir = base && base.indexOf("/") > 0 ? base.slice(0, base.lastIndexOf("/") + 1) : "";
    if (S.project.files[dir + href] != null) return dir + href;
    return S.project.files[href] != null ? href : null;
  }
  // Used while streaming: link tags to local CSS are replaced by their text and sent separately.
  function liveParts() {
    var hn = htmlName(); if (!hn) return null;
    var css = "", html = S.project.files[hn] || "";
    html = html.replace(/<link\b[^>]*>/gi, function (tag) {
      if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
      var m = /href\s*=\s*["']([^"']+)["']/i.exec(tag); if (!m || !isLocal(m[1])) return tag;
      var p = lookup(m[1], hn); if (p) { css += "\n" + S.project.files[p]; return ""; } return tag;
    });
    return { html: html, css: css };
  }
  var REPORTER = function (y) {
    return "<script>(function(){var T=window.opener||window.parent;function s(m,l,src){try{T.postMessage({fab:1,type:'err',message:String(m),line:l||0,src:src||''},'*')}catch(e){}}" +
      "try{localStorage.getItem('x')}catch(e){var mk=function(){var m={};return{getItem:function(k){return k in m?m[k]:null},setItem:function(k,v){m[k]=String(v)},removeItem:function(k){delete m[k]},clear:function(){m={}},key:function(i){return Object.keys(m)[i]||null},get length(){return Object.keys(m).length}}};try{Object.defineProperty(window,'localStorage',{value:mk()});Object.defineProperty(window,'sessionStorage',{value:mk()})}catch(e2){}}" +
      "window.addEventListener('error',function(e){if(e.target&&e.target!==window)return;s(e.message,e.lineno,e.filename)});" +
      "window.addEventListener('unhandledrejection',function(e){var r=e.reason;s('Unhandled promise rejection: '+(r&&r.message||r))});" +
      "var ce=console.error;console.error=function(){try{s('console.error: '+Array.prototype.join.call(arguments,' '))}catch(e){}ce.apply(console,arguments)};" +
      "var st;addEventListener('scroll',function(){clearTimeout(st);st=setTimeout(function(){try{T.postMessage({fab:1,type:'scroll',y:scrollY},'*')}catch(e){}},120)},{passive:true});" +
      "addEventListener('load',function(){" + (y ? "scrollTo(0," + (+y || 0) + ");" : "") + "try{T.postMessage({fab:1,type:'loaded'},'*')}catch(e){}});})();<\/script>";
  };
  function assembleFinal(forTab) {
    var hn = htmlName(); if (!hn) return null;
    var html = S.project.files[hn] || "";
    html = html.replace(/<link\b[^>]*>/gi, function (tag) {
      if (!/rel\s*=\s*["']?stylesheet/i.test(tag)) return tag;
      var m = /href\s*=\s*["']([^"']+)["']/i.exec(tag); if (!m || !isLocal(m[1])) return tag;
      var p = lookup(m[1], hn); return p ? "<style data-file=\"" + p + "\">\n" + S.project.files[p].replace(/<\/style/gi, "<\\/style") + "\n</style>" : tag;
    });
    html = html.replace(/<script\b([^>]*?)\bsrc\s*=\s*["']([^"']+)["']([^>]*)>\s*<\/script>/gi, function (all, a, src, b) {
      if (!isLocal(src)) return all;
      var p = lookup(src, hn); if (!p) return all;
      return "<script" + a + b + ">\n" + S.project.files[p].replace(/<\/script/gi, "<\\/script") + "\n//# sourceURL=" + p + "\n</script>";
    });
    var rep = REPORTER(forTab ? 0 : S.scrollY);
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, function (m) { return m + rep; });
    else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, function (m) { return m + "<head>" + rep + "</head>"; });
    else html = "<head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" + rep + "</head>" + html;
    if (!/<!doctype/i.test(html)) html = "<!doctype html>" + html;
    return html;
  }
  function sendToFrame(msg) {
    if (S.frameReady && frame.contentWindow) frame.contentWindow.postMessage(msg, "*"); else S.pending = msg;
  }
  function loadRuntime(mode) {
    S.frameMode = mode; S.frameReady = false; S.pending = null;
    frame.src = "preview.html?r=" + Date.now();
  }
  function updateEmpty() { $("#prevEmpty").hidden = !!htmlName() && !!(S.project.files[htmlName()] || "").trim(); }
  var liveTimer = 0, lastLive = 0;
  function liveUpdate() {
    if (!S.project) return; updateEmpty();
    var now = Date.now();
    if (now - lastLive < 120) { if (!liveTimer) liveTimer = setTimeout(function () { liveTimer = 0; liveUpdate(); }, 130); return; }
    lastLive = now;
    var p = liveParts(); if (!p || !p.html.trim()) return;
    if (S.frameMode !== "live") { loadRuntime("live"); }
    sendToFrame({ fab: 1, type: "live", html: p.html, css: p.css });
    if (S.gen) S.gen.previewAt = now;
  }
  function fullReload() {
    if (!S.project) return; updateEmpty(); S.errors = []; renderErrors(); markErrLines();
    var doc = assembleFinal(false);
    if (!doc || !(S.project.files[htmlName()] || "").trim()) { S.frameMode = "none"; frame.src = "about:blank"; S.frameReady = false; return; }
    S.finalDoc = doc; loadRuntime("final");
  }
  window.addEventListener("message", function (e) {
    var d = e.data; if (!d || d.fab !== 1) return;
    var isFrame = frame.contentWindow && e.source === frame.contentWindow, isTab = S.tabWin && !S.tabWin.closed && e.source === S.tabWin;
    if (!isFrame && !isTab) return;
    if (d.type === "ready") {
      if (isTab) { var tdoc = assembleFinal(true); if (tdoc) S.tabWin.postMessage({ fab: 1, type: "final", html: tdoc }, "*"); return; }
      S.frameReady = true;
      if (S.frameMode === "final" && S.finalDoc) sendToFrame({ fab: 1, type: "final", html: S.finalDoc });
      else if (S.pending) { var pm = S.pending; S.pending = null; frame.contentWindow.postMessage(pm, "*"); }
      else if (S.frameMode === "live") liveUpdate();
    } else if (d.type === "scroll" && isFrame) S.scrollY = d.y || 0;
    else if (d.type === "loaded" && isFrame && S.gen) S.gen.loadedAt = Date.now();
    else if (d.type === "err" || d.type === "preview-error") addError(d);
  });
  function guessFile(src) {
    if (src) { var m = /([\w\-./]+\.(?:js|mjs|css|html?))\s*$/i.exec(src); if (m && S.project.files[m[1]] != null) return m[1]; }
    return htmlName() || "";
  }
  function addError(d) {
    var file = guessFile(d.src), key = file + ":" + d.line + ":" + d.message;
    if (S.errors.some(function (x) { return x.key === key; }) || S.errors.length >= 8) return;
    S.errors.push({ key: key, message: d.message, file: file, line: d.line || 0 }); renderErrors(); markErrLines();
  }
  function renderErrors() {
    var n = S.errors.length; $("#errStrip").hidden = !n;
    if (n) $("#errText").textContent = n + " preview error" + (n > 1 ? "s" : "") + ": " + S.errors[0].message.slice(0, 90) + (S.errors[0].line ? " (" + S.errors[0].file + ":" + S.errors[0].line + ")" : "");
  }
  var errMarks = [];
  function markErrLines() {
    if (!cm) return; errMarks.forEach(function (m) { try { m.doc.removeLineClass(m.line, "background", "errline"); } catch (e) {} }); errMarks = [];
    var d = S.active && S.docs[S.active]; if (!d) return;
    S.errors.forEach(function (er) { if (er.file === S.active && er.line > 0 && er.line <= d.lineCount()) { d.addLineClass(er.line - 1, "background", "errline"); errMarks.push({ doc: d, line: er.line - 1 }); } });
  }
  function setDevice(dev) {
    S.device = dev; var d = $("#device"); d.className = "device " + dev;
    document.querySelectorAll("[data-dev]").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-dev") === dev); });
    fitDevice();
  }
  function fitDevice() {
    var st = $("#stage"), d = $("#device"); if (!st || !d.offsetWidth) return;
    var sc_ = $("#scaler");
    if (!sc_) { sc_ = el("div", { id: "scaler", class: "scaler" }); d.parentNode.insertBefore(sc_, d); sc_.appendChild(d); }
    var w = d.offsetWidth, h = d.offsetHeight, cw = st.clientWidth - 24, ch = st.clientHeight - 24;
    var sc = Math.min(1, cw / w, ch / h); if (!(sc > 0)) sc = 1;
    d.style.transform = "scale(" + sc + ")";
    sc_.style.width = Math.round(w * sc) + "px"; sc_.style.height = Math.round(h * sc) + "px";
  }
  if (window.ResizeObserver) new ResizeObserver(fitDevice).observe($("#stage"));
  window.addEventListener("resize", fitDevice);

  /* ---------- chat + status UI ---------- */
  function addMsg(role, text, extra) { var m = { role: role, text: text }; if (extra) for (var k in extra) m[k] = extra[k]; S.chat.push(m); renderChat(); autosave(); return m; }
  function renderChat() {
    var host = $("#chatLog"); host.textContent = "";
    if (!S.chat.length) host.appendChild(el("div", { class: "msg sys", text: "Welcome to FABLOCK AI BUILDER PRO. Describe a website or app and watch the code and phone preview build live. Try: \"Create a mobile login page with a purple gradient background, a welcome heading, an email input, a password input, and a login button.\"" }));
    S.chat.forEach(function (m, i) {
      var cls = m.role === "user" ? "user" : m.role === "error" ? "ai error" : m.role === "sys" ? "sys" : "ai";
      var node = el("div", { class: "msg " + cls }, [el("div", { text: m.text })]);
      if (m.files && m.files.length) node.appendChild(el("div", { class: "chips" }, m.files.map(function (f) {
        return el("span", { class: "chip", title: "Open " + f.path, text: f.path + (f.note ? " " + f.note : ""), onclick: function () { openTab(f.path); showView("code"); } }); })));
      if (m.retry && i === S.chat.length - 1) node.appendChild(el("div", { class: "act" }, [el("button", { class: "btn sm", text: "Retry", onclick: retryLast })]));
      host.appendChild(node);
    });
    host.scrollTop = host.scrollHeight;
  }
  var STEPS = ["Understand", "Plan", "Write", "Preview", "Check", "Ready"];
  function renderSteps(idx) {
    var host = $("#steps"); host.textContent = "";
    STEPS.forEach(function (s, i) { host.appendChild(el("span", { class: i < idx ? "done" : i === idx ? "on" : "", text: s })); });
  }
  function setStage(idx, text, meta) {
    $("#genStatus").hidden = false; renderSteps(idx); $("#stageText").textContent = text; $("#stageMeta").textContent = meta || "";
    var bar = $("#barFill").parentNode; bar.classList.toggle("indet", idx < 5 && !(S.gen && S.gen.chars > 0 && idx >= 2));
    $("#barFill").style.width = idx >= 5 ? "100%" : (idx >= 2 ? Math.min(92, 20 + Math.round(Math.sqrt((S.gen && S.gen.chars) || 0) / 2.4)) + "%" : "");
  }
  function stageForFile(path) {
    var e = (path.split(".").pop() || "").toLowerCase();
    if (e === "css") return "Writing CSS (" + path + ")...";
    if (e === "js" || e === "mjs") return "Generating JavaScript (" + path + ")...";
    return "Creating " + path + "...";
  }
  function setMode(m) {
    var hasFiles = Object.keys(realFiles(S.project ? S.project.files : {})).length > 0;
    if (m === "edit" && !hasFiles) m = "new";
    S.mode = m; $("#modeNew").classList.toggle("on", m === "new"); $("#modeEdit").classList.toggle("on", m === "edit");
    $("#modeEdit").disabled = !hasFiles;
    $("#btnGen").textContent = m === "new" ? "Generate Project" : "Apply Changes";
    $("#prompt").placeholder = m === "new" ? "Describe what to build…  (Ctrl+Enter to send)" : "Describe what to change in the current project…  (Ctrl+Enter)";
  }
  function setBusy(b) {
    $("#btnGen").hidden = b; $("#btnStop").hidden = !b; $("#btnPause").hidden = !b; $("#btnPause").textContent = "Pause";
    ["#btnClear", "#modeNew", "#modeEdit", "#btnFix"].forEach(function (s) { $(s).disabled = b; });
    $("#prompt").readOnly = b; if (cm) cm.setOption("readOnly", b ? true : false);
    if (!b) setMode(S.mode);
  }

  /* ---------- stream parser ---------- */
  function makeParser(cb) {
    var buf = "", pos = 0, cur = null, closing = "</file>";
    function clean(t) { return t.replace(/^\r?\n/, "").replace(/^```[\w-]*\r?\n/, "").replace(/\r?\n?```\s*$/, ""); }
    return {
      feed: function (s) { buf += s; },
      cur: function () { return cur; },
      process: function () {
        for (;;) {
          if (!cur) {
            var fi = buf.indexOf("<file", pos), ni = buf.indexOf("<note>", pos);
            if (ni >= 0 && (fi < 0 || ni < fi)) { var ne = buf.indexOf("</note>", ni); if (ne < 0) return; cb.note(buf.slice(ni + 6, ne).trim()); pos = ne + 7; continue; }
            if (fi < 0) return;
            var m = /^<file\s+path\s*=\s*["']([^"']+)["']\s*>/.exec(buf.slice(fi, fi + 400));
            if (!m) { if (buf.length - fi < 400) return; pos = fi + 5; continue; }
            cur = { path: normPath(m[1]), start: fi + m[0].length, ok: validPath(normPath(m[1])) }; pos = cur.start;
            if (cur.ok) cb.open(cur.path); continue;
          }
          var ci = buf.indexOf(closing, cur.start);
          if (ci >= 0) { if (cur.ok) cb.file(cur.path, clean(buf.slice(cur.start, ci)), true); pos = ci + closing.length; cur = null; continue; }
          var part = buf.slice(cur.start);
          for (var k = Math.min(closing.length - 1, part.length); k > 0; k--) { if (closing.indexOf(part.slice(-k)) === 0) { part = part.slice(0, -k); break; } }
          if (cur.ok) cb.file(cur.path, clean(part), false);
          return;
        }
      }
    };
  }

  /* ---------- generation ---------- */
  function lineDiff(oldT, newT) {
    var oc = {}, nc = {}, a = 0, r = 0;
    (oldT || "").split("\n").forEach(function (l) { oc[l] = (oc[l] || 0) + 1; });
    (newT || "").split("\n").forEach(function (l) { nc[l] = (nc[l] || 0) + 1; });
    Object.keys(nc).forEach(function (l) { a += Math.max(0, nc[l] - (oc[l] || 0)); });
    Object.keys(oc).forEach(function (l) { r += Math.max(0, oc[l] - (nc[l] || 0)); });
    return { added: a, removed: r, oldLines: (oldT || "").split("\n").length };
  }
  function historyForAI() {
    return S.chat.filter(function (m) { return m.role === "user" || (m.role === "ai" && m.text); }).slice(-6).map(function (m) { return { role: m.role === "user" ? "user" : "assistant", content: String(m.text).slice(0, 1500) }; });
  }
  function startGen(req) {
    if (S.gen) return;
    if (!S.token) return showAuth();
    var P = S.project, mode = req.mode;
    S.lastReq = req; S.snapshot = JSON.parse(JSON.stringify(P.files));
    var sentFiles = mode === "generate" ? undefined : realFiles(P.files);
    var body = { prompt: req.prompt || "", history: historyForAI() };
    if (sentFiles) body.files = sentFiles;
    if (mode === "fix") { body.error = req.error; body.errorFile = req.errorFile; }
    if (req.userText) addMsg("user", req.userText);
    var g = S.gen = { ctrl: new AbortController(), mode: mode, paused: false, resume: null, chars: 0, started: Date.now(), curPath: null, written: {}, note: "", finished: false, usage: null, finish: null, stopped: false, previewAt: 0, loadedAt: 0 };
    if (mode === "generate") {
      Object.keys(P.files).forEach(function (k) { delete P.files[k]; dropFileState(k); }); S.tabs = []; S.active = null; renderTree(); renderTabs(); renderEditor();
    }
    S.errors = []; renderErrors(); S.follow = true; S.scrollY = 0;
    setBusy(true); setStage(0, "Understanding your request...", ""); $("#btnRegen").disabled = true; $("#btnRevert").disabled = true;
    var aiMsg = addMsg("ai", "Working on it…");
    var parser = makeParser({
      note: function (n) { g.note = n; aiMsg.text = n; renderChat(); setStage(1, "Planning project structure...", n); },
      open: function (p) {
        g.curPath = p; if (P.files[p] == null) P.files[p] = ""; var existed = !!S.docs[p];
        if (existed && g.mode !== "generate") { dropFileState(p); }  // rewrite from empty so the editor shows the new code arriving
        P.files[p] = ""; if (S.tabs.indexOf(p) < 0) S.tabs.push(p);
        if (S.follow || !S.active) { S.active = p; }
        getDoc(p); S.rendered[p] = ""; S.streamWrite = true; S.docs[p].setValue(""); S.streamWrite = false;
        renderTree(); renderTabs(); renderEditor(); setStage(2, stageForFile(p), "");
      },
      file: function (p, text, complete) {
        setFileText(p, text); g.written[p] = text; if (complete) { g.curPath = null; }
      }
    });
    var flushT = 0;
    function flush() {
      flushT = 0; parser.process(); renderTabs();
      var c = parser.cur(); if (c && c.ok) setStage(2, stageForFile(c.path), g.chars + " chars · " + Math.round((Date.now() - g.started) / 1000) + "s");
      liveUpdate();
    }
    function schedule() { if (!flushT) flushT = setTimeout(flush, 80); }
    var watchdog = 0;
    function arm() { clearTimeout(watchdog); watchdog = setTimeout(function () { g.stalled = true; g.ctrl.abort(); }, 60000); }

    function handle(ev) {
      if (ev.t === "content") { g.chars += ev.d.length; parser.feed(ev.d); schedule(); }
      else if (ev.t === "thinking") { if (!g.chars) setStage(0, "Understanding your request...", "model is reasoning"); }
      else if (ev.t === "done") { g.finished = true; g.usage = ev.usage; g.finish = ev.finish; }
      else if (ev.t === "error") { throw new Error(ev.m || "The AI provider reported an error."); }
    }
    arm();
    fetch(withToken("/ai/" + mode), { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body), signal: g.ctrl.signal })
      .then(function (res) {
        if (!res.ok) return res.text().then(function (t) { var d = unwrap(t); if (res.status === 401) onAuthLost(); throw new Error((d && (d.error || d.message)) || ("Request failed (" + res.status + ")")); });
        var reader = res.body.getReader(), dec = new TextDecoder(), sse = "";
        function pump() {
          return (g.paused ? new Promise(function (r) { g.resume = r; }) : Promise.resolve()).then(function () {
            return reader.read();
          }).then(function (r) {
            if (r.done) return;
            arm(); sse += dec.decode(r.value, { stream: true });
            var parts = sse.split("\n\n"); sse = parts.pop();
            parts.forEach(function (blk) {
              blk.split("\n").forEach(function (line) {
                if (line.indexOf("data:") !== 0) return; var j; try { j = JSON.parse(line.slice(5)); } catch (e) { return; } handle(j);
              });
            });
            return pump();
          });
        }
        return pump();
      })
      .then(function () {
        clearTimeout(watchdog); clearTimeout(flushT); parser.process();
        if (!g.finished && !g.stopped) throw new Error("The stream ended before the AI finished.");
      })
      .then(function () { return finishGen(g, aiMsg, parser); }, function (err) { clearTimeout(watchdog); clearTimeout(flushT); return failGen(g, aiMsg, err); });
  }

  function endGen() { S.gen = null; setBusy(false); renderTabs(); }
  function restoreSnapshot() {
    var P = S.project; Object.keys(P.files).forEach(function (k) { delete P.files[k]; });
    Object.keys(S.snapshot || {}).forEach(function (k) { P.files[k] = S.snapshot[k]; });
    S.docs = {}; S.rendered = {};
    S.tabs = S.tabs.filter(function (t) { return P.files[t] != null; }); if (S.active && P.files[S.active] == null) S.active = S.tabs[0] || null;
    if (!S.active) { var n = Object.keys(realFiles(P.files)); if (n.length) { S.active = n.indexOf("index.html") >= 0 ? "index.html" : n[0]; if (S.tabs.indexOf(S.active) < 0) S.tabs.push(S.active); } }
    renderTree(); renderTabs(); renderEditor(); persistLocal(); refreshDirty(); fullReload();
  }
  function failGen(g, aiMsg, err) {
    var aborted = err && err.name === "AbortError";
    if (aborted && g.stopped && !g.stalled) {
      // user pressed Stop: keep what arrived, but let them undo it
      aiMsg.text = (g.note ? g.note + " " : "") + "Generation stopped. The code written so far was kept.";
      endGen(); setStage(5, "Stopped", ""); $("#btnRevert").disabled = false; $("#btnRegen").disabled = false; Object.keys(g.written).forEach(function (p) { if (S.docs[p]) S.docs[p].clearHistory(); });
      renderChat(); persistLocal(); refreshDirty(); fullReload(); return;
    }
    var msg = g.stalled ? "No data arrived for 60 seconds, so the generation was cancelled." : (err && err.message === "Failed to fetch" ? "Lost connection to the backend." : (err && err.message) || "Generation failed.");
    restoreSnapshot(); endGen(); setStage(5, "Failed", "your previous files were restored");
    aiMsg.role = "error"; aiMsg.text = msg + " Your previous project files were restored."; aiMsg.retry = true; $("#btnRegen").disabled = false;
    renderChat(); persistLocal();
  }
  function finishGen(g, aiMsg, parser) {
    var P = S.project, written = Object.keys(g.written), c = parser.cur();
    var truncated = g.finish === "length" || !!c;
    if (c && c.ok && g.written[c.path] == null) { /* nothing */ }
    if (!written.length) return failGen(g, aiMsg, new Error("The AI returned no files. Try rephrasing your request."));
    // diff summary + destructive-change check
    var changes = [], risky = [];
    written.forEach(function (p) {
      var old = S.snapshot[p], dfs = lineDiff(old, g.written[p]);
      if (old == null) changes.push({ path: p, note: "(new)" });
      else if (old !== g.written[p]) { changes.push({ path: p, note: "(+" + dfs.added + " −" + dfs.removed + ")" }); if (g.mode !== "generate" && dfs.oldLines >= 30 && dfs.removed / dfs.oldLines > 0.5) risky.push(p + " loses " + dfs.removed + " of " + dfs.oldLines + " lines"); }
    });
    var go = risky.length ? ask({ title: "Large change detected", body: "The AI would remove a lot of existing code: " + risky.join("; ") + ". Keep these changes?", confirm: "Keep changes", cancel: "Revert", danger: true, noInput: true }) : Promise.resolve(true);
    return go.then(function (keep) {
      if (keep == null) { restoreSnapshot(); endGen(); aiMsg.text = "Changes reverted at your request."; aiMsg.files = null; setStage(5, "Reverted", ""); renderChat(); return; }
      written.forEach(function (p) { if (S.docs[p]) S.docs[p].clearHistory(); });
      if (g.mode === "generate" && !S.project.nameSet) { var nm = (g.note || S.lastReq.prompt || "").replace(/\s+/g, " ").trim().slice(0, 40); if (nm) { P.name = nm; $("#projName").textContent = nm; } }
      var first = written.indexOf("index.html") >= 0 ? "index.html" : written[0];
      if (S.follow || !S.active) { S.active = first; if (S.tabs.indexOf(first) < 0) S.tabs.push(first); }
      aiMsg.files = changes; aiMsg.text = (g.note ? g.note + "\n" : "") + (g.mode === "fix" ? "Applied a targeted fix." : changes.length + " file(s) " + (g.mode === "generate" ? "created." : "updated.")) + (truncated ? "\nWarning: the AI hit its output limit, so the last file may be incomplete." : "");
      renderTree(); renderTabs(); renderEditor(); renderChat(); persistLocal(); refreshDirty();
      $("#btnRevert").disabled = false; $("#btnRegen").disabled = false;
      // Final run: reload the preview with the complete project, then really watch for errors.
      setStage(4, "Checking for errors...", "running the finished project"); S.gen.finishing = true;
      var t0 = Date.now(); g.loadedAt = 0; fullReload();
      return waitFor(function () { return g.loadedAt || Date.now() - t0 > 5000; }, 6000).then(function () { return sleep(900); }).then(function () {
        var n = S.errors.length; endGen();
        if (n) { setStage(5, "Finished with " + n + " preview error" + (n > 1 ? "s" : ""), "use Fix errors with AI"); aiMsg.text += "\nThe preview reported " + n + " error" + (n > 1 ? "s" : "") + ". Use \"Fix errors with AI\" to repair them."; }
        else if (!htmlName()) setStage(5, "Files ready (no HTML page to preview)", "");
        else setStage(5, "Project ready.", "no preview errors reported");
        renderChat(); doSave(true);
      });
    });
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitFor(fn, max) { var t0 = Date.now(); return new Promise(function (res) { (function tick() { if (fn() || Date.now() - t0 > max) return res(); setTimeout(tick, 100); })(); }); }
  function abortGen(why) { if (S.gen) { S.gen.stopped = true; if (S.gen.resume) { S.gen.resume(); S.gen.resume = null; } S.gen.ctrl.abort(); } }

  function retryLast() {
    if (S.gen || !S.lastReq) return;
    S.chat = S.chat.filter(function (m) { return !m.retry; }); var r = S.lastReq; r.userText = null; startGen(r);
  }
  function currentRequest() {
    var text = $("#prompt").value.trim();
    if (text.length < 3) { toast("Describe what you want to build first.", true); return null; }
    return { mode: S.mode === "new" ? "generate" : "edit", prompt: text, userText: text };
  }
  function onGenerate() {
    if (S.gen) return; var r = currentRequest(); if (!r) return;
    var hasFiles = Object.keys(realFiles(S.project.files)).length > 0;
    var go = (r.mode === "generate" && hasFiles)
      ? ask({ title: "Replace the current project?", body: "\"New project\" mode replaces all current files. You can undo it afterwards with Revert last. Use \"Modify existing\" to change what you have.", confirm: "Replace", danger: true, noInput: true })
      : Promise.resolve(true);
    go.then(function (ok) { if (ok == null) return; $("#prompt").value = ""; showView("chat"); startGen(r); });
  }

  /* ---------- export ---------- */
  function readme() {
    var files = Object.keys(realFiles(S.project.files)).sort(), hn = htmlName();
    return "# " + S.project.name + "\n\nGenerated with FABLOCK AI BUILDER PRO.\n\n## Run it\n\n" +
      (hn ? "1. Open `" + hn + "` in any modern browser (double-click it), or serve the folder:\n   ```\n   npx serve .\n   ```\n" : "This project has no HTML entry file.\n") +
      (S.project.files["package.json"] ? "2. This project includes a `package.json`. Install dependencies with `npm install`, then use the scripts it defines.\n" : "") +
      "\n## Files\n\n" + files.map(function (f) { return "- `" + f + "`"; }).join("\n") +
      "\n\n## Notes\n\n- Created: " + S.project.createdAt + "\n- Last modified: " + S.project.updatedAt + "\n- The code was written by an AI model and has not been built, linted or tested automatically. Review it before publishing.\n";
  }
  function exportZip() {
    if (typeof JSZip === "undefined") return toast("ZIP library failed to load. Check your connection.", true);
    var files = realFiles(S.project.files); if (!Object.keys(files).length) return toast("Nothing to export yet.", true);
    var z = new JSZip(), root = (S.project.name || "project").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "project";
    Object.keys(files).forEach(function (p) { z.file(root + "/" + p, files[p]); });
    if (!files["README.md"]) z.file(root + "/README.md", readme());
    z.generateAsync({ type: "blob" }).then(function (b) { download(b, root + ".zip"); toast("Exported " + root + ".zip"); });
  }
  function download(blob, name) {
    var a = el("a", { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  /* ---------- projects + settings dialogs ---------- */
  function openProjects() {
    openSheet(function (sheet, close) {
      sheet.appendChild(el("h3", { text: "Projects" }));
      var list = el("div", { class: "plist" }); sheet.appendChild(list);
      sheet.appendChild(el("div", { class: "row end" }, [
        el("button", { class: "btn", text: "Close", onclick: close }),
        el("button", { class: "btn primary", text: "New project", onclick: function () { if (S.gen) return toast("Stop the current generation first.", true); close(); persistLocal(); loadProject(newProject()); showView("chat"); } })]));
      var local = allLocal(), cloud = {};
      function draw() {
        list.textContent = ""; var ids = {}; Object.keys(local).forEach(function (k) { ids[k] = 1; }); Object.keys(cloud).forEach(function (k) { ids[k] = 1; });
        var arr = Object.keys(ids).map(function (id) { return { id: id, name: (local[id] || cloud[id]).name, at: (local[id] || cloud[id]).updatedAt, l: !!local[id], c: !!cloud[id] }; }).sort(function (a, b) { return a.at < b.at ? 1 : -1; });
        if (!arr.length) list.appendChild(el("div", { class: "muted", text: "No saved projects yet." }));
        arr.forEach(function (p) {
          list.appendChild(el("div", { class: "pitem" }, [
            el("span", { class: "nm", title: p.name, text: p.name, onclick: function () { openProject(p, close); } }),
            el("span", { class: "tag", text: (p.l ? "device" : "") + (p.l && p.c ? " + " : "") + (p.c ? "cloud" : "") }),
            el("button", { class: "btn sm danger", text: "Delete", onclick: function () {
              ask({ title: "Delete project", body: "Delete \"" + p.name + "\" everywhere? This cannot be undone.", confirm: "Delete", danger: true, noInput: true }).then(function (v) {
                if (v == null) return; var all = allLocal(); delete all[p.id]; lsSet(KEY.projects, JSON.stringify(all)); local = all; delete cloud[p.id];
                var after = p.c ? call("/projects/delete", { id: p.id }).catch(function (e) { toast("Cloud delete failed: " + e.message, true); }) : Promise.resolve();
                after.then(function () { if (S.project && S.project.id === p.id) loadProject(newProject()); openProjects(); });
              }); } })]));
        });
      }
      draw();
      call("/projects").then(function (d) { (d.projects || []).forEach(function (p) { cloud[p.id] = p; }); draw(); }, function (e) { list.appendChild(el("div", { class: "muted small", text: "Cloud list unavailable: " + e.message })); });
    });
  }
  function openProject(p, close) {
    if (S.gen) return toast("Stop the current generation first.", true);
    persistLocal(); var loc = allLocal()[p.id];
    if (!p.c || (loc && loc.updatedAt >= (p.at || ""))) { if (loc) { close(); loadProject(loc); showView("code"); return; } }
    call("/projects/get?id=" + encodeURIComponent(p.id)).then(function (d) {
      var proj = { id: d.id, name: d.name, createdAt: d.updatedAt, updatedAt: d.updatedAt, files: (d.data && d.data.files) || {}, framework: (d.data && d.data.framework) || "html", preview: (d.data && d.data.preview) || {}, chat: loc ? loc.chat : [] };
      close(); loadProject(proj); showView("code");
    }, function (e) { if (loc) { close(); loadProject(loc); } else toast("Could not open: " + e.message, true); });
  }
  function openSettings() {
    openSheet(function (sheet, close) {
      sheet.appendChild(el("h3", { text: "Project settings" }));
      var name = el("input", { type: "text", value: S.project.name, maxlength: "120" });
      var fw = el("select", {}, [el("option", { value: "html", text: "Vanilla HTML / CSS / JavaScript" })]);
      sheet.appendChild(el("label", {}, ["Project name", name]));
      sheet.appendChild(el("label", {}, ["Framework", fw]));
      sheet.appendChild(el("p", { class: "muted small", text: "Created " + new Date(S.project.createdAt).toLocaleString() + " · Modified " + new Date(S.project.updatedAt).toLocaleString() }));
      sheet.appendChild(el("p", { class: "muted small", text: "AI backend: " + API.replace(/^https?:\/\//, "") + ". The Groq API key lives only on that server. Signed in as " + (S.user ? S.user.email : "unknown") + "." }));
      sheet.appendChild(el("p", { class: "muted small", text: "Live preview supports plain HTML, CSS and JavaScript. React/JSX projects are not previewed." }));
      sheet.appendChild(el("div", { class: "row end" }, [
        el("button", { class: "btn danger", text: "Sign out", onclick: function () { persistLocal(); S.token = null; lsDel(KEY.token); lsDel(KEY.user); close(); location.reload(); } }),
        el("button", { class: "btn", text: "Close", onclick: close }),
        el("button", { class: "btn primary", text: "Save", onclick: function () { var v = name.value.trim() || "Untitled project"; S.project.name = v; S.project.nameSet = true; S.project.framework = fw.value; $("#projName").textContent = v; persistLocal(); close(); } })]));
    });
  }

  /* ---------- fix errors ---------- */
  function onFix() {
    if (S.gen || !S.errors.length) return;
    var errs = S.errors.slice(0, 4), file = errs[0].file;
    var text = errs.map(function (e) { return e.message + (e.line ? " (line " + e.line + (e.file ? " of " + e.file : "") + ")" : ""); }).join("\n");
    showView("chat"); startGen({ mode: "fix", prompt: "", error: text, errorFile: file, userText: "Fix the preview error(s): " + text.split("\n")[0] });
  }

  /* ---------- views, wiring ---------- */
  function showView(v) {
    $("#work").setAttribute("data-view", v);
    document.querySelectorAll("#tabbar button").forEach(function (b) { b.classList.toggle("on", b.getAttribute("data-view") === v); });
    setTimeout(function () { if (cm) cm.refresh(); fitDevice(); }, 30);
  }
  function wire() {
    $("#btnGen").onclick = onGenerate;
    $("#btnStop").onclick = function () { abortGen("stopped"); };
    $("#btnPause").onclick = function () {
      var g = S.gen; if (!g) return; g.paused = !g.paused; $("#btnPause").textContent = g.paused ? "Resume" : "Pause";
      if (g.paused) setStage(2, "Paused", "no more data is read until you resume"); else { var r = g.resume; g.resume = null; if (r) r(); setStage(2, "Resuming...", ""); }
    };
    $("#btnClear").onclick = function () { $("#prompt").value = ""; $("#prompt").focus(); };
    $("#btnRegen").onclick = function () {
      if (S.gen || !S.lastReq) return; restoreSnapshot(); var r = S.lastReq; r.userText = "Regenerate: " + (r.prompt || r.error || "").slice(0, 120); startGen(r);
    };
    $("#btnRevert").onclick = function () {
      if (S.gen || !S.snapshot) return;
      ask({ title: "Revert last generation", body: "Restore the files as they were before the last AI run?", confirm: "Revert", noInput: true }).then(function (v) {
        if (v == null) return; restoreSnapshot(); addMsg("sys", "Reverted to the files from before the last AI run."); $("#btnRevert").disabled = true; setMode(Object.keys(realFiles(S.project.files)).length ? "edit" : "new");
      });
    };
    $("#modeNew").onclick = function () { setMode("new"); }; $("#modeEdit").onclick = function () { setMode("edit"); };
    $("#prompt").addEventListener("keydown", function (e) { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); onGenerate(); } });
    $("#btnSave").onclick = function () { doSave(); };
    $("#btnExport").onclick = exportZip; $("#btnProjects").onclick = openProjects; $("#btnSettings").onclick = openSettings; $("#projName").onclick = openSettings;
    $("#btnNewFile").onclick = newFile; $("#btnNewFolder").onclick = newFolder;
    $("#btnFiles").onclick = function () { S.hidden = !S.hidden; $("#files").classList.toggle("collapsed", S.hidden); setTimeout(function () { cm.refresh(); }, 220); };
    $("#btnUndo").onclick = function () { cm.undo(); cm.focus(); }; $("#btnRedo").onclick = function () { cm.redo(); cm.focus(); };
    $("#btnFind").onclick = function () { cm.focus(); cm.execCommand("find"); }; $("#btnReplace").onclick = function () { cm.focus(); cm.execCommand("replace"); };
    $("#btnCopy").onclick = function () {
      if (!S.active) return; var t = cm.getValue();
      (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(function () { toast("Copied " + S.active); }, function () { cm.focus(); cm.execCommand("selectAll"); document.execCommand("copy"); toast("Copied " + S.active); });
    };
    $("#btnDownload").onclick = function () { if (!S.active) return; download(new Blob([S.project.files[S.active] || ""], { type: "text/plain" }), S.active.split("/").pop()); };
    document.querySelectorAll("[data-dev]").forEach(function (b) { b.onclick = function () { setDevice(b.getAttribute("data-dev")); persistLocal(); }; });
    $("#btnRefresh").onclick = function () { fullReload(); };
    $("#btnFix").onclick = onFix;
    $("#btnNewTab").onclick = function () {
      if (!assembleFinal(true)) return toast("Nothing to preview yet.", true);
      S.tabWin = window.open("preview.html?tab=1", "_blank"); if (!S.tabWin) toast("Pop-up blocked. Allow pop-ups for this site.", true);
    };
    $("#btnFull").onclick = function () { var s = $("#stage"); if (document.fullscreenElement) document.exitFullscreen(); else if (s.requestFullscreen) s.requestFullscreen().catch(function () { toast("Fullscreen is not available here.", true); }); else toast("Fullscreen is not supported in this browser.", true); };
    document.addEventListener("fullscreenchange", function () { setTimeout(fitDevice, 60); });
    $("#btnReload").onclick = function () { if (S.gen) return toast("Generation in progress.", true); persistLocal(); location.reload(); };
    document.querySelectorAll("#tabbar button").forEach(function (b) { b.onclick = function () { showView(b.getAttribute("data-view")); }; });
    window.addEventListener("beforeunload", function (e) { if (S.gen) { e.preventDefault(); e.returnValue = ""; } else persistLocal(); });
  }

  var started = false;
  function startApp() {
    $("#auth").hidden = true; $("#app").hidden = false;
    if (!started) { started = true; initEditor(); wire(); }
    var cur = lsGet(KEY.current), all = allLocal(), p = (cur && all[cur]) || null;
    if (!p) { var ids = Object.keys(all).sort(function (a, b) { return all[a].updatedAt < all[b].updatedAt ? 1 : -1; }); p = ids.length ? all[ids[0]] : newProject(); }
    loadProject(p);
    // Verify the saved sign-in is still valid (fast check; the AI call re-checks anyway).
    call("/auth/session").then(function (d) { if (d && d.user) { S.user = d.user; lsSet(KEY.user, JSON.stringify(d.user)); } }, function () {});
  }
  if (!API) { document.body.textContent = "Missing config.js (FABLOCK_CONFIG.API)."; }
  else if (S.token) startApp(); else showAuth();
})();
