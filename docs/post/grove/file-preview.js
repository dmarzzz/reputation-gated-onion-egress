/* global document, window */

if (window.location.protocol === "file:") {
  const setText = (selector, value) => {
    const element = document.querySelector(selector);
    if (element) element.textContent = value;
  };

  const showLocalPreview = () => {
    document.body.classList.remove("is-checking");
    document.body.classList.add("is-local-preview");

    setText("[data-view-state]", "Local preview · open the hosted Grove for live stats");
    setText("[data-snapshot-state]", "Local preview");
    setText("[data-network]", "Sepolia");
    setText("[data-view-time]", "Not connected");
    setText("[data-snapshot-cadence]", "15 min");
    setText("[data-node-count]", "—");
    setText("[data-history-low]", "—");
    setText("[data-history-high]", "—");
    setText("[data-history-samples]", "0");
    setText("[data-history-coverage]", "0%");

    const chart = document.querySelector("[data-history-chart]");
    chart?.setAttribute(
      "aria-label",
      "Local file preview. Open the hosted Grove for live signed count history.",
    );
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", showLocalPreview, { once: true });
  } else {
    showLocalPreview();
  }
}
