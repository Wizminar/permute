// Runs before first paint so the saved theme never flashes.
(function () {
  try {
    var t = localStorage.getItem('permute-theme');
    if (t === 'light') document.documentElement.dataset.theme = 'light';
  } catch (e) { /* storage blocked: stay on the dark default */ }
})();
