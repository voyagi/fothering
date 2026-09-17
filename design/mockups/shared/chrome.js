// Loaded synchronously in <head>: the stored theme is applied before first paint, so a dark-mode
// visitor who chose Light never sees a dark flash, and Device (no stored value) follows the OS.
(function () {
  var root = document.documentElement;
  // Pages style their scripted parts under .js, so a visitor without JavaScript never sees controls that do nothing.
  root.classList.add("js");
  try {
    var stored = localStorage.getItem("fothering-theme");
    if (stored === "light" || stored === "dark") root.dataset.theme = stored;
    // The flow animation choice (WCAG 2.2.2) is applied here too, so a stopped drawing never starts moving on load.
    var flow = localStorage.getItem("fothering-flow");
    if (flow === "stopped" || flow === "running") root.dataset.flow = flow;
  } catch (e) {}

  var sheets = [
    { href: "replay.html", label: "Incident replay" },
    { href: "console.html", label: "Console" },
    { href: "deploy.html", label: "Deploy" }
  ];
  var reads = [
    { href: "privacy.html", label: "Privacy" },
    { href: "ai.html", label: "AI disclosure" }
  ];

  function links(list, current) {
    return list.map(function (item) {
      var mark = item.href === current ? ' aria-current="page"' : "";
      return '<li><a href="' + item.href + '"' + mark + ">" + item.label + "</a></li>";
    }).join("");
  }

  function top() {
    var zones = ["", "A", "B", "C", "D", "E", "F"].map(function (z) { return "<span>" + z + "</span>"; }).join("");
    var modes = ["device", "light", "dark"].map(function (mode) {
      var name = mode.charAt(0).toUpperCase() + mode.slice(1);
      return '<label><input type="radio" name="theme" value="' + mode + '"><span>' + name + "</span></label>";
    }).join("");
    return '<a class="skip" href="#main">Skip to the drawing</a>' +
      '<div class="zones" aria-hidden="true">' + zones + "</div>" +
      '<header class="bar"><a class="wordmark" href="landing.html">FOTHERING</a>' +
      '<div class="bar-end"><a href="#index">Sheet index</a>' +
      '<fieldset class="theme"><legend>Colour theme</legend>' + modes + "</fieldset></div></header>";
  }

  // Sheet order follows the site: landing first, then the three working sheets, then the two reading sheets.
  var order = ["landing.html", "replay.html", "console.html", "deploy.html", "privacy.html", "ai.html"];

  function index(current) {
    var n = Math.max(0, order.indexOf(current)) + 1;
    return '<div><b>Project</b>Fothering. Stops one leak without stopping the ship.<br><span class="mono">eu-central-1, fixture build</span></div>' +
      '<nav aria-label="Sheets"><b>Sheets</b><ul>' + links(sheets, current) + "</ul></nav>" +
      "<div><b>Read</b><ul>" + links(reads, current) + "</ul></div>" +
      '<div><b>Drawing</b><span class="mono">FTH-00' + n + ", sheet " + n + " of " + order.length + '</span><br>' +
      '<span class="mono">Rev A, 2026-09-16</span><br><span class="mono">Status: fixture</span><br>Source private until submission</div>';
  }

  function wireTheme() {
    var current = root.dataset.theme || "device";
    document.querySelectorAll('.theme input[name="theme"]').forEach(function (input) {
      input.checked = input.value === current;
      input.addEventListener("change", function () {
        if (input.value === "device") delete root.dataset.theme;
        else root.dataset.theme = input.value;
        try {
          if (input.value === "device") localStorage.removeItem("fothering-theme");
          else localStorage.setItem("fothering-theme", input.value);
        } catch (e) {}
      });
    });
  }

  // Every drawing with moving flow carries a Stop flow button. With no stored choice the flow follows the
  // operating system: stopped under reduced motion, running otherwise. A click stores the opposite state.
  function wireFlow() {
    var buttons = document.querySelectorAll(".flow-toggle");
    if (!buttons.length) return;
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    function isStopped() {
      return root.dataset.flow === "stopped" || (root.dataset.flow !== "running" && reduce.matches);
    }
    function label() {
      var stopped = isStopped();
      buttons.forEach(function (button) { button.textContent = stopped ? "Run flow" : "Stop flow"; });
    }
    buttons.forEach(function (button) {
      button.addEventListener("click", function () {
        root.dataset.flow = isStopped() ? "running" : "stopped";
        try { localStorage.setItem("fothering-flow", root.dataset.flow); } catch (e) {}
        label();
      });
    });
    label();
  }

  document.addEventListener("DOMContentLoaded", function () {
    var current = location.pathname.split("/").pop() || "landing.html";
    var topSlot = document.querySelector('[data-chrome="top"]');
    var indexSlot = document.querySelector('[data-chrome="index"]');
    if (topSlot) topSlot.outerHTML = top();
    if (indexSlot) {
      indexSlot.className = "titleblock";
      indexSlot.id = "index";
      indexSlot.innerHTML = index(current);
    }
    wireTheme();
    wireFlow();
  });
})();
